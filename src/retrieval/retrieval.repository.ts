import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';

import { KYSELY } from '../common/database/database.module';
import type { DB } from '../common/database/schema';
import { toVectorLiteral } from '../common/database/vector';
import type { RankedChunk, VectorRankedChunk } from './retrieval.types';

interface Row {
  chunk_id: string;
  document_path: string;
  heading_path: string[];
  content: string;
}

interface VectorRow extends Row {
  distance: number;
}

const toRanked = (row: Row): RankedChunk => ({
  chunkId: row.chunk_id,
  documentPath: row.document_path,
  headingPath: row.heading_path,
  content: row.content,
});

const toVectorRanked = (row: VectorRow): VectorRankedChunk => ({
  ...toRanked(row),
  distance: row.distance,
});

@Injectable()
export class RetrievalRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /**
   * The cast to halfvec is repeated in ORDER BY rather than ordering by the
   * selected alias: the HNSW index is declared on the cast expression, and the
   * planner only matches it when the ORDER BY expression is written the same
   * way. Ordering by the alias silently degrades to a sequential scan over
   * every chunk.
   */
  async searchByVector(
    embedding: number[],
    limit: number,
  ): Promise<VectorRankedChunk[]> {
    const literal = toVectorLiteral(embedding);

    const result = await sql<VectorRow>`
      SELECT c.id AS chunk_id, d.path AS document_path,
             c.heading_path, c.content,
             c.embedding::halfvec(3072) <=> ${literal}::halfvec(3072) AS distance
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN sources   s ON s.id = d.source_id
      WHERE s.status = 'ready' AND c.embedding IS NOT NULL
      ORDER BY c.embedding::halfvec(3072) <=> ${literal}::halfvec(3072)
      LIMIT ${limit}
    `.execute(this.db);

    return result.rows.map(toVectorRanked);
  }

  /**
   * plainto_tsquery ANDs every term, so a natural-language question matches
   * nothing — measured against this corpus, "How do I validate the request
   * body of a POST endpoint?" returns zero rows. websearch_to_tsquery is not
   * the fix: on prose it produces the identical AND, and only diverges when
   * the user types quotes, `or` or `-`.
   *
   * Rewriting plainto_tsquery's own output to OR keeps its sanitisation,
   * stemming and stopword removal, which is why the question is not tokenised
   * in TypeScript: plainto_tsquery never emits operators, so hostile input
   * cannot survive into the rewritten query. Input that reduces to nothing
   * yields an empty tsquery and a NOTICE, not an exception, and an empty
   * tsquery matches no rows.
   */
  async searchByText(question: string, limit: number): Promise<RankedChunk[]> {
    const result = await sql<Row>`
      WITH q AS (
        SELECT to_tsquery('english',
                 replace(plainto_tsquery('english', ${question})::text,
                         ' & ', ' | ')) AS tsq
      )
      SELECT c.id AS chunk_id, d.path AS document_path,
             c.heading_path, c.content
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN sources   s ON s.id = d.source_id
      CROSS JOIN q
      WHERE s.status = 'ready' AND c.content_tsv @@ q.tsq
      ORDER BY ts_rank(c.content_tsv, q.tsq) DESC
      LIMIT ${limit}
    `.execute(this.db);

    return result.rows.map(toRanked);
  }
}
