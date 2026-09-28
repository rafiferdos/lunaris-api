import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { assert } from './errors.js';
export async function enforceRateLimit(db: Database, key: string, limit: number, seconds = 60) {
  const result = await db.execute(
    sql`insert into request_limits(key,count,expires_at) values(${key},1,now()+${seconds}*interval '1 second') on conflict(key) do update set count=case when request_limits.expires_at<=now() then 1 else request_limits.count+1 end,expires_at=case when request_limits.expires_at<=now() then now()+${seconds}*interval '1 second' else request_limits.expires_at end returning count`,
  );
  const { count } = z.object({ count: z.number() }).parse(result.rows[0]);
  assert(count <= limit, 429, 'RATE_LIMITED', 'Too many requests. Try again later.');
}
