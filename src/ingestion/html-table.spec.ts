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

  // content/microservices/nats.md leaves the second <td> of these rows open;
  // only the following <tr> (or the table's end) closes it in practice.
  it('keeps a cell whose closing </td> is missing from the source', () => {
    const html = [
      '<table>',
      '  <tr>',
      '    <td><code>gracefulShutdown</code></td>',
      '    <td>Enables graceful shutdown. Default is <code>false</code>.',
      '  </tr>',
      '  <tr>',
      '    <td><code>queue</code></td>',
      '    <td>Queue name which your server will listen to</td>',
      '  </tr>',
      '</table>',
    ].join('\n');

    expect(convertHtmlTable(html)).toBe(
      [
        '- `gracefulShutdown` — Enables graceful shutdown. Default is `false`.',
        '- `queue` — Queue name which your server will listen to',
      ].join('\n'),
    );
  });

  // content/microservices/kafka.md and grpc.md wrap a long <a> tag across
  // lines and split its closing tag as "</a\n      >" — a common way to hand
  // -format long HTML without rendering a stray space around the link text.
  it('turns a link whose closing tag is split across lines into a markdown link', () => {
    const html = [
      '<table><tr><td>Client configuration options (read more',
      '      <a',
      '        href="https://kafka.js.org/docs/configuration"',
      '        rel="nofollow"',
      '        target="blank"',
      '        >here</a',
      '      >)</td><td>x</td></tr></table>',
    ].join('\n');

    expect(convertHtmlTable(html)).toBe(
      '- Client configuration options (read more [here](https://kafka.js.org/docs/configuration)) — x',
    );
  });

  // content/techniques/versioning.md writes every href in this table with
  // single quotes.
  it('turns a single-quoted href into a markdown link', () => {
    const html =
      "<table><tr><td><a href='techniques/versioning#uri-versioning-type'><code>URI Versioning</code></a></td><td>The version will be passed within the URI of the request (default)</td></tr></table>";

    expect(convertHtmlTable(html)).toBe(
      '- [`URI Versioning`](techniques/versioning#uri-versioning-type) — The version will be passed within the URI of the request (default)',
    );
  });

  it('turns an unquoted href into a markdown link', () => {
    const html =
      '<table><tr><td><a href=https://example.com/s.ts>serializer</a></td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe(
      '- [serializer](https://example.com/s.ts) — x',
    );
  });

  it('keeps the text of a link with no href rather than dropping it', () => {
    const html =
      '<table><tr><td><a name="anchor">bare anchor</a></td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- bare anchor — x');
  });

  // A generic's angle brackets read like a tag once REMAINING_TAG runs, unless
  // the <code> body is protected from tag stripping first. Not present in the
  // current corpus, but typical of NestJS's typed API docs.
  it('does not let a generic inside <code> be mistaken for an HTML tag', () => {
    const html =
      '<table><tr><td><code>Promise<void></code></td><td><code>Record<string, number></code></td></tr></table>';

    expect(convertHtmlTable(html)).toBe(
      '- `Promise<void>` — `Record<string, number>`',
    );
  });

  it('decodes an entity inside <code> without exposing it to tag stripping', () => {
    const html =
      '<table><tr><td><code>Array&lt;string&gt;</code></td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- `Array<string>` — x');
  });

  // content/controllers.md uses <br /> to separate sentences within a cell;
  // dropping the tag outright fuses the words on either side of it.
  it('turns <br> into a space so adjacent words do not fuse', () => {
    const html = '<table><tr><td>line1<br>line2</td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- line1 line2 — x');
  });

  it('turns a self-closing <br /> into a space too', () => {
    const html =
      '<table><tr><td>line one<br />line two</td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- line one line two — x');
  });

  it('decodes an escaped pipe entity and still escapes it for the table', () => {
    const html = '<table><tr><td>a&#124;b</td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- a\\|b — x');
  });

  // The restore step assumes every code-placeholder character in the
  // rendered string is one the converter inserted. A literal copy of that
  // character already present in the source breaks the assumption and
  // consumes a <code> slot out of order, landing the real content in the
  // wrong place and leaving an empty backtick pair where it belonged.
  it('strips a stray code-placeholder character so it cannot steal a real code slot', () => {
    const html =
      '<table><tr><td>zap\u{e000}zap <code>real</code></td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- zapzap `real` — x');
  });

  it('strips a stray code-placeholder character even when the cell has no code block', () => {
    const html = '<table><tr><td>zap\u{e000}zap</td><td>x</td></tr></table>';

    expect(convertHtmlTable(html)).toBe('- zapzap — x');
  });
});
