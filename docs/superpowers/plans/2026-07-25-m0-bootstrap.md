# M0 Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring up the `docent` skeleton — Nest.js API, PostgreSQL with pgvector, Redis, typed configuration, migrations, a health endpoint that probes both dependencies, and CI that proves all of it.

**Architecture:** A Nest application with two modules: `common` (configuration, database, Redis) and `health`. Data access goes through Kysely over a `pg.Pool`, with migrations run by Kysely's native `Migrator` against SQL written by hand. `GET /health` uses `@nestjs/terminus` with two custom indicators that actually query PostgreSQL and Redis, so the endpoint attests to connectivity rather than to the process being alive. Dependencies run in Docker Compose; the application itself runs on the host via `npm run start:dev`.

**Tech Stack:** Node 24 LTS · TypeScript 5 (strict) · Nest.js 11 · Kysely 0.29 · `pg` 8 · ioredis 5 · zod 4 · `@nestjs/terminus` 11 · `@nestjs/config` 4 · Jest + supertest · Docker Compose · GitHub Actions

**Spec:** `docs/superpowers/specs/2026-07-25-m0-bootstrap-design.md`

## Global Constraints

- **Branch:** all work happens on `m0-bootstrap`, already created off `main`.
- **Node version:** 24 LTS (currently `24.18.0`, codename Krypton). Pinned in `.nvmrc`, in `package.json` `engines`, and read by CI via `node-version-file`.
- **Package manager:** npm.
- **TypeScript:** `strict: true` and `noUncheckedIndexedAccess: true` in `tsconfig.json`.
- **Zod 4 API:** use top-level format validators — `z.url()`, not the deprecated `z.string().url()`.
- **Kysely imports:** `Migrator` and `FileMigrationProvider` come from `kysely/migration`; `Kysely`, `PostgresDialect` and `sql` come from `kysely`.
- **Terminus 11 API:** custom indicators inject `HealthIndicatorService` and call `check(key)` → `.up()` / `.down()`. The `HealthIndicator` base class and `HealthCheckError` are deprecated — do not use them.
- **Comments:** explain the durable technical "why", never the task or milestone that motivated the code. No milestone IDs, no "step N" references in source files.
- **Secrets:** `.env` is gitignored and never committed. `.env.example` carries placeholder values only.
- **Commit trailer:** every commit message ends with
  `Claude-Session: https://claude.ai/code/session_011FzXB3AsT5LEFnCygRRASb`
- **No LLM provider keys** anywhere in M0 — they arrive in M1/M2.

## File Structure

| File | Responsibility |
|---|---|
| `src/main.ts` | Bootstrap: create app, enable shutdown hooks, listen on the configured port. |
| `src/app.module.ts` | Compose `AppConfigModule`, `DatabaseModule`, `RedisModule`, `HealthModule`. |
| `src/common/config/env.schema.ts` | The environment contract as a zod schema, plus `validateEnv`. |
| `src/common/config/config.module.ts` | Registers `@nestjs/config` globally with that validator. |
| `src/common/database/schema.ts` | The hand-written `DB` interface Kysely is generic over. |
| `src/common/database/database.module.ts` | Provides `Kysely<DB>`; destroys the pool on shutdown. |
| `src/common/redis/redis.module.ts` | Provides the ioredis client; quits it on shutdown. |
| `src/common/with-timeout.ts` | Bounds a promise by a deadline. Used by both health probes. |
| `src/health/indicators/database.indicator.ts` | Probes PostgreSQL with `select 1`. |
| `src/health/indicators/redis.indicator.ts` | Probes Redis with `PING`. |
| `src/health/health.controller.ts` | `GET /health`, aggregating both indicators. |
| `src/health/health.module.ts` | Wires Terminus, the indicators and the controller. |
| `migrations/0001_enable_pgvector.ts` | Enables the `vector` extension. |
| `scripts/migrate.ts` | CLI entry point for `migrateToLatest` / `migrateDown`. |
| `docker-compose.yml` | PostgreSQL (pgvector) and Redis, with healthchecks. |
| `.github/workflows/ci.yml` | lint → build → migrate → e2e against real services. |
| `test/health.e2e-spec.ts` | Boots the app and asserts `/health` reports both up. |

---

### Task 1: Scaffold the Nest application

