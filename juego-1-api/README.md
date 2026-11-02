# api-movies — Movie Catalog REST API

REST MVC API for a movie catalog. It exposes JWT authentication, catalog CRUD, search and
suggestions, reviews, watchlist, recommendations, user profiles/preferences/settings/onboarding,
notifications, CSV/JSON export, and a BullMQ-backed async job system.

> **Purpose of this file:** give a new contributor or agent a fast, accurate map of the project so
> they do not have to read the whole codebase. It points to the files and docs that hold the detail.

- **Runtime:** Node 24+ · TypeScript · Express 5
- **Databases:** MySQL 8 (`utf8mb4_0900_ai_ci`) · Redis 7 (cache, rate limiting, BullMQ)
- **Search:** Meilisearch (optional; automatic MySQL fallback)
- **Validation:** Zod · **Auth:** JWT · **Logs:** Winston · **Email:** Resend + React Email
- **Default port:** `8089`
- **Version:** see `source/package.json` (currently `1.1.0`)

## Repository layout

The repo root only holds cross-cutting files:

- `.github/workflows/ci.yml` — CI pipeline
- `AGENTS.md` — instructions for AI agents
- `CONTRIBUTING.md` — branching and release flow

**All application code and every npm command live in `source/`.** Run `npm` from there.

## Architecture

`source/api.ts` is the **composition root**. It manually wires every repository, service, and
controller (constructor injection / Dependency Injection) and returns the Express app via
`createApp()`. Tests inject mocks by passing arguments to `createApp(movieService, searchService, rateLimiter)`.

Request flow:

```text
HTTP → Express middleware (json → rateLimiter → requestLogger → static)
     → routes → controllers → services → repositories → domain/schemas → MySQL
                              └──────────────► Redis / Meilisearch / BullMQ
```

Patterns used deliberately across the code (each documented with a banner comment at the top of the
relevant file):

- **Composition root / DI** — `api.ts`
- **Factory Method** — `create*Routes(controller)` in `routes/`
- **Repository** — `repositories/`, one per aggregate, SQL only
- **Facade** — `services/movieService.ts` orchestrates 5 repositories behind one surface
- **Chain of Responsibility** — the Express middleware chain
- **Strategy + Serializer** — `serializers/` (CSV/JSON) selected by export format
- **Singleton** — MySQL pool in `db/connection.ts`, Redis client in `utils/redisClient.ts`

## Folder map (`source/`)

| Path | Role |
|------|------|
| `api.ts` | Composition root; mounts all routers; global error handler + 404 |
| `routes/` | Express routers, one factory per feature; declares auth/role guards |
| `controllers/` | Parse request, call service, shape response. No SQL, no business rules |
| `services/` | Business logic and orchestration; call repositories, cache, notifiers |
| `repositories/` | Data access (mysql2 pool); one class per aggregate/table group |
| `domain/` | Rich models / value objects (`Movie`, `Review`, `UserPreferences`, …) with `fromRow`/`toResponse` |
| `schemas/` | Zod schemas + inferred DTO types for request validation |
| `types/` | Shared TypeScript types (roles, JWT payloads, job payloads) |
| `middleware/` | `requireAuth`, `requireRole`, `requestLogger`, `rateLimiter`, `penaltyBox` |
| `config/` | `rateLimitConfig.ts`, `bullmq.ts` (queue names, priorities, limits) |
| `db/` | `connection.ts` (pool), `schema.sql` (baseline DDL), `migrations/`, `migrate.ts`, `seed.ts` |
| `jobs/` | BullMQ job handlers (send email, notification fan-out, recs recompute) |
| `queues/` | BullMQ queue producers (`emailQueue`, `notificationQueue`, `recommendationQueue`) |
| `workers/` | BullMQ worker processes (`emailWorker`, `notificationWorker`, `recommendationWorker`) |
| `notifiers/` | Email/notification interfaces + `Dev*` and `Queued*` implementations |
| `serializers/` | `CsvSerializer`, `JsonSerializer` (export) |
| `utils/` | `AppError`, `logger`, `cache`, `redisClient`, `meilisearchClient`, `ipExtractor`, … |
| `services/emailTemplates/` | React Email templates (`.tsx`) |
| `scripts/` | `reindex.ts`, `recomputeRecommendations.ts`, `migrateAffinityDecay.ts` |
| `public/` | Static assets served by the API (`lab-guide.html`, frontend labs) |
| `docs/` | Functional/technical specs — index at `docs/README.md` |
| `__tests__/` | Jest suites (`unit/`, `integration/`, `property/`, `pagination/`, `helpers/`) |
| `postman/`, `api.http` | Manual request collections |

