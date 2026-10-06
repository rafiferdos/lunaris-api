import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { topics, configs, topicMetrics } from '../../db/schema/domain.js';
import { scoring } from '../scoring/v1.js';
import { hasCoverage } from './selection.js';
import type { Question } from '../questions/schema.js';
import { assert } from '../../core/errors.js';
import type { AttemptService } from '../attempts/service.js';
export function createAssessmentService(db: Database, attempts: AttemptService) {
  async function list(userId: string) {
    const [topicRows, configRows, progressRows, bankRows, availability] = await Promise.all([
      db.select().from(topics).where(eq(topics.active, true)),
      db.select().from(configs),
      db.select().from(topicMetrics).where(eq(topicMetrics.userId, userId)),
      db.execute<{ topic_id: string; difficulty: Question['difficulty']; count: number }>(sql`
        select topic_id, difficulty, count(*)::int as count from (
          select distinct on (question_key) topic_id, difficulty from questions
          where status = 'PUBLISHED' order by question_key, version desc
        ) latest group by topic_id, difficulty
      `),
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
            hasCoverage(
              Object.fromEntries(
                bankRows.rows
                  .filter((b) => b.topic_id === t.id)
                  .map((b) => [b.difficulty, b.count]),
              ),
              c.policy,
            ),
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