Generates the project skeleton into a repository that already contains `README.md`, `LICENSE`, `CLAUDE.md`, `.gitignore`, `.gitattributes`, `_planning/` and `docs/`. `nest new` refuses a non-empty directory, so the scaffold is produced elsewhere and copied in.

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `eslint.config.mjs`, `.prettierrc`, `.nvmrc`, `src/main.ts`, `src/app.module.ts`, `test/jest-e2e.json`
- Delete (generated boilerplate with no purpose here): `src/app.controller.ts`, `src/app.controller.spec.ts`, `src/app.service.ts`, `test/app.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable Nest app whose root module is `AppModule` in `src/app.module.ts`, exporting `class AppModule`. `npm run build`, `npm run lint`, `npm run start:dev` all work.

- [ ] **Step 1: Install and select Node 24**

```bash
# If nvm is present:
nvm install 24
nvm use 24
node -v   # expect v24.x
```

If `nvm` is not installed, install Node 24 LTS by whatever means the machine uses (Homebrew: `brew install node@24`). Do not proceed on Node 26 — the lockfile and CI are pinned to 24.

- [ ] **Step 2: Generate the scaffold outside the repository**

```bash
cd /tmp
rm -rf docent-scaffold
npx --yes @nestjs/cli@11.0.24 new docent-scaffold \
  --package-manager npm --skip-git --skip-install --strict
```

Expected: `/tmp/docent-scaffold` contains `src/`, `test/`, `package.json`, `tsconfig.json`, `eslint.config.mjs`.

- [ ] **Step 3: Copy the scaffold in, preserving existing files**

`README.md` and `.gitignore` are excluded because this repository's versions are the ones we keep — the scaffold ships its own and would overwrite them.

```bash
cd /Users/athos/Documents/github/docent
rsync -a \
  --exclude '.git' \
  --exclude 'README.md' \
  --exclude '.gitignore' \
  /tmp/docent-scaffold/ ./
rm -rf /tmp/docent-scaffold
```

- [ ] **Step 4: Remove the generated boilerplate**

```bash
rm src/app.controller.ts src/app.controller.spec.ts src/app.service.ts test/app.e2e-spec.ts
```

- [ ] **Step 5: Reduce `src/app.module.ts` to an empty root**

Feature modules are added by later tasks.

```ts
import { Module } from '@nestjs/common';

@Module({
  imports: [],
})
export class AppModule {}
```

- [ ] **Step 6: Set the package identity and pin the runtime**

Edit `package.json`: set `"name": "docent"`, `"version": "0.1.0"`, `"description": "Agentic RAG over your docs and code"`, `"license": "MIT"`, and add:

```json
"engines": {
  "node": ">=24 <25"
}
```

- [ ] **Step 7: Create `.nvmrc`**

```
24
```

- [ ] **Step 8: Tighten `tsconfig.json`**

In `compilerOptions`, add these two entries (the `--strict` scaffold sets `strictNullChecks` and `noImplicitAny` but not the umbrella flag):

```json
"strict": true,
"noUncheckedIndexedAccess": true
```

- [ ] **Step 9: Install dependencies**

```bash
npm install
```

- [ ] **Step 10: Verify the scaffold builds, lints and boots**

```bash
npm run lint
npm run build
```

Expected: both exit 0. Then:

```bash
npm run start:dev
```

Expected: Nest logs `Nest application successfully started`. Stop it with Ctrl+C. It listens but serves no routes yet — that is correct at this point.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: scaffold Nest.js application

TypeScript strict mode with noUncheckedIndexedAccess, Node 24 LTS pinned
via .nvmrc and engines. Generated boilerplate controller and service
removed — the root module stays empty until feature modules exist.

Claude-Session: https://claude.ai/code/session_011FzXB3AsT5LEFnCygRRASb
EOF
)"
```

---

### Task 2: Provision PostgreSQL and Redis with Docker Compose

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `.env` (local only, gitignored)

**Interfaces:**
- Consumes: nothing.
- Produces: a reachable PostgreSQL at `postgresql://docent:docent@localhost:${POSTGRES_PORT}/docent` and Redis at `redis://localhost:${REDIS_PORT}`. Later tasks read these through `DATABASE_URL` and `REDIS_URL`.

- [ ] **Step 1: Write `docker-compose.yml`**

Host ports are parameterised so a developer whose machine already runs these services can move them without editing the file. Docker Compose interpolates `${...}` from `.env` in the project directory automatically.

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: docent
      POSTGRES_PASSWORD: docent
      POSTGRES_DB: docent
    ports:
      - '${POSTGRES_PORT:-5432}:5432'
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U docent -d docent']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports:
      - '${REDIS_PORT:-6379}:6379'
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres-data:
  redis-data:
