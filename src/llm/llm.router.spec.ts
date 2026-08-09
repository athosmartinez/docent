import { LlmRouter, type RoutedLink } from './llm.router';
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

// Pairs a fake link with the chain identity the router is constructed
// with — the only source it now has for attributing a failure, since
// LlmProvider itself carries no name.
function entry(
  provider: string,
  behaviour: { fails?: Error; deltas?: string[]; failsAfter?: number },
): RoutedLink {
  return {
    chain: { provider, model: 'm' },
    provider: link(provider, behaviour),
  };
}

// Wraps a plain async generator with a custom `.return`, so a test can
// control exactly what closing an abandoned candidate does — hang, throw,
// or count calls — independently of the delta sequence itself.
function withCustomClose(
  tokens: AsyncGenerator<string>,
  close: () => Promise<IteratorResult<string>>,
): LlmStream {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => tokens.next(),
      return: close,
    }),
    outcome: () => ({
      model: 'm',
      provider: 'openai',
      finishReason: 'stop',
      usage: null,
      reportedCostUsd: null,
      modelReason: 'primary',
    }),
  };
}

function hangsForever(): Promise<IteratorResult<string>> {
  return new Promise<IteratorResult<string>>(() => {
    // Never settles — the point is to prove the router bounds its own
    // wait rather than trusting a candidate's close to ever resolve.
  });
}

