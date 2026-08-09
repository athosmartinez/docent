import { Injectable } from '@nestjs/common';

import { describeError } from '../common/describe-error';
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  LlmStream,
  StreamOutcome,
} from './llm.types';

@Injectable()
export class LlmRouter implements LlmProvider {
  constructor(private readonly links: LlmProvider[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const failures: string[] = [];

    for (const link of this.links) {
      try {
        const completion = await link.complete(request);
        return { ...completion, modelReason: reasonFor(failures) };
      } catch (error: unknown) {
        failures.push(`${nameOf(link)}: ${describeError(error)}`);
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

      for (const link of links) {
        const candidate = link.stream(request);
        const iterator = candidate[Symbol.asyncIterator]();

        let first;
        try {
          first = await iterator.next();
        } catch (error: unknown) {
          // candidate.outcome() is available regardless of whether the
          // iterator ever produced a value — the provider/model it reports
          // are bound when the stream was opened, not once it succeeds.
          failures.push(
            `${candidate.outcome().provider}: ${describeError(error)}`,
          );
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

function nameOf(link: LlmProvider): string {
  return link.providerName ?? 'unknown';
}
