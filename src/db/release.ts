// Idempotent production catalog/content bootstrap. Never creates demo accounts.
import { loadConfig } from '../config/env.js';
import { createDatabase } from './client.js';
import { seedCatalog, seedDocument } from './seed.js';
import { createAdminService } from '../modules/admin/service.js';
import { importSchema } from '../modules/questions/schema.js';
import content from './content/launch-v1.json' with { type: 'json' };
const config = loadConfig();
const { db, pool } = createDatabase(config.DATABASE_URL);
try {
  const version = await pool.query<{ server_version: string }>('SHOW server_version');
  console.log(JSON.stringify({ postgresVersion: version.rows[0]?.server_version }));
  await seedCatalog(db);
  const document = importSchema.parse({
    schemaVersion: 1,
    questions: [...seedDocument.questions, ...content.questions],
  });
  // Null actor means a deployment operator, and is recorded in the import audit trail.
  const result = await createAdminService(db).import(null, document);
  console.log(JSON.stringify({ content: result }));
} finally {
  await pool.end();
}
