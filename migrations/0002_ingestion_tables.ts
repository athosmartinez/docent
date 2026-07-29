import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE sources (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      uri            text NOT NULL UNIQUE,
      type           text NOT NULL,
      status         text NOT NULL,
      error          text,
      commit_sha     text,
      document_count integer NOT NULL DEFAULT 0,
      chunk_count    integer NOT NULL DEFAULT 0,
      metadata       jsonb NOT NULL DEFAULT '{}',
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE documents (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_id  uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      path       text NOT NULL,
      title      text,
      metadata   jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_id, path)
    )
  `.execute(db);

  await sql`
    CREATE TABLE chunks (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ordinal      integer NOT NULL,
      content      text NOT NULL,
      heading_path text[] NOT NULL DEFAULT '{}',
      token_count  integer NOT NULL,
      embedding    vector(3072),
      content_tsv  tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
      metadata     jsonb NOT NULL DEFAULT '{}',
      created_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (document_id, ordinal)
    )
  `.execute(db);

  // pgvector indexes a `vector` column up to 2000 dimensions but a `halfvec` up
  // to 4000, so the index casts to half precision while storage keeps the full
  // value. Approximate search is what HNSW does regardless.
  await sql`
    CREATE INDEX chunks_embedding_idx ON chunks
      USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
  `.execute(db);

  await sql`CREATE INDEX chunks_content_tsv_idx ON chunks USING gin (content_tsv)`.execute(
    db,
  );
  await sql`CREATE INDEX chunks_document_id_idx ON chunks (document_id)`.execute(
    db,
  );
  await sql`CREATE INDEX documents_source_id_idx ON documents (source_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS chunks`.execute(db);
  await sql`DROP TABLE IF EXISTS documents`.execute(db);
  await sql`DROP TABLE IF EXISTS sources`.execute(db);
}
