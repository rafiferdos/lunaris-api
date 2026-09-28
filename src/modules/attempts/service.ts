import { and, eq, gte, sql, desc } from 'drizzle-orm';
import type { Database, Transaction } from '../../db/client.js';
import {
  attempts,
  attemptQuestions,
  answers,
  questions,
  topics,
  configs,
  integrityEvents,
  metrics,
  topicMetrics,
  xpLedger,
  ratingEvents,
} from '../../db/schema/domain.js';
import type { Result } from '../../db/schema/domain.js';
import { publicQuestion, type Mode, type Question } from '../questions/schema.js';
import { policySchema, quotaPolicy } from '../assessments/policy.js';
import { selectQuestions, shuffle } from '../assessments/selection.js';
import { assert } from '../../core/errors.js';
import { score } from '../scoring/v1.js';
import { rate } from '../rating/v1.js';
import { awardXp } from '../xp/v1.js';
import { assessIntegrity, integrityPolicy, type IntegrityEvent } from '../integrity/v1.js';
import { applyResult, emptyMetrics } from '../stats/metrics.js';
import { quotaBounds } from '../stats/streak.js';
import { attemptContent, lockUser, ownedAttempt } from './repository.js';
type Attempt = typeof attempts.$inferSelect;
export function createAttemptService(
  db: Database,
  clock: () => Date = () => new Date(),
  limits = quotaPolicy,
) {
  async function availability(tx: Database | Transaction, userId: string) {
    const now = clock(),
      bounds = quotaBounds(now);
    const [usage] = await tx
      .select({
        daily: sql<number>`count(*) filter (where ${attempts.startedAt}>=${bounds.day})::int`,
        weekly: sql<number>`count(*)::int`,
      })
      .from(attempts)
      .where(and(eq(attempts.userId, userId), gte(attempts.startedAt, bounds.week)));
    return {
      dailyUsed: usage?.daily ?? 0,
      weeklyUsed: usage?.weekly ?? 0,
      dailyLimit: limits.daily,
      weeklyLimit: limits.weekly,
      nextDailyReset: bounds.nextDay.toISOString(),
      nextWeeklyReset: bounds.nextWeek.toISOString(),
      canStart: (usage?.daily ?? 0) < limits.daily && (usage?.weekly ?? 0) < limits.weekly,
    };
  }
  async function finalize(
    tx: Transaction,
    a: Attempt,
    status: 'SUBMITTED' | 'AUTO_SUBMITTED' | 'EXPIRED',
    reason: string | null = null,
  ) {
    if (a.status !== 'IN_PROGRESS') return a;
    const now = clock();
    const { rows, events } = await attemptContent(tx, a.id);
    const integrity = assessIntegrity(events, a.mode);
    const academic = score(
      rows.map((r) => r.question.snapshot),
      rows.map((r) => r.answer?.selected ?? []),
      a.mode,
    );
    const eligible = a.policy.ranked && integrity.eligible;
    const [overall] = await tx.select().from(metrics).where(eq(metrics.userId, a.userId));
    const [topic] = await tx
      .select()
      .from(topicMetrics)
      .where(and(eq(topicMetrics.userId, a.userId), eq(topicMetrics.topicId, a.topicId)));
    const old = overall?.data ?? emptyMetrics(),
      oldTopic = topic?.data ?? emptyMetrics();
    const overallRating = rate(
        old.rating,
        old.ratedCount,
        academic.normalizedScore,
        a.mode,
        eligible,
      ),
      topicRating = rate(
        oldTopic.rating,
        oldTopic.ratedCount,
        academic.normalizedScore,
        a.mode,
        eligible,
      );
    const result: Result = {
      ...academic,
      reviews: academic.reviews.map((review, i) => ({
        ...review,
        questionId: rows[i]!.question.id,
        question: rows[i]!.question.snapshot,
        selected: rows[i]!.answer?.selected ?? [],
        responseTimeMs: rows[i]!.answer?.responseTimeMs ?? null,
      })),
      xp: awardXp(rows.length, academic.normalizedScore, a.mode, integrity.score, eligible),
      ratingChange: overallRating.delta,
      topicRatingChange: topicRating.delta,
      integrity: integrity.score,
      rankEligible: eligible,
      durationSeconds: Math.max(
        0,
        Math.floor((Math.min(+now, +a.expiresAt) - +a.startedAt) / 1000),
      ),
      xpVersion: a.policy.xpVersion,
      ratingVersion: a.policy.ratingVersion,
      integrityVersion: a.policy.integrityVersion,
    };
    const [updated] = await tx
      .update(attempts)
      .set({ status, submittedAt: now, result, reason })
      .where(eq(attempts.id, a.id))
      .returning();
    await tx.insert(xpLedger).values({
      userId: a.userId,
      attemptId: a.id,
      amount: result.xp,
      topicId: a.topicId,
      category: a.category,
      mode: a.mode,
      engineVersion: a.policy.xpVersion,
      createdAt: now,
    });
    await tx.insert(ratingEvents).values(
      [
        { scope: 'overall', ...overallRating },
        { scope: a.topicId, ...topicRating },
      ].map((r) => ({
        ...r,
        userId: a.userId,
        attemptId: a.id,
        engineVersion: a.policy.ratingVersion,
        createdAt: now,
      })),
    );
    const overallData = applyResult(old, result, overallRating.after, now),
      topicData = applyResult(oldTopic, result, topicRating.after, now);
    await tx
      .insert(metrics)
      .values({ userId: a.userId, data: overallData })
      .onConflictDoUpdate({ target: metrics.userId, set: { data: overallData } });
    await tx
      .insert(topicMetrics)
      .values({ userId: a.userId, topicId: a.topicId, data: topicData })
      .onConflictDoUpdate({
        target: [topicMetrics.userId, topicMetrics.topicId],
        set: { data: topicData },
      });
    await tx.execute(
      sql`select pg_notify('lunaris_leaderboard',${JSON.stringify({ topicId: a.topicId, category: a.category, mode: a.mode })})`,
    );
    return updated!;
  }
  async function dto(tx: Transaction, a: Attempt) {
    const { rows, events } = await attemptContent(tx, a.id);
    const [topic] = await tx.select().from(topics).where(eq(topics.id, a.topicId));
    return {
      id: a.id,
      status: a.status,
      topic: { id: topic!.id, slug: topic!.slug, name: topic!.name, category: topic!.category },
      mode: a.mode,
      startedAt: a.startedAt.toISOString(),
      expiresAt: a.expiresAt.toISOString(),
      serverTime: clock().toISOString(),
      submittedAt: a.submittedAt?.toISOString() ?? null,
      questionCount: rows.length,
      policy: { ...a.policy, integrity: integrityPolicy },
      integrity: assessIntegrity(events, a.mode),
      currentPosition: a.currentPosition,
      questions: rows.map((r) => ({
        ...publicQuestion(r.question.id, r.question.snapshot),
        position: r.question.position,
        selected: r.answer?.selected ?? [],
      })),
      result: a.result,
      reason: a.reason,
    };
  }
  async function run(
    userId: string,
    id: string,
    action: (tx: Transaction, a: Attempt) => Promise<Attempt>,
  ) {
    return db.transaction(async (tx) => {
      await lockUser(tx, userId);
      let a = await ownedAttempt(tx, userId, id);
      if (a.status === 'IN_PROGRESS' && clock() >= a.expiresAt)
        a = await finalize(tx, a, 'EXPIRED', 'DEADLINE');
      return dto(tx, await action(tx, a));
    });
  }
  return {
    availability: (userId: string) => availability(db, userId),
    async start(userId: string, input: { topicSlug: string; mode: Mode; requestKey: string }) {
      return db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const [existing] = await tx
          .select()
          .from(attempts)
          .where(and(eq(attempts.userId, userId), eq(attempts.requestKey, input.requestKey)));
        if (existing) {
          const [topic] = await tx.select().from(topics).where(eq(topics.id, existing.topicId));
          assert(
            existing.mode === input.mode && topic?.slug === input.topicSlug,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Request key was used for different parameters.',
          );
          return dto(
            tx,
            existing.status === 'IN_PROGRESS' && clock() >= existing.expiresAt
              ? await finalize(tx, existing, 'EXPIRED', 'DEADLINE')
              : existing,
          );
        }
        const [active] = await tx
          .select()
          .from(attempts)
          .where(and(eq(attempts.userId, userId), eq(attempts.status, 'IN_PROGRESS')));
        if (active && clock() >= active.expiresAt)
          await finalize(tx, active, 'EXPIRED', 'DEADLINE');
        else
          assert(
            !active,
            409,
            'ACTIVE_ATTEMPT',
            'Resume the existing attempt before starting another.',
          );
        assert(
          (await availability(tx, userId)).canStart,
          429,
          'QUOTA_EXCEEDED',
          'Assessment start quota exhausted.',
        );
        const [topic] = await tx
          .select()
          .from(topics)
          .where(and(eq(topics.slug, input.topicSlug), eq(topics.active, true)));
        assert(topic, 404, 'TOPIC_NOT_FOUND', 'Topic not found.');
        const [config] = await tx
          .select()
          .from(configs)
          .where(and(eq(configs.topicId, topic.id), eq(configs.mode, input.mode)));
        assert(config, 409, 'MODE_UNAVAILABLE', 'Assessment mode unavailable.');
        const policy = policySchema.parse(config.policy);
        assert(policy.enabled, 409, 'MODE_DISABLED', 'Assessment mode is disabled.');
        const pool = await tx
          .select()
          .from(questions)
          .where(and(eq(questions.topicId, topic.id), eq(questions.status, 'PUBLISHED')))
          .orderBy(desc(questions.version));
        const latest = [...new Map(pool.toReversed().map((q) => [q.questionKey, q])).values()];
        assert(
          latest.length >= policy.questionCount,
          409,
          'INSUFFICIENT_QUESTIONS',
          'Not enough published questions for this mode.',
        );
        const recent = await tx
          .select({ id: attemptQuestions.questionId })
          .from(attemptQuestions)
          .innerJoin(attempts, eq(attempts.id, attemptQuestions.attemptId))
          .where(
            and(
              eq(attempts.userId, userId),
              gte(attempts.startedAt, new Date(+clock() - 30 * 86400000)),
            ),
          );
        const chosen = selectQuestions(latest, policy, new Set(recent.map((r) => r.id)));
        const now = clock();
        const [a] = await tx
          .insert(attempts)
          .values({
            userId,
            topicId: topic.id,
            category: topic.category,
            mode: input.mode,
            requestKey: input.requestKey,
            policy,
            startedAt: now,
            expiresAt: new Date(+now + policy.durationSeconds * 1000),
          })
          .returning();
        await tx.insert(attemptQuestions).values(
          chosen.map((q, position) => ({
            attemptId: a!.id,
            questionId: q.id,
            position,
            snapshot: {
              ...q.content,
              options: shuffle<Question['options'][number]>(q.content.options),
            } as typeof q.content,
          })),
        );
        return dto(tx, a!);
      });
    },
    get: (userId: string, id: string) => run(userId, id, async (_tx, a) => a),
    submit: (userId: string, id: string) =>
      run(userId, id, (tx, a) => finalize(tx, a, 'SUBMITTED')),
    async answer(
      userId: string,
      id: string,
      questionId: string,
      input: { selected: string[]; responseTimeMs?: number },
    ) {
      const response = await run(userId, id, async (tx, a) => {
        if (a.status !== 'IN_PROGRESS') return a;
        const [question] = await tx
          .select()
          .from(attemptQuestions)
          .where(and(eq(attemptQuestions.id, questionId), eq(attemptQuestions.attemptId, a.id)));
        assert(question, 404, 'QUESTION_NOT_FOUND', 'Question is not part of this attempt.');
        assert(
          input.selected.every((id) => question.snapshot.options.some((o) => o.id === id)) &&
            new Set(input.selected).size === input.selected.length,
          422,
          'INVALID_OPTIONS',
          'Selected options are invalid or repeated.',
        );
        assert(
          question.snapshot.type === 'MULTIPLE_CHOICE' || input.selected.length <= 1,
          422,
          'INVALID_SELECTION',
          'Only one answer may be selected.',
        );
        const [previous] = await tx
          .select()
          .from(answers)
          .where(eq(answers.attemptQuestionId, questionId));
        if (!a.policy.editable && previous) {
          assert(
            JSON.stringify([...previous.selected].sort()) ===
              JSON.stringify([...input.selected].sort()),
            409,
            'ANSWER_LOCKED',
            'Committed answers cannot be changed.',
          );
          return a;
        }
        assert(
          a.policy.backNavigation || question.position >= a.currentPosition,
          409,
          'BACK_NAVIGATION_DISABLED',
          'This question can no longer be answered.',
        );
        await tx
          .insert(answers)
          .values({
            attemptQuestionId: questionId,
            selected: input.selected,
            responseTimeMs: input.responseTimeMs ?? null,
            savedAt: clock(),
          })
          .onConflictDoUpdate({
            target: answers.attemptQuestionId,
            set: {
              selected: input.selected,
              responseTimeMs: input.responseTimeMs ?? null,
              savedAt: clock(),
            },
          });
        if (!a.policy.backNavigation) {
          const [updated] = await tx
            .update(attempts)
            .set({ currentPosition: question.position })
            .where(eq(attempts.id, id))
            .returning();
          return updated!;
        }
        return a;
      });
      assert(
        response.status === 'IN_PROGRESS',
        409,
        'ATTEMPT_FINALIZED',
        'Attempt has ended; answers were not changed.',
      );
      return response;
    },
    event: (userId: string, id: string, input: Omit<IntegrityEvent, 'serverReceivedAt'>) =>
      run(userId, id, async (tx, a) => {
        if (a.status !== 'IN_PROGRESS') return a;
        const [existing] = await tx
          .select()
          .from(integrityEvents)
          .where(
            and(eq(integrityEvents.attemptId, id), eq(integrityEvents.sequence, input.sequence)),
          );
        if (existing) {
          const prior = existing.event;
          assert(
            prior.type === input.type &&
              prior.clientTimestamp === input.clientTimestamp &&
              prior.durationMs === input.durationMs &&
              prior.confidence === input.confidence,
            409,
            'EVENT_SEQUENCE_CONFLICT',
            'Sequence was used for a different event.',
          );
          return a;
        }
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(integrityEvents)
          .where(eq(integrityEvents.attemptId, id));
        assert((count?.n ?? 0) < 2000, 429, 'EVENT_LIMIT', 'Event limit reached.');
        await tx.insert(integrityEvents).values({
          attemptId: id,
          sequence: input.sequence,
          event: { ...input, serverReceivedAt: clock().toISOString() },
        });
        const integrity = assessIntegrity((await attemptContent(tx, id)).events, a.mode);
        return integrity.autoSubmit ? finalize(tx, a, 'AUTO_SUBMITTED', integrity.reason) : a;
      }),
    async expire() {
      const stale = await db
        .select({ id: attempts.id, userId: attempts.userId })
        .from(attempts)
        .where(and(eq(attempts.status, 'IN_PROGRESS'), sql`${attempts.expiresAt}<=${clock()}`))
        .limit(500);
      for (const a of stale) await run(a.userId, a.id, async (_tx, row) => row);
      return { processed: stale.length };
    },
  };
}
export type AttemptService = ReturnType<typeof createAttemptService>;
