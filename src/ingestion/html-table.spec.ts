import { convertHtmlTable } from './html-table';

describe('convertHtmlTable', () => {
  it('renders a table with header cells as a markdown table', () => {
    const html = [
      '<table>',
      '  <tr><th>Option</th><th>Type</th></tr>',
      '  <tr><td><code>enableDebugMessages</code></td><td><code>boolean</code></td></tr>',
      '</table>',
    ].join('\n');

    expect(convertHtmlTable(html)).toBe(
      [
        '| Option | Type |',
        '| --- | --- |',
        '| `enableDebugMessages` | `boolean` |',
      ].join('\n'),
    );
  });

  it('renders a headerless two-column table as a definition list', () => {
    const html = [
      '<table>',
      '  <tr><td><code>urls</code></td><td>An array of connection URLs to try in order</td></tr>',
      '  <tr><td><code>queue</code></td><td>Queue name which your server will listen to</td></tr>',
      '</table>',
    ].join('\n');

    expect(convertHtmlTable(html)).toBe(
      [
        '- `urls` — An array of connection URLs to try in order',
        '- `queue` — Queue name which your server will listen to',
      ].join('\n'),
    );
  });

  it('keeps every cell of a headerless table with more than two columns', () => {
    const html = '<table><tr><td>a</td><td>b</td><td>c</td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- a — b — c');
  });

  it('turns a link cell into a markdown link', () => {
    const html =
      '<table><tr><td>Custom <a href="https://example.com/s.ts" target="_blank">serializer</a> for messages</td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe(
      '- Custom [serializer](https://example.com/s.ts) for messages — x',
    );
  });

  it('converts emphasis and drops tags it does not translate', () => {
    const html =
      '<table><tr><td><strong>bold</strong> and <b>also</b></td><td><span>plain</span></td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- **bold** and **also** — plain');
  });

  it('decodes the escaped braces the corpus uses', () => {
    const html =
      '<table><tr><td><code>&#123;a: 1&#125;</code></td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- `{a: 1}` — x');
  });

  it('escapes a literal pipe so it cannot break a markdown table', () => {
    const html = '<table><tr><th>A</th></tr><tr><td>x | y</td></tr></table>';

    expect(convertHtmlTable(html)).toContain('x \\| y');
  });

  it('collapses whitespace inside a cell onto one line', () => {
    const html = [
      '<table>',
      '<tr><td>one',
      '   two</td><td>x</td></tr>',
      '</table>',
    ].join('\n');

    expect(convertHtmlTable(html)).toBe('- one two — x');
  });

  it('returns the input unchanged when it contains no rows', () => {
    const html = '<table></table>';

    expect(convertHtmlTable(html)).toBe(html);
  });
});