## Data model

17 tables, defined as the baseline in `db/schema.sql` and versioned in `db/migrations/`.
`schema.sql` and `db/migrations/0000_schema_base.sql` must stay in sync.

**Catalog:** `movies` (title, year, rating, duration, plot, poster, age_rating, FK `id_director`),
`directors`, `genres`, `actors`, `movie_genres`, `movie_actors`, `audit_log`
(JSON `old_snapshot`/`new_snapshot`, `action ∈ CREATE|UPDATE|DELETE`).

**Users & auth:** `users` (uuid PK, email, password_hash, `role ∈ admin|premium|user`,
email_verified), `refresh_tokens`, `email_verifications`.

**Profile & preferences:** `user_profiles` (display_name, bio, avatar, country, birth_year,
is_public), `user_preferences` (favorite/disliked genres/directors/actors, `genre_affinity`,
`content_filters` as JSON), `user_settings` (language, theme, region, notify_*, privacy_*,
spoiler_free, onboarding_completed).

**Engagement:** `user_watchlists` (unique `user_id`+`movie_id`, priority 1–5),
`reviews` (unique `user_id`+`movie_id`, rating `decimal(2,1)`),
`recommendation_feedback` (`action ∈ view|hide|like|not_interested`),
`notifications` (unique `user_id`+`type`+`dedupe_key` for idempotency).

## API endpoints