describe('LlmRouter', () => {
  it('answers from the first link when it works', async () => {
    const router = new LlmRouter([
      entry('openai', {}),
      entry('openrouter', {}),
    ]);

    const completion = await router.complete(request);

    expect(completion.provider).toBe('openai');
    expect(completion.modelReason).toBe('primary');
  });

  // A 401 is not retryable against the same provider, which is why the
  // reflex is to give up on it — but the next link is a different provider
  // with a different key, so falling through is precisely the point.
  it('falls through on an authentication failure', async () => {
    const router = new LlmRouter([
      entry('openai', { fails: new Error('401 Incorrect API key') }),
      entry('openrouter', {}),
    ]);

    const completion = await router.complete(request);

    expect(completion.provider).toBe('openrouter');
    expect(completion.modelReason).toMatch(/^fallback: /);
    expect(completion.modelReason).toContain('Incorrect API key');
  });

  it('tries each link at most once and reports every reason when all fail', async () => {
    const first = entry('openai', { fails: new Error('boom one') });
    const second = entry('openrouter', { fails: new Error('boom two') });
    const completeFirst = jest.spyOn(first.provider, 'complete');

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
      entry('openai', { fails: new Error('dropped'), failsAfter: 0 }),
      entry('openrouter', { deltas: ['x', 'y'] }),
    ]);

    const stream = router.stream(request);
    const received: string[] = [];
    for await (const delta of stream) received.push(delta);

    expect(received).toEqual(['x', 'y']);
    expect(stream.outcome().provider).toBe('openrouter');
  });

  it('does not lose the peeked delta', async () => {
    const router = new LlmRouter([entry('openai', { deltas: ['first', '!'] })]);

    const received: string[] = [];
    for await (const delta of router.stream(request)) received.push(delta);

    expect(received).toEqual(['first', '!']);
  });

  // Past the first delta the client already holds part of an answer, so a
  // silent switch would splice two different answers together.
  it('propagates a failure that lands after the first delta', async () => {
    const router = new LlmRouter([
      entry('openai', {
        deltas: ['a', 'b'],
        fails: new Error('mid'),
        failsAfter: 1,
      }),
      entry('openrouter', {}),
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

    const router = new LlmRouter([
      { chain: { provider: 'openai', model: 'm' }, provider: abandonable },
    ]);

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
      entry('openai', { deltas: [] }),
      entry('openrouter', { deltas: ['should', 'not', 'be', 'used'] }),
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
    const router = new LlmRouter([entry('openai', {})]);
    const stream = router.stream(request);

    expect(stream.outcome().modelReason).not.toBe('primary');
    expect(stream.outcome().provider).toBe('unknown');
  });

  it('reports a state distinct from "not started" when every link fails', async () => {
    const router = new LlmRouter([
      entry('openai', { fails: new Error('boom one'), failsAfter: 0 }),
      entry('openrouter', { fails: new Error('boom two'), failsAfter: 0 }),
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

  it('attributes a stream failure to the link it was constructed with', async () => {
    const router = new LlmRouter([
      entry('openai', { fails: new Error('dropped'), failsAfter: 0 }),
      entry('openrouter', { fails: new Error('also dropped'), failsAfter: 0 }),
    ]);

    await expect(
      (async () => {
        for await (const delta of router.stream(request)) void delta;
      })(),
    ).rejects.toThrow(/openai: dropped[\s\S]*openrouter: also dropped/);
  });

  it('attributes a complete() failure to the link it was constructed with', async () => {
    const router = new LlmRouter([
      entry('openai', { fails: new Error('401 Incorrect API key') }),
      entry('openrouter', { fails: new Error('429 rate limited') }),
    ]);

    await expect(router.complete(request)).rejects.toThrow(
      /openai: 401 Incorrect API key[\s\S]*openrouter: 429 rate limited/,
    );
  });

  // Attribution reads only the chain identity a link was constructed with —
  // never anything derived from the provider object itself, which no longer
  // carries a name at all. Pairing a link with a mismatched identity proves
  // that: the reported name follows the pairing, not the object's own
  // behaviour.
  it('attributes a failure using the paired identity, not anything read off the provider', async () => {
    const router = new LlmRouter([
      {
        chain: { provider: 'openrouter', model: 'm' },
        provider: link('openai', { fails: new Error('boom') }),
      },
    ]);

    await expect(router.complete(request)).rejects.toThrow(/openrouter: boom/);
  });

  // Closing an abandoned candidate is best-effort: nothing guarantees
  // `.return()` ever settles, and the router must not trust it to. Without
  // a bound, both of these hang forever instead of reaching their
  // assertions.
  it('bounds a close that never settles so a fully consumed stream still completes', async () => {
    async function* tokens(): AsyncGenerator<string> {
      await Promise.resolve();
      yield 'a';
      yield 'b';
    }
    const provider: LlmProvider = {
      complete: () => Promise.reject(new Error('unused')),
      stream: () => withCustomClose(tokens(), hangsForever),
    };

    const router = new LlmRouter([
      { chain: { provider: 'openai', model: 'm' }, provider },
    ]);

    const received: string[] = [];
    for await (const delta of router.stream(request)) received.push(delta);

    expect(received).toEqual(['a', 'b']);
  });

  it('bounds a close that never settles so a mid-stream failure still surfaces', async () => {
    async function* tokens(): AsyncGenerator<string> {
      await Promise.resolve();
      yield 'a';
      throw new Error('mid-stream boom');
    }
    const provider: LlmProvider = {
      complete: () => Promise.reject(new Error('unused')),
      stream: () => withCustomClose(tokens(), hangsForever),
    };

    const router = new LlmRouter([
      { chain: { provider: 'openai', model: 'm' }, provider },
    ]);

    const received: string[] = [];
    await expect(
      (async () => {
        for await (const delta of router.stream(request)) received.push(delta);
      })(),
    ).rejects.toThrow('mid-stream boom');
    expect(received).toEqual(['a']);
  });

  // Cleanup reports, it never decides what the caller sees: a close that
  // fails must not be able to overwrite an answer or a failure that already
  // happened.
  it('does not let a failing close replace a completed answer', async () => {
    async function* tokens(): AsyncGenerator<string> {
      await Promise.resolve();
      yield 'a';
      yield 'b';
    }
    const provider: LlmProvider = {
      complete: () => Promise.reject(new Error('unused')),
      stream: () =>
        withCustomClose(tokens(), () =>
          Promise.reject(new Error('openai close failed')),
        ),
    };

    const router = new LlmRouter([
      { chain: { provider: 'openai', model: 'm' }, provider },
    ]);

    const received: string[] = [];
    for await (const delta of router.stream(request)) received.push(delta);

    expect(received).toEqual(['a', 'b']);
  });

  it('does not let a failing close replace the original mid-stream failure', async () => {
    async function* tokens(): AsyncGenerator<string> {
      await Promise.resolve();
      yield 'a';
      throw new Error('mid-stream boom');
    }
    const provider: LlmProvider = {
      complete: () => Promise.reject(new Error('unused')),
      stream: () =>
        withCustomClose(tokens(), () =>
          Promise.reject(new Error('openai close failed')),
        ),
    };

    const router = new LlmRouter([
      { chain: { provider: 'openai', model: 'm' }, provider },
    ]);

    const received: string[] = [];
    await expect(
      (async () => {
        for await (const delta of router.stream(request)) received.push(delta);
      })(),
    ).rejects.toThrow('mid-stream boom');
    expect(received).toEqual(['a']);
  });

  // A link the router walks away from without ever choosing it — one that
  // lost the peek — still opened a connection and still needs it closed.
  it('closes a link that is rejected during the peek', async () => {
    let returnCalls = 0;
    const rejected: LlmProvider = {
      complete: () => Promise.reject(new Error('unused')),
      stream: (): LlmStream => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('dropped')),
          return: () => {
            returnCalls += 1;
            return Promise.resolve({ value: undefined, done: true });
          },
        }),
        outcome: () => ({
          model: 'm',
          provider: 'openai',
          finishReason: 'stop',
          usage: null,
          reportedCostUsd: null,
          modelReason: 'primary',
        }),
      }),
    };

    const router = new LlmRouter([
      { chain: { provider: 'openai', model: 'm' }, provider: rejected },
      entry('openrouter', { deltas: ['x'] }),
    ]);

    for await (const delta of router.stream(request)) void delta;

    expect(returnCalls).toBe(1);
  });

  it('closes a link that ends with zero deltas', async () => {
    let returnCalls = 0;
    const empty: LlmProvider = {
      complete: () => Promise.reject(new Error('unused')),
      stream: (): LlmStream => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
          return: () => {
            returnCalls += 1;
            return Promise.resolve({ value: undefined, done: true });
          },
        }),
        outcome: () => ({
          model: 'm',
          provider: 'openai',
          finishReason: 'stop',
          usage: null,
          reportedCostUsd: null,
          modelReason: 'primary',
        }),
      }),
    };

    const router = new LlmRouter([
      { chain: { provider: 'openai', model: 'm' }, provider: empty },
    ]);

    for await (const delta of router.stream(request)) void delta;

    expect(returnCalls).toBe(1);
  });

  // The pairing is the only source of a link's identity. Reading it off the
  // provider object instead compiles, and every assertion about the message's
  // content still passes — so the fixture deliberately disagrees with itself,
  // and only the source can explain which name comes out.
  it('attributes a stream failure using the paired identity, not anything read off the provider', async () => {
    const router = new LlmRouter([
      {
        chain: { provider: 'openrouter', model: 'm' },
        provider: link('openai', { fails: new Error('boom') }),
      },
    ]);

    await expect(
      (async () => {
        for await (const delta of router.stream(request)) void delta;
      })(),
    ).rejects.toThrow(/openrouter: boom/);
  });

  // A bound proven only to exist is not proven to be useful. Every test above
  // passes with the timeout set to zero, which would drop a link whose
  // teardown legitimately takes a moment instead of waiting for it — leaving
  // the connection open, which is the leak the close exists to prevent. This
  // pins that a close settling well inside the bound is actually awaited.
  it('waits for a close that settles inside the bound', async () => {
    let closed = false;

    async function* tokens(): AsyncGenerator<string> {
      await Promise.resolve();
      yield 'a';
    }

    const provider: LlmProvider = {
      complete: () => Promise.reject(new Error('unused')),
      stream: () =>
        withCustomClose(
          tokens(),
          () =>
            new Promise<IteratorResult<string>>((resolve) => {
              setTimeout(() => {
                closed = true;
                resolve({ value: undefined, done: true });
              }, 50);
            }),
        ),
    };

    const router = new LlmRouter([
      { chain: { provider: 'openai', model: 'm' }, provider },
    ]);

    for await (const delta of router.stream(request)) void delta;

    expect(closed).toBe(true);
  });
});
