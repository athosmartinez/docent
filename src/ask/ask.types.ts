export interface Citation {
  /** 1-based, and the number the answer text cites. */
  ordinal: number;
  chunkId: string;
  path: string;
  headingPath: string[];
  score: number;
}

export interface AskResult {
  /** null exactly when grounded is false. */
  answer: string | null;
  grounded: boolean;
  citations: Citation[];
}
