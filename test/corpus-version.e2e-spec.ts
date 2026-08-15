import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { AppModule } from '../src/app.module';
import { CorpusVersion } from '../src/common/cache/corpus-version';
import { KYSELY } from '../src/common/database/database.module';
import type { DB } from '../src/common/database/schema';

/**
 * Every class that queries Postgres directly in this codebase (the
 * `*.repository.ts` classes) is tested exclusively against a real database,
 * never through a mocked Kysely double — there is no precedent anywhere in
 * this repo for a `.spec.ts` file standing in for that. `CorpusVersion` is
 * that same shape of class, so its behavioural claims — that the version
 * changes exactly when a `ready` source is added, removed, or touched, and
 * not otherwise — live here rather than in a `src/common/cache/*.spec.ts`
 * unit file. A mocked Kysely double could only prove the string-formatting
 * around a canned row, which is not the property that matters: the whole
 * point of deriving the version from Postgres is that the two can never
 * disagree, and only a real query against real rows can demonstrate that.
 *
 * There's a second, harder constraint pointing the same way: `npm test`
 * (this suite's neighbour) runs *before* `npm run migrate` in CI, so a
 * `sources`-querying test living under the unit config would fail with
 * "relation does not exist" on every CI run, not merely be redundant.
 *
 * `current()` reads the *whole* `sources` table by design — that's the
 * point of it — and the e2e runner shares one Postgres instance across
 * several suites running concurrently (`ask.repository`, `retrieval`,
 * `ingestion`, `ingestion.concurrency`, `ingestion.heartbeat`, plus this
 * file's own sibling `ask.e2e`), several of which insert, delete or flip the
 * status of `ready` sources as part of their own fixtures. A test here that
 * read `before`/`after` values as two ordinary queries would be racing every
 * one of them: any sibling committing a `ready`-row change in the gap
 * between the two reads changes the version for a reason that has nothing
 * to do with what the test just did, and a "does not change" assertion has
 * no way to tell the difference from its own actual claim being false.
 * Wrapping each test's whole read-mutate-read sequence in one `REPEATABLE
 * READ` transaction fixes that: Postgres takes that transaction's snapshot
 * at its first statement and holds it for every later statement in the same
 * transaction, so no other session's commits — however many, however
 * mid-test — become visible partway through. The transaction still sees its
 * *own* writes, so the mutation each test makes is visible to its own
 * `after` read, exactly as if the table were private to it. Rolling back
 * instead of committing at the end makes every test self-cleaning: nothing
 * it wrote is ever visible outside its own transaction, so there is no
 * `sources` row left over to track or delete.
 */
describe('CorpusVersion', () => {
  let app: INestApplication<Server>;
  let db: Kysely<DB>;
  let corpusVersion: CorpusVersion;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get<Kysely<DB>>(KYSELY);
    corpusVersion = app.get(CorpusVersion);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Runs `fn` inside a snapshot-isolated, always-rolled-back transaction. */
  async function isolated(
    fn: (trx: Kysely<DB>) => Promise<void>,
  ): Promise<void> {
    const trx = await db
      .startTransaction()
      .setIsolationLevel('repeatable read')
      .execute();
    try {
      await fn(trx);
    } finally {
      await trx.rollback().execute();
    }
  }

  async function insertSource(
    trx: Kysely<DB>,
    status: string,
  ): Promise<string> {
    const row = await trx
      .insertInto('sources')
      .values({
        uri: `corpus-version-e2e-${randomUUID()}`,
        type: 'docs',
        status,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

  it('changes when a ready source is added', () =>
    isolated(async (trx) => {
      const before = await corpusVersion.current(trx);
      await insertSource(trx, 'ready');
      const after = await corpusVersion.current(trx);

      expect(after).not.toBe(before);
    }));

  it('changes when a ready source is deleted', () =>
    isolated(async (trx) => {
      const id = await insertSource(trx, 'ready');
      const before = await corpusVersion.current(trx);

      await trx.deleteFrom('sources').where('id', '=', id).execute();
      const after = await corpusVersion.current(trx);

      expect(after).not.toBe(before);
    }));

  it("changes when an existing ready source's updated_at moves", () =>
    isolated(async (trx) => {
      const id = await insertSource(trx, 'ready');
      const before = await corpusVersion.current(trx);

      // Far enough in the future that this row is unambiguously the
      // transaction's newest `ready` row regardless of what already existed
      // in the corpus when this snapshot was taken.
      await trx
        .updateTable('sources')
        .set({ updated_at: new Date('2099-01-01T00:00:00.000Z') })
        .where('id', '=', id)
        .execute();
      const after = await corpusVersion.current(trx);

      expect(after).not.toBe(before);
    }));

  it('does not change when a failed source is added', () =>
    isolated(async (trx) => {
      const before = await corpusVersion.current(trx);
      await insertSource(trx, 'failed');
      const after = await corpusVersion.current(trx);

      expect(after).toBe(before);
    }));

  // Every test above that deletes a row deletes the one it just inserted —
  // which, having just been inserted, is by construction the newest `ready`
  // source, so `max(updated_at)` alone already registers its removal. That
  // leaves the count term unexercised on the one shape of change only it can
  // see: a `ready` source disappearing while a *different* one remains the
  // newest. Without the count term, deleting an old, superseded source would
  // leave the version — and so the cache key — unchanged, and every answer
  // grounded in that source's now-gone chunks would stay servable from cache
  // for the rest of its TTL.
  it('changes when a ready source that is not the newest is deleted', () =>
    isolated(async (trx) => {
      const olderId = await insertSource(trx, 'ready');
      await trx
        .updateTable('sources')
        .set({ updated_at: new Date('2020-01-01T00:00:00.000Z') })
        .where('id', '=', olderId)
        .execute();

      // Unambiguously the newest, so deleting `olderId` below leaves
      // max(updated_at) exactly where it was — only the count can move.
      const newerId = await insertSource(trx, 'ready');
      await trx
        .updateTable('sources')
        .set({ updated_at: new Date('2099-01-01T00:00:00.000Z') })
        .where('id', '=', newerId)
        .execute();

      const before = await corpusVersion.current(trx);
      await trx.deleteFrom('sources').where('id', '=', olderId).execute();
      const after = await corpusVersion.current(trx);

      expect(after).not.toBe(before);
    }));

  // Every test above sandwiches a source mutation between the two calls, so
  // a version that varies for a reason unrelated to `sources` — the wall
  // clock, an in-memory counter, a random component — could still pass all
  // of them: something real happens either side of the difference, and nothing
  // here proves the difference is *because* of it. Calling `current()` twice
  // with no write at all in between is the one shape of test where a version
  // tied to nothing has no cover, and it is the shape the invalidation
  // guarantee actually depends on: two requests for the same question,
  // milliseconds apart, must land on the same key or the cache never hits.
  it('returns the same value across two calls with nothing changed in between', () =>
    isolated(async (trx) => {
      const first = await corpusVersion.current(trx);
      const second = await corpusVersion.current(trx);

      expect(second).toBe(first);
    }));
});
