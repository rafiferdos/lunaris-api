import { serve } from '@hono/node-server';
import { loadConfig } from './config/env.js';
import { createDatabase } from './db/client.js';
import { createLogger } from './core/logger.js';
import { createLeaderboardEvents } from './modules/leaderboard/events.js';
import { createApp } from './app.js';
const config = loadConfig(),
  logger = createLogger(config),
  { db, pool } = createDatabase(config.DATABASE_URL);
pool.on('error', () => logger.error('Unexpected database pool error'));
const events = createLeaderboardEvents(config.DATABASE_URL, logger);
await events.start();
const { app } = createApp(db, config, events);
const server = serve({ fetch: app.fetch, port: config.PORT }, () =>
  logger.info({ port: config.PORT }, 'Lunaris API listening'),
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  logger.info('Graceful shutdown started');
  const deadline = setTimeout(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    logger.error('Shutdown deadline exceeded');
    process.exit(1);
  }, 10000);
  deadline.unref();
  const drained = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  try {
    await events.close();
    if ('closeIdleConnections' in server) server.closeIdleConnections();
    await drained;
    await pool.end();
  } catch (error) {
    logger.error({ errorName: error instanceof Error ? error.name : 'Unknown' }, 'Shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
