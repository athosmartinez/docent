export const EMBEDDINGS = Symbol('EMBEDDINGS');

export interface EmbeddingsProvider {
  /**
   * Returns one vector per input, in the same order as the input.
   */
  embed(texts: string[]): Promise<number[][]>;
}
