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

/**
 * What the answer cache stores, and what a hit is read back as. A superset
 * of AskResult rather than AskResult itself: a hit still has to become a
 * `cost_source: 'cached'` ledger row, and that needs the provider and model
 * the original answer used, which AskResult has no field for because the
 * wire response never carried them. `provider`/`model`/`finishReason` are
 * null exactly when `grounded` is false, the same as `answer` — a refusal
 * never reached a model, so there is nothing honest to cache for any of
 * them.
 */
export interface CachedAnswer extends AskResult {
  provider: string | null;
  model: string | null;
  finishReason: string | null;
}
