import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config/env.js';
import { createDatabase } from './client.js';
const config = loadConfig();
const { db, pool } = createDatabase(process.env.DATABASE_URL_UNPOOLED ?? config.DATABASE_URL);
const lock = await pool.connect();
try {
  await lock.query("select pg_advisory_lock(hashtextextended('lunaris:migrations',0))");
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
} finally {
  await lock.query("select pg_advisory_unlock(hashtextextended('lunaris:migrations',0))");
  lock.release();
  await pool.end();
}
