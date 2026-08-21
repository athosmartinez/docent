# CLAUDE.md — working on docent

Guidance for AI agents (and humans) working in this repository.

## What this is

`docent` is an **agentic RAG service** over docs/codebases, in **TypeScript / Nest.js**, with multi-provider LLM routing + fallback, cost tracking, an evaluation suite, and a native **MCP** server. See `README.md` for the public overview.

## Current status — M3 complete

The service ingests a documentation repository into embedded, indexed chunks and
answers questions about it with inline citations: `POST /ask` and `POST /ask/stream`
(SSE) both drive `retrieval`, which queries the vector index and `content_tsv` and
fuses the two rankings by Reciprocal Rank Fusion. A question with no chunk close
enough to it is refused before the LLM is ever called. A minimal chat page at `/`
drives both endpoints.

A completion is answered by walking a configurable provider chain (`llm`): the
default ships as a single `openai:gpt-4.1-mini` link, and a second, OpenRouter, link
is opt-in via `LLM_CHAIN` — every provider named there must have its key set, and a
repeated `provider:model` pair is rejected at boot. Every answered or refused
question writes a row to `cost_ledger` (`cost`), priced from reported usage or a
price table when the model is in it, `unknown` otherwise; `GET /costs?from&to`
aggregates it by provider and model. A question's embedding and a corpus-versioned
answer are both cached in Redis, so a repeated question costs nothing and answers
instantly. `/ask`, `/ask/stream` and `/ingest` are rate-limited per client address,
backed by Redis; every request is logged as one JSON line carrying a request id
that the response echoes back. **Next milestone: M4** (agentic layer) — see
`_planning/03-roadmap.md`.

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
- **PostgreSQL + pgvector** (vectors) · **Redis** (cache, rate limiting)
- LLM access via OpenAI-compatible SDKs + OpenRouter · MCP via `@modelcontextprotocol/sdk`
- Eval via promptfoo + LLM-as-judge

Modules under `src/` today: **`common`** (config, database, redis, cache, structured
logging, rate limiting, shared helpers), **`health`**, **`ingestion`** (source
fetching, markdown cleaning, HTML-table conversion, chunking, and the repository that
writes documents/chunks), **`embeddings`** (the OpenAI embeddings provider),
**`retrieval`** (the vector + lexical queries and their RRF fusion), **`llm`** (the
provider chain and the router that walks it with fallback), **`cost`** (pricing a
completion from its usage, the ledger, and `GET /costs`) and **`ask`** (grounding,
prompt assembly, citation numbering, persistence, caching, and the REST/SSE
controller plus the chat page). The rest — `agent · mcp · eval · api` — are the
target structure from `_planning/02-architecture.md`; each is created by the
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
- **`documents` and `chunks` rows outlive a source that ends `failed`.** Nothing
  deletes them: `deleteSourceContent` runs at the *start* of a pipeline (to clear a
  previous attempt before re-ingesting), never after a failure partway through. A
  source that fails on document 80 of 136 still leaves the first 79 documents' chunks
  committed. Anything that reads chunks must filter on `sources.status` (e.g. only
  `'ready'`), or it will serve rows from a partially-ingested run as though the run had
  completed.
- **`chunks.metadata.filenames` is scoped to the document, not the chunk.** It is
  computed once from every non-empty `@@filename(...)` directive found anywhere in the
  source markdown, then copied onto every chunk produced from that document —
  including chunks whose own text contains none of those files. It says which files
  the document as a whole mentions, not which file a given chunk's example belongs to;
  code that reads it needs to treat it that way.
- **A table is atomic when chunking, like a fenced code block — in both the form
  it arrives in and the form it leaves in.** Chunks carry no overlap, so a half
  beginning on a bare `<td>` or a bare pipe row can never be reassembled from what
  precedes it. Tables are converted to markdown during cleaning — with a header row
  they become markdown (pipe) tables, without one they become definition lists,
  since a two-column table with no header is a list of key-value pairs. The
  production corpus contains no raw `<table>` markup once cleaning has run, so the
  chunker's HTML-table tracker only guards a shape conversion failed to read; the
  markdown-table tracker guards the pipe tables that actually ship, and is what
  closes the defect on the real path. A definition list is not made atomic — its
  `- \`key\` — value` lines are individually self-contained and safe to split.