```

The `pgvector/pgvector` image is stock PostgreSQL with the extension precompiled, so enabling it is a one-line migration rather than a build step.

- [ ] **Step 2: Write `.env.example`**

It lists exactly the variables the code reads. Provider credentials are absent because nothing reads them yet.

```bash
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://docent:docent@localhost:5432/docent
REDIS_URL=redis://localhost:6379

# Host ports for the docker-compose services.
# Override both the port and the matching URL above if these are already taken.
# POSTGRES_PORT=5432
# REDIS_PORT=6379
```

- [ ] **Step 3: Create the local `.env`**

This machine already runs a Redis on 6379 (the `backend-service-redis-1` container), so the local Redis moves to 6380. Confirm before choosing:

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN
lsof -nP -iTCP:6379 -sTCP:LISTEN
```

Write `.env` (gitignored — verify with `git check-ignore .env`, which must print `.env`):

```bash
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://docent:docent@localhost:5432/docent
REDIS_URL=redis://localhost:6380

REDIS_PORT=6380
```

If 5432 turned out to be occupied too, set `POSTGRES_PORT` and update `DATABASE_URL` to match.

- [ ] **Step 4: Start the services**

```bash
docker compose up -d
```

- [ ] **Step 5: Verify both report healthy**

```bash
docker compose ps
```

Expected: both services `running (healthy)`. If either is `starting`, wait five seconds and re-run; if either is `unhealthy`, inspect with `docker compose logs postgres` / `docker compose logs redis`.

Confirm the extension is available for installation (not yet installed — that is Task 4):

```bash
docker compose exec postgres psql -U docent -d docent \
  -c "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';"
```

Expected: one row naming `vector`.

- [ ] **Step 6: Commit**

`.env` is gitignored and must not appear in the diff. Verify with `git status --short` before committing.

```bash
git add docker-compose.yml .env.example
git commit -m "$(cat <<'EOF'
feat: add docker-compose with pgvector and redis

Host ports are parameterised so a machine already running Postgres or
Redis can relocate them without editing the compose file. The pgvector
image ships the extension precompiled.

Claude-Session: https://claude.ai/code/session_011FzXB3AsT5LEFnCygRRASb
EOF
)"
```

---

### Task 3: Typed configuration with startup validation

A malformed or missing environment variable must kill the process at boot with a message naming the variable — not surface as a connection error on the first request.

**Files:**
- Create: `src/common/config/env.schema.ts`, `src/common/config/env.schema.spec.ts`, `src/common/config/config.module.ts`
- Modify: `src/app.module.ts`, `src/main.ts`

**Interfaces:**
- Consumes: `AppModule` from Task 1.
- Produces:
  - `envSchema` — the zod schema.
  - `type Env = z.infer<typeof envSchema>` with fields `NODE_ENV: 'development' | 'test' | 'production'`, `PORT: number`, `DATABASE_URL: string`, `REDIS_URL: string`.
  - `validateEnv(raw: Record<string, unknown>): Env` — throws on invalid input.
  - `class AppConfigModule` — registers `ConfigModule` globally. Downstream code injects `ConfigService<Env, true>` and reads values with `config.get('PORT', { infer: true })`.

- [ ] **Step 1: Install the dependencies**

```bash
npm install @nestjs/config zod
```

- [ ] **Step 2: Write the failing test**

Create `src/common/config/env.schema.spec.ts`:

```ts
import { validateEnv } from './env.schema';

const valid = {
  DATABASE_URL: 'postgresql://docent:docent@localhost:5432/docent',
  REDIS_URL: 'redis://localhost:6379',
};

describe('validateEnv', () => {
  it('applies defaults for the optional variables', () => {
    const env = validateEnv({ ...valid });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('coerces PORT from its string form', () => {
    const env = validateEnv({ ...valid, PORT: '8080' });

    expect(env.PORT).toBe(8080);
  });

  it('names the offending variable when one is missing', () => {
    expect(() => validateEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a malformed URL', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: 'not-a-url' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- env.schema
```

Expected: FAIL — `Cannot find module './env.schema'`.

- [ ] **Step 4: Write `src/common/config/env.schema.ts`**

