import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE queries (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      question   text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE answers (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      query_id      uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
      answer        text,
      grounded      boolean NOT NULL,
      model         text,
      provider      text,
      finish_reason text,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  // chunk_id is a real foreign key rather than a jsonb blob because the
  // evaluation suite measures recall by joining a citation to an annotated
  // chunk. ON DELETE CASCADE means re-ingesting a source discards the
  // citations that pointed into the previous generation of its chunks,
  // which is correct: those chunk ids no longer exist.
  await sql`
    CREATE TABLE citations (
      id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      answer_id uuid NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
      chunk_id  uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      ordinal   integer NOT NULL,
      score     double precision NOT NULL,
      UNIQUE (answer_id, ordinal)
    )
  `.execute(db);

  await sql`CREATE INDEX answers_query_id_idx ON answers (query_id)`.execute(
    db,
  );
  await sql`CREATE INDEX citations_answer_id_idx ON citations (answer_id)`.execute(
    db,
  );
  await sql`CREATE INDEX citations_chunk_id_idx ON citations (chunk_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS citations`.execute(db);
  await sql`DROP TABLE IF EXISTS answers`.execute(db);
  await sql`DROP TABLE IF EXISTS queries`.execute(db);
}