- **Two atomic regions that are each individually correct can compose into a gap
  neither has alone.** The chunker's fence and table trackers are the concrete case:
  while inside a fence, the table's token accounting was skipped entirely, so an
  unclosed table containing a fenced block escaped its own bound. A new atomic region
  needs testing in combination with the existing ones, not only on its own.
- **A pgvector kNN query must repeat the `::halfvec(3072)` cast in `ORDER BY`** — the
  HNSW index is declared on that expression, and the planner matches it only when
  `ORDER BY` is written identically. Ordering by a selected alias gives correct rows,
  no error, and a sequential scan.
  But the cast is necessary, not sufficient. Measured on this corpus: the planner uses
  the index at `LIMIT` 5 and 8 and abandons it at 12 and 20, and retrieval runs at
  `RETRIEVAL_TOP_N=20`. On 839 rows a sequential scan genuinely is cheaper, so the
  planner is right and the index only earns its keep as the corpus grows. A
  verification that runs `EXPLAIN` at a smaller `LIMIT` than production passes and
  proves nothing, which is exactly what happened here.
- **`plainto_tsquery` ANDs every term, and `websearch_to_tsquery` does not fix it.**
  Measured: a natural-language question matches zero chunks under either, because on
  prose both produce the identical AND query; `websearch_to_tsquery` only diverges when
  the user types quotes, `or`, or `-`. The lexical arm rewrites `plainto_tsquery`'s own
  output from `&` to `|` inside SQL, which keeps its sanitisation and stemming — that
  is why the question is never tokenised in TypeScript.
- **The lexical half is an index of literal identifiers, not of a language.** The
  dictionary is fixed to `english`, so a Portuguese question matches nothing on prose
  terms — but it still matches any identifier it names, and identifiers are
  language-neutral. Measured: `'como valido o corpo da requisicao?'` → 0 chunks;
  `'como uso o ValidationPipe para validar?'` → 18, with the right documents on top. A
  per-source dictionary only becomes necessary when the ingested *content* is not
  English.
