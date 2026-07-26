# M0 — Bootstrap & Infrastructure (design)

Status: approved, ready for implementation planning
Milestone: M0 (see `_planning/03-roadmap.md`)

## Goal

Get the skeleton running with one command. At the end of M0, `docker compose up -d`
plus `npm run start:dev` must bring the service up, and `GET /health` must report
whether PostgreSQL and Redis are actually reachable. CI must prove the same thing on
every push.

No domain logic ships in M0. Ingestion, retrieval, the agent loop, LLM routing, cost
tracking, MCP and eval all belong to later milestones.

## Decisions

| Decision | Rationale |
|---|---|
| **Kysely** for data access, no `kysely-codegen` | Type-safe SQL with full control over the pgvector kNN queries that M2 depends on. The `DB` interface is hand-written (~8 tables at full scope), which removes the need to run a live database just to generate types — a step that would otherwise sit in CI and in onboarding. |
| **Migrations in SQL, run by Kysely's native `Migrator`** | The `CREATE EXTENSION vector` statement and HNSW index tuning are outside what any schema-diff generator handles well. Writing them explicitly keeps them reviewable. |
| **Health check with real dependency probes** (`@nestjs/terminus`) | A static `200 {status:'ok'}` cannot distinguish "the app booted" from "the app booted and connected". M0's entire deliverable is that the infrastructure comes up, so the endpoint must attest to it. |
| **CI runs migrations and the e2e test against real services** | A broken migration or a misconfigured connection surfaces in the pull request instead of on the next manual run. |
| **zod** for environment validation, not `class-validator` | The whole contract fits in one readable block, and coercion (`PORT` as a number) is built in. |
| **The application is not in `docker-compose.yml`** | The milestone's definition of done is compose for dependencies plus `start:dev` for the app. A production Dockerfile is M7. |
| **Node 24 LTS** pinned in `.nvmrc`, `engines` and CI | LTS is what the M7 production image will target; pinning now avoids a version drift later. |

## Scope

### File layout

```
docent/
├─ src/
│  ├─ common/
│  │  ├─ config/
│  │  │  ├─ config.module.ts
│  │  │  └─ env.schema.ts
│  │  ├─ database/
│  │  │  ├─ database.module.ts
│  │  │  ├─ schema.ts
│  │  │  └─ migrator.ts
│  │  └─ redis/
│  │     └─ redis.module.ts
│  ├─ health/
│  │  ├─ health.module.ts
│  │  ├─ health.controller.ts
│  │  └─ indicators/
│  │     ├─ database.indicator.ts
│  │     └─ redis.indicator.ts
│  ├─ app.module.ts
│  └─ main.ts
├─ migrations/
│  └─ 0001_enable_pgvector.ts
├─ scripts/
│  └─ migrate.ts
├─ test/
│  └─ health.e2e-spec.ts
├─ .github/workflows/ci.yml
├─ docker-compose.yml
├─ .env.example
├─ .nvmrc
├─ eslint.config.mjs
├─ tsconfig.json
└─ package.json
```

Only `common` and `health` are created in M0. The remaining modules from
`_planning/02-architecture.md` (`ingestion`, `retrieval`, `agent`, `llm`, `cost`,
`mcp`, `eval`, `api`) are created when they have content.

### Scaffolding into a populated repository

`nest new` requires an empty target directory, and this repository already holds
`README.md`, `LICENSE`, `CLAUDE.md`, `.gitignore`, `.gitattributes` and `_planning/`.
The scaffold is generated in a temporary directory and its output moved in, leaving
the existing files and `.git` untouched. Generated boilerplate that serves no purpose
(`app.controller.ts`, `app.service.ts` and their specs) is deleted.

### Configuration

`@nestjs/config` registered globally, validated at startup by zod. A missing or
malformed variable terminates the process with a readable error before the server
accepts connections.

```ts
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});
```

`.env.example` documents exactly these four variables and nothing else. Provider API
keys arrive in M1/M2, when code actually reads them.

### Database access

A global module provides a `Kysely<DB>` instance built on a `pg.Pool`, destroying it
in `onModuleDestroy`. `main.ts` calls `app.enableShutdownHooks()` so that hook fires
on SIGTERM/SIGINT rather than leaking connections.

Redis is provided the same way, by a global module wrapping a single `ioredis`
client that is closed on shutdown.

`src/common/database/schema.ts` holds the hand-written `DB` interface. It starts
empty in M0 — Kysely creates and owns its `kysely_migration` bookkeeping tables
without them being declared — and gains `sources`, `documents` and `chunks` in M1.

### Migrations

