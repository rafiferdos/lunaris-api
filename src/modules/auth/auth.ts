import {
  passwordRecoveryEnabled,
  sendPasswordReset,
  sendEmailVerification,
} from '../notifications/mail.js';
import { betterAuth } from 'better-auth';
import { openAPI } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Config } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import * as schema from '../../db/schema/auth.js';
export function createAuth(db: Database, config: Config) {
  return betterAuth({
    plugins: [openAPI({ disableDefaultReference: true })],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: [config.FRONTEND_ORIGIN],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      requireEmailVerification: passwordRecoveryEnabled(config),
      ...(passwordRecoveryEnabled(config)
        ? {
            sendResetPassword: async ({
              user,
              token,
            }: {
              user: { email: string };
              token: string;
            }) => sendPasswordReset(config, user.email, token),
          }
        : {}),
    },
    ...(passwordRecoveryEnabled(config)
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: false,
            afterEmailVerification: async (verified) => {
              // Ownership requires proof of inbox access; signup input can never assign a role.
              if (verified.email.toLowerCase() !== config.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase())
                return;
              await db
                .update(schema.user)
                .set({ role: 'ADMIN', updatedAt: new Date() })
                .where(
                  and(
                    eq(schema.user.id, verified.id),
                    eq(schema.user.emailVerified, true),
                    eq(schema.user.role, 'USER'),
                  ),
                );
            },
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => sendEmailVerification(config, user.email, url),
          },
        }
      : {}),
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
        '/get-session': { window: 60, max: 240 },
        '/sign-up/email': { window: 60, max: 5 },
        '/sign-in/email': { window: 60, max: 10 },
        '/request-password-reset': { window: 60, max: 3 },
        '/reset-password': { window: 60, max: 5 },
        '/send-verification-email': { window: 60, max: 3 },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  });
}
export type Auth = ReturnType<typeof createAuth>;
