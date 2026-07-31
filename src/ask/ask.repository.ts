import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';

import { KYSELY } from '../common/database/database.module';
import type { DB } from '../common/database/schema';
import type { Citation } from './ask.types';

export interface RecordInput {
  question: string;
  answer: string | null;
  grounded: boolean;
  model: string | null;
  provider: string | null;
  finishReason: string | null;
  citations: Citation[];
}

@Injectable()
export class AskRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /**
   * One transaction, so a citation that violates its foreign key cannot leave
   * a query row behind describing an answer that was never stored.
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

      return answer.id;
    });
  }
}
