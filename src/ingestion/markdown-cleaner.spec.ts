import { cleanMarkdown } from './markdown-cleaner';

describe('cleanMarkdown', () => {
  it('drops the JavaScript half of a @@switch block', () => {
    const raw = [
      '```typescript',
      '@@filename(auth.guard)',
      'export class AuthGuard implements CanActivate {}',
      '@@switch',
      'export class AuthGuard {}',
      '```',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('implements CanActivate');
    expect(content).not.toContain('@@switch');
    expect(content).not.toContain('export class AuthGuard {}');
  });

  it('lifts @@filename out of the text and reports it', () => {
    const raw = [
      '```typescript',
      '@@filename(auth.guard)',
      'const x = 1;',
      '```',
    ].join('\n');

    const { content, filenames } = cleanMarkdown(raw);

    expect(filenames).toEqual(['auth.guard']);
    expect(content).not.toContain('@@filename');
    expect(content).toContain('const x = 1;');
  });

  it('leaves a fence without Nest markup untouched', () => {
    const raw = ['```typescript', 'const x = 1;', 'const y = 2;', '```'].join(
      '\n',
    );

    expect(cleanMarkdown(raw).content).toBe(raw);
  });

  it('removes Angular banner components', () => {
    const raw = [
      '### Guards',
      '',
      '<app-banner-courses></app-banner-courses>',
      '',
      'Text.',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).not.toContain('app-banner');
    expect(content).toContain('### Guards');
    expect(content).toContain('Text.');
  });

  it('removes figure blocks', () => {
    const raw = [
      '### Guards',
      '<figure><img class="illustrative-image" src="/assets/Guards_1.png" /></figure>',
      'Text.',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).not.toContain('<figure>');
    expect(content).not.toContain('<img');
    expect(content).toContain('Text.');
  });

  it('does not treat @@switch outside a fence as a directive', () => {
    const raw = 'Prose mentioning @@switch literally.';

    expect(cleanMarkdown(raw).content).toContain('@@switch');
  });

  it('handles several fences independently', () => {
    const raw = [
      '```typescript',
      'const a = 1;',
      '@@switch',
      'var a = 1;',
      '```',
      'Between.',
      '```typescript',
      'const b = 2;',
      '```',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).not.toContain('var a = 1;');
    expect(content).toContain('const a = 1;');
    expect(content).toContain('const b = 2;');
    expect(content).toContain('Between.');
  });

  it('converts an HTML table in the body to markdown', () => {
    const raw = [
      '### Options',
      '',
      '<table>',
      '  <tr><td><code>urls</code></td><td>Connection URLs</td></tr>',
      '</table>',
      '',
      'After.',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('- `urls` — Connection URLs');
    expect(content).not.toContain('<table>');
    expect(content).not.toContain('<td>');
    expect(content).toContain('### Options');
    expect(content).toContain('After.');
  });

  it('leaves a table inside a fenced code block untouched', () => {
    const raw = [
      '```html',
      '<table>',
      '  <tr><td>example</td></tr>',
      '</table>',
      '```',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('<table>');
    expect(content).toContain('<td>example</td>');
  });

  it('converts several tables in one document independently', () => {
    const raw = [
      '<table><tr><td>a</td><td>1</td></tr></table>',
      '',
      'Between.',
      '',
      '<table><tr><th>H</th></tr><tr><td>b</td></tr></table>',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('- a — 1');
    expect(content).toContain('| H |');
    expect(content).toContain('Between.');
    expect(content).not.toContain('<table>');
  });

  it('leaves an unclosed table as it found it', () => {
    const raw = ['<table>', '  <tr><td>a</td></tr>', 'no closing tag'].join(
      '\n',
    );

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('<table>');
    expect(content).toContain('no closing tag');
  });

  it('preserves an Angular component example encoded inside a table cell code span', () => {
    const raw =
      '<table><tr><td><code>&lt;app-foo&gt;&lt;/app-foo&gt;</code></td><td>desc</td></tr></table>';

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('`<app-foo></app-foo>` — desc');
  });

  it('preserves a figure block encoded inside a table cell code span', () => {
    const raw =
      '<table><tr><td><code>&lt;figure&gt;&lt;/figure&gt;</code></td><td>desc</td></tr></table>';

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('`<figure></figure>` — desc');
  });

  it('preserves an Angular component example written as an inline code span in prose', () => {
    const raw =
      'Use `<app-banner-courses></app-banner-courses>` to embed the banner.';

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('`<app-banner-courses></app-banner-courses>`');
  });

  it('still removes a real Angular component that appears outside any code span', () => {
    const raw = [
      '### Guards',
      '',
      '<app-banner-courses></app-banner-courses>',
      '',
      'Text.',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).not.toContain('app-banner');
    expect(content).toContain('### Guards');
    expect(content).toContain('Text.');
  });

  it('leaves a figure block inside a fenced code block untouched', () => {
    const raw = [
      '```html',
      '<figure><img src="/assets/example.png" /></figure>',
      '```',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('<figure>');
    expect(content).toContain('<img');
  });

  it('keeps a surviving inline span mapped to its own content when a figure between two spans is removed', () => {
    const raw =
      'Use `foo` here. <figure><figcaption>See `bar` for detail</figcaption></figure> Then use `baz` too.';

    const { content } = cleanMarkdown(raw);

    expect(content).toBe('Use `foo` here.  Then use `baz` too.');
  });

  it('keeps a surviving fenced block mapped to its own content when a figure between two fences is removed', () => {
    const raw = [
      '```js',
      'const a = 1;',
      '```',
      '',
      '<figure>',
      '```js',
      'const b = 2;',
      '```',
      '</figure>',
      '',
      '```js',
      'const c = 3;',
      '```',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).toBe(
      '```js\nconst a = 1;\n```\n\n```js\nconst c = 3;\n```',
    );
  });

  it('keeps a real span mapped to its own content when a removed Angular component swallowed its own span', () => {
    const raw =
      'Intro. <app-foo>`inside`</app-foo> Real text with `outside` span.';

    const { content } = cleanMarkdown(raw);

    expect(content).toBe('Intro.  Real text with `outside` span.');
  });

  it('keeps every surviving span mapped to its own content across two removed figures', () => {
    const raw =
      'A `one` here. <figure>`two`</figure> B `three` here. <figure>`four`</figure> C `five` here.';

    const { content } = cleanMarkdown(raw);

    expect(content).toBe('A `one` here.  B `three` here.  C `five` here.');
  });

  it('does not open a table buffer on `<table>` mentioned inside an inline code span', () => {
    // TABLE_OPEN tested against the raw line with no inline-code awareness
    // would read this as the start of a real table, then buffer the rest of
    // the document behind it: no later `</table>` ever arrives, so the fence
    // below loses its closing marker and the @@filename directive is read as
    // ordinary buffered text instead of being extracted.
    const raw = [
      'Use the `<table>` element for tabular data.',
      '',
      '```typescript',
      '@@filename(auth.guard)',
      'const x = 1;',
      '```',
    ].join('\n');

    const { content, filenames } = cleanMarkdown(raw);

    expect(filenames).toEqual(['auth.guard']);
    expect(content).not.toContain('@@filename');
    expect(content).toContain('const x = 1;');
    expect((content.match(/```/g) ?? []).length).toBe(2);
  });

  it('still opens a table buffer for a real <table> on a line that also carries an unrelated inline code span', () => {
    const raw = [
      '<table> see `example` below',
      '  <tr><td>a</td><td>1</td></tr>',
      '</table>',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('- a — 1');
    expect(content).not.toContain('<table');
  });
});
