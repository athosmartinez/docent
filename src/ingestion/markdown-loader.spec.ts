import * as path from 'node:path';

import { loadMarkdownFiles } from './markdown-loader';

const FIXTURES = path.resolve(__dirname, '../../test/fixtures/corpus');

describe('loadMarkdownFiles', () => {
  it('finds files recursively and returns paths relative to the directory', async () => {
    const documents = await loadMarkdownFiles(FIXTURES, '**/*.md');
    const paths = documents.map((d) => d.path).sort();

    expect(paths).toEqual([
      'guards.md',
      'nested/interceptors.md',
      'pipes.md',
      'untitled.md',
    ]);
  });

  it('honours a narrower glob', async () => {
    const documents = await loadMarkdownFiles(FIXTURES, 'nested/**/*.md');

    expect(documents.map((d) => d.path)).toEqual(['nested/interceptors.md']);
  });

  it('takes the title from the first ### heading', async () => {
    const documents = await loadMarkdownFiles(FIXTURES, 'guards.md');

    expect(documents[0]?.title).toBe('Guards');
  });

  it('falls back to the filename when a document has no heading', async () => {
    const documents = await loadMarkdownFiles(FIXTURES, 'untitled.md');

    expect(documents[0]?.title).toBe('untitled');
  });

  it('returns the raw text untouched, leaving cleaning to a later stage', async () => {
    const documents = await loadMarkdownFiles(FIXTURES, 'guards.md');

    expect(documents[0]?.raw).toContain('@@switch');
  });

  it('returns nothing when the glob matches no file', async () => {
    await expect(loadMarkdownFiles(FIXTURES, '**/*.txt')).resolves.toEqual([]);
  });
});
