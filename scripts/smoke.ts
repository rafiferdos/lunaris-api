import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { loadConfig } from '../src/config/env.js';
import { attemptSchema } from '../src/openapi/schemas.js';
const config = loadConfig();
if (config.NODE_ENV === 'production')
  throw new Error('Smoke creates disposable users; run against development only.');
let cookie = '';
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(new URL(path, config.BETTER_AUTH_URL), {
    method,
    headers: {
      Origin: config.FRONTEND_ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response;
}
await request('/health/ready');
const email = `smoke-${randomUUID()}@example.com`,
  password = `Test-${randomUUID()}!`;
await request('/api/auth/sign-up/email', 'POST', { name: 'Smoke Test', email, password });
const login = await request('/api/auth/sign-in/email', 'POST', { email, password });
cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
await request('/api/v1/me');
await request('/api/v1/assessments');
await request('/api/v1/assessments/javascript');
const a = z.object({ data: attemptSchema }).parse(
  await (
    await request('/api/v1/attempts', 'POST', {
      topicSlug: 'javascript',
      mode: 'MEDIUM',
      requestKey: randomUUID(),
    })
  ).json(),
).data;
for (const q of a.questions)
  await request(`/api/v1/attempts/${a.id}/answers/${q.id}`, 'PUT', {
    selected: [q.options[0]!.id],
    responseTimeMs: 1000,
  });
await request(`/api/v1/attempts/${a.id}/integrity-events`, 'POST', {
  sequence: 1,
  type: 'WINDOW_BLUR',
});
const controller = new AbortController();
const live = await fetch(new URL('/api/v1/leaderboards/stream', config.BETTER_AUTH_URL), {
  headers: { Cookie: cookie },
  signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
});
assert.equal(live.status, 200);
const reader = live.body!.getReader();
const greeting = await reader.read();
assert.match(new TextDecoder().decode(greeting.value), /connected/);
const first = z
  .object({ data: attemptSchema })
  .parse(await (await request(`/api/v1/attempts/${a.id}/submit`, 'POST', {})).json()).data;
const nextEvent = await reader.read();
assert.match(new TextDecoder().decode(nextEvent.value), /leaderboard.updated/);
controller.abort();
const second = z
  .object({ data: attemptSchema })
  .parse(await (await request(`/api/v1/attempts/${a.id}/submit`, 'POST', {})).json()).data;
assert.deepEqual(first.result, second.result);
for (const path of [
  `/api/v1/attempts/${a.id}/result`,
  '/api/v1/history',
  '/api/v1/stats/overview',
  '/api/v1/stats/performance',
  '/api/v1/leaderboards',
  '/openapi.json',
  '/api/auth/open-api/generate-schema',
])
  await request(path);
await request('/api/auth/sign-out', 'POST', {});
const loggedOut = await fetch(new URL('/api/v1/me', config.BETTER_AUTH_URL), {
  headers: { Cookie: cookie },
});
assert.equal(loggedOut.status, 401);
process.stdout.write(
  'HTTP smoke passed: auth, catalog, answers, integrity, submit replay, results, history, stats, leaderboard, SSE, docs, logout.\n',
);
