import { sql } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import type { Database } from '../../db/client.js';
import { decodeCursor, encodeCursor, cursorSchema } from '../../core/cursor.js';
import { quotaBounds } from '../stats/streak.js';
export const leaderboardQuery = z.object({
  period: z.enum(['weekly', 'monthly', 'all_time']).default('weekly'),
  category: z.enum(['overall', 'technical', 'interpersonal']).default('overall'),
  topic: z
    .string()
    .regex(/^[a-z0-9-]{2,80}$/)
    .optional(),
  mode: z.enum(['all', 'easy', 'medium', 'competitive']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: cursorSchema,
});
const rowSchema = z.object({
  rank: z.coerce.number(),
  id: z.uuid(),
  name: z.string(),
  username: z.string().nullable(),
  xp: z.coerce.number(),
  rating: z.coerce.number(),
  performance: z.coerce.number(),
  accuracy: z.coerce.number().nullable(),
  assessments: z.coerce.number(),
  integrity: z.coerce.number(),
  streak: z.coerce.number(),
  movement: z.null(),
});
export const leaderboardRowSchema = rowSchema;
export function createLeaderboardService(db: Database) {
  return {
    async list(userId: string, input: z.infer<typeof leaderboardQuery>) {
      const signature = JSON.stringify([input.period, input.category, input.topic, input.mode]);
      const c = decodeCursor(
        input.cursor,
        z.object({
          xp: z.number(),
          rating: z.number(),
          performance: z.number(),
          assessments: z.number(),
          id: z.uuid(),
          scope: z.literal(signature),
        }),
      );
      const now = new Date(),
        start =
          input.period === 'weekly'
            ? quotaBounds(now).week
            : input.period === 'monthly'
              ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
              : new Date(0);
      const base = sql`with totals as (select u.id,u.name,p.username,sum(x.amount)::int xp,coalesce((m.data->>'rating')::int,1000) rating,avg((a.result->>'normalizedScore')::float) performance,avg((a.result->>'accuracyPercent')::float) accuracy,count(*)::int assessments,avg((a.result->>'integrity')::float) integrity,case when (m.data->>'lastAssessmentAt')::timestamptz >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' - interval '1 day' then coalesce((m.data->>'currentStreak')::int,0) else 0 end streak,null::text movement from xp_ledger x join "user" u on u.id=x.user_id join attempts a on a.id=x.attempt_id join topics t on t.id=x.topic_id left join user_profiles p on p.user_id=u.id left join user_metrics m on m.user_id=u.id left join user_preferences pref on pref.user_id=u.id where x.created_at>=${start} and (a.result->>'rankEligible')::boolean=true and coalesce((pref.settings->>'publicProfile')::boolean,true)=true ${input.category !== 'overall' ? sql`and x.category=${input.category.toUpperCase()}` : sql``} ${input.mode !== 'all' ? sql`and x.mode=${input.mode.toUpperCase()}` : sql``} ${input.topic ? sql`and t.slug=${input.topic}` : sql``} group by u.id,p.username,m.data), ranked as(select *,row_number() over(order by xp desc,rating desc,performance desc,assessments desc,id) rank from totals)`;
      const [pageResult, currentResult, countResult] = await Promise.all([
        db.execute(
          sql`${base} select * from ranked ${c ? sql`where (-xp,-rating,-performance,-assessments,id)>(${-c.xp},${-c.rating},${-c.performance},${-c.assessments},${c.id}::uuid)` : sql``} order by rank limit ${input.limit + 1}`,
        ),
        db.execute(sql`${base} select * from ranked where id=${userId}::uuid`),
        db.execute(sql`${base} select count(*)::int total from ranked`),
      ]);
      const rows = z.array(rowSchema).parse(pageResult.rows),
        last = rows[Math.min(input.limit, rows.length) - 1];
      const current = currentResult.rows[0] ? rowSchema.parse(currentResult.rows[0]) : null;
      const total = z.object({ total: z.number() }).parse(countResult.rows[0]).total;
      return {
        data: rows.slice(0, input.limit),
        meta: {
          nextCursor:
            rows.length > input.limit && last
              ? encodeCursor({
                  xp: last.xp,
                  rating: last.rating,
                  performance: last.performance,
                  assessments: last.assessments,
                  id: last.id,
                  scope: signature,
                })
              : null,
          total,
          currentUser: current,
          percentile: current && total ? (current.rank / total) * 100 : null,
          period: input.period,
        },
      };
    },
  };
}
