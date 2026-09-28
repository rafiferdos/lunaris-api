import { eq, asc } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { attempts, metrics, topicMetrics, ratingEvents } from '../../db/schema/domain.js';
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
    let overall = emptyMetrics();
    const byTopic = new Map<string, ReturnType<typeof emptyMetrics>>();
    for (const a of rows) {
      if (!a.result || !a.submittedAt) continue;
      overall = applyResult(
        overall,
        a.result,
        events.find((e) => e.attemptId === a.id && e.scope === 'overall')?.after ?? overall.rating,
        a.submittedAt,
      );
      const old = byTopic.get(a.topicId) ?? emptyMetrics();
      byTopic.set(
        a.topicId,
        applyResult(
          old,
          a.result,
          events.find((e) => e.attemptId === a.id && e.scope === a.topicId)?.after ?? old.rating,
          a.submittedAt,
        ),
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