Kysely's `Migrator` with `FileMigrationProvider`, reading `migrations/*.ts`. Each
file exports `up` and `down` and writes its SQL through the `sql` template tag, so
the statements stay visible in the source. `scripts/migrate.ts` runs them through
`tsx` against the TypeScript sources rather than a build output, which keeps
`npm run migrate` usable without a prior `npm run build`.

The single M0 migration enables the extension:

```ts
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP EXTENSION IF EXISTS vector`.execute(db);
}
```

No tables are created in M0. The `chunks.embedding` column requires a fixed
dimensionality (`vector(1536)`), and that number follows from the embedding model
chosen in M1. Creating the table now would mean guessing it and migrating again.

### Health endpoint

`GET /health`, backed by `@nestjs/terminus`. Terminus ships no indicator for Kysely
or Redis, so both are custom:

- `database` — executes `select 1` through the Kysely instance.
- `redis` — issues `PING` through the ioredis client.

Each probe is bounded by a 3 second timeout so a hung connection cannot stall the
endpoint.

Because `pg.Pool` connects lazily, the application starts even when PostgreSQL is
unreachable, and `/health` returns 503 until the dependency recovers. This is the
correct readiness semantic for an orchestrator, and it makes the milestone
demonstrable: stopping the container flips the endpoint.

Healthy response:

```json
{
  "status": "ok",
  "info": { "database": { "status": "up" }, "redis": { "status": "up" } },
  "error": {},
  "details": { "database": { "status": "up" }, "redis": { "status": "up" } }
}
```

With PostgreSQL down, the endpoint responds 503 and moves `database` into `error`.

### Docker Compose

Two services, each with a healthcheck and a named volume:

| Service | Image | Healthcheck |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | `pg_isready` |
| `redis` | `redis:7-alpine` | `redis-cli ping` |

The pgvector image ships the extension precompiled, so the migration only has to
enable it.

Host port mappings are parameterised as `${POSTGRES_PORT:-5432}:5432` and
`${REDIS_PORT:-6379}:6379`. The defaults are the conventional ports for anyone
cloning the repository; a developer whose host already runs those services overrides
them in `.env` without editing the compose file.

Redis has no consumer in M0 beyond the health probe — its cache role starts in M3.
It is provisioned now because the roadmap places the compose file in M0 and because a
health check that covers both dependencies is what makes the milestone verifiable.

### Continuous integration

A single workflow on `push` and `pull_request`, running on Node 24 with `services`
for `pgvector/pgvector:pg17` and `redis:7-alpine`, both gated by health-check
options so steps do not start against an unready container.

Steps: `npm ci` → `npm run lint` → `npm run build` → `npm run migrate` →
`npm run test:e2e`.

The migration and test steps read `DATABASE_URL` and `REDIS_URL` from the job
environment, pointing at the service containers on `localhost` with their default
ports. No `.env` file exists in CI, which incidentally exercises the same code path
a deployment would use.

### Type checking, linting, tests

- `tsconfig.json`: `strict: true` and `noUncheckedIndexedAccess: true`.
- ESLint 9 flat config with Prettier, as generated by the scaffold.
- One end-to-end test: boot the application, request `GET /health`, assert 200 with
  both indicators up. It requires the compose services to be running.

No unit tests in M0. There is no business logic yet, and asserting that a
configuration getter returns its value tests the framework rather than the code.

### npm scripts

`start:dev` · `build` · `lint` · `format` · `test:e2e` · `migrate` · `migrate:down`

On completion, the **Commands** section of `CLAUDE.md` is filled in and the M0
checkbox in `README.md` is ticked.

## Out of scope for M0

Structured logging (pino), husky/lint-staged, rate limiting, a production
Dockerfile, any domain module, and any LLM provider credentials.

## Definition of done

1. `docker compose up -d` starts PostgreSQL and Redis, both reporting healthy.
2. `npm run migrate` applies `0001_enable_pgvector`; `SELECT * FROM pg_extension`
   lists `vector`.
3. `npm run start:dev` boots the API on the configured port.
4. `GET /health` returns 200 with `database` and `redis` up.
5. Stopping the PostgreSQL container makes `GET /health` return 503 with `database`
   in `error`; restarting it restores 200.
6. Removing a required variable from `.env` makes the process exit at startup with a
   message naming that variable.
7. CI is green on the branch, including the migration and e2e steps.

## Known risks

- **Node 24 is not installed on the development machine** (it currently runs 26.5.0),
  so the first setup requires installing it. Accepted in exchange for matching the
  runtime the production image will target.
- **`pg` returns `vector` columns as a string** such as `'[0.1,0.2]'`, not as
  `number[]`. This affects the `DB` interface in M1, where the column needs an
  explicit `ColumnType` with serialisation on both sides. It does not affect M0.
