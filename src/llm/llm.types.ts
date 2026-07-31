export const LLM = Symbol('LLM');

export interface CompletionRequest {
  system: string;
  user: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
  finishReason: string;
}

/**
 * One provider today. The shape is the one a multi-provider router can
 * implement unchanged, so introducing routing later replaces the binding
 * behind this token rather than the call sites.
 */
export interface LlmProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream(request: CompletionRequest): AsyncIterable<string>;
}
