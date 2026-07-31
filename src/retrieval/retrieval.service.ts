import { Inject, Injectable } from '@nestjs/common';

import {
  EMBEDDINGS,
  type EmbeddingsProvider,
} from '../embeddings/embeddings.types';
import { fuseByRrf } from './rrf';
import { RetrievalRepository } from './retrieval.repository';
import type { RetrievedChunk } from './retrieval.types';

@Injectable()
export class RetrievalService {
  constructor(
    @Inject(RetrievalRepository)
    private readonly repository: RetrievalRepository,
    @Inject(EMBEDDINGS) private readonly embeddings: EmbeddingsProvider,
    @Inject('RETRIEVAL_TOP_N') private readonly topN: number,
    @Inject('RETRIEVAL_TOP_K') private readonly topK: number,
    @Inject('RRF_K') private readonly rrfK: number,
  ) {}

  async search(question: string): Promise<RetrievedChunk[]> {
    const [embedding] = await this.embeddings.embed([question]);

    if (!embedding) {
      throw new Error('no embedding was returned for the question');
    }

    // Both arms run against the same question; the lexical one takes the raw
    // text because its stemming happens inside PostgreSQL.
    const [byVector, byText] = await Promise.all([
      this.repository.searchByVector(embedding, this.topN),
      this.repository.searchByText(question, this.topN),
    ]);

    return fuseByRrf([byVector, byText], this.rrfK).slice(0, this.topK);
  }
}
