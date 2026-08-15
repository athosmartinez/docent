import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';

import { KYSELY } from '../database/database.module';
import type { DB } from '../database/schema';

@Injectable()
export class CorpusVersion {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /**
   * Derived from Postgres rather than held as a counter in Redis. A counter
   * in Redis is lost to a flush or an eviction, and a version that resets to
   * its initial value makes every superseded answer reachable again — stale
   * content served as fresh, with no symptom anywhere. Deriving it from the
   * sources themselves means the two can never disagree.
   *
   * Only `ready` sources count. A source that is `pending`, `processing`, or
   * `failed` has not changed what a question can be grounded against —
   * `documents`/`chunks` rows outlive a failed run, but nothing reads them
   * until the source reaches `ready` — so counting it here would invalidate
   * every cached answer for a change that never reached retrieval.
   *
   * Takes an optional executor, defaulting to the pool-backed instance every
   * production caller relies on implicitly by never passing one. Its only
   * reason to exist is a caller-supplied transaction: this query reads the
   * *whole* `sources` table by design, so a test proving a claim about one
   * change to it (or the absence of one) needs to see a snapshot immune to
   * every other suite committing unrelated rows to that same shared table
   * concurrently — which passing a `REPEATABLE READ` transaction here gives
   * it, without this class needing to know that's why.
   */
  async current(db: Kysely<DB> = this.db): Promise<string> {
    const row = await db
      .selectFrom('sources')
      .select((eb) => [
        eb.fn.countAll<string>().as('sources'),
        eb.fn.max<Date | null>('updated_at').as('latest'),
      ])
      .where('status', '=', 'ready')
      .executeTakeFirstOrThrow();

    return `${row.sources}-${row.latest?.toISOString() ?? 'none'}`;
  }
}
