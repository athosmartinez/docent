import { Injectable } from '@nestjs/common';

import { describeError } from '../common/describe-error';
import type { ChainLink } from './llm-chain';
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  LlmStream,
  StreamOutcome,
} from './llm.types';

/**
 * A link paired with the chain entry it was built from. Identity lives here,
 * not on LlmProvider: the interface answers "can this complete a request",
 * and who a link *is* is context the router needs about the object it was
 * handed, not part of what the object itself promises. Attributing a
 * rejection to the wrong link — or to no link at all — is worse than the
 * `unknown` a missing/optional name would silently produce, so there is no
 * fallback: a link with no identity cannot be constructed.
 */
export interface RoutedLink {
  readonly chain: ChainLink;
  readonly provider: LlmProvider;
}

@Injectable()
export class LlmRouter implements LlmProvider {
  constructor(private readonly links: RoutedLink[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const failures: string[] = [];

    for (const { chain, provider } of this.links) {
      try {
        const completion = await provider.complete(request);
        return { ...completion, modelReason: reasonFor(failures) };
      } catch (error: unknown) {
        failures.push(`${chain.provider}: ${describeError(error)}`);
      }
    }

    throw new Error(`every provider failed: ${failures.join(' | ')}`);
  }

  /**
   * Switching links is possible only until the link's stream has produced a
   * result — success or failure. A provider failure very often surfaces on
   * the first iteration rather than on the call that opens the stream, so
   * one delta (or the end of the stream) has to be pulled before a link is
   * trusted; that peeked delta is then re-yielded, not dropped.
   *
   * A stream that opens fine and ends with zero deltas is deliberately *not*
   * a fallback trigger: that is the provider answering with nothing — a
   * content filter, an empty completion — not a failure to answer at all.
   * Shopping that outcome around the rest of the chain would retry a content
   * decision the provider already made, which is both wasteful and wrong;
   * the finish reason already on the outcome is what a caller acts on
   * instead.
   */
  stream(request: CompletionRequest): LlmStream {
    const links = this.links;
    let chosen: LlmStream | null = null;
    // Distinct from 'primary' so a caller reading outcome() before iteration
    // starts — or after every link has failed, see below — can't mistake
    // either state for a link having actually answered.
    let reason = 'not started';

    async function* deltas(): AsyncGenerator<string> {
      const failures: string[] = [];

      for (const { chain, provider } of links) {
        const candidate = provider.stream(request);
        const iterator = candidate[Symbol.asyncIterator]();

        let first;
        try {
          first = await iterator.next();
        } catch (error: unknown) {
          failures.push(`${chain.provider}: ${describeError(error)}`);
          continue;
        }

        chosen = candidate;
        reason = reasonFor(failures);

        if (first.done === true) return;

        try {
          yield first.value;

          // Past this point the caller holds part of an answer, so a
          // failure propagates rather than splicing a second provider's
          // answer onto the first one's.
          let next = await iterator.next();
          while (next.done !== true) {
            yield next.value;
            next = await iterator.next();
          }
        } finally {
          // A caller that stops iterating early — an SSE client
          // disconnecting, an AbortController firing — unwinds this
          // generator via `.return()`, which runs this block. Without
          // forwarding that into the candidate's own iterator, its
          // generator is left suspended mid-stream, holding the provider's
          // response open until whatever upstream timeout eventually kills
          // it.
          await iterator.return?.();
        }
        return;
      }

      reason = `every provider failed: ${failures.join(' | ')}`;
      throw new Error(reason);
    }

    const iterator = deltas();

    return {
      [Symbol.asyncIterator]: () => iterator,
      outcome: (): StreamOutcome =>
        chosen
          ? { ...chosen.outcome(), modelReason: reason }
          : {
              model: 'unknown',
              provider: 'unknown',
              finishReason: null,
              usage: null,
              reportedCostUsd: null,
              modelReason: reason,
            },
    };
  }
}

function reasonFor(failures: string[]): string {
  return failures.length === 0
    ? 'primary'
    : `fallback: ${failures[failures.length - 1] ?? 'unknown'}`;
}
