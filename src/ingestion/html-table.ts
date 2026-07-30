/**
 * Recognising a table is shared: the cleaner uses these to accumulate one, the
 * chunker to refuse to cut inside one. A second definition would let the two
 * disagree about where a table begins.
 */
export const TABLE_OPEN = /<table[\s>]/i;
export const TABLE_CLOSE = /<\/table>/i;

const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
// Lenient about a missing close tag: the corpus has rows whose <td> is never
// closed (the source relies on the next <td> or </tr> to end it), so a cell
// runs up to whichever of "the next cell" or "the end of the row" comes
// first, rather than requiring its own matching close tag.
const CELL = /<(t[dh])[^>]*>([\s\S]*?)(?=<\/t[dh]\s*>|<t[dh][^>]*>|$)/gi;
const CODE = /<code>([\s\S]*?)<\/code>/gi;
// A private-use-area sentinel, not a control character, so a <code> body can
// be pulled out and restored around the tag-stripping pass without a stray
// generic's angle brackets (e.g. `Promise<void>`) being read as a tag.
//
// The token carries its own index rather than being restored by a walk that
// counts occurrences left to right: REMAINING_TAG matches any run of
// non-`>` text between a `<` and a `>`, and LINK discards its attribute
// group wholesale once the href is pulled out of it, so either can delete a
// range that spans a placeholder along with unrelated text around it. A
// counter has no way to know one placeholder vanished — it hands the next
// surviving placeholder the deleted one's body instead of leaving it
// unresolved, substituting one code span for another. Baking the index into
// the token turns restoration into a lookup: a placeholder that survives
// always resolves to its own body, and one deleted along with its enclosing
// markup is simply never looked up.
//
// Written via String.fromCodePoint rather than as a literal invisible
// character in source, which is unreadable and error-prone to edit.
const CODE_PLACEHOLDER_MARK = String.fromCodePoint(0xe000);
const CODE_PLACEHOLDER = new RegExp(
  `${CODE_PLACEHOLDER_MARK}(\\d+)${CODE_PLACEHOLDER_MARK}`,
  'g',
);
// Closing tag tolerates whitespace before '>': hand-wrapped long <a> tags in
// the corpus split it as "</a\n      >" to avoid rendering a stray space
// around the link text.
const LINK = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
// Matches whichever quoting style the source used, or none at all.
const HREF_ATTR = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const EMPHASIS = /<(strong|b)>([\s\S]*?)<\/\1>/gi;
const BREAK = /<br\s*\/?>/gi;
const REMAINING_TAG = /<[^>]+>/g;

interface Row {
  isHeader: boolean;
  cells: string[];
}

/**
 * Renders one HTML table as markdown.
 *
 * Two output shapes, chosen by whether the source marked a header row. A table
 * with `<th>` keeps its header, because that row carries meaning. A table
 * without one is a list of key-value pairs wearing table markup — markdown
 * would demand a separator row, and synthesising a header would invent
 * structure the source does not have, so it becomes a definition list instead.
 *
 * The corpus this serves has no rowspan, no colspan and no nested tables, so a
 * regex scan is sufficient and a parser dependency is not warranted. A shape
 * this cannot read returns unchanged rather than half-converted — the chunker
 * keeps tables whole either way, so unconverted markup costs tokens but loses
 * nothing.
 */
export function convertHtmlTable(html: string): string {
  const rows = parseRows(html);

  if (rows.length === 0) {
    return html;
  }

  const headerRow = rows.find((row) => row.isHeader);

  if (headerRow === undefined) {
    return rows.map((row) => `- ${row.cells.join(' — ')}`).join('\n');
  }

  const width = headerRow.cells.length;
  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  const body = rows
    .filter((row) => !row.isHeader)
    .map((row) => `| ${row.cells.join(' | ')} |`);

  return [`| ${headerRow.cells.join(' | ')} |`, separator, ...body].join('\n');
}

function parseRows(html: string): Row[] {
  const rows: Row[] = [];

  for (const rowMatch of html.matchAll(ROW)) {
    const inner = rowMatch[1];

    if (inner === undefined) {
      continue;
    }

    const cells: string[] = [];
    let isHeader = false;

    for (const cellMatch of inner.matchAll(CELL)) {
      const tag = cellMatch[1];
      const content = cellMatch[2];

      if (tag === undefined || content === undefined) {
        continue;
      }

      if (tag.toLowerCase() === 'th') {
        isHeader = true;
      }

      cells.push(renderCell(content));
    }

    if (cells.length > 0) {
      rows.push({ isHeader, cells });
    }
  }

  return rows;
}

function renderCell(html: string): string {
  // The restore step below trusts that every occurrence of the sentinel mark
  // in the rendered string is one this function inserted. A literal copy
  // already present in the source would break that trust and collide with a
  // real token, so any pre-existing one is discarded first — a Private Use
  // Area codepoint carries no meaning in documentation, so removing it loses
  // nothing.
  const sanitized = html.replaceAll(CODE_PLACEHOLDER_MARK, '');

  // Lifted out, entities and all, before the generic tag-stripping pass below
  // runs. A raw generic inside a code sample (`Promise<void>`) is otherwise
  // indistinguishable from a real tag once REMAINING_TAG sees it.
  const codeBodies: string[] = [];
  const withoutCode = sanitized.replace(CODE, (_match, body: string) => {
    const index =
      codeBodies.push(decodeEntities(body).replace(/\s+/g, ' ').trim()) - 1;

    return `${CODE_PLACEHOLDER_MARK}${index}${CODE_PLACEHOLDER_MARK}`;
  });

  const rendered = decodeEntities(
    withoutCode
      .replace(LINK, linkReplacer)
      .replace(EMPHASIS, '**$2**')
      // Must run before REMAINING_TAG: stripped outright, <br> would fuse
      // the words on either side of it instead of separating them.
      .replace(BREAK, ' ')
      .replace(REMAINING_TAG, ''),
  )
    // A cell may wrap across source lines; a markdown row is one line.
    .replace(/\s+/g, ' ')
    // Escaped after tag removal so a pipe introduced by decoding is caught too.
    .replace(/\|/g, '\\|')
    .trim();

  // A lookup, not a walk: each surviving token names its own index, so it
  // resolves to its own body regardless of how many other tokens were
  // deleted along with the tag or attribute that enclosed them.
  return rendered.replace(CODE_PLACEHOLDER, (_match, indexText: string) => {
    const body = codeBodies[Number(indexText)];

    return body === undefined ? '' : `\`${body.replace(/\|/g, '\\|')}\``;
  });
}

function linkReplacer(_match: string, attrs: string, text: string): string {
  const hrefMatch = HREF_ATTR.exec(attrs);

  // No href, or one this pattern can't parse: keep the text rather than
  // let the whole anchor vanish.
  if (hrefMatch === null) {
    return text;
  }

  const href = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '';

  return `[${text}](${href})`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#123;/g, '{')
    .replace(/&#125;/g, '}')
    .replace(/&#124;/g, '|')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}
