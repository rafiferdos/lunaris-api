// Explicit release check. Only its newly created private fixture is removed.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadConfig } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { user } from '../src/db/schema/auth.js';
import { attemptSchema } from '../src/openapi/schemas.js';
if (process.env.RUN_PRODUCTION_SMOKE !== '1' || process.env.VERCEL_ENV !== 'production')
  throw new Error('Launch smoke requires an explicit production-build opt-in.');
const config = loadConfig();
assert.equal(config.NODE_ENV, 'production');
assert.ok(config.FRONTEND_ORIGIN.startsWith('https://'));
const { db, pool } = createDatabase(config.DATABASE_URL);
const email = `release-check-${randomUUID()}@example.invalid`;
const password = `Release-${randomUUID()}!`;
let cookie = '',
  id = '';
async function request(path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch(new URL(path, config.FRONTEND_ORIGIN), {
    method,
    headers: {
      Origin: config.FRONTEND_ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(id ? { 'X-Lunaris-User': id } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, expected, `${method} ${path}: unexpected status`);
  return response;
}
try {
  await request('/api/health/ready');
  const capabilities = z
    .object({ emailVerification: z.boolean() })
    .parse(await (await request('/api/capabilities')).json());
  // Never send fake recipient emails or weaken verification for the check.
  assert.equal(
    capabilities.emailVerification,
    false,
    'Use a real verified staging account when email is enabled.',
  );
  const signup = await request('/api/auth/sign-up/email', 'POST', {
    name: 'Private release check',
    email,
    password,
  });
  id = z.object({ user: z.object({ id: z.uuid() }) }).parse(await signup.json()).user.id;
  const cookies = signup.headers.getSetCookie();
  assert.ok(
    cookies.some(
      (value) =>
        /;\s*Secure/i.test(value) && /;\s*HttpOnly/i.test(value) && /SameSite=Lax/i.test(value),
    ),
  );
  assert.ok(cookies.every((value) => !/;\s*Domain=/i.test(value)));
  cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  await request('/api/v1/me/preferences', 'PATCH', { publicProfile: false });
  await request('/api/auth/get-session');
  const catalog = z
    .object({ data: z.array(z.object({ modes: z.array(z.object({ available: z.boolean() })) })) })
    .parse(await (await request('/api/v1/assessments')).json());
  assert.equal(catalog.data.length, 26);
  assert.ok(
    catalog.data.every(
      (topic) => topic.modes.length === 3 && topic.modes.every((mode) => mode.available),
    ),
  );
  const attempt = z.object({ data: attemptSchema }).parse(
    await (
      await request('/api/v1/attempts', 'POST', {
        topicSlug: 'javascript',
        mode: 'MEDIUM',
        requestKey: randomUUID(),
      })
    ).json(),
  ).data;
  assert.equal(attempt.questions.length, 5);
  assert.ok(!JSON.stringify(attempt.questions).includes('isCorrect'));
  for (const question of attempt.questions)
    await request(`/api/v1/attempts/${attempt.id}/answers/${question.id}`, 'PUT', {
      selected: [question.options[0]!.id],
      responseTimeMs: 1000,
    });
  const controller = new AbortController();
  const stream = await fetch(new URL('/api/v1/leaderboards/stream', config.FRONTEND_ORIGIN), {
    headers: { Cookie: cookie },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
  });
  assert.equal(stream.status, 200);
  assert.ok(stream.headers.get('cache-control')?.includes('no-transform'));
  const greeting = await stream.body!.getReader().read();
  assert.match(new TextDecoder().decode(greeting.value), /event: connected/);
  controller.abort();
  const first = z
    .object({ data: attemptSchema })
    .parse(await (await request(`/api/v1/attempts/${attempt.id}/submit`, 'POST', {})).json()).data;
  const repeated = z
    .object({ data: attemptSchema })
    .parse(await (await request(`/api/v1/attempts/${attempt.id}/submit`, 'POST', {})).json()).data;
  assert.equal(first.status, 'SUBMITTED');
  assert.deepEqual(first.result, repeated.result);
  for (const path of [
    '/api/v1/history',
    '/api/v1/stats/overview',
    '/api/v1/leaderboards',
    `/api/v1/attempts/${attempt.id}/result`,
  ])
    await request(path);
  await request('/api/v1/admin/questions', 'GET', undefined, 403);
  await request('/api/auth/sign-out', 'POST', {});
  await request('/api/v1/me', 'GET', undefined, 401);
  console.log(
    'Live HTTPS smoke passed: secure host-only cookies, 26 topics/78 modes, answers, submit replay, results/history/stats, SSE, admin isolation and logout.',
  );
} finally {
  // The random address belongs only to this invocation; never truncate any table.
  await db.delete(user).where(eq(user.email, email));
  assert.equal(
    (await db.select({ id: user.id }).from(user).where(eq(user.email, email))).length,
    0,
  );
  await pool.end();
  console.log('Private release fixture removed.');
}
