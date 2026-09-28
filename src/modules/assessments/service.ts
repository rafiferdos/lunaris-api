import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { topics, configs, questions, topicMetrics } from '../../db/schema/domain.js';
import { scoring } from '../scoring/v1.js';
import { assert } from '../../core/errors.js';
import type { AttemptService } from '../attempts/service.js';
export function createAssessmentService(db: Database, attempts: AttemptService) {
  async function list(userId: string) {
    const [topicRows, configRows, progressRows, bankRows, availability] = await Promise.all([
      db.select().from(topics).where(eq(topics.active, true)),
      db.select().from(configs),
      db.select().from(topicMetrics).where(eq(topicMetrics.userId, userId)),
      db
        .select({
          topicId: questions.topicId,
          count: sql<number>`count(distinct ${questions.questionKey})::int`,
        })
        .from(questions)
        .where(eq(questions.status, 'PUBLISHED'))
        .groupBy(questions.topicId),
      attempts.availability(userId),
    ]);
    return topicRows.map((t) => ({
      ...t,
      modes: configRows
        .filter((c) => c.topicId === t.id)
        .map((c) => ({
          id: c.id,
          mode: c.mode,
          ...c.policy,
          scoring: scoring[c.mode],
          available:
            c.policy.enabled &&
            (bankRows.find((b) => b.topicId === t.id)?.count ?? 0) >= c.policy.questionCount,
        })),
      progress: progressRows.find((p) => p.topicId === t.id)?.data ?? null,
      availability,
    }));
  }
  return {
    list,
    async get(userId: string, slug: string) {
      const topic = (await list(userId)).find((t) => t.slug === slug);
      assert(topic, 404, 'TOPIC_NOT_FOUND', 'Topic not found.');
      return topic;
    },
  };
}
