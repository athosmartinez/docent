import { glob, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';

export interface LoadedDocument {
  path: string;
  title: string;
  raw: string;
}

const PAGE_HEADING = /^###\s+(.+?)\s*$/m;
const PARENT_SEGMENT = '..';

/**
 * Reads every file the glob matches, relative to `directory`. Node's own glob
 * covers this, so the pipeline carries no matching dependency.
 *
 * `include` arrives here from an HTTP request body (the ingest endpoint takes
 * it verbatim), so it is treated as untrusted input rather than a trusted
 * config value. A `..` segment is refused before globbing even runs, and
 * every match is re-checked against the directory's resolved real path
 * afterwards — the second check is what catches a symlink that sits inside
 * the tree by name but resolves outside it, which no amount of pattern
 * inspection alone would see.
 */
export async function loadMarkdownFiles(
  directory: string,
  include: string,
): Promise<LoadedDocument[]> {
  assertNoParentSegment(include);

  const realDirectory = await realpath(directory);
  const documents: LoadedDocument[] = [];

  for await (const match of glob(include, { cwd: directory })) {
    const matchPath = path.join(directory, match);
    const realMatchPath = await realpath(matchPath);

    assertWithinDirectory(realDirectory, realMatchPath, match);

    const relativePath = match.split(path.sep).join('/');
    const raw = await readFile(matchPath, 'utf8');

    documents.push({
      path: relativePath,
      title: extractTitle(raw, relativePath),
      raw,
    });
  }

  return documents.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A legitimate include for this pipeline never needs to climb out of the
 * source directory, so a literal `..` segment is rejected outright rather
 * than left for the containment check below to catch after a wasted glob.
 */
function assertNoParentSegment(include: string): void {
  if (include.split('/').includes(PARENT_SEGMENT)) {
    throw new Error(
      `include pattern must not climb out of the source directory: ${include}`,
    );
  }
}

/**
 * Confirms a match's resolved, symlink-free location still sits under the
 * directory's own resolved location. Comparing by path segment (via
 * `path.relative`) rather than string prefix matters: a sibling directory
 * that merely shares the parent directory's name as a prefix — `/tmp/corpus`
 * vs. `/tmp/corpus-evil` — would otherwise pass a naive `startsWith` check.
 */
function assertWithinDirectory(
  realDirectory: string,
  realMatchPath: string,
  match: string,
): void {
  const relative = path.relative(realDirectory, realMatchPath);

  if (
    relative === PARENT_SEGMENT ||
    relative.startsWith(`${PARENT_SEGMENT}${path.sep}`)
  ) {
    throw new Error(
      `matched file resolves outside the source directory: ${match}`,
    );
  }
}

/**
 * Falls back to the filename so every document has something a citation can
 * name. A page without a heading is rare but should not become an untitled row.
 */
function extractTitle(raw: string, relativePath: string): string {
  return (
    PAGE_HEADING.exec(raw)?.[1] ??
    path.basename(relativePath, path.extname(relativePath))
  );
}
