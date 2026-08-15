import { Inject, Injectable } from '@nestjs/common';

import { CacheService } from '../common/cache/cache.service';
import { embeddingKey } from '../common/cache/cache.keys';
import {
  EMBEDDINGS,
  type EmbeddingsProvider,
} from '../embeddings/embeddings.types';
import { fuseByRrf } from './rrf';
import { RetrievalRepository } from './retrieval.repository';
import type { RetrievalResult } from './retrieval.types';

@Injectable()
export class RetrievalService {
  constructor(
    @Inject(RetrievalRepository)
    private readonly repository: RetrievalRepository,
    @Inject(EMBEDDINGS) private readonly embeddings: EmbeddingsProvider,
    @Inject(CacheService) private readonly cache: CacheService,
    @Inject('RETRIEVAL_TOP_N') private readonly topN: number,
    @Inject('RETRIEVAL_TOP_K') private readonly topK: number,
    @Inject('RRF_K') private readonly rrfK: number,
    @Inject('EMBEDDING_MODEL') private readonly embeddingModel: string,
    @Inject('EMBEDDING_DIMENSIONS')
    private readonly embeddingDimensions: number,
    @Inject('CACHE_EMBEDDING_TTL_S')
    private readonly embeddingCacheTtlS: number,
  ) {}

  async search(question: string): Promise<RetrievalResult> {
    const embedding = await this.embed(question);

    // Both arms run against the same question; the lexical one takes the raw
    // text because its stemming happens inside PostgreSQL.
    const [byVector, byText] = await Promise.all([
      this.repository.searchByVector(embedding, this.topN),
      this.repository.searchByText(question, this.topN),
    ]);

    return {
      chunks: fuseByRrf([byVector, byText], this.rrfK).slice(0, this.topK),
      bestDistance: byVector[0]?.distance ?? null,
    };
  }

  private async embed(question: string): Promise<number[]> {
    const key = embeddingKey(
      this.embeddingModel,
      this.embeddingDimensions,
      question,
    );

    const cached = await this.cache.getVector(key);
    if (cached) {
      return cached;
    }

    const [embedding] = await this.embeddings.embed([question]);

    if (!embedding) {
      throw new Error('no embedding was returned for the question');
    }

    await this.cache.setVector(key, embedding, this.embeddingCacheTtlS);

    return embedding;
  }
}
