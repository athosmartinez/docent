import { glob, readFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface LoadedDocument {
  path: string;
  title: string;
  raw: string;
}

const PAGE_HEADING = /^###\s+(.+?)\s*$/m;

/**
 * Reads every file the glob matches, relative to `directory`. Node's own glob
 * covers this, so the pipeline carries no matching dependency.
 */
export async function loadMarkdownFiles(
  directory: string,
  include: string,
): Promise<LoadedDocument[]> {
  const documents: LoadedDocument[] = [];

  for await (const match of glob(include, { cwd: directory })) {
    const relativePath = match.split(path.sep).join('/');
    const raw = await readFile(path.join(directory, match), 'utf8');

    documents.push({
      path: relativePath,
      title: extractTitle(raw, relativePath),
      raw,
    });
  }

  return documents.sort((a, b) => a.path.localeCompare(b.path));
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
