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
    providerName: provider,
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

  // An SSE endpoint that stops iterating on client disconnect calls
  // `.return()` on the router's generator, same as a `break`. If that isn't
  // forwarded to the chosen link, its generator stays suspended inside the
  // provider SDK's own `for await`, holding the response open indefinitely.
  it('closes an abandoned link stream when the caller stops iterating early', async () => {
    let closed = false;
    const abandonable: LlmProvider = {
      providerName: 'openai',
      complete: () => Promise.reject(new Error('unused')),
      stream: (): LlmStream => {
        async function* tokens(): AsyncGenerator<string> {
          try {
            await Promise.resolve();
            yield 'a';
            yield 'b';
          } finally {
            closed = true;
          }
        }
        const iterator = tokens();
        return {
          [Symbol.asyncIterator]: () => iterator,
          outcome: () => ({
            model: 'm',
            provider: 'openai',
            finishReason: 'stop',
            usage: null,
            reportedCostUsd: null,
            modelReason: 'primary',
          }),
        };
      },
    };

    const router = new LlmRouter([abandonable]);

    for await (const delta of router.stream(request)) {
      void delta;
      break;
    }

    expect(closed).toBe(true);
  });

  // A stream that opens and ends with zero deltas is the provider answering
  // with nothing — a content filter, an empty completion — not a failure to
  // reach it. Retrying that against the next link would retry a content
  // decision the provider already made, not a transient fault.
  it('does not fall through to a healthy link when the first ends with zero deltas', async () => {
    const router = new LlmRouter([
      link('openai', { deltas: [] }),
      link('openrouter', { deltas: ['should', 'not', 'be', 'used'] }),
    ]);

    const stream = router.stream(request);
    const received: string[] = [];
    for await (const delta of stream) received.push(delta);

    expect(received).toEqual([]);
    expect(stream.outcome().provider).toBe('openai');
  });

  // A cost ledger persists modelReason verbatim, so 'primary' must mean a
  // link actually answered — never "nothing has happened yet" and never
  // "every link failed", both of which are real states a caller can observe
  // by reading outcome() at the wrong time.
  it('reports a distinguishable state before any attempt has been made', () => {
    const router = new LlmRouter([link('openai', {})]);
    const stream = router.stream(request);

    expect(stream.outcome().modelReason).not.toBe('primary');
    expect(stream.outcome().provider).toBe('unknown');
  });

  it('reports a state distinct from "not started" when every link fails', async () => {
    const router = new LlmRouter([
      link('openai', { fails: new Error('boom one'), failsAfter: 0 }),
      link('openrouter', { fails: new Error('boom two'), failsAfter: 0 }),
    ]);
    const stream = router.stream(request);
    const notStarted = stream.outcome().modelReason;

    await expect(
      (async () => {
        for await (const delta of stream) void delta;
      })(),
    ).rejects.toThrow(/boom one[\s\S]*boom two/);

    const afterExhaustion = stream.outcome().modelReason;
    expect(afterExhaustion).not.toBe('primary');
    expect(afterExhaustion).not.toBe(notStarted);
  });

  it('attributes a stream failure to the link that produced it', async () => {
    const router = new LlmRouter([
      link('openai', { fails: new Error('dropped'), failsAfter: 0 }),
      link('openrouter', { fails: new Error('also dropped'), failsAfter: 0 }),
    ]);

    await expect(
      (async () => {
        for await (const delta of router.stream(request)) void delta;
      })(),
    ).rejects.toThrow(/openai: dropped[\s\S]*openrouter: also dropped/);
  });

  it('attributes a complete() failure to the link that produced it', async () => {
    const router = new LlmRouter([
      link('openai', { fails: new Error('401 Incorrect API key') }),
      link('openrouter', { fails: new Error('429 rate limited') }),
    ]);

    await expect(router.complete(request)).rejects.toThrow(
      /openai: 401 Incorrect API key[\s\S]*openrouter: 429 rate limited/,
    );
  });
});
