import { eq, asc } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { attempts, metrics, topicMetrics, ratingEvents, xpLedger } from '../../db/schema/domain.js';
import { lockUser } from '../attempts/repository.js';
import { applyResult, emptyMetrics } from './metrics.js';
export async function rebuildUser(db: Database, userId: string) {
  return db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const rows = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.userId, userId))
      .orderBy(asc(attempts.submittedAt), asc(attempts.id));
    const events = await tx.select().from(ratingEvents).where(eq(ratingEvents.userId, userId));
    const ledger = await tx.select().from(xpLedger).where(eq(xpLedger.userId, userId));
    const xpByAttempt = new Map(ledger.map((entry) => [entry.attemptId, entry.amount]));
    const ratings = new Map(
      events.map((entry) => [`${entry.attemptId}:${entry.scope}`, entry.after]),
    );
    let overall = emptyMetrics();
    const byTopic = new Map<string, ReturnType<typeof emptyMetrics>>();
    for (const a of rows) {
      if (!a.result || !a.submittedAt) continue;
      const result = { ...a.result, xp: xpByAttempt.get(a.id) ?? 0 };
      overall = applyResult(
        overall,
        result,
        ratings.get(`${a.id}:overall`) ?? overall.rating,
        a.submittedAt,
      );
      const old = byTopic.get(a.topicId) ?? emptyMetrics();
      byTopic.set(
        a.topicId,
        applyResult(old, result, ratings.get(`${a.id}:${a.topicId}`) ?? old.rating, a.submittedAt),
      );
    }
    await tx
      .insert(metrics)
      .values({ userId, data: overall })
      .onConflictDoUpdate({ target: metrics.userId, set: { data: overall } });
    await tx.delete(topicMetrics).where(eq(topicMetrics.userId, userId));
    if (byTopic.size)
      await tx
        .insert(topicMetrics)
        .values([...byTopic].map(([topicId, data]) => ({ userId, topicId, data })));
    return overall;
  });
}
