import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';

import { KYSELY } from '../common/database/database.module';
import type { DB } from '../common/database/schema';
import type { CostSource } from '../cost/cost.calculator';
import type { Citation } from './ask.types';

export interface RecordCost {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  usdCost: number | null;
  costSource: CostSource;
  modelReason: string;
}

export interface RecordInput {
  question: string;
  answer: string | null;
  grounded: boolean;
  model: string | null;
  provider: string | null;
  finishReason: string | null;
  citations: Citation[];
  /**
   * Absent for a refusal: no model was called, so there is nothing honest to
   * put in provider/model, which the ledger declares NOT NULL.
   */
  cost?: RecordCost;
}

@Injectable()
export class AskRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /**
   * One transaction, so a citation that violates its foreign key cannot leave
   * a query row behind describing an answer that was never stored — and so a
   * ledger row can never describe an answer that, in the end, wasn't either.
   */
  record(input: RecordInput): Promise<string> {
    return this.db.transaction().execute(async (trx) => {
      const query = await trx
        .insertInto('queries')
        .values({ question: input.question })
        .returning('id')
        .executeTakeFirstOrThrow();

      const answer = await trx
        .insertInto('answers')
        .values({
          query_id: query.id,
          answer: input.answer,
          grounded: input.grounded,
          model: input.model,
          provider: input.provider,
          finish_reason: input.finishReason,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      if (input.citations.length > 0) {
        await trx
          .insertInto('citations')
          .values(
            input.citations.map((citation) => ({
              answer_id: answer.id,
              chunk_id: citation.chunkId,
              ordinal: citation.ordinal,
              score: citation.score,
            })),
          )
          .execute();
      }

      // Written in the same transaction as the answer it belongs to: a
      // ledger row describing an answer that was never stored would inflate
      // every total built from it, and there is no later moment at which
      // the two could be reconciled.
      if (input.cost) {
        await trx
          .insertInto('cost_ledger')
          .values({
            query_id: query.id,
            provider: input.cost.provider,
            model: input.cost.model,
            prompt_tokens: input.cost.promptTokens,
            completion_tokens: input.cost.completionTokens,
            cached_tokens: input.cost.cachedTokens,
            usd_cost: input.cost.usdCost,
            cost_source: input.cost.costSource,
            model_reason: input.cost.modelReason,
          })
          .execute();
      }

      return answer.id;
    });
  }
}
