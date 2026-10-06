import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDatabase } from '../src/db/client.js';
import { loadConfig } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { seedCatalog, seedDocument } from '../src/db/seed.js';
import { user } from '../src/db/schema/auth.js';
import {
  attempts,
  xpLedger,
  ratingEvents,
  questions,
  configs,
  notificationJobs,
  notificationSubscriptions,
  preferences,
} from '../src/db/schema/domain.js';
import { createAttemptService } from '../src/modules/attempts/service.js';
import { rebuildUser } from '../src/modules/stats/rebuild.js';
import { attemptSchema } from '../src/openapi/schemas.js';
import { createLeaderboardEvents } from '../src/modules/leaderboard/events.js';
import {
  createNotificationService,
  unsubscribeToken,
} from '../src/modules/notifications/service.js';
import { createLogger } from '../src/core/logger.js';
const env = loadConfig();
const testUrl = env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
suite('PostgreSQL API and concurrency regressions', () => {
  if (!testUrl) return;
  const parsed = new URL(testUrl);
  if (
    !parsed.pathname.endsWith('_test') ||
    testUrl === env.DATABASE_URL ||
    env.NODE_ENV === 'production'
  )
    throw new Error(
      'Refusing destructive tests: use a distinct *_test database outside production.',
    );
  const config = {
    ...env,
    DATABASE_URL: testUrl,
    NODE_ENV: 'test' as const,
    LOG_LEVEL: 'silent' as const,
  };
  const { db, pool } = createDatabase(testUrl);
  let now = new Date('2026-09-28T12:00:00Z');
  const events = createLeaderboardEvents(testUrl, createLogger(config));
  const runtime = createApp(db, config, events, () => now);
  let adminCookie = '';
  let adminId = '',
    userId = '',
    cookie = '';
  async function request(path: string, method = 'GET', body?: unknown, session = cookie) {
    return runtime.app.request(path, {
      method,
      headers: {
        origin: config.FRONTEND_ORIGIN,
        ...(session ? { cookie: session } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function register(email: string) {
    const response = await request(
      '/api/auth/sign-up/email',
      'POST',
      { name: 'Integration User', email, password: 'Test-password-2026!' },
      '',
    );
    expect(response.status).toBe(200);
    const data = z.object({ user: z.object({ id: z.uuid() }) }).parse(await response.json());
    return {
      id: data.user.id,
      cookie: response.headers
        .getSetCookie()
        .map((s) => s.split(';')[0])
        .join('; '),
    };
  }
  async function start(mode: 'EASY' | 'MEDIUM' | 'COMPETITIVE' = 'EASY') {
    const response = await request('/api/v1/attempts', 'POST', {
      topicSlug: 'javascript',
      mode,
      requestKey: randomUUID(),
    });
    expect(response.status).toBe(200);
    return z.object({ data: attemptSchema }).parse(await response.json()).data;
  }
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'src/db/migrations' });
    await events.start();
  });
  beforeEach(async () => {
    await db.execute(
      sql`truncate table "user",topics,request_limits,rate_limit,verification restart identity cascade`,
    );
    now = new Date('2026-09-28T12:00:00Z');
    const admin = await register(`admin-${randomUUID()}@example.com`);
    adminId = admin.id;
    adminCookie = admin.cookie;
    await db.update(user).set({ role: 'ADMIN' }).where(eq(user.id, adminId));
    const normal = await register(`member-${randomUUID()}@example.com`);
    userId = normal.id;
    cookie = normal.cookie;
    await seedCatalog(db);
    await runtime.admin.import(adminId, seedDocument);
  });
  afterAll(async () => {
    await events.close();
    await pool.end();
  });
  it('recovers passwords through one-time tokens and revokes existing sessions', async () => {
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
    const mailRuntime = createApp(db, {
      ...config,
      RESEND_API_KEY: 'test-key-never-sent',
      EMAIL_FROM: 'accounts@example.com',
    });
    const sent: { text: string; to: string[] }[] = [];
    const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(url).toBe('https://api.resend.com/emails');
      sent.push(JSON.parse(String(init?.body)) as { text: string; to: string[] });
      return new Response(JSON.stringify({ id: randomUUID() }), { status: 200 });
    });
    try {
      const identity = (await db.select().from(user).where(eq(user.id, userId)))[0]!;
      const authRequest = (path: string, body: unknown) =>
        mailRuntime.app.request(`/api/auth/${path}`, {
          method: 'POST',
          headers: { origin: config.FRONTEND_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect(
        (
          await authRequest('request-password-reset', {
            email: identity.email,
            redirectTo: `${config.FRONTEND_ORIGIN}/reset-password`,
          })
        ).status,
      ).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toEqual([identity.email]);
      const link = sent[0]!.text.match(/https?:\/\/\S+/)![0];
      const token = new URL(link).searchParams.get('token');
      expect(token).toBeTruthy();
      const resetBody = { token, newPassword: 'New-test-password-2026!' };
      expect((await authRequest('reset-password', resetBody)).status).toBe(200);
      expect((await authRequest('reset-password', resetBody)).status).toBe(400);
      expect((await request('/api/v1/me')).status).toBe(401);
      expect(
        (
          await authRequest('sign-in/email', {
            email: identity.email,
            password: resetBody.newPassword,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await authRequest('request-password-reset', {
            email: 'unknown@example.com',
            redirectTo: `${config.FRONTEND_ORIGIN}/reset-password`,
          })
        ).status,
      ).toBe(200);
      expect(sent).toHaveLength(1);
    } finally {
      send.mockRestore();
    }
  });
  it('requires email verification with configured delivery and accepts the native verification link', async () => {
    const email = `verification-${randomUUID()}@example.com`;
    const configured = createApp(db, {
      ...config,
      RESEND_API_KEY: 'test-only',
      EMAIL_FROM: 'accounts@example.com',
      BOOTSTRAP_ADMIN_EMAIL: email,
    });
    const sent: { text: string; to: string[] }[] = [];
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)) as { text: string; to: string[] });
      return new Response('{}', { status: 200 });
    });
    const call = (path: string, body: unknown) =>
      configured.app.request(`/api/auth/${path}`, {
        method: 'POST',
        headers: { origin: config.FRONTEND_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      expect(
        (
          await call('sign-up/email', {
            name: 'Verified User',
            email,
            password: 'Test-password-2026!',
          })
        ).status,
      ).toBe(200);
      expect(sent).toHaveLength(1);
      expect((await db.select().from(user).where(eq(user.email, email)))[0]?.role).toBe('USER');
      const signupLink = new URL(sent[0]!.text.match(/https?:\/\/\S+/)![0]);
      expect(signupLink.origin).toBe(config.FRONTEND_ORIGIN);
      expect((await call('sign-in/email', { email, password: 'Test-password-2026!' })).status).toBe(
        403,
      );
      expect((await db.select().from(user).where(eq(user.email, email)))[0]?.role).toBe('USER');
      const verified = await configured.app.request(signupLink.pathname + signupLink.search);
      expect(verified.status).toBe(302);
      expect(verified.headers.get('location')).toBe(
        `${config.FRONTEND_ORIGIN}/login?verified=success`,
      );
      expect((await call('sign-in/email', { email, password: 'Test-password-2026!' })).status).toBe(
        200,
      );
      expect((await db.select().from(user).where(eq(user.email, email)))[0]).toMatchObject({
        emailVerified: true,
        role: 'ADMIN',
      });
      expect((await db.select().from(user).where(eq(user.id, userId)))[0]?.role).toBe('USER');
    } finally {
      transport.mockRestore();
    }
  });
  it('does not treat legacy notification flags as consent and persists explicit opt-ins', async () => {
    await db.insert(preferences).values({ userId, settings: { email: true, reminders: true } });
    expect((await (await request('/api/v1/me/preferences')).json()).data).toMatchObject({
      email: false,
      reminders: false,
    });
    expect(
      (await (await request('/api/v1/me/preferences', 'PATCH', { email: true })).json()).data,
    ).toMatchObject({ email: true, reminders: false });
    expect(
      (
        await db
          .select()
          .from(notificationSubscriptions)
          .where(eq(notificationSubscriptions.userId, userId))
      )[0]?.summariesAt,
    ).toBeInstanceOf(Date);
  });
  it('deduplicates concurrent notification workers, retries identical payloads, and honors unsubscribe', async () => {
    const at = new Date(now.getTime() - 10 * 86400000);
    await db.update(user).set({ emailVerified: true, createdAt: at }).where(eq(user.id, userId));
    await db.insert(notificationSubscriptions).values({ userId, summariesAt: at, remindersAt: at });
    const mailConfig = {
      ...config,
      RESEND_API_KEY: 'test-only',
      EMAIL_FROM: 'accounts@example.com',
      CRON_SECRET: 'test-only-job-key-that-is-long-enough',
    };
    const mails: { key: string; text: string }[] = [];
    let rejects = true;
    const worker = createNotificationService(
      db,
      mailConfig,
      () => now,
      async (mail) => {
        mails.push(mail);
        if (rejects) throw new Error('Provider outage');
      },
    );
    await Promise.all([worker.run(), worker.run()]);
    expect(mails).toHaveLength(2);
    expect(new Set(mails.map((m) => m.key)).size).toBe(2);
    rejects = false;
    now = new Date(now.getTime() + 5 * 60000);
    await worker.unsubscribe(unsubscribeToken(mailConfig, userId, 'reminder', now));
    await worker.run();
    expect(mails).toHaveLength(3);
    expect(mails[2]!.key).toBe(mails.find((m) => m.text.includes('Your Lunaris week'))!.key);
    const jobs = await db
      .select()
      .from(notificationJobs)
      .where(eq(notificationJobs.userId, userId));
    expect(jobs.map((j) => j.status).sort()).toEqual(['cancelled', 'sent']);
    expect((await request('/api/notifications/unsubscribe?token=forged', 'POST')).status).toBe(400);
  });
  it('does not send notification jobs to unverified addresses and rejects unauthenticated job runs', async () => {
    const at = new Date(now.getTime() - 10 * 86400000);
    await db.insert(notificationSubscriptions).values({ userId, summariesAt: at, remindersAt: at });
    const deliver = vi.fn();
    const worker = createNotificationService(
      db,
      {
        ...config,
        RESEND_API_KEY: 'test-only',
        EMAIL_FROM: 'accounts@example.com',
        CRON_SECRET: 'test-only-job-key-that-is-long-enough',
      },
      () => now,
      deliver,
    );
    await worker.run();
    expect(deliver).not.toHaveBeenCalled();
    expect((await request('/api/jobs/daily')).status).toBe(401);
  });
  it('rejects a stale account identity before reading or mutating another account', async () => {
    for (const method of ['GET', 'PATCH']) {
      const response = await runtime.app.request('/api/v1/me', {
        method,
        headers: {
          cookie,
          origin: config.FRONTEND_ORIGIN,
          'content-type': 'application/json',
          'x-lunaris-user': adminId,
        },
        ...(method === 'PATCH'
          ? { body: JSON.stringify({ displayName: 'Should not change' }) }
          : {}),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'SESSION_CHANGED' });
    }
    const logout = await runtime.app.request('/api/auth/sign-out', {
      method: 'POST',
      headers: {
        cookie,
        origin: config.FRONTEND_ORIGIN,
        'content-type': 'application/json',
        'x-lunaris-user': adminId,
      },
      body: '{}',
    });
    expect(logout.status).toBe(409);
    expect(await (await request('/api/v1/me')).json()).toMatchObject({
      data: { displayName: 'Integration User' },
    });
    expect((await request('/api/v1/me')).headers.get('cache-control')).toBe('no-store');
  });
  it('broadcasts privacy/name changes and allows clearing a username', async () => {
    async function changed(path: string, body: unknown) {
      const received = new Promise<unknown>((resolve) => {
        const off = events.subscribe((value) => {
          off();
          resolve(value);
        });
      });
      expect((await request(path, 'PATCH', body)).status).toBe(200);
      await expect(received).resolves.toEqual({ refresh: true });
    }
    await changed('/api/v1/me', { username: 'audit_username' });
    await changed('/api/v1/me', { username: null });
    expect(await (await request('/api/v1/me')).json()).toMatchObject({ data: { username: null } });
    await changed('/api/v1/me/preferences', { publicProfile: false });
  });
  it('closes an existing SSE stream after its session is revoked', async () => {
    const response = await request('/api/v1/leaderboards/stream');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
    expect((await request('/api/auth/sign-out', 'POST', {})).status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('session.expired');
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();
  });
  it('protects auth/admin, rejects invalid payloads and origins, serves docs/readiness', async () => {
    expect((await request('/api/v1/me', 'GET', undefined, '')).status).toBe(401);
    expect((await request('/api/v1/admin/questions')).status).toBe(403);
    expect((await request('/api/v1/attempts', 'POST', { mode: 'bogus' })).status).toBe(422);
    expect(
      (
        await runtime.app.request('/api/v1/attempts', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect((await request('/health/ready')).status).toBe(200);
    expect((await request('/openapi.json')).status).toBe(200);
  });
  it('serves admin contracts, publication/config updates and profile preferences', async () => {
    expect(
      (await request('/api/v1/admin/questions?limit=2', 'GET', undefined, adminCookie)).status,
    ).toBe(200);
    expect(
      (await request('/api/v1/admin/questions/import/validate', 'POST', seedDocument, adminCookie))
        .status,
    ).toBe(200);
    expect(
      (await request('/api/v1/admin/questions/import', 'POST', seedDocument, adminCookie)).status,
    ).toBe(200);
    const [q] = await db.select().from(questions).limit(1);
    expect(
      (
        await request(
          `/api/v1/admin/questions/${q!.id}/publication`,
          'PATCH',
          { status: 'ARCHIVED' },
          adminCookie,
        )
      ).status,
    ).toBe(200);
    const [config] = await db.select().from(configs).limit(1);
    expect(
      (
        await request(
          `/api/v1/admin/assessment-configs/${config!.id}`,
          'PUT',
          { ...config!.policy, durationSeconds: 900 },
          adminCookie,
        )
      ).status,
    ).toBe(200);
    expect((await request('/api/v1/admin/audit', 'GET', undefined, adminCookie)).status).toBe(200);
    expect((await request('/api/v1/me', 'PATCH', { displayName: 'Updated User' })).status).toBe(
      200,
    );
    expect(
      (await request('/api/v1/me/preferences', 'PATCH', { publicProfile: false, mode: 'dark' }))
        .status,
    ).toBe(200);
    expect((await request('/api/v1/me', 'PATCH', { role: 'ADMIN' })).status).toBe(422);
  });
  it('paginates history and XP rankings without duplicates and binds ranking cursors to filters', async () => {
    const service = createAttemptService(db, () => now, { daily: 5, weekly: 10 });
    for (let i = 0; i < 3; i++) {
      const a = await service.start(userId, {
        topicSlug: 'javascript',
        mode: 'EASY',
        requestKey: randomUUID(),
      });
      await service.submit(userId, a.id);
    }
    const pageSchema = z.object({
      data: z.array(z.object({ id: z.uuid() })),
      meta: z.object({ nextCursor: z.string().nullable() }),
    });
    const first = pageSchema.parse(await (await request('/api/v1/history?limit=2')).json());
    expect(first.data).toHaveLength(2);
    const second = pageSchema.parse(
      await (
        await request(
          `/api/v1/history?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor!)}`,
        )
      ).json(),
    );
    expect(second.data).toHaveLength(1);
    expect(new Set([...first.data, ...second.data].map((r) => r.id)).size).toBe(3);
    const other = await service.start(adminId, {
      topicSlug: 'javascript',
      mode: 'EASY',
      requestKey: randomUUID(),
    });
    await service.submit(adminId, other.id);
    const rankings = pageSchema.parse(
      await (await request('/api/v1/leaderboards?period=all_time&limit=1')).json(),
    );
    expect(rankings.meta.nextCursor).not.toBeNull();
    const next = pageSchema.parse(
      await (
        await request(
          `/api/v1/leaderboards?period=all_time&limit=1&cursor=${encodeURIComponent(rankings.meta.nextCursor!)}`,
        )
      ).json(),
    );
    expect(next.data[0]!.id).not.toBe(rankings.data[0]!.id);
    expect(
      (
        await request(
          `/api/v1/leaderboards?period=weekly&cursor=${encodeURIComponent(rankings.meta.nextCursor!)}`,
        )
      ).status,
    ).toBe(400);
  });
  it('rejects database history edits and conflicting integrity sequence reuse', async () => {
    const a = await start();
    await runtime.attempts.event(userId, a.id, { sequence: 1, type: 'WINDOW_BLUR' });
    await expect(
      runtime.attempts.event(userId, a.id, { sequence: 1, type: 'TAB_HIDDEN' }),
    ).rejects.toMatchObject({ code: 'EVENT_SEQUENCE_CONFLICT' });
    await runtime.attempts.submit(userId, a.id);
    await expect(
      db.update(attempts).set({ status: 'IN_PROGRESS' }).where(eq(attempts.id, a.id)),
    ).rejects.toThrow();
    await expect(
      db.update(xpLedger).set({ amount: 999 }).where(eq(xpLedger.attemptId, a.id)),
    ).rejects.toThrow();
    const [q] = await db.select().from(questions).limit(1);
    await expect(
      db.update(questions).set({ contentHash: 'changed' }).where(eq(questions.id, q!.id)),
    ).rejects.toThrow();
  });
  it('completes an authenticated API flow, resumes sanitized questions, and finalizes once', async () => {
    const catalog = await request('/api/v1/assessments');
    expect(catalog.status).toBe(200);
    const a = await start('MEDIUM');
    for (const key of ['isCorrect', 'quality', 'points', 'weight', 'explanation'])
      expect(JSON.stringify(a.questions)).not.toContain(`"${key}"`);
    const resumed = z
      .object({ data: attemptSchema })
      .parse(await (await request(`/api/v1/attempts/${a.id}`)).json()).data;
    expect(resumed.questions).toEqual(a.questions);
    const q = a.questions[0]!;
    expect(
      (
        await request(`/api/v1/attempts/${a.id}/answers/${q.id}`, 'PUT', {
          selected: [q.options[0]!.id],
        })
      ).status,
    ).toBe(200);
    const submissions = await Promise.all([
      request(`/api/v1/attempts/${a.id}/submit`, 'POST', {}),
      request(`/api/v1/attempts/${a.id}/submit`, 'POST', {}),
    ]);
    const bodies = await Promise.all(submissions.map((r) => r.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(await db.select().from(xpLedger).where(eq(xpLedger.attemptId, a.id))).toHaveLength(1);
    expect(
      await db.select().from(ratingEvents).where(eq(ratingEvents.attemptId, a.id)),
    ).toHaveLength(2);
    for (const route of [
      `/api/v1/attempts/${a.id}/result`,
      '/api/v1/history',
      '/api/v1/stats/overview',
      '/api/v1/stats/topics',
      '/api/v1/stats/performance',
      '/api/v1/stats/activity',
      '/api/v1/leaderboards',
    ])
      expect((await request(route)).status, route).toBe(200);
    const before = await runtime.stats.overview(userId);
    await rebuildUser(db, userId);
    expect(await runtime.stats.overview(userId)).toEqual(before);
    expect(
      (
        await request('/api/v1/attempts', 'POST', {
          topicSlug: 'react',
          mode: 'EASY',
          requestKey: randomUUID(),
        })
      ).status,
    ).toBe(429);
  });
  it('serializes concurrent starts and binds idempotency keys', async () => {
    const input = { topicSlug: 'javascript', mode: 'EASY' as const, requestKey: randomUUID() };
    const results = await Promise.all([
      runtime.attempts.start(userId, input),
      runtime.attempts.start(userId, input),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(await db.select().from(attempts)).toHaveLength(1);
    await expect(
      runtime.attempts.start(userId, { ...input, topicSlug: 'react' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('allows only one of two different concurrent starts', async () => {
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        runtime.attempts.start(userId, {
          topicSlug: 'javascript',
          mode: 'EASY',
          requestKey: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('enforces independent weekly quotas when daily limit is higher', async () => {
    const service = createAttemptService(db, () => now, { daily: 3, weekly: 2 });
    for (let i = 0; i < 2; i++) {
      const a = await service.start(userId, {
        topicSlug: 'javascript',
        mode: 'EASY',
        requestKey: randomUUID(),
      });
      await service.submit(userId, a.id);
    }
    await expect(
      service.start(userId, { topicSlug: 'javascript', mode: 'EASY', requestKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
  it('locks Competitive answers, auto-submits on tab hidden, preserves review without ranked rewards', async () => {
    const a = await start('COMPETITIVE'),
      q = a.questions[0]!;
    await runtime.attempts.answer(userId, a.id, q.id, { selected: [q.options[0]!.id] });
    await expect(
      runtime.attempts.answer(userId, a.id, q.id, { selected: [q.options[1]!.id] }),
    ).rejects.toMatchObject({ code: 'ANSWER_LOCKED' });
    const result = await runtime.attempts.event(userId, a.id, { sequence: 1, type: 'TAB_HIDDEN' });
    expect(result.status).toBe('AUTO_SUBMITTED');
    expect(result.result).toMatchObject({ xp: 0, ratingChange: 0, rankEligible: false });
    expect(result.result!.reviews[0]!.selected).toEqual([q.options[0]!.id]);
    expect((await runtime.attempts.submit(userId, a.id)).result).toEqual(result.result);
  });
  it('exposes committed skips and the next integrity sequence when resuming', async () => {
    const a = await start('COMPETITIVE');
    expect(a.nextIntegritySequence).toBe(0);
    expect(a.questions[0]!.answered).toBe(false);
    await runtime.attempts.answer(userId, a.id, a.questions[0]!.id, { selected: [] });
    await runtime.attempts.event(userId, a.id, { sequence: 4, type: 'INTEGRITY_HEARTBEAT' });
    const resumed = await runtime.attempts.get(userId, a.id);
    expect(resumed.questions[0]).toMatchObject({ answered: true, selected: [] });
    expect(resumed.questions[1]!.answered).toBe(false);
    expect(resumed.nextIntegritySequence).toBe(5);
  });
  it('rejects answers after expiry and finalizes abandoned attempts idempotently', async () => {
    const a = await start();
    now = new Date(+now + 700000);
    await expect(
      runtime.attempts.answer(userId, a.id, a.questions[0]!.id, { selected: [] }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_FINALIZED' });
    expect((await runtime.attempts.get(userId, a.id)).status).toBe('EXPIRED');
    expect(await runtime.attempts.expire()).toEqual({ processed: 0 });
  });
  it('enforces ownership and prevents client-forged scores', async () => {
    const a = await start();
    await expect(runtime.attempts.get(adminId, a.id)).rejects.toMatchObject({
      code: 'ATTEMPT_NOT_FOUND',
    });
    expect((await request(`/api/v1/attempts/${a.id}/submit`, 'POST', { xp: 99999 })).status).toBe(
      422,
    );
  });
  it('validates atomic imports, duplicate content, versions and unknown topics', async () => {
    const duplicate = await runtime.admin.import(adminId, seedDocument);
    expect(duplicate).toMatchObject({ created: 0, alreadyExists: 25 });
    const newDoc = structuredClone(seedDocument);
    newDoc.questions = newDoc.questions.slice(0, 2).map((q) => ({ ...q, version: 2 }));
    newDoc.questions[1]!.topicSlug = 'unknown-topic';
    expect((await runtime.admin.validate(newDoc)).valid).toBe(false);
    await expect(runtime.admin.import(adminId, newDoc)).rejects.toMatchObject({
      code: 'INVALID_IMPORT',
    });
    expect(await db.select().from(questions).where(eq(questions.version, 2))).toHaveLength(0);
    const invalid = structuredClone(seedDocument);
    Object.assign(invalid.questions[0]!.options[0]!, { quality: 'BEST' });
    expect((await runtime.admin.validate(invalid)).valid).toBe(false);
    newDoc.questions[1]!.topicSlug = 'javascript';
    expect((await runtime.admin.validate(newDoc)).created).toBe(2);
    expect((await runtime.admin.import(adminId, newDoc)).created).toBe(2);
  });
  it('preserves attempt snapshots when a later version is published', async () => {
    const a = await start();
    const doc = structuredClone(seedDocument);
    doc.questions = doc.questions
      .filter((q) => q.topicSlug === 'javascript')
      .map((q) => ({ ...q, version: 2, prompt: `Updated: ${q.prompt}` }));
    await runtime.admin.import(adminId, doc);
    expect((await runtime.attempts.get(userId, a.id)).questions).toEqual(a.questions);
  });
  it('uses the configured question count and rejects unavailable modes without consuming quota', async () => {
    await db.update(configs).set({
      policy: {
        questionCount: 100,
        durationSeconds: 600,
        distribution: { FOUNDATIONAL: 1, INTERMEDIATE: 0, ADVANCED: 0 },
        editable: true,
        backNavigation: true,
        ranked: true,
        enabled: true,
        scoringVersion: 'scoring/v1',
        xpVersion: 'xp/v1',
        ratingVersion: 'rating/v1',
        integrityVersion: 'integrity/v1',
      },
    });
    await expect(
      runtime.attempts.start(userId, {
        topicSlug: 'javascript',
        mode: 'EASY',
        requestKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_QUESTIONS' });
    expect(await db.select().from(attempts)).toHaveLength(0);
  });
  it('delivers PostgreSQL cross-connection leaderboard invalidation after commit', async () => {
    const received = new Promise<unknown>((resolve) => {
      const unsubscribe = events.subscribe((value) => {
        unsubscribe();
        resolve(value);
      });
    });
    const a = await start();
    await runtime.attempts.submit(userId, a.id);
    await expect(received).resolves.toMatchObject({ mode: 'EASY', category: 'TECHNICAL' });
  });
});
