import { currentRequestId, requestContext } from './request-context';

describe('request-context', () => {
  it('is undefined outside any run() — boot, shutdown, a background job', () => {
    expect(currentRequestId()).toBeUndefined();
  });

  it('is readable inside run(), and reverts to undefined once it exits', () => {
    let observedInside: string | undefined;

    requestContext.run({ requestId: 'req-1' }, () => {
      observedInside = currentRequestId();
    });

    expect(observedInside).toBe('req-1');
    expect(currentRequestId()).toBeUndefined();
  });

  // The whole reason this exists rather than a module-level variable: a
  // plain variable set before an `await` and read after it would still work
  // in a single-request test, but would leak across two requests
  // interleaved on the same event loop. Awaiting inside run() and reading
  // the id only after resuming is what actually exercises that the context
  // is carried past the microtask boundary, not merely closed over.
  it('survives an await inside run()', async () => {
    let observedAfterAwait: string | undefined;

    await requestContext.run({ requestId: 'req-async' }, async () => {
      await Promise.resolve();
      observedAfterAwait = currentRequestId();
    });

    expect(observedAfterAwait).toBe('req-async');
  });

  it("two overlapping run() calls never see each other's id", async () => {
    const results: string[] = [];

    await Promise.all([
      requestContext.run({ requestId: 'a' }, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        results.push(`a:${currentRequestId() ?? 'none'}`);
      }),
      requestContext.run({ requestId: 'b' }, async () => {
        await Promise.resolve();
        results.push(`b:${currentRequestId() ?? 'none'}`);
      }),
    ]);

    expect(results.sort()).toEqual(['a:a', 'b:b']);
  });
});
