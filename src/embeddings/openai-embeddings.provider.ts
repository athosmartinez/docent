import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';

import type { EmbeddingsProvider } from './embeddings.types';

/**
 * The API accepts up to 2048 inputs per request and caps the sum of their tokens
 * at 300,000. At the chunk sizes this pipeline produces, 100 stays far inside
 * both limits; raising it materially would need the token sum checked too.
 */
const BATCH_SIZE = 100;

@Injectable()
export class OpenAiEmbeddingsProvider implements EmbeddingsProvider {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly dimensions: number,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
      const batch = texts.slice(offset, offset + BATCH_SIZE);

      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });

      if (response.data.length !== batch.length) {
        throw new Error(
          `embedding response is incomplete: expected ${batch.length} vectors, received ${response.data.length}`,
        );
      }

      // Each item carries its own index because the response order is not
      // guaranteed. Mapping by array position would silently pair a chunk with
      // another chunk's vector.
      const ordered = [...response.data].sort((a, b) => a.index - b.index);

      for (const item of ordered) {
        vectors.push(item.embedding);
      }
    }

    return vectors;
  }
}
