# CLAUDE.md — working on docent

Guidance for AI agents (and humans) working in this repository.

## What this is

`docent` is an **agentic RAG service** over docs/codebases, in **TypeScript / Nest.js**, with multi-provider LLM routing + fallback, cost tracking, an evaluation suite, and a native **MCP** server. See `README.md` for the public overview.

## Current status — M0 complete

The service boots, connects to PostgreSQL and Redis, and reports readiness at
`GET /health`. There is no ingestion or retrieval yet. **Next milestone: M1**
(ingestion pipeline) — see `_planning/03-roadmap.md`.

## The plan lives in `_planning/` (read it first)

`_planning/` is a **gitignored, personal** folder — the source of truth for scope and sequencing. Before writing code, read:

- `_planning/03-roadmap.md` — **all deliverables, M0 → M7**, each with a checklist and definition-of-done. **Work one milestone at a time, in order.**
- `_planning/02-architecture.md` — modules, data model, API contracts, technical decisions.
- `_planning/01-vision.md` — goals and **non-goals** (respect the non-goals; they prevent scope creep).

Do **not** commit anything under `_planning/` (it is gitignored on purpose).

## Tech stack & structure

- **Node.js · TypeScript (strict) · Nest.js**
- **PostgreSQL + pgvector** (vectors) · **Redis** (cache)
- LLM access via OpenAI-compatible SDKs + OpenRouter · MCP via `@modelcontextprotocol/sdk`
- Eval via promptfoo + LLM-as-judge
- Feature modules under `src/`: `ingestion · retrieval · agent · llm · cost · mcp · eval · api · common`

## Commands

```bash
docker compose up -d      # PostgreSQL + pgvector and Redis
npm run migrate           # apply pending migrations
npm run migrate:down      # roll the last one back
npm run start:dev         # API on http://localhost:3000
npm run lint              # ESLint
npm test                  # unit tests
npm run test:e2e          # end-to-end tests (needs compose running)
npm run build             # compile to dist/
```

`GET /health` returns 200 when PostgreSQL and Redis both answer, and 503 otherwise.

## Conventions

- **Follow the roadmap.** Don't jump ahead or add features outside the current milestone. If an idea comes up, note it under "Ideias futuras" in `_planning/03-roadmap.md` and keep going. Shipping > perfection.
- **MVP first:** M0 → M2 must produce a working, demoable RAG before production concerns (M3+).
- **Comments explain the durable technical "why", not the task.** No ticket IDs, sprint dates, or "step N" references in code/tests.
- **README honesty:** the public README marks features as done vs. planned. Never document behavior that doesn't exist yet. When a milestone completes, tick its checkbox in `README.md`.
- **Tests** on critical paths (ingestion, retrieval, router/fallback, eval).
- **TypeScript strict**; lint + format must pass before commit.

## Security

- **Never commit secrets.** API keys and config live only in `.env` (already gitignored). Keep `.env.example` with placeholder values only.
- Do not log full prompts/responses containing secrets.

## Git

- Branch work off `main`; a PR's `head` is always the task branch (never an environment/feature branch into another).
- End commit messages with the `Claude-Session` footer.

## Definition of done

Per-milestone DoD is in `_planning/03-roadmap.md`. A milestone isn't done until its DoD is met and it's independently demoable.
