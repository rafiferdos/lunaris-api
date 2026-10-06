// Vercel entry point. The persistent Node server remains in src/server.ts.
import { Hono } from 'hono';
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { loadConfig } from './src/config/env.js';
import { createDatabase } from './src/db/client.js';
import { createApp } from './src/app.js';
import { createLogger } from './src/core/logger.js';
const config = loadConfig();
const { db, pool } = createDatabase(config.DATABASE_URL, true);
const logger = createLogger(config);
pool.on('error', () => logger.error('Unexpected database pool error'));
attachDatabasePool(pool);
const runtime = createApp(db, config);
const app = new Hono();
let sweep: Promise<unknown> | undefined;
let nextSweep = 0;
app.use('*', async (_c, next) => {
  // Keep expiry timely while the app is used, without a timer that Vercel can freeze.
  if (!sweep && Date.now() >= nextSweep) {
    nextSweep = Date.now() + config.EXPIRY_SWEEP_INTERVAL_MS;
    sweep = Promise.all([runtime.attempts.expire(), runtime.notifications.run(2)])
      .catch(() => logger.error('Background job failed; will retry'))
      .finally(() => {
        sweep = undefined;
      });
    waitUntil(sweep);
  }
  await next();
});
app.route('/', runtime.app);
export default app;
