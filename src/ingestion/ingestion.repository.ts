import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, type Selectable } from 'kysely';

import { KYSELY } from '../common/database/database.module';
import type { DB, SourcesTable } from '../common/database/schema';
import { toVectorLiteral } from '../common/database/vector';

export type SourceRow = Selectable<SourcesTable>;

export interface DocumentInput {
  path: string;
  title: string | null;
}

export interface ChunkInput {
  ordinal: number;
  content: string;
  headingPath: string[];
  tokenCount: number;
  embedding: number[];
  metadata: Record<string, unknown>;
}

/**
 * Every write to `sources.updated_at` below uses Postgres's own clock
 * (`sql\`now()\``), never `new Date()` from the application. CorpusVersion's
 * soundness rests on one thing: a newly-`ready` source's timestamp exceeds
 * every other `ready` source's. That holds under one monotonic clock; it
 * does not hold under two. With an application clock and a database clock
 * disagreeing — ordinary skew, or a backwards NTP step on the host running
 * ingestion — a source can be fully re-ingested, its old chunks deleted, new
 * ones committed, `markReady` run, and still not become the corpus's newest
 * `ready` row, so the version never moves and the answer cache keeps
 * serving every answer grounded in the old chunks until its TTL expires,
 * with no error and no symptom. A single clock closes that trigger for a
 * single-database deployment; it does not make the mechanism airtight in
 * general (concurrent ingestion runs can still commit out of start order),
 * which is what CACHE_ANSWER_TTL_S ultimately bounds.
 */
@Injectable()
export class IngestionRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  async createSource(uri: string, type: string): Promise<string> {
    const row = await this.db
      .insertInto('sources')
      .values({ uri, type, status: 'pending' })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

  findSourceByUri(uri: string): Promise<SourceRow | undefined> {
    return this.db
      .selectFrom('sources')
      .selectAll()
      .where('uri', '=', uri)
      .executeTakeFirst();
  }

  findSource(id: string): Promise<SourceRow | undefined> {
    return this.db
      .selectFrom('sources')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  listSources(): Promise<SourceRow[]> {
    return this.db
      .selectFrom('sources')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
  }

  async deleteSource(id: string): Promise<void> {
    await this.db.deleteFrom('sources').where('id', '=', id).execute();
  }

  /**
   * Removes what a previous run wrote, so re-ingesting a source replaces its
   * content instead of leaving two generations of chunks competing in search.
   * Documents cascade to chunks.
   */
  async deleteSourceContent(sourceId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('documents')
        .where('source_id', '=', sourceId)
        .execute();
      await trx
        .updateTable('sources')
        .set({ document_count: 0, chunk_count: 0, updated_at: sql`now()` })
        .where('id', '=', sourceId)
        .execute();
    });
  }

  async markProcessing(id: string, commitSha: string | null): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({
        status: 'processing',
        commit_sha: commitSha,
        error: null,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Postgres's own `now()`. `claimForProcessing` below already stamps the
   * row it claims with the database's `now()`, never the application's — a
   * caller computing a staleness threshold (`now() - leaseMs`) needs that
   * same clock, or it ends up comparing a lease renewed moments ago by one
   * clock against a threshold computed from a different, disagreeing one,
   * which can make a genuinely live run look expired.
   */
  async databaseNow(): Promise<Date> {
    const result = await sql<{ now: Date }>`SELECT now() AS now`.execute(
      this.db,
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error('SELECT now() returned no rows');
    }

    return row.now;
  }

  /**
   * Atomically transitions a source to `processing`, but only if it is
   * actually claimable: not currently mid-run, or mid-run but stale (its
   * lease — `updated_at` — has expired). A single conditional `UPDATE`
   * rather than a read followed by a separate write means two concurrent
   * callers can't both observe "claimable" and both proceed — Postgres
   * serializes the two updates against the same row, and the loser's WHERE
   * clause re-evaluates against the winner's already-committed state and
   * matches nothing. Returns the updated row on success, `undefined` if
   * another live run already holds the claim.
   */
  async claimForProcessing(
    id: string,
    staleBefore: Date,
  ): Promise<SourceRow | undefined> {
    const result = await sql<SourceRow>`
      UPDATE sources
      SET status = 'processing', commit_sha = NULL, error = NULL, updated_at = now()
      WHERE id = ${id}::uuid
        AND (status NOT IN ('pending', 'processing') OR updated_at < ${staleBefore})
      RETURNING *
    `.execute(this.db);

    return result.rows[0];
  }

  /**
   * Renews a live run's lease independently of document boundaries, so a
   * single slow document cannot make a genuinely active run look dead to a
   * competing claim. Guarded on `status = 'processing'` so a heartbeat can
   * only ever extend the run that is still the one holding the source —
   * never a run that has already finished (`ready`/`failed`) or been
   * reclaimed out from under it.
   */
  async touchProcessing(id: string): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({ updated_at: sql`now()` })
      .where('id', '=', id)
      .where('status', '=', 'processing')
      .execute();
  }

  async markReady(id: string): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({ status: 'ready', updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({ status: 'failed', error, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async recordSkipped(id: string, skipped: number): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({ metadata: { skipped_documents: skipped }, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  /**
   * One transaction per document: either the document and all of its chunks
   * land, or neither does. A partial document would retrieve as if it were
   * complete.
   */
  async insertDocumentWithChunks(
    sourceId: string,
    document: DocumentInput,
    chunks: ChunkInput[],
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('documents')
        .values({
          source_id: sourceId,
          path: document.path,
          title: document.title,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      if (chunks.length > 0) {
        await trx
          .insertInto('chunks')
          .values(
            chunks.map((chunk) => ({
              document_id: inserted.id,
              ordinal: chunk.ordinal,
              content: chunk.content,
              heading_path: chunk.headingPath,
              token_count: chunk.tokenCount,
              embedding: toVectorLiteral(chunk.embedding),
              metadata: chunk.metadata,
            })),
          )
          .execute();
      }

      await trx
        .updateTable('sources')
        .set({
          document_count: sql`document_count + 1`,
          chunk_count: sql`chunk_count + ${chunks.length}`,
          updated_at: sql`now()`,
        })
        .where('id', '=', sourceId)
        .execute();
    });
  }
}
