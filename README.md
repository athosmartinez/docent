<div align="center">

# 🧭 docent

**Agentic RAG over your documentation, built as a real backend service — ingestion and grounded answers with citations are live today; multi-provider fallback, cost tracking, the evaluation suite, and native MCP support are the target design.**

![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![NestJS](https://img.shields.io/badge/Nest.js-E0234E?logo=nestjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL%20+%20pgvector-4169E1?logo=postgresql&logoColor=white)
![Status](https://img.shields.io/badge/status-early%20development-orange)

</div>

---

## What is docent?

A **docent** is the expert guide who walks you through a collection and answers your questions about it. This project does the same for **technical documentation**: point it at a set of docs — a folder or a git repository of markdown — and it becomes an AI assistant you can query through a **REST API**, a **web UI**, or **directly inside Claude / Cursor** via the **Model Context Protocol (MCP)**. Ingesting **source code** the same way — chunked by AST rather than treated as prose — is planned for **M6.5**.

Unlike a typical demo chatbot, `docent` is built like a real backend service, in **TypeScript / Nest.js**, with the engineering concerns that matter in production:

- 🔀 **Multi-provider LLM routing with fallback** (OpenAI, Gemini, OpenRouter)
- 💰 **Per-request cost & token accounting**
- 🧪 **An automated evaluation suite** that measures answer *faithfulness* and *cost* across models
- 🔌 **A native MCP server**, so it plugs into agentic IDEs and assistants

> 🚧 **Status: early development.** This README describes the target design. See the [Roadmap](#roadmap) for what is built vs. planned.

---

## Why docent

| | |
|---|---|
| 📚 **Grounded, not guessing** | Every answer cites the exact source chunks it used, retrieved by fusing a vector search and a full-text search over the corpus. When nothing retrieved is close enough to the question, it refuses instead of guessing — `answer: null`, `citations: []`, `grounded: false` — without ever calling the LLM. The distance threshold is measured against the corpus, not chosen by hand. |
| 🤖 **Agentic retrieval** *(planned)* | The model will use tools in multiple steps (search, fetch, plan) instead of a single naive lookup. |
| 🔀 **Resilient by design** *(planned)* | If a provider fails or times out, requests will fall back down a configurable chain. No single point of failure. |
| 💰 **Cost-aware** *(planned)* | Tokens and USD cost will be tracked per request, so you can answer "which model is best for *this* task, and at what price?". |
| 🧪 **Measurable quality** *(planned)* | A reproducible eval suite will score retrieval hit-rate, faithfulness and relevance — and compare models head to head. |
| 🔌 **MCP-native** *(planned)* | Will run as an MCP server, usable as a tool inside Claude Desktop / Cursor. |

---

## Architecture

```mermaid
flowchart TB
  subgraph Ingestion["📥 Ingestion pipeline"]
    SRC["Docs · Code (planned)"] --> CHUNK["Loader & Chunker (structure-aware)"]
    CHUNK --> EMB["Embeddings"]
    EMB --> VEC[("PostgreSQL + pgvector")]
  end

  subgraph Query["💬 Query pipeline"]
    CL["Web UI · REST"] --> RET["Retriever: vector + lexical fusion"]
    RET --> VEC
    RET --> LLM["LLM call (single provider)"]
    LLM --> ANS["Answer + Citations"]
  end

  subgraph Agentic["🤖 Agentic layer (planned)"]
    MCP["MCP"] --> AGENT["Agent Orchestrator"]
    AGENT --> TOOLS["Tools: retriever · web search"]
    AGENT --> ROUTER["LLM Router + Fallback"]
    ROUTER --> P1["OpenAI"]
    ROUTER --> P2["Gemini"]
    ROUTER --> P3["OpenRouter"]
  end

  TOOLS -.-> RET
  ROUTER -.-> LLM
  ROUTER -.-> COST[("Cost & Token Ledger")]
  AGENT -.-> CACHE[("Redis Cache")]
```

**Ingestion** turns sources into searchable knowledge: load → chunk (structure-aware) → embed → store in `pgvector`.
**Query** answers a question today by retrieving relevant chunks (fused vector + full-text search), calling a single LLM, and returning a grounded answer with citations — or declining when nothing retrieved is close enough. The agent loop, multi-provider fallback, and cost/token logging are still ahead.

---

## Tech stack

- **Runtime / framework:** Node.js 24 LTS · TypeScript (strict) · Nest.js
- **Storage / vectors:** PostgreSQL + pgvector · Redis (cache)
- **LLM access:** OpenAI embeddings (`text-embedding-3-large`) · OpenAI-compatible SDKs · OpenRouter *(routing planned)*
- **Agent tooling / MCP:** `@modelcontextprotocol/sdk`
- **Evaluation:** promptfoo + LLM-as-judge
- **Infra:** Docker · docker-compose · GitHub Actions (CI)

---

## Getting started

**Requirements:** Node **24 LTS** (pinned in `.nvmrc`) and Docker.

```bash
git clone https://github.com/athosmartinez/docent.git
cd docent

nvm use                       # Node 24 — other majors will fail in confusing ways

cp .env.example .env          # database and redis connection strings
docker compose up -d          # PostgreSQL + pgvector + Redis

npm install
npm run migrate
npm run start:dev             # API on http://localhost:3000
```

Verify it came up:

```bash
curl localhost:3000/health
```

Terminus reports `status`, `info`, `error` and `details` — `error` and `details` are present (as `{}` / mirrored `info`) even when everything is healthy:

```json
{
  "status": "ok",
  "info": {
    "database": { "status": "up" },
    "redis": { "status": "up" }
  },
  "error": {},
  "details": {
    "database": { "status": "up" },
    "redis": { "status": "up" }
  }
}
```

Ingest a documentation source:

```bash
npm run ingest -- https://github.com/nestjs/docs.nestjs.com --include 'content/**/*.md'
```

or over HTTP, which returns immediately and processes in the background:

```bash
curl -X POST localhost:3000/ingest \
  -H 'content-type: application/json' \
  -d '{ "source": "https://github.com/nestjs/docs.nestjs.com", "include": "content/**/*.md" }'
# { "sourceId": "...", "status": "pending" }

curl localhost:3000/sources/<sourceId>
# { "status": "ready", "document_count": 136, "chunk_count": 839, ... }
```

> **Known limitation:** ingestion runs in-process. If the service is interrupted
> mid-run, the source is protected by a lease that expires after 15 minutes — after
> that, a new run may reclaim it. A durable queue arrives with M3.

Ask a question about the ingested corpus:

```bash
curl -X POST localhost:3000/ask \
  -H 'content-type: application/json' \
  -d '{ "question": "What options does ValidationPipe accept?" }'
```

```json
{
  "answer": "The `ValidationPipe` accepts the following options as configuration, which are derived from both the `ValidationPipeOptions` interface and the `class-validator` ValidatorOptions interface:\n\n- `transform` (boolean): Enables automatic transformation of payloads to DTO class instances.\n- `disableErrorMessages` (boolean): If set to true, detailed validation error messages are disabled in the response.\n- `exceptionFactory` (function): A factory function that takes an array of validation errors and returns an exception object.\n- `errorFormat` ('list' | 'grouped'): Specifies the format of validation error messages....",
  "grounded": true,
  "citations": [
    { "ordinal": 1, "chunkId": "9dea1116-5fbb-491b-ace9-e75083a79914", "path": "content/techniques/validation.md", "headingPath": ["Validation", "Stripping properties"], "score": 0.032266458495966696 },
    { "ordinal": 2, "chunkId": "d78e391d-cf77-4dd6-9acf-3cf4fc5b1713", "path": "content/techniques/validation.md", "headingPath": ["Validation", "Using the built-in ValidationPipe"], "score": 0.032018442622950824 },
    { "ordinal": 3, "chunkId": "555988a9-714a-4ca1-a2e3-bcf69605e574", "path": "content/techniques/validation.md", "headingPath": ["Validation", "Auto-validation"], "score": 0.030309988518943745 },
    { "ordinal": 4, "chunkId": "2f136cd8-df56-419a-a9c9-809f84a021b4", "path": "content/pipes.md", "headingPath": ["Pipes", "Class validator"], "score": 0.028370221327967807 },
    { "ordinal": 5, "chunkId": "124eebb2-a872-421c-8d3f-15569ed4820d", "path": "content/techniques/validation.md", "headingPath": ["Validation", "Transform payload objects"], "score": 0.028309409888357256 },
    { "ordinal": 6, "chunkId": "d06aa196-d602-4a82-8a19-66f7ff109229", "path": "content/pipes.md", "headingPath": ["Pipes", "Transformation use case"], "score": 0.027272727272727275 },
    { "ordinal": 7, "chunkId": "57052851-84f2-44c3-b0e6-87808e6279e1", "path": "content/pipes.md", "headingPath": ["Pipes", "Binding pipes"], "score": 0.026709401709401708 },
    { "ordinal": 8, "chunkId": "9f101f63-83d9-461d-b805-cc8d8c743868", "path": "content/custom-decorators.md", "headingPath": ["Custom route decorators", "Working with pipes"], "score": 0.02581612258494337 }
  ]
}
```

If nothing retrieved is close enough to the question, `docent` refuses instead of guessing — `answer` is `null`, `citations` is `[]`, `grounded` is `false`, and no LLM call is made at all; ask it something the corpus doesn't cover (e.g. "How do I file my taxes in Brazil?") and it declines rather than improvising.

The same question can also be streamed token-by-token over SSE at `POST /ask/stream`, which emits the citations event before the first answer token so a client can render sources while the answer is still arriving.

A minimal chat page that drives both endpoints is served at `http://localhost:3000`.

### Using docent inside Claude / Cursor (MCP)

> 🚧 Planned — the MCP server exposes `search_kb`, `fetch_document` and `ask` as tools.

---

## Evaluation

> 🚧 Planned (M6) — none of this is implemented yet.

The differentiator: `docent` is designed to ship with a **reproducible evaluation harness**, not just a demo.

- A curated **Q&A dataset** over the ingested corpus
- Automated metrics: **retrieval hit-rate**, **faithfulness** (is the answer grounded in retrieved context?), **answer relevance**, plus **latency and cost**
- **LLM-as-judge** for the qualitative metrics
- A results table committed to the repo, **comparing models and providers** (quality × cost)

This makes it possible to answer, with numbers, *which* model and retrieval strategy is best for a given corpus.

---

## Roadmap

- [x] **M0 — Bootstrap & infra** (Nest scaffold, docker-compose, config, CI skeleton, health check)
- [x] **M1 — Ingestion pipeline** (markdown loader, structure-aware chunking, embeddings, pgvector store)
- [x] **M1.5 — Table handling** (HTML tables converted to markdown, never split across chunks)
- [x] **M2 — Core RAG** (retriever, grounded answers with citations, streaming, minimal UI)
- [ ] **M3 — Production engine** (multi-provider router + fallback, cost/token ledger, caching)
- [ ] **M4 — Agentic layer** (tool calling, multi-step planning, anti-hallucination guardrails)
- [ ] **M5 — MCP server** (stdio + HTTP, tools exposed, Claude/Cursor integration)
- [ ] **M6 — Evaluation suite** (dataset, metrics, LLM-as-judge, model comparison table)
- [ ] **M6.5 — Source code ingestion** (chunking by AST, search over literal identifiers)
- [ ] **M7 — Polish & launch** (tests, CI, Docker, demo deploy, docs)

---

## License

[MIT](./LICENSE) © Athos Martinez Andrade
