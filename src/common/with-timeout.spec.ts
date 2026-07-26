import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('resolves with the underlying value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('propagates the underlying rejection', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 50),
    ).rejects.toThrow('boom');
  });

  it('rejects once the deadline passes', async () => {
    const never = new Promise<string>(() => {});

    await expect(withTimeout(never, 10)).rejects.toThrow(
      /timed out after 10ms/,
    );
  });

  it('clears its timer so a resolved call leaves no handle behind', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    await withTimeout(Promise.resolve('ok'), 50);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
