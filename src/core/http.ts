import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { Config } from '../config/env.js';
import type { Auth } from '../modules/auth/auth.js';
import type { Database } from '../db/client.js';
import { DomainError, assert } from './errors.js';
import { problemSchema } from '../openapi/schemas.js';
import { enforceRateLimit } from './rate-limit.js';
export type HttpEnv = { Variables: { requestId: string; userId: string } };
const empty = z.object({});
export function createRouter(app: OpenAPIHono<HttpEnv>, auth: Auth, db: Database, config: Config) {
  return function route<
    P extends z.ZodObject,
    Q extends z.ZodObject,
    B extends z.ZodType,
    O extends z.ZodType,
  >(
    options: {
      method: 'get' | 'post' | 'put' | 'patch';
      path: string;
      summary: string;
      params: P;
      query: Q;
      body: B;
      response: O;
      admin?: boolean;
      rate?: number;
    },
    handler: (input: {
      userId: string;
      params: z.infer<P>;
      query: z.infer<Q>;
      body: z.infer<B>;
    }) => Promise<unknown>,
  ) {
    app.openAPIRegistry.registerPath({
      method: options.method,
      path: options.path,
      summary: options.summary,
      security: [{ sessionCookie: [] }],
      request: {
        params: options.params === empty ? undefined : options.params,
        query: options.query === empty ? undefined : options.query,
        ...(options.method !== 'get'
          ? { body: { required: true, content: { 'application/json': { schema: options.body } } } }
          : {}),
      },
      responses: {
        200: {
          description: 'Success',
          content: { 'application/json': { schema: options.response } },
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 409, 413, 415, 422, 429, 500].map((status) => [
            status,
            {
              description: 'Problem Details',
              content: { 'application/problem+json': { schema: problemSchema } },
            },
          ]),
        ),
      },
    });
    app.on(options.method.toUpperCase(), options.path.replace(/\{(\w+)\}/g, ':$1'), async (c) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      assert(session, 401, 'UNAUTHENTICATED', 'Sign in to continue.');
      c.set('userId', session.user.id);
      if (options.admin)
        assert(session.user.role === 'ADMIN', 403, 'FORBIDDEN', 'Administrator access required.');
      if (options.method !== 'get') {
        const origin = c.req.header('origin');
        assert(
          origin === config.FRONTEND_ORIGIN || origin === config.BETTER_AUTH_URL,
          403,
          'UNTRUSTED_ORIGIN',
          'A trusted Origin header is required for mutations.',
        );
      }
      if (options.rate)
        await enforceRateLimit(db, `${session.user.id}:${options.path}`, options.rate);
      let raw: unknown = {};
      if (options.method !== 'get') {
        assert(
          c.req.header('content-type')?.split(';')[0] === 'application/json',
          415,
          'JSON_REQUIRED',
          'Use application/json.',
        );
        try {
          raw = await c.req.json();
        } catch {
          throw new DomainError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
        }
      }
      const params = options.params.parse(c.req.param()),
        query = options.query.parse(c.req.query()),
        body = options.body.parse(raw);
      const response = await handler({ userId: session.user.id, params, query, body });
      // JSON round-trip normalizes Date fields before validating the public boundary.
      const parsed = options.response.safeParse(JSON.parse(JSON.stringify(response)));
      if (!parsed.success)
        throw new DomainError(500, 'RESPONSE_CONTRACT', 'An internal response contract failed.');
      return c.json(parsed.data);
    });
  };
}
export { empty };
