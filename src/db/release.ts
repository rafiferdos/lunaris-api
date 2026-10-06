// Only catalog metadata is bootstrapped. Deployments never contain or recreate a question bank.
import { loadConfig } from '../config/env.js';
import { createDatabase } from './client.js';
import { seedCatalog } from './catalog.js';
const config = loadConfig();
const { db, pool } = createDatabase(config.DATABASE_URL);
try {
  await seedCatalog(db);
  console.log(JSON.stringify({ catalog: 'ready', questionSource: 'database' }));
} finally {
  await pool.end();
}
