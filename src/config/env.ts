import { z } from 'zod';
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.url().startsWith('postgres'),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    FRONTEND_ORIGIN: z.url(),
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.email().optional(),
    EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10000).max(3600000).default(60000),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    TEST_DATABASE_URL: z.url().optional(),
    SEED_PASSWORD: z.string().min(12).optional(),
  })
  .superRefine((v, c) => {
    if (!!v.RESEND_API_KEY !== !!v.EMAIL_FROM)
      c.addIssue({
        code: 'custom',
        message: 'Set both RESEND_API_KEY and EMAIL_FROM to enable password recovery.',
      });
    if (
      v.NODE_ENV === 'production' &&
      (!v.BETTER_AUTH_URL.startsWith('https://') ||
        !v.FRONTEND_ORIGIN.startsWith('https://') ||
        v.BETTER_AUTH_SECRET.startsWith('replace-'))
    )
      c.addIssue({
        code: 'custom',
        message: 'Production requires HTTPS origins and a random auth secret.',
      });
    for (const key of ['FRONTEND_ORIGIN', 'BETTER_AUTH_URL'] as const) {
      const u = new URL(v[key]);
      if (
        !['http:', 'https:'].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== '/'
      )
        c.addIssue({
          code: 'custom',
          path: [key],
          message: 'Use an origin without path, credentials, query, or fragment.',
        });
    }
  })
  .transform((value) => ({
    ...value,
    FRONTEND_ORIGIN: new URL(value.FRONTEND_ORIGIN).origin,
    BETTER_AUTH_URL: new URL(value.BETTER_AUTH_URL).origin,
  }));
export type Config = z.infer<typeof envSchema>;
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(source);
}
