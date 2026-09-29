import { z } from '@hono/zod-openapi';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { profiles, preferences, topics } from '../../db/schema/domain.js';
import { user } from '../../db/schema/auth.js';
import { assert } from '../../core/errors.js';
export const profilePatch = z.strictObject({
  displayName: z.string().trim().min(2).max(80).optional(),
  username: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,23}$/)
    .nullable()
    .optional(),
  avatarUrl: z.url().startsWith('https://').nullable().optional(),
  bio: z.string().max(500).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  timezone: z
    .string()
    .max(80)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown timezone')
    .optional(),
  preferredTopics: z
    .array(z.string().regex(/^[a-z0-9-]{2,80}$/))
    .max(30)
    .optional(),
});
export const preferenceSchema = z.strictObject({
  mode: z.enum(['light', 'dark', 'system']).optional(),
  palette: z.enum(['taupe', 'neutral', 'stone', 'zinc', 'blue', 'green', 'rose']).optional(),
  radius: z.enum(['sharp', 'compact', 'default', 'soft', 'rounded']).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  reducedMotion: z.boolean().optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'COMPETITIVE']).optional(),
  timer: z.boolean().optional(),
  email: z.boolean().optional(),
  reminders: z.boolean().optional(),
  publicProfile: z.boolean().optional(),
});
export function createUserService(db: Database) {
  return {
    async get(id: string) {
      const [identity] = await db
        .select({
          id: user.id,
          displayName: user.name,
          email: user.email,
          avatarUrl: user.image,
          role: user.role,
          joinedAt: user.createdAt,
        })
        .from(user)
        .where(eq(user.id, id));
      assert(identity, 404, 'USER_NOT_FOUND', 'User not found.');
      const [profile] = await db.select().from(profiles).where(eq(profiles.userId, id));
      return {
        ...identity,
        joinedAt: identity.joinedAt.toISOString(),
        username: profile?.username ?? null,
        bio: profile?.bio ?? '',
        country: profile?.country ?? null,
        timezone: profile?.timezone ?? 'UTC',
        preferredTopics: profile?.preferredTopics ?? [],
      };
    },
    async update(id: string, input: z.infer<typeof profilePatch>) {
      await db.transaction(async (tx) => {
        if (input.preferredTopics?.length) {
          const found = await tx
            .select()
            .from(topics)
            .where(inArray(topics.slug, input.preferredTopics));
          assert(
            found.length === new Set(input.preferredTopics).size,
            422,
            'UNKNOWN_TOPIC',
            'Preferred topic does not exist.',
          );
        }
        const { displayName, avatarUrl, ...profile } = input;
        if (displayName !== undefined || avatarUrl !== undefined)
          await tx
            .update(user)
            .set({
              ...(displayName !== undefined ? { name: displayName } : {}),
              ...(avatarUrl !== undefined ? { image: avatarUrl } : {}),
              updatedAt: new Date(),
            })
            .where(eq(user.id, id));
        if (Object.keys(profile).length)
          await tx
            .insert(profiles)
            .values({ userId: id, ...profile })
            .onConflictDoUpdate({ target: profiles.userId, set: profile });
        if (input.displayName !== undefined || input.username !== undefined)
          await tx.execute(
            sql`select pg_notify('lunaris_leaderboard', ${JSON.stringify({ refresh: true })})`,
          );
      });
      return this.get(id);
    },
    async preferences(id: string) {
      const [row] = await db.select().from(preferences).where(eq(preferences.userId, id));
      return preferenceSchema.parse(row?.settings ?? {});
    },
    async setPreferences(id: string, input: z.infer<typeof preferenceSchema>) {
      return db.transaction(async (tx) => {
        await tx.execute(
          (await import('drizzle-orm'))
            .sql`select pg_advisory_xact_lock(hashtextextended(${`preferences:${id}`},0))`,
        );
        const [row] = await tx.select().from(preferences).where(eq(preferences.userId, id));
        const settings = { ...row?.settings, ...input };
        await tx
          .insert(preferences)
          .values({ userId: id, settings })
          .onConflictDoUpdate({ target: preferences.userId, set: { settings } });
        if (
          input.publicProfile !== undefined &&
          input.publicProfile !== row?.settings.publicProfile
        )
          await tx.execute(
            sql`select pg_notify('lunaris_leaderboard', ${JSON.stringify({ refresh: true })})`,
          );
        return preferenceSchema.parse(settings);
      });
    },
  };
}
