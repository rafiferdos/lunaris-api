// Optional development identities only. Question content is imported from an external document.
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from './client.js';
import { user } from './schema/auth.js';
import { profiles } from './schema/domain.js';
import { seedCatalog } from './catalog.js';
import { createAuth } from '../modules/auth/auth.js';
import { loadConfig, type Config } from '../config/env.js';
export { seedCatalog } from './catalog.js';
export async function seedDevelopment(db: Database, config: Config) {
  if (config.NODE_ENV === 'production')
    throw new Error('Development seed is disabled in production.');
  if (!config.SEED_PASSWORD) throw new Error('Set SEED_PASSWORD for development accounts.');
  await seedCatalog(db);
  const auth = createAuth(db, config);
  const email = 'admin@lunaris.local';
  let [identity] = await db.select().from(user).where(eq(user.email, email));
  if (!identity) {
    await auth.api.signUpEmail({
      body: { email, password: config.SEED_PASSWORD, name: 'Development Admin' },
    });
    [identity] = await db.select().from(user).where(eq(user.email, email));
  }
  if (!identity) throw new Error('Development identity could not be created.');
  await db.update(user).set({ role: 'ADMIN' }).where(eq(user.id, identity.id));
  await db
    .insert(profiles)
    .values({ userId: identity.id, username: 'lunaris_admin', timezone: 'UTC' })
    .onConflictDoNothing();
  return { users: 1, questions: 0 };
}
if (import.meta.url === new URL(process.argv[1] ?? '', 'file://').href) {
  const config = loadConfig(),
    { db, pool } = createDatabase(config.DATABASE_URL);
  try {
    console.log(await seedDevelopment(db, config));
  } finally {
    await pool.end();
  }
}