```ts
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test -- env.schema
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Write `src/common/config/config.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnv } from './env.schema';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
```

- [ ] **Step 7: Register it in `src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module';

@Module({
  imports: [AppConfigModule],
})
export class AppModule {}
```

- [ ] **Step 8: Use the validated port in `src/main.ts`**

```ts
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module';
import type { Env } from './common/config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Without this, OnApplicationShutdown never fires and pooled connections leak
  // when the process receives SIGTERM.
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
```

- [ ] **Step 9: Verify the application boots with a valid `.env`**

```bash
npm run start:dev
```

Expected: starts on port 3000. Stop with Ctrl+C.

- [ ] **Step 10: Verify it refuses to boot without a required variable**

```bash
mv .env .env.backup
DATABASE_URL= REDIS_URL=redis://localhost:6380 npm run start:dev
```

Expected: the process exits with `Invalid environment configuration:` followed by a line naming `DATABASE_URL`. Then restore:

```bash
mv .env.backup .env
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: add typed configuration with startup validation

Environment is parsed by zod before the server accepts connections, so a
missing or malformed variable fails the boot with a message naming it
rather than surfacing as a connection error on the first request.

Claude-Session: https://claude.ai/code/session_011FzXB3AsT5LEFnCygRRASb
EOF
)"
```

---

### Task 4: Database access and migrations

**Files:**
- Create: `src/common/database/schema.ts`, `src/common/database/database.module.ts`, `migrations/0001_enable_pgvector.ts`, `scripts/migrate.ts`
- Modify: `src/app.module.ts`, `package.json`

**Interfaces:**
- Consumes: `Env` and `AppConfigModule` from Task 3.
- Produces:
  - `type DB` — the Kysely schema interface, empty in M0.
  - `const KYSELY: symbol` — the injection token. Consumers write `@Inject(KYSELY) private readonly db: Kysely<DB>`.
  - `class DatabaseModule` — global; exports `KYSELY`; destroys the pool in `onApplicationShutdown`.
  - `npm run migrate` and `npm run migrate:down`.

- [ ] **Step 1: Install the dependencies**

```bash
npm install kysely pg
npm install --save-dev @types/pg tsx
```

- [ ] **Step 2: Write `src/common/database/schema.ts`**

```ts
/**
 * The Kysely schema interface, written by hand rather than generated, so that
 * types do not require a running database to produce. Tables are declared here
 * as the features that own them ship.
 *
 * Kysely creates and manages its own migration bookkeeping tables; they are
 * intentionally absent.
 */
export type DB = Record<never, never>;
```

- [ ] **Step 3: Write `src/common/database/database.module.ts`**

```ts
import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { Env } from '../config/env.schema';
import type { DB } from './schema';

export const KYSELY = Symbol('KYSELY');

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Kysely<DB> =>
        new Kysely<DB>({
          dialect: new PostgresDialect({
            pool: new Pool({
              connectionString: config.get('DATABASE_URL', { infer: true }),
            }),
          }),
        }),
    },
  ],
  exports: [KYSELY],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
```

The pool connects lazily, so the application starts even when PostgreSQL is unreachable. The health endpoint is what reports the difference.

- [ ] **Step 4: Write `migrations/0001_enable_pgvector.ts`**

`Kysely<any>` is what Kysely's documentation prescribes for migrations: a migration runs against the schema as it existed at that point in history, not against the current `DB` interface.

```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP EXTENSION IF EXISTS vector`.execute(db);
}
```

- [ ] **Step 5: Write `scripts/migrate.ts`**

```ts
/* eslint-disable @typescript-eslint/no-explicit-any, no-console */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const direction = process.argv[2] === 'down' ? 'down' : 'latest';

  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(process.cwd(), 'migrations'),
    }),
  });

  const { error, results } =
    direction === 'down'
      ? await migrator.migrateDown()
      : await migrator.migrateToLatest();

  for (const result of results ?? []) {
    const outcome = result.status === 'Success' ? 'applied' : result.status;
    console.log(`${outcome}: ${result.migrationName}`);
  }

  await db.destroy();

  if (error) {
    console.error('migration failed:', error);
    process.exit(1);
  }

  if (!results?.length) {
    console.log('no pending migrations');
  }
}

void main();
```

- [ ] **Step 6: Add the npm scripts**

In `package.json`, add to `scripts`:

