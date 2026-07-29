/**
 * Recognising a table is shared: the cleaner uses these to accumulate one, the
 * chunker to refuse to cut inside one. A second definition would let the two
 * disagree about where a table begins.
 */
export const TABLE_OPEN = /<table[\s>]/i;
export const TABLE_CLOSE = /<\/table>/i;

const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL = /<(t[dh])[^>]*>([\s\S]*?)<\/\1>/gi;
const CODE = /<code>([\s\S]*?)<\/code>/gi;
const LINK = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const EMPHASIS = /<(strong|b)>([\s\S]*?)<\/\1>/gi;
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
  return (
    html
      .replace(CODE, '`$1`')
      .replace(LINK, '[$2]($1)')
      .replace(EMPHASIS, '**$2**')
      .replace(REMAINING_TAG, '')
      .replace(/&#123;/g, '{')
      .replace(/&#125;/g, '}')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      // A cell may wrap across source lines; a markdown row is one line.
      .replace(/\s+/g, ' ')
      // Escaped after tag removal so a pipe introduced by decoding is caught too.
      .replace(/\|/g, '\\|')
      .trim()
  );
}
