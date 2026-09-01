import { Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/describe-error';
import { withTimeout } from '../common/with-timeout';
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

// `.return()` closing an abandoned candidate's connection is local teardown
// (aborting a fetch reader), not a round trip, so it should settle quickly;
// bounded generously in case an SDK's internal cleanup does something slow,
// still far below anything a caller would notice stacked onto response
// teardown.
const CLOSE_TIMEOUT_MS = 1_000;

/**
 * Closes a link the router is leaving behind — one that lost the peek,
 * ended with nothing, or is being abandoned mid-stream because the caller
 * stopped consuming. `.return()` is what releases the underlying provider
 * connection, but nothing guarantees it settles, or settles without
 * throwing — and cleanup must never be able to change what the caller sees.
 * Bounded by `withTimeout`; a close that times out or rejects is logged and
 * dropped, never re-thrown, so it can neither hang the caller nor replace
 * the answer (or the failure) the caller already has.
 */
async function closeQuietly(
  iterator: AsyncIterator<string>,
  provider: string,
): Promise<void> {
  try {
    await withTimeout(Promise.resolve(iterator.return?.()), CLOSE_TIMEOUT_MS);
  } catch (error: unknown) {
    new Logger('LlmRouter').warn(
      `${provider}: failed to close abandoned stream: ${describeError(error)}`,
    );
  }
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
          await closeQuietly(iterator, chain.provider);
          continue;
        }

        chosen = candidate;
        reason = reasonFor(failures);

        if (first.done === true) {
          await closeQuietly(iterator, chain.provider);
          return;
        }

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
          // it. closeQuietly never throws and never hangs past its own
          // bound, so this finally can't replace whatever the try block
          // was in the middle of producing — a value, a normal return, or
          // a failure already propagating out of it.
          await closeQuietly(iterator, chain.provider);
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
              configuredModel: 'unknown',
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
