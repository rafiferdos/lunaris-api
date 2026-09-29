# Frontend integration contract

The sibling `lunaris` frontend now uses these authenticated APIs through generated OpenAPI types and a credentialed TanStack Query client. See its README for local setup and browser verification. The live schemas at `/openapi.json` and `/api/auth/open-api/generate-schema` are authoritative for exact field names, enums, defaults and response bodies.

## Transport and sessions

Set a public API base URL (local `http://localhost:4000`). Every fetch uses `credentials: 'include'`. Mutations send `Content-Type: application/json` and a JSON body, including `{}` for submit/logout. Browsers send Origin automatically; scripts must use the configured frontend origin. Never persist the session token in localStorage. Configure the API's `FRONTEND_ORIGIN` to the frontend's exact origin.

Auth endpoints use Better Auth's native response/error format: POST `/api/auth/sign-up/email` with `{name,email,password}`, POST `/api/auth/sign-in/email` with `{email,password}`, POST `/api/auth/sign-out` with `{}`, GET `/api/auth/get-session`. Signup cannot assign ADMIN. Passwords must be 12–128 characters. Domain endpoints use `{data: ...}` or `{data: [...], meta: {nextCursor: ...}}` as defined in OpenAPI. Errors use `application/problem+json` with `type`, `title`, `status`, `code`, `detail`, `requestId` and optional field errors. Handle 401 as sign-in, 409 as a state conflict, 422 as validation, 429 as throttling. Do not retry arbitrary mutations under a new request key.

## Screen mapping

| UI                         | Endpoints under `/api/v1`                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Profile/settings           | GET/PATCH `/me`, GET/PATCH `/me/preferences`                                                                                |
| Assessment catalog/details | GET `/assessments`, `/assessments/{slug}`, `/assessments/{slug}/availability`                                               |
| Start/resume               | POST `/attempts`, GET `/attempts/{id}`                                                                                      |
| Answer                     | PUT `/attempts/{id}/answers/{questionId}`                                                                                   |
| Integrity/heartbeat        | POST `/attempts/{id}/integrity-events`, `/attempts/{id}/heartbeat`                                                          |
| Submit/result              | POST `/attempts/{id}/submit`, GET `/attempts/{id}/result`                                                                   |
| History                    | GET `/history`                                                                                                              |
| Dashboard/performance      | GET `/stats/overview`, `/stats/topics`, `/stats/performance`, `/stats/activity`                                             |
| Leaderboard                | GET `/leaderboards`, GET `/leaderboards/stream` (SSE)                                                                       |
| Admin imports              | POST `/admin/questions/import/validate`, POST `/admin/questions/import`                                                     |
| Admin content/config/audit | GET `/admin/questions`, PATCH `/admin/questions/{id}/publication`, PUT `/admin/assessment-configs/{id}`, GET `/admin/audit` |

## Assessment flow

1. Read availability; show server reasons for disabled modes and UTC quota/reset details.
2. Generate one UUID `requestKey` per intentional start and retain it for network retries. POST `{topicSlug:'javascript',mode:'MEDIUM',requestKey}`. Reuse the same key on retry, including after timeout. Quota is consumed at start.
3. Keep the returned attempt ID and recover via GET on refresh. Render the stored question/option order without reshuffling. Active questions expose no `isCorrect`, `quality`, explanation or scoring metadata. `questionId` is the attempt-question UUID, not the logical import key. Each question includes `answered`: an empty selection with `answered: true` is a committed skip, not an unanswered question.
4. Save `{selected:['option-id'],responseTimeMs:1200}`. `selected:[]` is a skip. Competitive answers are committed, including an empty selection; the frontend must confirm intent before committing a skip. Never assume browser navigation overrides the stored policy.
5. Render the timer using returned server time and expiry. On expiry or 409 ATTEMPT_FINALIZED, refetch; the server finalizes lazily or via expiry jobs. Never award XP or calculate authoritative score locally.
6. Initialize integrity sequencing from the returned `nextIntegritySequence`, preserving any locally queued higher sequences. Send integrity events with increasing sequence numbers; retain the original sequence and contents for retries. Example `{sequence:1,type:'TAB_HIDDEN',clientTimestamp:new Date().toISOString()}`. Debounce duplicate UI listeners. Send VAD activity summaries only, never audio. Heartbeat requires `type:'INTEGRITY_HEARTBEAT'`.
7. Every integrity response may represent a finalized attempt. Competitive critical events can immediately terminate the assessment. Render the returned result and stop sending answers/timers. POST submit with `{}`; repeated submissions return the stored result.

The result separates raw score, normalized score, objective accuracy, weighted quality, integrity, rank eligibility, XP and rating changes. Preserve nullable accuracy for weighted-only assessments. Display normalized score out of 100; rating and XP are separate measures. Review data is available only after finalization .

## Pagination and live updates

History and admin lists use opaque cursors. Leaderboards accept `period=weekly|monthly|all_time`, `category=overall|technical|interpersonal`, optional topic slug, `mode=all|easy|medium|competitive`, `limit` and `cursor`. Keep filters unchanged across a cursor chain; reset to page one on filter changes or live invalidation. Do not decode, manufacture or use cursors as offsets.

Use `new EventSource(apiBase + '/api/v1/leaderboards/stream', {withCredentials:true})`. Listen for `connected`, `leaderboard.updated` and `keepalive`. Refetch on connected/reconnected and relevant updates; notifications contain only scope information, not another user's private result. Streams close at session expiry and require reauthentication. Unsubscribe on unmount/logout. Movement is nullable; do not fabricate an increase/decrease badge.

## Admin JSON authoring

Send the file's parsed JSON directly with Content-Type application/json (no multipart upload). Root: `{schemaVersion:1,questions:[...]}`. See `src/db/seed-data.json` for a complete valid example and OpenAPI for strict schemas. Common fields include questionKey, integer version, topicSlug, category, difficulty, type, prompt, explanation, tags, estimatedTimeSeconds, status and options. Optional fields are context, code and language.

SINGLE_CHOICE/MULTIPLE_CHOICE options use `{id,text,isCorrect}`; WEIGHTED_CHOICE options use `{id,text,quality:'BEST'|'STRONG'|'ACCEPTABLE'|'WEAK'}`. Raw points, objective flags in weighted options, weighted metadata in objective options and other unknown fields are rejected. Single choice needs exactly one correct answer; multiple choice needs a correct answer and a distractor; weighted needs a BEST response. Option IDs must be unique. Maximum 1000 questions and 2 MB per request.

Validate first to get indexed/path-specific errors, then import. Validation does not write. Import revalidates and commits the entire batch atomically. Identical key/version/content is a no-op; different content under an existing key/version is rejected. Increment version for edits. Publication is a separate audited operation. Existing attempts retain old snapshots after edits, publication changes or config changes.

## Integration status and external work

The frontend connects authentication, catalog/history/stats/rankings, profile/preferences, answer autosave/resume, finalization, browser integrity signals, optional local VAD and admin imports. Browser coverage exercises these flows against the running API, including lost-response replay, cross-tab editing and SSE invalidation. Frontend signup fixtures pace requests to respect the real authentication limiter. Production catalog expansion, email delivery, deployment and operational scheduling remain separate work.
