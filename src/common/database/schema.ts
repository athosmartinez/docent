import type { ColumnType, Generated } from 'kysely';

/**
 * The dimensionality the chunks table declares. Configuration is validated
 * against this at boot, so switching embedding models without migrating the
 * column fails at startup rather than on the first insert.
 */
export const CHUNK_EMBEDDING_DIMENSIONS = 3072;

/**
 * A pgvector column. The driver exchanges it as a text literal in every
 * direction — see toVectorLiteral / parseVectorLiteral.
 */
type VectorColumn = ColumnType<string, string, string>;

export interface SourcesTable {
  id: Generated<string>;
  uri: string;
  type: string;
  status: string;
  error: string | null;
  commit_sha: string | null;
  document_count: Generated<number>;
  chunk_count: Generated<number>;
  metadata: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DocumentsTable {
  id: Generated<string>;
  source_id: string;
  path: string;
  title: string | null;
  metadata: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
}

export interface ChunksTable {
  id: Generated<string>;
  document_id: string;
  ordinal: number;
  content: string;
  heading_path: string[];
  token_count: number;
  embedding: VectorColumn;
  metadata: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
}

/**
 * The Kysely schema interface, written by hand rather than generated, so that
 * types do not require a running database to produce. Tables are declared here
 * as the features that own them ship.
 *
 * Kysely creates and manages its own migration bookkeeping tables; they are
 * intentionally absent. The generated `content_tsv` column is also absent —
 * PostgreSQL maintains it and application code never writes it.
 */
export interface DB {
  sources: SourcesTable;
  documents: DocumentsTable;
  chunks: ChunksTable;
}
