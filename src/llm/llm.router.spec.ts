import { LlmRouter } from './llm.router';
import type { CompletionResult, LlmProvider, LlmStream } from './llm.types';

const request = { system: 's', user: 'u' };

function result(provider: string): CompletionResult {
  return {
    text: 'answer',
    model: 'm',
    provider,
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 },
    reportedCostUsd: null,
    modelReason: 'primary',
  };
}

function link(
  provider: string,
  behaviour: { fails?: Error; deltas?: string[]; failsAfter?: number },
): LlmProvider {
  return {
    complete: () =>
      behaviour.fails
        ? Promise.reject(behaviour.fails)
        : Promise.resolve(result(provider)),
    stream: (): LlmStream => {
      const deltas = behaviour.deltas ?? ['a', 'b'];
      async function* tokens(): AsyncGenerator<string> {
        // Mirrors a real network stream, where every delta arrives across a
        // microtask boundary rather than synchronously.
        await Promise.resolve();
        if (behaviour.fails && behaviour.failsAfter === undefined) {
          throw behaviour.fails;
        }
        for (const [index, delta] of deltas.entries()) {
          if (behaviour.failsAfter === index && behaviour.fails) {
            throw behaviour.fails;
          }
          yield delta;
        }
      }
      const iterator = tokens();
      return {
        [Symbol.asyncIterator]: () => iterator,
        outcome: () => ({
          model: 'm',
          provider,
          finishReason: 'stop',
          usage: null,
          reportedCostUsd: null,
          modelReason: 'primary',
        }),
      };
    },
  };
}

describe('LlmRouter', () => {
  it('answers from the first link when it works', async () => {
    const router = new LlmRouter([link('openai', {}), link('openrouter', {})]);

    const completion = await router.complete(request);

    expect(completion.provider).toBe('openai');
    expect(completion.modelReason).toBe('primary');
  });

  // A 401 is not retryable against the same provider, which is why the
  // reflex is to give up on it — but the next link is a different provider
  // with a different key, so falling through is precisely the point.
  it('falls through on an authentication failure', async () => {
    const router = new LlmRouter([
      link('openai', { fails: new Error('401 Incorrect API key') }),
      link('openrouter', {}),
    ]);

    const completion = await router.complete(request);

    expect(completion.provider).toBe('openrouter');
    expect(completion.modelReason).toMatch(/^fallback: /);
    expect(completion.modelReason).toContain('Incorrect API key');
  });

  it('tries each link at most once and reports every reason when all fail', async () => {
    const first = link('openai', { fails: new Error('boom one') });
    const second = link('openrouter', { fails: new Error('boom two') });
    const completeFirst = jest.spyOn(first, 'complete');

    const router = new LlmRouter([first, second]);

    await expect(router.complete(request)).rejects.toThrow(
      /boom one[\s\S]*boom two/,
    );
    expect(completeFirst).toHaveBeenCalledTimes(1);
  });

  // The failure that matters lands on the first iteration, not on the call
  // that opens the stream — so returning the stream as soon as it opens
  // would hand the caller a stream that is already doomed.
  it('switches links when the first delta never arrives', async () => {
    const router = new LlmRouter([
      link('openai', { fails: new Error('dropped'), failsAfter: 0 }),
      link('openrouter', { deltas: ['x', 'y'] }),
    ]);

    const stream = router.stream(request);
    const received: string[] = [];
    for await (const delta of stream) received.push(delta);

    expect(received).toEqual(['x', 'y']);
    expect(stream.outcome().provider).toBe('openrouter');
  });

  it('does not lose the peeked delta', async () => {
    const router = new LlmRouter([link('openai', { deltas: ['first', '!'] })]);

    const received: string[] = [];
    for await (const delta of router.stream(request)) received.push(delta);

    expect(received).toEqual(['first', '!']);
  });

  // Past the first delta the client already holds part of an answer, so a
  // silent switch would splice two different answers together.
  it('propagates a failure that lands after the first delta', async () => {
    const router = new LlmRouter([
      link('openai', {
        deltas: ['a', 'b'],
        fails: new Error('mid'),
        failsAfter: 1,
      }),
      link('openrouter', {}),
    ]);

    const received: string[] = [];
    await expect(
      (async () => {
        for await (const delta of router.stream(request)) received.push(delta);
      })(),
    ).rejects.toThrow('mid');
    expect(received).toEqual(['a']);
  });
});
