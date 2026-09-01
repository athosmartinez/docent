export const LLM = Symbol('LLM');

export interface CompletionRequest {
  system: string;
  user: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /**
   * Input tokens the provider served from its own prompt cache. Already
   * counted inside promptTokens — charging both in full double-bills the
   * cached portion.
   */
  cachedTokens: number;
}

export interface CompletionResult {
  text: string;
  /**
   * What actually served the request, as the provider's own response
   * reports it — OpenAI echoes the dated snapshot it resolved the alias to
   * (`gpt-4.1-mini-2025-04-14`), not the alias configured. Worth recording
   * exactly as reported: a provider quietly serving a more specific model
   * than requested is information, not noise to normalise away. Never used
   * to look up a price — see `configuredModel`.
   */
  model: string;
  /**
   * The model this link was configured with (`ChainLink.model`), known at
   * construction rather than read off the response. This is what
   * `computeCost` prices by: the price table is keyed on what was asked
   * for, and a provider's more specific echo would only ever miss it.
   */
  configuredModel: string;
  provider: string;
  finishReason: string;
  /** null when the provider reported no usage at all. */
  usage: TokenUsage | null;
  /**
   * Cost in USD as the provider itself reported it, or null when it reports
   * none. Kept separate from any locally computed figure so an estimate can
   * never be mistaken for a measurement.
   */
  reportedCostUsd: number | null;
  /** Why this link answered: 'primary', or 'fallback: <preceding error>'. */
  modelReason: string;
}

/**
 * What a stream can only report once it has ended. A chat completion API
 * sends the finish reason on its final chunk and the usage after that, so
 * none of this is knowable up front. Reading it before iteration completes
 * yields the partial picture, not an error.
 */
export interface StreamOutcome {
  /** See `CompletionResult.model` — the same served-vs-configured split. */
  model: string;
  /** See `CompletionResult.configuredModel`. */
  configuredModel: string;
  provider: string;
  finishReason: string | null;
  usage: TokenUsage | null;
  reportedCostUsd: number | null;
  modelReason: string;
}

export interface LlmStream extends AsyncIterable<string> {
  outcome(): StreamOutcome;
}

/**
 * Implemented both by a single provider and by the router that walks a chain
 * of them, so introducing routing replaces the binding behind the LLM token
 * rather than the call sites.
 */
export interface LlmProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream(request: CompletionRequest): LlmStream;
}
