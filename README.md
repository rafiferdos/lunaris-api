# Lunaris API

Standalone Node 24 / TypeScript backend for Lunaris. Hono handles HTTP, Better Auth owns cookie sessions, PostgreSQL persists domain data through stable Drizzle ORM 0.45.x. Zod schemas validate input and public output and generate OpenAPI documentation. The frontend repository is not modified or required at runtime.

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
- Defaults: 5 questions; Easy 600 seconds, Medium 480, Competitive 360. Easy/Medium allow edits and back navigation; Competitive commits answers and prevents moving backward. All modes are ranked by default. Admin changes affect future attempts only.
- Question difficulty is independent of mode. Selection uses the configured difficulty distribution, avoids recently used questions when the bank permits, and falls back to other available difficulties without duplicating a question. Insufficient total content makes a mode unavailable.
- Seed content has 26 catalog topics and 25 demonstration questions across JavaScript, TypeScript, React, Next.js and Communication. Its difficulty labels demonstrate selection; this is not a complete calibrated production question bank. Other topics stay unavailable until populated. Version selection chooses the newest published version for each logical key.
- Engines, formulas and thresholds are documented in [policy reference](docs/policies.md). Normalized scores are 0–100, rating starts at 1000, and XP is the primary leaderboard ordering metric.
- Periods and streaks use UTC. Leaderboards are live keyset pages, not frozen snapshots: if rankings change between page requests, refresh from the first page. Historical rank movement is `null` until ranking snapshots are implemented.
- Browser integrity telemetry is an untrusted signal, not proof of cheating. No microphone recordings, audio uploads or transcripts are stored. Missing microphone permission does not automatically mean misconduct.

## Operations

```sh
pnpm jobs:expire   # finalizes up to 500 expired attempts per invocation
pnpm jobs:rebuild  # rebuilds aggregate metrics from immutable history and ledgers
pnpm db:generate  # review generated SQL before applying migrations
```

Schedule expiry externally every minute; repeat when a batch is full. Reads, writes and new starts also finalize expired attempts lazily. Schedule rebuild only for recovery/reconciliation. No hidden in-process job scheduler is required. Both jobs use database locks and can safely overlap requests. Apply migrations once per release before serving traffic; run a backup and test restore before production schema changes.

```sh
docker build -t lunaris-api:local .
# Supply production environment through your secret manager/runtime:
# docker run --env-file /secure/lunaris.env -p 4000:4000 lunaris-api:local
# Migration command in the image: node dist/db/migrate.js
# Job commands: node dist/jobs/expire.js / node dist/jobs/rebuild.js
```

The image runs as the `node` user and contains compiled code, production dependencies and migrations. CI installs the lockfile, formats, lints, typechecks, runs coverage with PostgreSQL 18 and builds. TypeScript is held at 6.x for the installed ESLint tooling; Drizzle uses stable 0.x, not release candidates.

Production needs reachable PostgreSQL, HTTPS API/frontend origins, a strong Better Auth secret, scheduled expiry, backups and monitoring. Prefer same-site hosts such as `app.example.com` and `api.example.com` for SameSite=Lax cookies. Configure proxies to disable SSE buffering and allow long-lived connections. PostgreSQL LISTEN uses a dedicated session connection: use a direct/session-pooled connection, not a transaction-only pooler. SSE reconnects after database disconnects and sends invalidations, not durable replay; clients refetch after reconnect.

Logs contain request IDs, paths, status, timing and authenticated user ID, never request bodies or credentials. The API enforces explicit credentialed CORS, trusted mutation origins, HttpOnly cookies, production secure cookies, ownership checks, server-only roles, per-user mutation limits, strict import metadata and a 2 MB body limit. Auth has its own database-backed rate limits. Deploy shared ingress connection limits and request limits for additional protection. Email/password auth works locally; email verification/password-reset delivery and social OAuth providers are not configured. Adding those flows requires provider credentials and delivery callbacks.

See [frontend contract](docs/frontend-contract.md) for the remaining frontend wiring. Official integration references: [Hono](https://hono.dev/examples/zod-openapi), [Better Auth Hono](https://better-auth.com/docs/integrations/hono), [Better Auth Drizzle](https://better-auth.com/docs/adapters/drizzle), [Drizzle migrations](https://orm.drizzle.team/docs/migrations).
