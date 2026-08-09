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
        failures.push(describeError(error));
      }
    }

    throw new Error(`every provider failed: ${failures.join(' | ')}`);
  }

  /**
   * Switching links is possible only until the first delta reaches the
   * caller. A provider failure very often surfaces on the first iteration
   * rather than on the call that opens the stream, so the link is not
   * considered good until one delta has actually arrived — and that delta is
   * then re-yielded, not dropped.
   */
  stream(request: CompletionRequest): LlmStream {
    const links = this.links;
    let chosen: LlmStream | null = null;
    let reason = 'primary';

    async function* deltas(): AsyncGenerator<string> {
      const failures: string[] = [];

      for (const link of links) {
        const candidate = link.stream(request);
        const iterator = candidate[Symbol.asyncIterator]();

        let first;
        try {
          first = await iterator.next();
        } catch (error: unknown) {
          failures.push(describeError(error));
          continue;
        }

        chosen = candidate;
        reason = reasonFor(failures);

        if (first.done === true) return;
        yield first.value;

        // Past this point the caller holds part of an answer, so a failure
        // propagates rather than splicing a second provider's answer onto
        // the first one's.
        let next = await iterator.next();
        while (next.done !== true) {
          yield next.value;
          next = await iterator.next();
        }
        return;
      }

      throw new Error(`every provider failed: ${failures.join(' | ')}`);
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
