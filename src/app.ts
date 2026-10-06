import {
  createNotificationService,
  notificationDeliveryEnabled,
} from './modules/notifications/service.js';
import { timingSafeEqual } from 'node:crypto';
import { passwordRecoveryEnabled } from './modules/notifications/mail.js';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { streamSSE } from 'hono/streaming';
import { apiReference } from '@scalar/hono-api-reference';
import { sql } from 'drizzle-orm';
import type { Config } from './config/env.js';
import type { Database } from './db/client.js';
import { createAuth } from './modules/auth/auth.js';
import { createLogger } from './core/logger.js';
import { DomainError, assert } from './core/errors.js';
import { createRouter, empty, type HttpEnv } from './core/http.js';
import { createAttemptService } from './modules/attempts/service.js';
import { createAssessmentService } from './modules/assessments/service.js';
import { createUserService, profilePatch, preferenceSchema } from './modules/users/service.js';
import { createAdminService } from './modules/admin/service.js';
import { createStatsService, historyQuery } from './modules/stats/queries.js';
import {
  createLeaderboardService,
  leaderboardQuery,
  leaderboardRowSchema,
} from './modules/leaderboard/service.js';
import type { LeaderboardEvents } from './modules/leaderboard/events.js';
import { eventSchema } from './modules/integrity/v1.js';
import { modeSchema, questionSchema, importSchema } from './modules/questions/schema.js';
import { policySchema } from './modules/assessments/policy.js';
import * as dto from './openapi/schemas.js';
export function createApp(
  db: Database,
  config: Config,
  events?: LeaderboardEvents,
  clock?: () => Date,
) {
  const app = new OpenAPIHono<HttpEnv>(),
    auth = createAuth(db, config),
    logger = createLogger(config);
  const attempts = createAttemptService(db, clock),
    assessments = createAssessmentService(db, attempts),
    notifications = createNotificationService(db, config, clock),
    users = createUserService(db),
    admin = createAdminService(db),
    stats = createStatsService(db),
    leaderboard = createLeaderboardService(db);
  app.use(
    '*',
    requestId(),
    secureHeaders(),
    cors({
      origin: config.FRONTEND_ORIGIN,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-Request-ID', 'X-Lunaris-User'],
      exposeHeaders: ['X-Request-ID', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
    if (c.res.headers.get('content-type')?.startsWith('text/event-stream')) {
      // Proxies must flush events immediately instead of buffering compressed chunks.
      c.header('Cache-Control', 'no-store, no-cache, no-transform');
      c.header('X-Accel-Buffering', 'no');
    }
  });
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    logger.info(
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path.replace(/(\/api\/auth\/reset-password\/)[^/]+/, '$1[redacted]'),
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
        userId: c.get('userId'),
      },
      'request',
    );
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: () => {
        throw new DomainError(413, 'BODY_TOO_LARGE', 'Maximum request body is 2 MB.');
      },
    }),
  );
  app.onError((error, c) => {
    const validation = error instanceof z.ZodError;
    const domain = error instanceof DomainError;
    const dbCode =
      typeof error === 'object' &&
      'cause' in error &&
      error.cause &&
      typeof error.cause === 'object' &&
      'code' in error.cause
        ? error.cause.code
        : undefined;
    const status = validation ? 422 : domain ? error.status : dbCode === '23505' ? 409 : 500;
    const code = validation
      ? 'VALIDATION_ERROR'
      : domain
        ? error.code
        : status === 409
          ? 'CONFLICT'
          : 'INTERNAL_ERROR';
    if (status === 500)
      logger.error({ requestId: c.get('requestId'), errorName: error.name }, 'Request failed');
    return new Response(
      JSON.stringify({
        type: `urn:lunaris:problem:${code.toLowerCase()}`,
        code,
        title: status === 500 ? 'Internal server error' : code.replaceAll('_', ' '),
        status,
        detail:
          status === 500
            ? 'The request could not be completed.'
            : validation
              ? 'Request validation failed.'
              : domain
                ? error.message
                : 'Resource already exists.',
        requestId: c.get('requestId'),
        ...(validation
          ? {
              errors: error.issues.map((i) => ({
                path: i.path.join('.'),
                code: i.code,
                message: i.message,
              })),
            }
          : domain && error.errors
            ? { errors: error.errors }
            : {}),
      }),
      {
        status,
        headers: { 'content-type': 'application/problem+json', 'x-request-id': c.get('requestId') },
      },
    );
  });
  app.notFound((c) => {
    throw new DomainError(404, 'NOT_FOUND', `No route for ${c.req.method} ${c.req.path}.`);
  });
  app.get('/api/jobs/daily', async (c) => {
    const expected = Buffer.from(`Bearer ${config.CRON_SECRET ?? ''}`);
    const received = Buffer.from(c.req.header('authorization') ?? '');
    assert(
      config.CRON_SECRET &&
        expected.length === received.length &&
        timingSafeEqual(expected, received),
      401,
      'UNAUTHORIZED',
      'A valid job credential is required.',
    );
    const expired = await attempts.expire();
    const delivery = await notifications.run();
    return c.json({ data: { expired, notifications: delivery } });
  });
  app.post('/api/notifications/unsubscribe', async (c) => {
    await notifications.unsubscribe(c.req.query('token') ?? '');
    return c.json({ data: { unsubscribed: true } });
  });
  app.get('/health/live', (c) => c.json({ data: { status: 'alive' } }));
  app.on('GET', ['/health/ready', '/api/health/ready'], async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ data: { status: 'ready' } });
    } catch {
      throw new DomainError(503, 'NOT_READY', 'A required dependency is unavailable.');
    }
  });
  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/api/capabilities',
    summary: 'Public account recovery availability',
    responses: {
      200: {
        description: 'Configured public features',
        content: {
          'application/json': {
            schema: z.object({
              passwordReset: z.boolean(),
              emailVerification: z.boolean(),
              notifications: z.boolean(),
            }),
          },
        },
      },
    },
  });
  app.get('/api/capabilities', (c) =>
    c.json({
      passwordReset: passwordRecoveryEnabled(config),
      emailVerification: passwordRecoveryEnabled(config),
      notifications: notificationDeliveryEnabled(config),
    }),
  );
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    const expectedUser = c.req.header('x-lunaris-user');
    if (expectedUser) {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      assert(
        session?.user.id === expectedUser,
        409,
        'SESSION_CHANGED',
        'Your signed-in account changed. Reload before continuing.',
      );
    }
    return auth.handler(c.req.raw);
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name:
      config.NODE_ENV === 'production'
        ? '__Secure-better-auth.session_token'
        : 'better-auth.session_token',
  });
  const route = createRouter(app, auth, db, config),
    id = z.object({ id: z.uuid() }),
    slug = z.object({ slug: z.string().regex(/^[a-z0-9-]{2,80}$/) }),
    page = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().max(2048).optional(),
    });
  const base = { params: empty, query: empty, body: empty };
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/me',
      summary: 'Current profile',
      response: dto.data(dto.profileSchema),
    },
    async ({ userId }) => ({ data: await users.get(userId) }),
  );
  route(
    {
      ...base,
      method: 'patch',
      path: '/api/v1/me',
      summary: 'Update profile',
      body: profilePatch,
      response: dto.data(dto.profileSchema),
    },
    async ({ userId, body }) => ({ data: await users.update(userId, body) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/me/preferences',
      summary: 'Synced preferences',
      response: dto.data(preferenceSchema),
    },
    async ({ userId }) => ({ data: await users.preferences(userId) }),
  );
  route(
    {
      ...base,
      method: 'patch',
      path: '/api/v1/me/preferences',
      summary: 'Update preferences',
      body: preferenceSchema,
      response: dto.data(preferenceSchema),
    },
    async ({ userId, body }) => ({ data: await users.setPreferences(userId, body) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/assessments',
      summary: 'Assessment catalog and availability',
      response: dto.data(z.array(dto.assessmentSchema)),
    },
    async ({ userId }) => ({ data: await assessments.list(userId) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/assessments/{slug}',
      summary: 'Assessment detail',
      params: slug,
      response: dto.data(dto.assessmentSchema),
    },
    async ({ userId, params }) => ({ data: await assessments.get(userId, params.slug) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/assessments/{slug}/availability',
      summary: 'UTC quota and mode availability',
      params: slug,
      response: dto.data(dto.assessmentSchema.pick({ availability: true, modes: true })),
    },
    async ({ userId, params }) => ({ data: await assessments.get(userId, params.slug) }),
  );
  route(
    {
      ...base,
      method: 'post',
      path: '/api/v1/attempts',
      summary: 'Start and consume quota (idempotent requestKey)',
      body: z.strictObject({ topicSlug: slug.shape.slug, mode: modeSchema, requestKey: z.uuid() }),
      rate: 10,
      response: dto.data(dto.attemptSchema),
    },
    async ({ userId, body }) => ({ data: await attempts.start(userId, body) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/attempts/{id}',
      summary: 'Resume exact stored question order',
      params: id,
      response: dto.data(dto.attemptSchema),
    },
    async ({ userId, params }) => ({ data: await attempts.get(userId, params.id) }),
  );
  route(
    {
      ...base,
      method: 'put',
      path: '/api/v1/attempts/{id}/answers/{questionId}',
      summary: 'Commit an answer',
      params: id.extend({ questionId: z.uuid() }),
      body: z.strictObject({
        selected: z.array(z.string().max(64)).max(8),
        responseTimeMs: z.number().int().min(0).max(7200000).optional(),
      }),
      rate: 120,
      response: dto.data(dto.attemptSchema),
    },
    async ({ userId, params, body }) => ({
      data: await attempts.answer(userId, params.id, params.questionId, body),
    }),
  );
  route(
    {
      ...base,
      method: 'post',
      path: '/api/v1/attempts/{id}/submit',
      summary: 'Finalize once and return stored result',
      params: id,
      body: z.strictObject({}),
      rate: 20,
      response: dto.data(dto.attemptSchema),
    },
    async ({ userId, params }) => ({ data: await attempts.submit(userId, params.id) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/attempts/{id}/result',
      summary: 'Final result and answer review',
      params: id,
      response: dto.data(dto.attemptSchema),
    },
    async ({ userId, params }) => {
      const a = await attempts.get(userId, params.id);
      assert(a.result, 409, 'RESULT_NOT_READY', 'Attempt is still active.');
      return { data: a };
    },
  );
  for (const [path, body] of [
    ['integrity-events', eventSchema],
    ['heartbeat', eventSchema.extend({ type: z.literal('INTEGRITY_HEARTBEAT') })],
  ] as const)
    route(
      {
        ...base,
        method: 'post',
        path: `/api/v1/attempts/{id}/${path}`,
        summary: path,
        params: id,
        body,
        rate: 120,
        response: dto.data(dto.attemptSchema),
      },
      async ({ userId, params, body }) => ({ data: await attempts.event(userId, params.id, body) }),
    );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/history',
      summary: 'Cursor-paginated attempt history',
      query: historyQuery,
      response: dto.list(dto.historyRowSchema),
    },
    async ({ userId, query }) => stats.history(userId, query),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/stats/overview',
      summary: 'Rebuildable current metrics',
      response: dto.data(
        dto.metricsSchema.extend({
          rank: z.number().nullable(),
          percentile: z.number().nullable(),
        }),
      ),
    },
    async ({ userId }) => {
      const [overview, ranking] = await Promise.all([
        stats.overview(userId),
        leaderboard.list(userId, leaderboardQuery.parse({ period: 'all_time', limit: 1 })),
      ]);
      return {
        data: {
          ...overview,
          rank: ranking.meta.currentUser?.rank ?? null,
          percentile: ranking.meta.percentile,
        },
      };
    },
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/stats/topics',
      summary: 'Topic performance, mastery, and rating improvement',
      response: dto.data(
        z.array(
          dto.metricsSchema.extend({
            topic: z.string(),
            name: z.string(),
            category: categorySchemaForStats(),
            mastery: z.number(),
            improvement: z.number(),
          }),
        ),
      ),
    },
    async ({ userId }) => ({ data: await stats.topics(userId) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/stats/performance',
      summary: 'Category/mode performance and latest 180 rating events',
      response: dto.data(
        z.object({
          groups: z.array(
            z.object({
              category: z.string(),
              mode: z.string(),
              count: z.number(),
              performance: z.number(),
              accuracy: z.number().nullable(),
              answerQuality: z.number().nullable(),
            }),
          ),
          ratingHistory: z.array(
            z.object({ at: z.iso.datetime(), rating: z.number(), delta: z.number() }),
          ),
        }),
      ),
    },
    async ({ userId }) => ({ data: await stats.performance(userId) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/stats/activity',
      summary: 'UTC finalized activity in last 365 days',
      response: dto.data(
        dto.metricsSchema.extend({
          days: z.array(z.object({ date: z.string(), count: z.number() })),
        }),
      ),
    },
    async ({ userId }) => ({ data: await stats.activity(userId) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/leaderboards',
      summary: 'XP ranking with current user position',
      query: leaderboardQuery,
      response: z.object({
        data: z.array(leaderboardRowSchema),
        meta: dto.pageMeta.extend({
          total: z.number(),
          currentUser: leaderboardRowSchema.nullable(),
          percentile: z.number().nullable(),
          period: z.string(),
        }),
      }),
    },
    async ({ userId, query }) => leaderboard.list(userId, query),
  );
  const importBody = z.strictObject({
    schemaVersion: z.literal(1),
    questions: z.array(z.unknown()).min(1).max(1000),
  });
  route(
    {
      ...base,
      method: 'post',
      path: '/api/v1/admin/questions/import/validate',
      summary: 'Dry-run detailed question import validation',
      admin: true,
      rate: 10,
      body: importBody,
      response: dto.data(
        z.object({
          valid: z.boolean(),
          created: z.number(),
          alreadyExists: z.number(),
          errors: z.array(
            z.object({
              path: z.string(),
              code: z.string(),
              message: z.string(),
              questionIndex: z.number().nullable(),
              questionKey: z.string().nullable(),
            }),
          ),
        }),
      ),
    },
    async ({ body }) => ({ data: await admin.validate(body) }),
  );
  route(
    {
      ...base,
      method: 'post',
      path: '/api/v1/admin/questions/import',
      summary: 'Atomic versioned question import',
      admin: true,
      rate: 5,
      body: importSchema,
      response: dto.data(
        z.object({ batchId: z.uuid(), created: z.number(), alreadyExists: z.number() }),
      ),
    },
    async ({ userId, body }) => ({ data: await admin.import(userId, body) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/admin/questions',
      summary: 'Admin question versions',
      admin: true,
      query: page,
      response: dto.list(z.object({ id: z.uuid(), question: questionSchema, status: z.string() })),
    },
    async ({ query }) => admin.list(query.limit, query.cursor),
  );
  route(
    {
      ...base,
      method: 'patch',
      path: '/api/v1/admin/questions/{id}/publication',
      summary: 'Publish/archive immutable question versions',
      admin: true,
      params: id,
      body: z.strictObject({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']) }),
      response: dto.data(z.object({ id: z.uuid(), status: z.string() })),
    },
    async ({ userId, params, body }) => ({
      data: await admin.publication(userId, params.id, body.status),
    }),
  );
  route(
    {
      ...base,
      method: 'put',
      path: '/api/v1/admin/assessment-configs/{id}',
      summary: 'Update future attempt policy',
      admin: true,
      params: id,
      body: policySchema,
      response: dto.data(
        z.object({
          id: z.uuid(),
          topicId: z.uuid(),
          mode: modeSchema,
          policy: policySchema,
          updatedAt: z.string(),
        }),
      ),
    },
    async ({ userId, params, body }) => ({ data: await admin.configure(userId, params.id, body) }),
  );
  route(
    {
      ...base,
      method: 'get',
      path: '/api/v1/admin/audit',
      summary: 'Admin audit log',
      admin: true,
      query: page,
      response: dto.list(
        z.object({
          id: z.uuid(),
          adminId: z.uuid().nullable(),
          action: z.string(),
          target: z.string(),
          metadata: z.record(z.string(), z.unknown()),
          createdAt: z.string(),
        }),
      ),
    },
    async ({ query }) => admin.audit(query.limit, query.cursor),
  );
  const streamsPerUser = new Map<string, number>();
  app.get('/api/v1/leaderboards/stream', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    assert(session, 401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const openCount = streamsPerUser.get(session.user.id) ?? 0;
    assert(
      openCount < 5,
      429,
      'STREAM_LIMIT',
      'Close another live leaderboard before opening this one.',
    );
    assert(
      [...streamsPerUser.values()].reduce((sum, count) => sum + count, 0) < 500,
      503,
      'STREAM_CAPACITY',
      'Live updates are busy. Try again shortly.',
    );
    streamsPerUser.set(session.user.id, openCount + 1);
    return streamSSE(c, async (stream) => {
      let stopped = false;
      const unsubscribe = events?.subscribe((scope) => {
        void stream
          .writeSSE({ event: 'leaderboard.updated', data: JSON.stringify(scope) })
          .catch(() => {
            stopped = true;
          });
      });
      const offClose = events?.onClose(() => {
        stopped = true;
        stream.abort();
      });
      stream.onAbort(() => {
        stopped = true;
        unsubscribe?.();
        offClose?.();
      });
      try {
        await stream.writeSSE({ event: 'connected', data: '{}' });
        const startedAt = Date.now();
        while (!stopped && (events || Date.now() - startedAt < 210000)) {
          await stream.sleep(15000);
          if (stopped) break;
          const current = await auth.api.getSession({ headers: c.req.raw.headers });
          if (
            !current ||
            current.user.id !== session.user.id ||
            current.session.id !== session.session.id
          ) {
            await stream.writeSSE({ event: 'session.expired', data: '{}' });
            break;
          }
          if (new Date(current.session.expiresAt) <= new Date()) break;
          await stream.writeSSE({
            event: events ? 'keepalive' : 'leaderboard.updated',
            data: events ? '{}' : '{"refresh":true}',
          });
        }
      } finally {
        const remaining = (streamsPerUser.get(session.user.id) ?? 1) - 1;
        if (remaining > 0) streamsPerUser.set(session.user.id, remaining);
        else streamsPerUser.delete(session.user.id);
        unsubscribe?.();
        offClose?.();
      }
    });
  });
  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/api/v1/leaderboards/stream',
    summary: 'SSE invalidation events; refetch rankings after reconnect',
    security: [{ sessionCookie: [] }],
    responses: {
      200: {
        description: 'connected, leaderboard.updated, keepalive events',
        content: { 'text/event-stream': { schema: z.string() } },
      },
    },
  });
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Lunaris API',
      version: '1.0.0',
      description:
        'Better Auth native endpoints are mounted at /api/auth. Session cookies required for /api/v1.',
    },
    servers: [{ url: config.BETTER_AUTH_URL }],
  });
  app.get('/docs', apiReference({ url: '/openapi.json' }));
  app.get('/docs/auth', apiReference({ url: '/api/auth/open-api/generate-schema' }));
  return { app, auth, attempts, admin, stats, leaderboard, notifications };
}
function categorySchemaForStats() {
  return z.enum(['TECHNICAL', 'INTERPERSONAL']);
}
