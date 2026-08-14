import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';

import { KYSELY } from '../common/database/database.module';
import type { DB } from '../common/database/schema';

export interface CostTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  usdCost: number;
  unpricedRequests: number;
}

export interface CostByModel {
  provider: string;
  model: string;
  requests: number;
  usdCost: number;
  unpricedRequests: number;
}

export interface CostReport {
  totals: CostTotals;
  byModel: CostByModel[];
}

// SUM(numeric) returns numeric, and COUNT(*) returns bigint — both exceed
// what a JS number can hold without loss, so pg hands both back as strings
// on the wire. Number() at this single boundary keeps the rest of the code
// in numbers; the magnitudes a cost ledger deals in, dollars and token
// counts, are nowhere near what a double loses.
const toNumber = (value: string | null): number =>
  value === null ? 0 : Number(value);

@Injectable()
export class CostRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /**
   * `from` is inclusive and `to` is exclusive — `>=` and `<`, never `<=` on
   * `to`. A `to` given as a bare date (midnight) would otherwise drop every
   * row from that day, which is the classic shape of an off-by-one report.
   */
  async report(from?: Date, to?: Date): Promise<CostReport> {
    const totalsRow = await this.db
      .selectFrom('cost_ledger')
      .$if(from !== undefined, (qb) =>
        qb.where('created_at', '>=', from as Date),
      )
      .$if(to !== undefined, (qb) => qb.where('created_at', '<', to as Date))
      .select((eb) => [
        eb.fn.countAll<string>().as('requests'),
        eb.fn.sum<string | null>('prompt_tokens').as('prompt_tokens'),
        eb.fn.sum<string | null>('completion_tokens').as('completion_tokens'),
        eb.fn.sum<string | null>('cached_tokens').as('cached_tokens'),
        eb.fn.sum<string | null>('usd_cost').as('usd_cost'),
        eb.fn
          .count<string>('id')
          .filterWhere('usd_cost', 'is', null)
          .as('unpriced_requests'),
      ])
      .executeTakeFirstOrThrow();

    const byModelRows = await this.db
      .selectFrom('cost_ledger')
      .$if(from !== undefined, (qb) =>
        qb.where('created_at', '>=', from as Date),
      )
      .$if(to !== undefined, (qb) => qb.where('created_at', '<', to as Date))
      .select((eb) => [
        'provider',
        'model',
        eb.fn.countAll<string>().as('requests'),
        eb.fn.sum<string | null>('usd_cost').as('usd_cost'),
        eb.fn
          .count<string>('id')
          .filterWhere('usd_cost', 'is', null)
          .as('unpriced_requests'),
      ])
      .groupBy(['provider', 'model'])
      .orderBy('provider')
      .orderBy('model')
      .execute();

    return {
      totals: {
        requests: toNumber(totalsRow.requests),
        promptTokens: toNumber(totalsRow.prompt_tokens),
        completionTokens: toNumber(totalsRow.completion_tokens),
        cachedTokens: toNumber(totalsRow.cached_tokens),
        usdCost: toNumber(totalsRow.usd_cost),
        unpricedRequests: toNumber(totalsRow.unpriced_requests),
      },
      byModel: byModelRows.map((row) => ({
        provider: row.provider,
        model: row.model,
        requests: toNumber(row.requests),
        usdCost: toNumber(row.usd_cost),
        unpricedRequests: toNumber(row.unpriced_requests),
      })),
    };
  }
}
