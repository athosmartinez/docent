import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // usd_cost is nullable and cost_source names its origin, so a figure
  // computed from a local price table can never be read as one the provider
  // measured — and a row with neither is stored as unknown rather than as a
  // zero that would quietly deflate every total built on top of it.
  await sql`
    CREATE TABLE cost_ledger (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      query_id          uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
      provider          text NOT NULL,
      model             text NOT NULL,
      prompt_tokens     integer NOT NULL,
      completion_tokens integer NOT NULL,
      cached_tokens     integer NOT NULL DEFAULT 0,
      usd_cost          numeric(14,8),
      cost_source       text NOT NULL,
      model_reason      text NOT NULL,
      created_at        timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`CREATE INDEX cost_ledger_query_id_idx ON cost_ledger (query_id)`.execute(
    db,
  );
  await sql`CREATE INDEX cost_ledger_created_at_idx ON cost_ledger (created_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS cost_ledger`.execute(db);
}