```json
"migrate": "node --env-file-if-exists=.env --import tsx scripts/migrate.ts",
"migrate:down": "node --env-file-if-exists=.env --import tsx scripts/migrate.ts down"
```

`--env-file-if-exists` reads `.env` when present and falls through to the process environment otherwise, which is exactly the difference between this machine and CI.

- [ ] **Step 7: Register the module in `src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module';
import { DatabaseModule } from './common/database/database.module';

@Module({
  imports: [AppConfigModule, DatabaseModule],
})
export class AppModule {}
```

- [ ] **Step 8: Run the migration**

```bash
npm run migrate
```

Expected: `applied: 0001_enable_pgvector`.

- [ ] **Step 9: Verify the extension is installed**

```bash
docker compose exec postgres psql -U docent -d docent \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

Expected: one row for `vector`.

- [ ] **Step 10: Verify the migration is idempotent and reversible**

```bash
npm run migrate          # expect: no pending migrations
npm run migrate:down     # expect: applied/Success: 0001_enable_pgvector
npm run migrate          # expect: applied: 0001_enable_pgvector
```

- [ ] **Step 11: Verify lint and build still pass**

```bash
npm run lint
npm run build
```

Expected: both exit 0.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: add Kysely database module and pgvector migration

Kysely runs over a lazily-connecting pg pool, so the app boots even when
Postgres is down and readiness is reported by the health endpoint instead.
Migrations are hand-written SQL run by Kysely's native migrator, because
CREATE EXTENSION and index tuning fall outside what a schema differ covers.

Claude-Session: https://claude.ai/code/session_011FzXB3AsT5LEFnCygRRASb
EOF
)"
```

---

### Task 5: Health endpoint probing both dependencies

`GET /health` must distinguish "the process is alive" from "the process is connected". It returns 200 only when `select 1` succeeds against PostgreSQL and `PING` succeeds against Redis; otherwise 503.

**Files:**
- Create: `src/common/with-timeout.ts`, `src/common/with-timeout.spec.ts`, `src/common/redis/redis.module.ts`, `src/health/indicators/database.indicator.ts`, `src/health/indicators/redis.indicator.ts`, `src/health/health.controller.ts`, `src/health/health.module.ts`, `test/health.e2e-spec.ts`
- Modify: `src/app.module.ts`, `package.json`

**Interfaces:**
- Consumes: `KYSELY` and `DB` from Task 4; `Env` from Task 3.
- Produces:
  - `withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>`
  - `const REDIS: symbol` — injection token for the `Redis` client.
  - `class RedisModule` — global; exports `REDIS`.
  - `class DatabaseHealthIndicator` with `isHealthy(key: string): Promise<HealthIndicatorResult>`
  - `class RedisHealthIndicator` with the same signature.
  - `GET /health`.

- [ ] **Step 1: Install the dependencies**

```bash
npm install @nestjs/terminus ioredis
```

- [ ] **Step 2: Write the failing test for the timeout helper**

Create `src/common/with-timeout.spec.ts`:

```ts
import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('resolves with the underlying value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('propagates the underlying rejection', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 50),
    ).rejects.toThrow('boom');
  });

  it('rejects once the deadline passes', async () => {
    const never = new Promise<string>(() => {});

    await expect(withTimeout(never, 10)).rejects.toThrow(/timed out after 10ms/);
  });

  it('clears its timer so a resolved call leaves no handle behind', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    await withTimeout(Promise.resolve('ok'), 50);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npm test -- with-timeout
```

Expected: FAIL — `Cannot find module './with-timeout'`.

- [ ] **Step 4: Write `src/common/with-timeout.ts`**

```ts
/**
 * Bounds a promise by a deadline. A dependency that accepts a TCP connection but
 * never answers would otherwise hang the caller indefinitely, since neither the
 * pg pool nor ioredis fails such a request on its own.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npm test -- with-timeout
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Write `src/common/redis/redis.module.ts`**

```ts
import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { Env } from '../config/env.schema';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Redis => {
        const client = new Redis(config.get('REDIS_URL', { infer: true }), {
          maxRetriesPerRequest: 1,
        });

        // ioredis emits 'error' on every reconnection attempt. An EventEmitter
        // with no listener for that event throws, which would take the process
        // down in exactly the situation the health check exists to report.
        const logger = new Logger('Redis');
        client.on('error', (error: Error) => logger.warn(error.message));

        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit();
  }
}
```

- [ ] **Step 7: Write `src/health/indicators/database.indicator.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { Kysely, sql } from 'kysely';

