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
