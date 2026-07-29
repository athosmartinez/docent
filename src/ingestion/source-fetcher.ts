import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { describeError } from '../common/describe-error';

const run = promisify(execFile);

export interface FetchedSource {
  directory: string;
  commitSha: string | null;
  cleanup: () => Promise<void>;
}

const CLONE_TIMEOUT_MS = 120_000;

/**
 * Reduces any source to a directory on disk, so every later stage works against
 * the filesystem and can be tested without network access.
 */
export async function fetchSource(uri: string): Promise<FetchedSource> {
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    return cloneRepository(uri);
  }

  if (!path.isAbsolute(uri)) {
    throw new Error(
      `source must be an http(s) URL or an absolute path, received: ${uri}`,
    );
  }

  const stats = await stat(uri).catch(() => null);

  if (stats === null || !stats.isDirectory()) {
    throw new Error(`source is not a directory: ${uri}`);
  }

  return {
    directory: uri,
    commitSha: null,
    // A directory this function did not create is not its to remove.
    cleanup: () => Promise.resolve(),
  };
}

async function cloneRepository(url: string): Promise<FetchedSource> {
  const directory = await mkdtemp(path.join(tmpdir(), 'docent-ingest-'));

  try {
    await run('git', ['clone', '--depth', '1', url, directory], {
      timeout: CLONE_TIMEOUT_MS,
    });

    const { stdout } = await run('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
    });

    return {
      directory,
      commitSha: stdout.trim(),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    // A clone that fails partway still leaves a temp directory behind; every
    // retry without this would leak one more into the system temp.
    await rm(directory, { recursive: true, force: true });
    throw new Error(`failed to clone ${url}: ${describeError(error)}`);
  }
}
