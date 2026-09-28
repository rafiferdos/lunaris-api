import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as auth from './schema/auth.js';
import * as domain from './schema/domain.js';
export function createDatabase(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  });
  const db = drizzle(pool, { schema: { ...auth, ...domain } });
  return { db, pool };
}
export type Database = ReturnType<typeof createDatabase>['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
