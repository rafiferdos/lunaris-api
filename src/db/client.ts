import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as auth from './schema/auth.js';
import * as domain from './schema/domain.js';
export function createDatabase(url: string, serverless = false) {
  const connection = new URL(url);
  if (['require', 'prefer', 'verify-ca'].includes(connection.searchParams.get('sslmode') ?? ''))
    connection.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({
    connectionString: connection.href,
    max: serverless ? 5 : 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: serverless ? 5000 : 30000,
    statement_timeout: 15000,
  });
  const db = drizzle(pool, { schema: { ...auth, ...domain } });
  return { db, pool };
}
export type Database = ReturnType<typeof createDatabase>['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
