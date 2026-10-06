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
    SMTP_HOST: z
      .string()
      .regex(/^[a-z0-9.-]+$/i)
      .optional(),
    SMTP_USER: z.email().optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
    CRON_SECRET: z.string().min(32).optional(),
    EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10000).max(3600000).default(60000),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    TEST_DATABASE_URL: z.url().optional(),
    SEED_PASSWORD: z.string().min(12).optional(),
  })
  .superRefine((v, c) => {
    const smtp = [v.SMTP_HOST, v.SMTP_USER, v.SMTP_PASSWORD].filter(Boolean).length;
    if ((smtp !== 0 && smtp !== 3) || (v.RESEND_API_KEY && smtp))
      c.addIssue({
        code: 'custom',
        message: 'Configure exactly one provider: Resend or SMTP with host, user, and password.',
      });
    if (v.SMTP_HOST === 'smtp.gmail.com' && v.EMAIL_FROM !== v.SMTP_USER)
      c.addIssue({ code: 'custom', message: 'Gmail sender must match SMTP_USER.' });
    if (!!(v.RESEND_API_KEY || smtp === 3) !== !!v.EMAIL_FROM)
      c.addIssue({
        code: 'custom',
        message: 'Set EMAIL_FROM and a complete Resend or SMTP configuration to enable email.',
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
