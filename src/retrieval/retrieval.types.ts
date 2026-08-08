/**
 * A chunk as one search arm ranked it. Position in the array is the rank;
 * the arm's own score is deliberately absent, because fusion never reads it.
 */
export interface RankedChunk {
  chunkId: string;
  documentPath: string;
  headingPath: string[];
  content: string;
}

export interface RetrievedChunk extends RankedChunk {
  /** The fused score. Not comparable to any single arm's score. */
  score: number;
}

/** A chunk from the vector arm, carrying the distance that ranked it. */
export interface VectorRankedChunk extends RankedChunk {
  /**
   * Cosine distance to the question: 0 is identical, 2 is opposite. Unlike a
   * fused rank score it measures proximity, so it can answer "is anything here
   * actually close to what was asked" — which rank position cannot, since the
   * nearest chunk is rank 1 however far away it is.
   */
  distance: number;
}

/** What a search returns: the fused ranking, plus the grounding signal. */
export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /**
   * The distance of the vector arm's nearest chunk, or null when the arm
   * returned nothing. Deliberately taken from the vector arm directly rather
   * than from the fused list: fusion can reorder, and the grounding question
   * is "is anything close", not "what ranked first".
   */
  bestDistance: number | null;
}
