import { betterAuth } from 'better-auth';
import { openAPI } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import * as schema from '../../db/schema/auth.js';
export function createAuth(db: Database, config: Config) {
  return betterAuth({
    plugins: [openAPI({disableDefaultReference: true})],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: [config.FRONTEND_ORIGIN],
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    user: {
      additionalFields: {
        role: { type: ['USER', 'ADMIN'], required: true, defaultValue: 'USER', input: false },
      },
    },
    advanced: {
      database: { generateId: () => randomUUID() },
      useSecureCookies: config.NODE_ENV === 'production',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.NODE_ENV === 'production',
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-up/email': { window: 60, max: 5 },
        '/sign-in/email': { window: 60, max: 10 },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  });
}
export type Auth = ReturnType<typeof createAuth>;
