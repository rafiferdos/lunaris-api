# Lunaris API

Standalone Node 24 / TypeScript backend for Lunaris. Hono handles HTTP, Better Auth owns cookie sessions, PostgreSQL persists domain data through stable Drizzle ORM 0.45.x. Zod schemas validate input and public output and generate OpenAPI documentation. The sibling `lunaris` frontend consumes the API; it is not required to run this service.

## Run locally

Requires Node 24, pnpm 12.4.1 and Docker Compose.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Set BETTER_AUTH_SECRET to a random secret and SEED_PASSWORD to a local password.
pnpm docker:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Generate a secret with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. Never commit `.env`. Development PostgreSQL is on localhost:5434; the isolated test database is on localhost:5435. `docker:down` retains development data; do not delete its volume unless intentionally resetting it.

- API: http://localhost:4000
- Domain OpenAPI: `/openapi.json`; Scalar UI: `/docs`
- Better Auth OpenAPI: `/api/auth/open-api/generate-schema`; UI: `/docs/auth`
- Liveness: `/health/live`; database readiness: `/health/ready`

Seed accounts: `admin@lunaris.local` (ADMIN), `sofia@lunaris.local` and `arjun@lunaris.local` (USER), using `SEED_PASSWORD`. Seeding refuses production, preserves existing account passwords, imports content idempotently and creates sample attempts through the real scoring pipeline. Never use seed credentials in production.