Auth legend: — public · **A** `requireAuth` · **premium**/**admin** `requireRole`.

| Group | Method & path | Auth | Notes |
|-------|---------------|------|-------|
| Catalog (`/movies`) | `GET /` | — | Paginate/filter/sort; cached in Redis |
| | `GET /random` | — | Random batch |
| | `GET /genres` | — | Cached |
| | `GET /suggest` | — | Suggestions |
| | `GET /:id` | — | Detail |
| | `GET /:id/similar` | — | Similar movies |
| | `GET /:id/audit-log` | admin | Audit trail |
| | `POST /` · `PATCH /:id` · `DELETE /:id` | admin | Write, records audit log |
| Export | `GET /movies/export/:format` | premium | `csv` or `json`, uses movie filters |
| Search | `GET /movies/search` | — | Meilisearch or MySQL fallback |
| | `GET /movies/search/suggest` | — | Autocomplete (`title`/`director`/`genre`) |
| Reviews | `GET /movies/:id/reviews` | — | Paginated |
| | `POST /movies/:id/reviews` | A | One review per user per movie |
| | `GET/PATCH/DELETE /movies/:id/reviews/me` | A | Own review |
| Auth | `POST /auth/register` · `/login` · `/refresh` · `/logout` | — | Returns access (short-lived) + refresh token |
| | `POST /auth/verify` · `/resend` | — | Email verification flow |
| | `POST /auth/forgot` · `/reset` | — | Password reset flow |
| Watchlist | `POST` · `GET /users/me/watchlist` · `DELETE /users/me/watchlist/:movieId` | A | |
| Profile | `GET/PATCH /users/me/profile` | A | Own profile |
| | `GET /users/:id/profile` | — | Public profile (`is_public`) |
| Settings | `GET/PATCH /users/me/settings` | A | |
| Preferences | `GET/PUT /users/me/preferences` · `GET …/stats` | A | |
| Onboarding | `POST /users/me/onboarding` | A | Completes onboarding, seeds preferences |
| Recommendations | `GET /users/me/recommendations` | A | `?type=content\|collab\|hybrid&limit=` |
| | `POST /users/me/recommendations/feedback` | A | view/hide/like/not_interested |
| Notifications | `GET /users/me/notifications` · `…/unread-count` | A | |
| | `PATCH /users/me/notifications/:id/read` · `/read-all` | A | |
| User admin | `PATCH /users/:id/role` | admin | Change role |
| Metrics | `GET/DELETE /metrics/rate-limit`, `DELETE /metrics/rate-limit/penalty[/:identifier]` | admin | Rate-limit metrics + penalty box admin |
| Queue admin | `GET /admin/queues` | — | Bull Board UI (**not yet protected — see debt**) |

Mount order matters: `api.ts` mounts `/movies/search` before `/movies`, and `/users/me/*` routes
before `/:id` routes (e.g. `userProfileRoutes`) so `me` is not parsed as an id.

## Authentication & RBAC

- Access + refresh JWTs signed with `JWT_SECRET` / `JWT_REFRESH_SECRET`. `requireAuth` verifies the
  `Authorization: Bearer` header, checks `type === 'access'`, and populates `req.user = { id, role }`.
- Roles are hierarchical: `admin > premium > user`. `requireRole(minRole)` runs after `requireAuth`
  and passes any role at or above the minimum (`requireRole('premium')` also admits `admin`).
- Registration persists `users` + `email_verifications` in one transaction; the verification email is
  **best-effort** (the response stays `201`; `POST /auth/resend` is the recovery path).

## Rate limiting

Redis-backed, with strategies for `global`, `auth`, `write`, and `user` scopes
(`middleware/rateLimiterStrategies.ts`), plus a **penalty box** for repeated abuse
(`middleware/penaltyBox.ts`). Thresholds are configurable via env (`config/rateLimitConfig.ts`).
The limiter is **fail-open**: if Redis is down, requests are allowed rather than 500ing.
Disabled in tests by default (`RATE_LIMIT_ENABLED=false`).

## Search

`services/searchService.ts` uses Meilisearch when `MEILISEARCH_ENABLED !== 'false'` and the index is
available; otherwise (or on error) it falls back to MySQL. The response `meta.source` reports which
engine answered. Index config lives in `utils/meilisearchClient.ts`; `npm run reindex` rebuilds it.

## Recommendations

`services/recommendationService.ts` computes pure scoring functions:

- **content** — similarity to the user's history (shared genres, repeated director/actor).
- **collab** — item-item cosine filtering over other users' interactions.
- **hybrid** (default) — `content*0.4 + collab*0.4 + pref*0.2`, where `pref` matches declared
  favorites/`genre_affinity`.

History = reviews (weight `rating`) ∪ watchlist (weight `priority`), de-duplicated by max weight;
already-seen items are always excluded. Results are cached 24 h in Redis
(`recs:user:{id}:{type}`; collab scores in `recs:user:{id}:collab:scores`). Cache is invalidated on
review/watchlist/feedback/preference changes. See `docs/features/hu-11-recommendation-engine.md`.

## Async jobs (BullMQ)

7 queues, 4 worker processes, Redis-backed, with exponential retry + dead-letter and a nightly cron:

| Queue | Priority (lower = sooner) | Worker |
|-------|---------------------------|--------|
| `email-critical` / `email-transactional` / `email-marketing` | 1 / 5 / 10 | `emailWorker` |
| `notification-fanout` / `notification-inapp` | 1 / 3 | `notificationWorker` |
| `recs-recompute-user` / `recs-recompute-all` | 1 / 10 | `recommendationWorker` |

- Producer side is **best-effort**: if Redis is unreachable, the business operation still succeeds and
  the failure is logged.
- Bull Board UI is mounted at `/admin/queues`.
- Email delivery uses Resend; without `RESEND_API_KEY` the worker logs the email (dev mode).
- Full contract: `docs/features/hu-13-bullmq-job-queue.md`.

## Testing

Jest + Supertest, `maxWorkers: 1`, `testTimeout: 30000` (`jest.config.js`).

- `__tests__/unit/` — services, middleware, domain, jobs
- `__tests__/integration/` — full HTTP flows via Supertest
- `__tests__/property/` — fast-check property tests
- `__tests__/pagination/` — pagination edge cases
- `__tests__/helpers/` — test DB setup, auth helpers, Redis mock

Test DB safety: `globalSetup.js` **drops and recreates** `DB_NAME_TEST` from `db/schema.sql` before
workers start, and refuses any name that does not end in `_test` or that equals `DB_NAME`
(`setTestDbEnv.js` redirects the app to it per worker). **Never point `DB_NAME_TEST` at a dev DB.**

- Most suites use `ioredis-mock`. The rate-limiter and BullMQ suites use **real Redis**
  (`REDIS_URL_TEST` → Testcontainers → `describe.skip`).
- Run one suite: `npm test -- <pattern>` (Jest 30 uses `--testPathPatterns`).
- Focused scripts: `npm run test:ratelimit`, `npm run test:queues`.

## Commands (run from `source/`)

```powershell
npm ci
npm run dev          # tsx watch api.ts
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm test             # jest
npm run migrate      # apply db/migrations
npm run migrate:status
npm run seed         # seed catalog/users (--keep-data to append)
npm run reindex      # rebuild Meilisearch index
npm run recs:compute # enqueue recompute-all (recs:compute:sync for direct)
# workers
npm run worker:dev
npm run worker:email:dev
npm run worker:notifications:dev
npm run worker:recs:dev
```

Convenience env in `.env` (see `.env.example`); MySQL/Redis must be running.

## Code & Git conventions

- **Branches:** `main` (releases/hotfixes only, via PR), `develop` (integration), `feature/*`,
  `fix/*`, `docs/*` (merge `--no-ff` into `develop`), `hotfix/*` (branch from `main`, PR into `main`,
  then sync back to `develop`). No squash/rebase. No direct commits to `main`.
- **Commits:** one file per commit (except the atomic `package.json` + `package-lock.json` pair).
- **Docs-only merges** to `develop` may use `[skip ci]`, but the HEAD of `develop` must be a commit
  *without* it before opening the `develop → main` PR. See `docs/cross-cutting/skip-ci-develop.md`.
- **CI** (`.github/workflows/ci.yml`): runs on push to `develop`/`main` and PRs to `main`; jobs
  `build`, `test` (MySQL 8 + Redis 7 services), `migrations`. `hotfix/*` pushes do not trigger CI.

## Documentation

Specs and decisions live in `source/docs/`. Start at `source/docs/README.md`.

- Features by user story: `docs/features/` (HU-09 suggest, HU-10 profiles/preferences, HU-11
  recommendations, HU-12 profiles 2.0, HU-13 BullMQ).
- Cross-cutting: `docs/cross-cutting/` (CSV export, DB pool, rate-limiter test isolation, skip-ci).
- Fixes: `docs/fixes/`. Proposals: `docs/proposals/`. ADRs: `docs/decisions/`.
- Feature template: `docs/_template-feature.md`.

## Known debt / limitations

- `/admin/queues` (Bull Board) is unauthenticated in all environments.
- Email rate limiting is **per queue**, not global across Resend's quota; no enqueue-failure metric.
- `notifications` rows are not purged (no retention/TTL job).
- `recs.ready` is in-app only; no email template.
- Redis is a single point of failure (no Sentinel/Cluster).
- No automatic cache-hit-rate metric.
- In-app notifications are poll-based (no SSE/WebSocket).

See `docs/features/hu-13-bullmq-job-queue.md` → "Limitaciones / Deuda Conocida" for the full list.
