import * as path from 'node:path';

import { fetchSource } from './source-fetcher';

const FIXTURES = path.resolve(__dirname, '../../test/fixtures/corpus');

describe('fetchSource', () => {
  it('passes an absolute local path through without cloning', async () => {
    const fetched = await fetchSource(FIXTURES);

    expect(fetched.directory).toBe(FIXTURES);
    expect(fetched.commitSha).toBeNull();

    // Cleanup must not delete a directory it did not create.
    await fetched.cleanup();
    await expect(fetchSource(FIXTURES)).resolves.toBeDefined();
  });

  it('rejects a relative path, which would resolve against the server cwd', async () => {
    await expect(fetchSource('./some/path')).rejects.toThrow(/absolute/i);
  });

  it('rejects an SSH remote, which needs credentials the service does not hold', async () => {
    await expect(
      fetchSource('git@github.com:nestjs/docs.nestjs.com.git'),
    ).rejects.toThrow(/http/i);
  });

  it('rejects a path that does not exist', async () => {
    await expect(fetchSource('/nonexistent/directory/xyz')).rejects.toThrow(
      /not a directory|no such/i,
    );
  });
});