import { KYSELY } from '../../common/database/database.module';
import type { DB } from '../../common/database/schema';
import { withTimeout } from '../../common/with-timeout';

const PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await withTimeout(sql`select 1`.execute(this.db), PROBE_TIMEOUT_MS);
      return indicator.up();
    } catch (error) {
      return indicator.down(
        error instanceof Error ? error.message : 'unreachable',
      );
    }
  }
}
```

- [ ] **Step 8: Write `src/health/indicators/redis.indicator.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import type Redis from 'ioredis';

import { REDIS } from '../../common/redis/redis.module';
import { withTimeout } from '../../common/with-timeout';

const PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS) private readonly client: Redis,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await withTimeout(this.client.ping(), PROBE_TIMEOUT_MS);
      return indicator.up();
    } catch (error) {
      return indicator.down(
        error instanceof Error ? error.message : 'unreachable',
      );
    }
  }
}
```

- [ ] **Step 9: Write `src/health/health.controller.ts`**

```ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.database.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
```

- [ ] **Step 10: Write `src/health/health.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, RedisHealthIndicator],
})
export class HealthModule {}
```

- [ ] **Step 11: Wire everything into `src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module';
import { DatabaseModule } from './common/database/database.module';
import { RedisModule } from './common/redis/redis.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [AppConfigModule, DatabaseModule, RedisModule, HealthModule],
})
export class AppModule {}
```

- [ ] **Step 12: Write the end-to-end test**

Create `test/health.e2e-spec.ts`:

```ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports both dependencies up', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.info.database.status).toBe('up');
    expect(response.body.info.redis.status).toBe('up');
  });
});
```

- [ ] **Step 13: Run the e2e test**

The compose services must be running (`docker compose ps`).

```bash
npm run test:e2e
```

Expected: PASS, 1 test.

- [ ] **Step 14: Verify the endpoint by hand, both healthy and degraded**

```bash
npm run start:dev
```

In a second terminal:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health   # expect 200
curl -s localhost:3000/health | jq                               # both 'up'
```

Now stop PostgreSQL and observe the endpoint change:

```bash
docker compose stop postgres
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health   # expect 503
curl -s localhost:3000/health | jq '.error.database'             # status 'down'

docker compose start postgres
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health   # expect 200
```

The application must have stayed up throughout. If it crashed when PostgreSQL or Redis went away, that is a defect in this task — fix it before committing.

Stop the dev server with Ctrl+C.

- [ ] **Step 15: Verify lint and build**

```bash
npm run lint
npm run build
```

Expected: both exit 0.

- [ ] **Step 16: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: add health endpoint probing Postgres and Redis

A static 200 cannot distinguish a process that booted from one that
connected, so both dependencies are queried for real and each probe is
bounded by a deadline. The endpoint reports 503 while a dependency is
unreachable and recovers on its own once it returns.

Claude-Session: https://claude.ai/code/session_011FzXB3AsT5LEFnCygRRASb
EOF
)"
```

---

### Task 6: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the npm scripts from Tasks 1, 4 and 5 — `lint`, `build`, `test`, `migrate`, `test:e2e`.
- Produces: a green CI run on every push and pull request.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

Service containers always publish on their default host ports, so the URLs here use 5432 and 6379 regardless of what the local `.env` overrides.

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: pgvector/pgvector:pg17
        env:
          POSTGRES_USER: docent
          POSTGRES_PASSWORD: docent
          POSTGRES_DB: docent
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U docent -d docent"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      NODE_ENV: test
      DATABASE_URL: postgresql://docent:docent@localhost:5432/docent
      REDIS_URL: redis://localhost:6379

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm

      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm test
      - run: npm run migrate
      - run: npm run test:e2e
```

- [ ] **Step 2: Reproduce the CI environment locally before pushing**

This runs the same commands CI will, reading configuration from the environment rather than from `.env` — which is the part most likely to break.

```bash
mv .env .env.backup
NODE_ENV=test \
DATABASE_URL=postgresql://docent:docent@localhost:5432/docent \
REDIS_URL=redis://localhost:6380 \
  npm run migrate
mv .env.backup .env
```

Expected: `no pending migrations` (the migration already ran in Task 4). It must not fail with `DATABASE_URL is not set`.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: run lint, build, tests and migrations against real services

