import { TimeoutError, withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('resolves with the underlying value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('propagates the underlying rejection', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 50),
    ).rejects.toThrow('boom');
  });

  // The two rejection paths are easy to conflate — both are just "the
  // promise rejected" to a caller that only checks .rejects.toThrow() — but
  // a caller that wants to tell "the dependency answered with an error"
  // apart from "the dependency never answered in time" needs the class to
  // actually differ, not just the message. Both directions are asserted so
  // a change that made every rejection a TimeoutError (or none of them one)
  // would fail one of these two.
  it('does not wrap the underlying rejection in a TimeoutError', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 50),
    ).rejects.not.toBeInstanceOf(TimeoutError);
  });

  it('rejects once the deadline passes', async () => {
    const never = new Promise<string>(() => {});

    await expect(withTimeout(never, 10)).rejects.toThrow(
      /timed out after 10ms/,
    );
  });

  it('rejects with a TimeoutError specifically, once the deadline passes', async () => {
    const never = new Promise<string>(() => {});

    await expect(withTimeout(never, 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('clears its timer so a resolved call leaves no handle behind', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    await withTimeout(Promise.resolve('ok'), 50);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
