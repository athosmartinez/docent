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
 * A stream of text deltas that also carries the reason it stopped. The
 * reason is only known once the underlying stream has ended — a chat
 * completion API reports it on the final chunk, not up front — so it is a
 * method read after iteration completes, not a value returned alongside the
 * iterable. It resolves to null if the stream ends without ever reporting
 * one (a connection drop mid-stream, for example), which is honest: it
 * says nothing was observed, rather than asserting the completion reached a
 * normal stop.
 */
export interface LlmStream extends AsyncIterable<string> {
  finishReason(): string | null;
}

/**
 * One provider today. The shape is the one a multi-provider router can
 * implement unchanged, so introducing routing later replaces the binding
 * behind this token rather than the call sites.
 */
export interface LlmProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream(request: CompletionRequest): LlmStream;
}
