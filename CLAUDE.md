# CLAUDE.md — working on docent

Guidance for AI agents (and humans) working in this repository.

## What this is

`docent` is an **agentic RAG service** over docs/codebases, in **TypeScript / Nest.js**, with multi-provider LLM routing + fallback, cost tracking, an evaluation suite, and a native **MCP** server. See `README.md` for the public overview.

## Current status — M1 complete

The service ingests a documentation repository into embedded, indexed chunks:
`POST /ingest` and `npm run ingest` both drive the same pipeline. There is no
retrieval or answering yet — the `content_tsv` column and the vector index exist but
nothing queries them. **Next milestone: M2** (core RAG) — see `_planning/03-roadmap.md`.

## The plan lives in `_planning/` (read it first)

`_planning/` is a **gitignored, personal** folder — the source of truth for scope and sequencing. Before writing code, read:

- `_planning/03-roadmap.md` — **all deliverables, M0 → M7**, each with a checklist and definition-of-done. **Work one milestone at a time, in order.**
- `_planning/02-architecture.md` — modules, data model, API contracts, technical decisions.
- `_planning/01-vision.md` — goals and **non-goals** (respect the non-goals; they prevent scope creep).

Each milestone also leaves its own working notes there: `_planning/specs/` holds the
design agreed before implementation, `_planning/plans/` the task breakdown used to
build it. Read the current milestone's spec before writing code, and the previous
one's when you need to know why something is the way it is.

Do **not** commit anything under `_planning/` (it is gitignored on purpose).

## Runtime — Node 24

The project is pinned to **Node 24 LTS** in `.nvmrc` and in `package.json` `engines`.
`engines` only warns, so nothing stops you from running an older or newer major and
hitting confusing failures — `nvm use` before anything else, and check `node -v`
reports 24.x. The `migrate` scripts depend on `--env-file-if-exists`, which is one of
the flags that will bite you first on the wrong runtime.

## Tech stack & structure

- **Node.js · TypeScript (strict) · Nest.js**
- **PostgreSQL + pgvector** (vectors) · **Redis** (cache)
- LLM access via OpenAI-compatible SDKs + OpenRouter · MCP via `@modelcontextprotocol/sdk`
- Eval via promptfoo + LLM-as-judge

Modules under `src/` today: **`common`** (config, database, redis, shared helpers) and
**`health`**. The rest — `ingestion · retrieval · agent · llm · cost · mcp · eval · api`
— are the target structure from `_planning/02-architecture.md`; each is created by the
milestone that gives it content, not before.

## Commands

```bash
docker compose up -d      # PostgreSQL + pgvector and Redis
npm run migrate           # apply pending migrations
npm run migrate:down      # roll the last one back
npm run start:dev         # API on http://localhost:3000
npm run start:prod        # run the build (node dist/src/main)
npm run lint              # check only — fails on the first warning
npm run lint:fix          # the mutating variant
npm run format            # Prettier
npm test                  # unit tests
npm run test:e2e          # end-to-end tests (needs compose running)
npm run build             # compile to dist/
npm run ingest -- <source> [--include <glob>]   # ingest a docs repo or local path
```

`npm run lint` is a hard gate: no `--fix`, and `--max-warnings 0`, so a warning fails
CI the same as an error. Use `lint:fix` when you want it to rewrite files. Both cover
`scripts/` and `migrations/` as well as `src/` and `test/`.

`GET /health` returns 200 when PostgreSQL and Redis both answer, and 503 otherwise.

## Conventions

- **Follow the roadmap.** Don't jump ahead or add features outside the current milestone. If an idea comes up, note it under "Ideias futuras" in `_planning/03-roadmap.md` and keep going. Shipping > perfection.
- **MVP first:** M0 → M2 must produce a working, demoable RAG before production concerns (M3+).
- **Comments explain the durable technical "why", not the task.** No ticket IDs, sprint dates, or "step N" references in code/tests.
- **README honesty:** the public README marks features as done vs. planned. Never document behavior that doesn't exist yet. When a milestone completes, tick its checkbox in `README.md`.
- **Tests** on critical paths (ingestion, retrieval, router/fallback, eval).
- **TypeScript strict**; lint + format must pass before commit.

## Codebase patterns

These exist because their absence already caused a defect. Follow them when adding
anything that talks to the network or to the database.

- **Every network client gets an `error` listener.** `pg.Pool` and the ioredis client
  both emit `error` outside any request — on an idle socket teardown, on a reconnect
  attempt. An `EventEmitter` with no listener for `error` *throws*, killing the
  process. See `src/common/database/database.module.ts` and
  `src/common/redis/redis.module.ts`.
- **Describe errors with `describeError`** (`src/common/describe-error.ts`), never with
  `error.message` directly. A refused connection arrives as an `AggregateError` whose
  `.message` is the empty string — the detail lives in `.code` and `.errors[]`. It also
  avoids `instanceof Error`, which fails across realm boundaries (notably inside Jest).
- **Bound anything that can hang** with `withTimeout` (`src/common/with-timeout.ts`) —
  health probes and shutdown both use it. Note it bounds the *caller*, not the
  underlying query: a timed-out query still holds its pooled client, which is why
  `onApplicationShutdown` is bounded too.
- **The Kysely schema is hand-written** in `src/common/database/schema.ts`, so types
  never require a live database. Add tables there as the feature that owns them ships.
  `pg` returns a `vector` column as a string like `'[0.1,0.2]'`, not `number[]` — that
  column needs an explicit `ColumnType` with serialisation on both sides.
- **Migrations are hand-written SQL**, run by Kysely's own migrator. `Migrator` and
  `FileMigrationProvider` import from **`kysely/migration`**; migration functions take
  `Kysely<any>`, because a migration runs against the schema as it was at that point in
  history, not against the current `DB` interface.
- **Configuration is validated at boot** by zod in `src/common/config/env.schema.ts`.
  Anything new the code reads from the environment goes in that schema, with a
  constraint tight enough to fail at startup rather than at first use.
- **Embedding results are matched by the API's `index` field, never by array
  position.** The response order is not guaranteed, and pairing by position would
  silently attach one chunk's vector to another.
- **The chunk embedding dimensionality lives in exactly two places:** the migration's
  `vector(3072)` and `CHUNK_EMBEDDING_DIMENSIONS` in
  `src/common/database/schema.ts`, which configuration is validated against at boot.
  The HNSW index casts to `halfvec` because pgvector caps a `vector` index at 2000
  dimensions.

## Security

- **Never commit secrets.** API keys and config live only in `.env` (already gitignored). Keep `.env.example` with placeholder values only.
- Do not log full prompts/responses containing secrets.

## Git

- Branch work off `main`; a PR's `head` is always the task branch (never an environment/feature branch into another).
- End commit messages with the `Claude-Session` footer.

## Definition of done

Per-milestone DoD is in `_planning/03-roadmap.md`. A milestone isn't done until its DoD is met and it's independently demoable.