- **Grounding is decided by semantic distance, never by a fused rank score.** A fused
  RRF score encodes rank, not proximity: with two arms its whole range is
  `[1/61, 2/61]`, and the vector arm always returns its nearest N however far away they
  are — so there is always a rank-1 chunk. Measured, four clearly out-of-corpus
  questions scored exactly `1/61`, and one ("how do I file my taxes in Brazil") outscored
  a real question about custom guards by matching the common word "file". The refusal
  now compares the vector arm's cosine distance for the nearest chunk against
  `GROUNDING_MAX_DISTANCE`; distance is a cost, so smaller is better and the comparison
  refuses when it is *greater*. The threshold is measured, not chosen —
  `npm run calibrate:floor` re-derives it. Over 30 in-corpus questions (drawn from the
  corpus's own headings, so each is demonstrably answerable) and 14 out-of-corpus ones,
  the populations overlap by a hair: the furthest in-corpus question ("how do I upload a
  file?") measured 0.61568, closer than the nearest out-of-corpus one ("how do I write a
  Dockerfile for a Python Flask app?") at 0.60737. No single threshold gets every
  question in the sample right. The default is set to the furthest in-corpus distance
  measured, because refusing a question the corpus can actually answer costs more than
  answering one that merely sounds related.
- **The e2e database is not hermetic.** It holds the fully ingested corpus alongside
  test fixtures. A test question containing ordinary vocabulary dilutes retrieval
  ranking and can drop a fixture below the grounding threshold, failing a test for a
  reason unrelated to what it checks — so a fixture-targeting question must reduce to
  stopwords plus a lexeme unique to that fixture. For the same reason every e2e query
  **and** cleanup must be scoped to the rows its own suite created: an unscoped
  `deleteFrom` cascades into other suites' fixtures, and an unscoped existence check
  stays green on any leftover row.
- **`nest build` compiles TypeScript only, and the asset copier does not know where
  tsc put the output.** Because `scripts/` and `migrations/` compile alongside `src/`,
  tsc's inferred root is the repository root and `.ts` output lands under `dist/src/**`,
  so the `nest-cli.json` asset entry needs an explicit `outDir: "dist/src"`. Without it
  the page exists under `src/` and never reaches `dist/` — working under `start:dev`
  and returning 500 under `start:prod`, a failure no test reaches because tests run
  from source.
- **The SSE wire format's `event:` / `data:` parsing is safe only because every
  payload is `JSON.stringify`d**, so no newline can appear inside a data value. That
  pairing is load-bearing: emitting a raw multi-line string would silently corrupt
  frame parsing on the client.
- **A test that pins an invariant needs a fixture where violating the invariant
  changes the result** — and the way to know is to introduce the violation and watch
  the test fail, not to re-read the test. Repeatedly in this codebase a test that
  looked correct could not catch the regression it was named for: a fixture already
  sorted the way the code sorts it, an empty stream chunk placed last where the real
  API sends it first, an existence check that any leftover row satisfied. Each was
  found by mutation and none by reading.
- **The chain separator is the first colon only** (`parseLlmChain`,
  `src/llm/llm-chain.ts`). An OpenRouter model name can carry a further colon as a
  variant suffix (`google/gemini-2.5-flash:free`); splitting on every colon would
  route to a different model than the one configured.
- **A link failure falls through on every error, including 401.** `LlmRouter`
  (`src/llm/llm.router.ts`) never inspects a failure's status code before moving to
  the next link — the next link is a different provider with a different key, so a
  401 that is fatal for this one says nothing about the next one's chance of
  succeeding. Refusing to repeat a `provider:model` pair, enforced once in
  `parseLlmChain`, is what keeps this from retrying the same doomed call forever.
- **A stream link is not chosen until its first delta arrives, and that delta is
  re-yielded rather than dropped.** A provider failure very often surfaces on the
  first iteration rather than on the call that opens the stream, so `LlmRouter.stream()`
  pulls one delta before trusting a link good; having already produced real content,
  that delta goes to the caller too, not just the ones that follow it.
- **`prompt_tokens` already contains `cached_tokens`.** `normaliseUsage`
  (`src/llm/openai-compatible.provider.ts`) keeps both numbers as reported rather than
  subtracting one from the other; `computeCost` (`src/cost/cost.calculator.ts`) is the
  one place that derives the uncached remainder, so an input rate is never applied to
  the same tokens twice.
- **`pg` returns `numeric` as a string, like `vector`.** A `numeric` can exceed what a
  JS `double` holds without loss, so `cost_ledger.usd_cost`'s `NumericColumn`
  (`src/common/database/schema.ts`) declares the string form explicitly — adding two
  unparsed numeric strings in JavaScript concatenates them instead of summing,
  silently.
- **The answer cache's version is derived from Postgres, never held as a Redis
  counter.** `CorpusVersion.current()` (`src/common/cache/corpus-version.ts`)
  computes `count(*)` plus `max(updated_at)` over `ready` sources on every read. A
  counter in Redis is lost to a flush or an eviction, and one that resets to its
  initial value makes every superseded answer reachable again — stale content served
  as fresh, with no symptom anywhere.
- **The cache fails open, because Redis is an optimisation, not a dependency.**
  Every `CacheService` read and write (`src/common/cache/cache.service.ts`) swallows
  and logs rather than propagating — a cache miss and an unreachable cache look
  identical to every caller, both meaning "compute it yourself." The rate limiter
  (`src/common/throttling/redis-throttler.storage.ts`) fails open for the same reason
  but not the same way: it bounds the wait with `withTimeout` first, because ordinary
  latency on a reachable Redis should not read as "no limit" either.

## Security

- **Never commit secrets.** API keys and config live only in `.env` (already gitignored). Keep `.env.example` with placeholder values only.
- Do not log full prompts/responses containing secrets.

## Git

- Branch work off `main`; a PR's `head` is always the task branch (never an environment/feature branch into another).
- End commit messages with the `Claude-Session` footer.

## Definition of done

Per-milestone DoD is in `_planning/03-roadmap.md`. A milestone isn't done until its DoD is met and it's independently demoable.