Service containers for pgvector and Redis let the workflow apply the
migration and exercise the health endpoint, so a broken migration or a
misconfigured connection fails the pull request instead of the next
manual run.

Claude-Session: https://claude.ai/code/session_011FzXB3AsT5LEFnCygRRASb
EOF
)"
git push -u origin m0-bootstrap
```

- [ ] **Step 4: Verify the run is green**

```bash
gh run watch
```

Expected: all six steps succeed. If a step fails, fix it and push again — do not proceed to Task 7 with red CI.

---

### Task 7: Document the milestone

**Files:**
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: the npm scripts and workflow from all previous tasks.
- Produces: documentation that matches what the code actually does.

- [ ] **Step 1: Fill in the Commands section of `CLAUDE.md`**

Replace the placeholder block under `## Commands` with:

````markdown
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
````

Then replace the `## Current status — greenfield` section, which no longer holds, with:

```markdown
## Current status — M0 complete

The service boots, connects to PostgreSQL and Redis, and reports readiness at
`GET /health`. There is no ingestion or retrieval yet. **Next milestone: M1**
(ingestion pipeline) — see `_planning/03-roadmap.md`.
```

- [ ] **Step 2: Tick M0 in `README.md`**

Change the roadmap line to:

```markdown
- [x] **M0 — Bootstrap & infra** (Nest scaffold, docker-compose, config, CI skeleton, health check)
```

- [ ] **Step 3: Replace the Getting started placeholder in `README.md`**

The section currently carries a "🚧 Target setup (work in progress — commands will land as milestones ship)" note above commands that did not exist. The setup commands are now real; the ingest and ask examples are not. Remove the section-wide warning, keep the setup block as it stands, and move the warning onto the two commands that remain aspirational:

````markdown
## Getting started

```bash
git clone https://github.com/athosmartinez/docent.git
cd docent

cp .env.example .env          # add your provider API keys
docker compose up -d          # PostgreSQL + pgvector + Redis

npm install
npm run migrate
npm run start:dev             # API on http://localhost:3000
```

Verify it came up:

```bash
curl localhost:3000/health
# {"status":"ok","info":{"database":{"status":"up"},"redis":{"status":"up"}}}
```

> 🚧 Planned — ingestion (M1) and querying (M2) are not implemented yet.

```bash
# ingest a documentation folder or a git repo
curl -X POST localhost:3000/ingest -d '{ "source": "https://github.com/some/library" }'

# ask, and get an answer with citations
curl -X POST localhost:3000/ask -d '{ "question": "How do I configure retries?" }'
```
````

Note that `cp .env.example .env` no longer needs provider API keys at this milestone — adjust that comment to `# database and redis connection strings`.

- [ ] **Step 4: Verify every documented command actually works**

Run each command in the `CLAUDE.md` block from a clean state and confirm it does what the documentation claims. A command that is documented but broken is worse than one that is absent.

```bash
docker compose down
docker compose up -d
sleep 10
npm run migrate
npm test
npm run test:e2e
npm run build
```

Expected: all succeed.

- [ ] **Step 5: Commit and push**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: record M0 commands and mark the milestone complete

The README no longer warns that setup is aspirational, because it is not;
the warning moves onto the ingest and ask examples, which still are.

Claude-Session: https://claude.ai/code/session_011FzXB3AsT5LEFnCygRRASb
EOF
)"
git push
```

- [ ] **Step 6: Confirm the definition of done**

Walk the spec's DoD list and check each item:

1. `docker compose up -d` brings both services to healthy.
2. `npm run migrate` applies `0001_enable_pgvector`; `pg_extension` lists `vector`.
3. `npm run start:dev` boots on the configured port.
4. `GET /health` returns 200 with both indicators up.
5. Stopping PostgreSQL makes it return 503 with `database` in `error`; restarting restores 200.
6. Removing a required variable makes the process exit at startup naming that variable.
7. CI is green, including the migration and e2e steps.

Any item that does not hold is a defect to fix before opening the pull request.

---

## Notes for the reviewer

- **Tasks 3, 4 and 5 depend on the compose services running.** Start them (`docker compose up -d`) before Task 3 and leave them up.
- **Task 5 is the largest.** It ships the Redis provider, both indicators, the controller and the e2e test together because none of them is independently demonstrable — a Redis module with no consumer cannot be verified, and an indicator with no controller cannot be called.
- **The pull request targets `main` with `m0-bootstrap` as head**, per the repository's git conventions.