## Verify

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke # API must already be running with development data
```

`pnpm test:coverage` produces a local coverage report. Integration tests run against `TEST_DATABASE_URL`, migrate and truncate that database. They refuse a production environment, a database name without `_test`, or the development database URL. Without a test URL, integration tests are explicitly skipped. The HTTP smoke test creates a disposable development account and attempt; it exercises real cookies, SSE, submit replay and logout. Unit tests cover scoring, XP, rating, integrity, schemas, selection and UTC boundaries; real PostgreSQL tests cover authorization, concurrent starts/submits, quotas, expiry, ownership, immutable snapshots, atomic imports and notifications.

## Design

`src/app.ts` composes HTTP routes and their response contracts. Business logic lives in `src/modules/{auth,users,assessments,questions,attempts,scoring,xp,rating,integrity,stats,leaderboard,admin}`. `src/core` owns errors, cursor validation, database rate limits, logging and the authenticated route boundary. `src/config/env.ts` validates configuration at startup. Pure versioned engines are independent of HTTP and persistence. No frontend mocks or browser-calculated results are trusted.

Tables: Better Auth `user`, `session`, `account`, `verification`, `rate_limit`; domain `user_profiles`, `user_preferences`, `topics`, `assessment_configs`, `questions`, `attempts`, `attempt_questions`, `attempt_answers`, `integrity_events`, `xp_ledger`, `rating_events`, `user_metrics`, `user_topic_metrics`, `question_import_batches`, `admin_audit_logs`, `request_limits`.

Question options are stored within versioned JSONB question content, not a separate options table. An attempt stores immutable question and policy snapshots, shuffled option order and positions. JSONB metrics are rebuildable caches; attempts, XP ledger and rating events are historical sources. Database triggers reject edits to question content, attempt snapshots, finalized attempts and ledger events. Publication status can change without altering historical content. Privileged database maintenance remains outside the HTTP permission model.

A per-user transaction advisory lock serializes quota checks, starts and finalization across processes. A partial unique index allows one active attempt per user. A unique user/request-key pair makes start retries stable; unique ledger constraints and terminal-state checks make submission idempotent. Finalization, ledgers, metrics and PostgreSQL notification commit together. Database transactions roll back failed imports and invalid starts.

## Policies and assumptions

- Quotas count starts, globally per user: 1 per UTC day, 7 per UTC Monday-based week. A disconnect or abandonment does not refund a start.
- Defaults: Easy 10 questions / 1200 seconds, Medium 15 / 1800, Competitive 15 / 1500. Easy/Medium allow edits and back navigation; Competitive commits answers and prevents moving backward. All modes are ranked by default. Admin changes affect future attempts only.
- Question difficulty is independent of mode. Selection uses the configured difficulty distribution, avoids recently used questions when the bank permits, and falls back to other available difficulties without duplicating a question. Insufficient total content makes a mode unavailable.
- Questions exist only in the database. The October collection has 780 original source-based questions across 26 topics, with 10 per difficulty per topic; every record includes reference URLs, access date, learning objective and difficulty rationale. Development seeding creates only an optional admin identity and catalog metadata. Tests use isolated synthetic tokens, never a production question bank. Difficulty labels and interpersonal weights remain editorial, not statistically calibrated. Selection uses the newest published version per logical key and exact apportioned difficulty counts; shortage disables the mode instead of silently substituting another level.
- Engines, formulas and thresholds are documented in [policy reference](docs/policies.md). Normalized scores are 0–100, rating starts at 1000, and XP is the primary leaderboard ordering metric.
- Periods and streaks use UTC. Leaderboards are live keyset pages, not frozen snapshots: if rankings change between page requests, refresh from the first page. Historical rank movement is `null` until ranking snapshots are implemented.
- Browser integrity telemetry is an untrusted signal, not proof of cheating. No microphone recordings, audio uploads or transcripts are stored. Missing microphone permission does not automatically mean misconduct.

## Operations

```sh
pnpm jobs:expire   # finalizes up to 500 expired attempts per invocation
pnpm jobs:rebuild  # rebuilds aggregate metrics from immutable history and ledgers
pnpm db:generate  # review generated SQL before applying migrations
```

The server automatically processes up to 500 expired attempts per sweep. Additional expired batches are handled on subsequent sweeps; jobs:expire remains available for manual catch-up. Reads, writes and new starts also finalize expired attempts lazily. Schedule rebuild only for recovery/reconciliation. The server runs a non-overlapping expiry sweep at startup and every EXPIRY_SWEEP_INTERVAL_MS (default 60000). Both jobs use database locks and can safely overlap requests. Apply migrations once per release before serving traffic; run a backup and test restore before production schema changes.

```sh
docker build -t lunaris-api:local .
# Supply production environment through your secret manager/runtime:
# docker run --env-file /secure/lunaris.env -p 4000:4000 lunaris-api:local
# Migration command in the image: node dist/db/migrate.js
# Job commands: node dist/jobs/expire.js / node dist/jobs/rebuild.js
```

The image runs as the `node` user and contains compiled code, production dependencies and migrations. CI installs the lockfile, formats, lints, typechecks, runs coverage with PostgreSQL 18 and builds. TypeScript is held at 6.x for the installed ESLint tooling; Drizzle uses stable 0.x, not release candidates.

Production needs reachable PostgreSQL, HTTPS API/frontend origins, a strong Better Auth secret, backups and monitoring. Prefer same-site hosts such as `app.example.com` and `api.example.com` for SameSite=Lax cookies. Configure proxies to disable SSE buffering and allow long-lived connections. PostgreSQL LISTEN uses a dedicated session connection: use a direct/session-pooled connection, not a transaction-only pooler. SSE reconnects after database disconnects and sends invalidations, not durable replay; clients refetch after reconnect.

Logs contain request IDs, paths, status, timing and authenticated user ID, never request bodies or credentials. The API enforces explicit credentialed CORS, trusted mutation origins, HttpOnly cookies, production secure cookies, ownership checks, server-only roles, identity-bound requests via optional X-Lunaris-User (409 SESSION_CHANGED on mismatch), per-user mutation limits, strict import metadata and a 2 MB body limit. Auth has its own database-backed rate limits. Deploy shared ingress connection limits and request limits for additional protection. Email/password auth works locally. Password reset uses Better Auth one-time tokens, paired RESEND_API_KEY / EMAIL_FROM configuration and a verified Resend sender. Reset revokes existing sessions. GET /api/capabilities exposes whether delivery is configured; real delivery must be tested before public launch. Configured email delivery requires native email verification at signup/login. Explicit notification opt-ins persist separately from legacy preferences; durable jobs send weekly summaries and inactivity reminders. Social OAuth is not implemented.

See [frontend contract](docs/frontend-contract.md) for client transport, resume and live-update requirements. Official integration references: [Hono](https://hono.dev/examples/zod-openapi), [Better Auth Hono](https://better-auth.com/docs/integrations/hono), [Better Auth Drizzle](https://better-auth.com/docs/adapters/drizzle), [Drizzle migrations](https://orm.drizzle.team/docs/migrations).

SSE streams periodically revalidate the session, emit session.expired and close after revocation. Connection bounds are five per user and 500 globally per process; shared ingress limits are still needed. Privacy/display-name changes notify ranking clients. Leaderboard page, viewer position and total use one SQL snapshot. Session reads have a separate rate limit from login/signup. All /api responses are no-store.

## Vercel + Neon deployment

`index.ts` exports the Hono app for Vercel; the persistent Node/Docker server remains supported. `vercel.json` runs migrations under a database advisory lock, imports the immutable production catalog using `db:release`, and compiles the service. Release imports never create demo accounts. Connect Neon secrets to Production only; previews must use a separate database and matching origins.

Use Node 24, `ENABLE_EXPERIMENTAL_COREPACK=1`, a random `BETTER_AUTH_SECRET`, a separate `CRON_SECRET`, and exact HTTPS origins. Both `BETTER_AUTH_URL` and `FRONTEND_ORIGIN` point to the public frontend when its `/api/*` proxy is enabled. The frontend uses `NEXT_PUBLIC_API_URL=same-origin` and `API_UPSTREAM` set to the canonical API origin. Credentials stay in HttpOnly cookies on the frontend host, avoiding cross-site cookie restrictions between two vercel.app projects. Readiness is available at `/api/health/ready` through that proxy.

Email supports either Resend with a verified domain, or SMTP over TLS on port 465. Gmail requires an App Password with SMTP_HOST=smtp.gmail.com, SMTP_USER and EMAIL_FROM matching the sender. Set the password directly in Vercel as a production Secret. `BOOTSTRAP_ADMIN_EMAIL` promotes only that address after native email verification proves inbox ownership; unverified signup never grants administrator access. Real verification/reset delivery must be checked after configuration. Gmail is suitable for a small launch, subject to Google sending limits and abuse protections; use a transactional provider for sustained volume.

Vercel Hobby supports a daily authenticated cron. Active requests additionally schedule bounded expiry and notification work via waitUntil; no background timer is relied upon in a frozen function. Notification workers claim leased PostgreSQL jobs with SKIP LOCKED, recheck verification/consent before sending, deduplicate by user/kind/week, and retain failures for review. Resend retries retain payload/idempotency keys within 23 hours. Ambiguous SMTP failures or reclaimed SMTP leases stop automatic delivery to avoid duplicates. Job bodies/addresses expire after 90 days. Inspect failed jobs and platform logs; do not blindly resend an SMTP job that might already have been accepted.

Serverless connections use the Neon pooled URL and attachDatabasePool, with five connections per instance and short idle timeouts. Leaderboard SSE closes before the function timeout, then reconnects and refreshes on a 15-second signal. The Vercel adapter does not keep a dedicated PostgreSQL LISTEN connection. Free-plan quotas and cold starts limit capacity. Configure provider monitoring, check backup retention and verify a restore before relying on the database for irreplaceable data.

`test:launch` is an explicit live HTTPS release check, guarded by RUN_PRODUCTION_SMOKE=1 and VERCEL_ENV=production. Before enabling real email delivery, deploy with `vercel --prod --build-env RUN_PRODUCTION_SMOKE=1` to verify host-only secure cookies, catalog availability, quiz writes/finalization, result replay, streaming, authorization and logout through the public app proxy. It creates one random private fixture, then deletes only that invocation's account and its cascading data; it never truncates tables or sends fake recipient email. When verification is enabled, use a real verified staging account instead. Normal builds do not run this check.
