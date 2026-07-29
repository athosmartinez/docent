import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

  describe('containment', () => {
    let outsideDir: string;

    beforeEach(async () => {
      outsideDir = await mkdtemp(path.join(tmpdir(), 'docent-outside-'));
      await writeFile(
        path.join(outsideDir, 'secret.md'),
        'OUTSIDE SECRET\n',
        'utf8',
      );
    });

    afterEach(async () => {
      await rm(outsideDir, { recursive: true, force: true });
    });

    it('rejects a pattern that climbs out of the directory with one ../', async () => {
      await expect(
        loadMarkdownFiles(FIXTURES, '../outside/*.md'),
      ).rejects.toThrow(/\.\.\/outside\/\*\.md/);
    });

    it('rejects a pattern that climbs out of the directory with ../../', async () => {
      await expect(
        loadMarkdownFiles(FIXTURES, '../../etc/**/*.md'),
      ).rejects.toThrow(/\.\.\/\.\.\/etc/);
    });

    it('rejects a symlink inside the directory that resolves outside it', async () => {
      const linkPath = path.join(FIXTURES, 'escape-link');
      await symlink(outsideDir, linkPath);

      try {
        await expect(
          loadMarkdownFiles(FIXTURES, 'escape-link/*.md'),
        ).rejects.toThrow(/outside the source directory/);
      } finally {
        await rm(linkPath, { force: true });
      }
    });

    it('still honours a legitimate nested pattern', async () => {
      const documents = await loadMarkdownFiles(FIXTURES, 'nested/**/*.md');

      expect(documents.map((d) => d.path)).toEqual(['nested/interceptors.md']);
    });

    it('still refuses an absolute pattern pointing outside the directory', async () => {
      // Has no `..` segment, so the upfront check lets it through; joining it
      // onto `directory` folds it into a subpath that does not exist, so it
      // is still refused rather than read — same outcome as before this fix,
      // just for a different reason under the hood.
      const absolutePattern = path.join(outsideDir, '*.md');

      await expect(
        loadMarkdownFiles(FIXTURES, absolutePattern),
      ).rejects.toThrow();
    });
  });
});
