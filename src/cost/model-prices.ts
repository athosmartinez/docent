export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
  /** USD per 1,000,000 input tokens the provider served from its cache. */
  cachedInputPerMillion: number;
}

/**
 * Prices live in code, keyed the same way LLM_CHAIN names a link, so the two
 * can be cross-checked at boot. A price that could be changed by an
 * environment variable is a price nobody can reconstruct from the repository
 * six months later, which defeats the point of keeping a ledger.
 *
 * Verify against the providers' published pricing when adding a model; a
 * wrong number here is silent, and the ledger will look authoritative.
 *
 * Checked 2026-08-12:
 * - openai:gpt-4.1-mini — https://developers.openai.com/api/docs/pricing
 *   (OpenAI's own API pricing page, Standard tier, flagship models table).
 * - openrouter:google/gemini-2.5-flash — the live `pricing` object for this
 *   model id from OpenRouter's public `GET /api/v1/models` endpoint
 *   (https://openrouter.ai/api/v1/models), which is what OpenRouter itself
 *   bills against rather than a marketing page. Its `input_cache_read` came
 *   back as 0.00000003 USD/token (= $0.03/million), one quarter of the
 *   $0.075/million a first draft of this table assumed — that assumed figure
 *   was never checked against OpenRouter and has been corrected here. It
 *   also lines up with Google's own Gemini API pricing page, which lists
 *   $0.03/million for context-cache reads on this model.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'openai:gpt-4.1-mini': {
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
    cachedInputPerMillion: 0.1,
  },
  'openrouter:google/gemini-2.5-flash': {
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cachedInputPerMillion: 0.03,
  },
};
