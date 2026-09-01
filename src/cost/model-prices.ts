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
 *
 * Re-verified 2026-08-13:
 * - openrouter:google/gemini-2.5-flash — fetched
 *   https://openrouter.ai/api/v1/models directly and read the JSON response
 *   for the `google/gemini-2.5-flash` entry (not a markdown-rendered
 *   summary of the page, which is lossy over a ~400-model list and can miss
 *   the one entry that matters): `prompt: "0.0000003"`,
 *   `completion: "0.0000025"`, `input_cache_read: "0.00000003"` USD/token —
 *   $0.30/M input, $2.50/M output, $0.03/million cache-read, all matching
 *   this table. This is the rate OpenRouter's own billing endpoint reports
 *   for the exact model id, which takes precedence over the generic "cache
 *   reads are 0.25x input" heuristic OpenRouter states elsewhere (that
 *   heuristic would imply $0.075/M here); it also happens to match Google's
 *   own Gemini API pricing page for context-cache reads on this model,
 *   though OpenRouter is who invoices us, not Google, so the endpoint above
 *   is the citation that actually settles it.
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
