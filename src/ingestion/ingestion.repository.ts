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
        .set({ document_count: 0, chunk_count: 0, updated_at: new Date() })
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
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  async markReady(id: string): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({ status: 'ready', updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({ status: 'failed', error, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async recordSkipped(id: string, skipped: number): Promise<void> {
    await this.db
      .updateTable('sources')
      .set({ metadata: { skipped_documents: skipped }, updated_at: new Date() })
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
          updated_at: new Date(),
        })
        .where('id', '=', sourceId)
        .execute();
    });
  }
}
