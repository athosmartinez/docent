import { encode } from 'gpt-tokenizer';

import { TABLE_CLOSE, TABLE_OPEN } from './html-table';

export interface Chunk {
  content: string;
  headingPath: string[];
  tokenCount: number;
  ordinal: number;
}

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  minTokens?: number;
}

interface Section {
  headingPath: string[];
  lines: string[];
}

const DEFAULTS = { targetTokens: 800, maxTokens: 1200, minTokens: 100 };

const PAGE_HEADING = /^###\s+(.+?)\s*$/;
const SECTION_HEADING = /^####\s+(.+?)\s*$/;
// A fence marker may sit behind any number of blockquote levels — Nest's
// admonitions render their code samples with a `>` prefix on every line,
// fence markers included.
const FENCE = /^(?:\s*>)*\s*```/;
const QUOTE_PREFIX = /^(?:\s*>)*/;

function countTokens(text: string): number {
  return encode(text).length;
}

function quoteDepth(line: string): number {
  const prefix = QUOTE_PREFIX.exec(line)?.[0] ?? '';

  return (prefix.match(/>/g) ?? []).length;
}

// A table that has run this many multiples of the *default* ceiling without
// meeting a `</table>` is not a legitimate reference table left long on
// purpose — it is a `<table>` whose closing tag is missing or malformed.
// Left untreated, the table tracker would keep reporting every remaining
// line as "part of the table", bypassing both the ceiling and the
// paragraph-break flush and swallowing the rest of the section into one
// chunk that can outgrow even an embedding model's input limit (8191 tokens
// for the models this service targets).
//
// This is pinned to DEFAULTS.maxTokens rather than whatever maxTokens a
// particular call is given: the bound polices a source *defect*, not normal
// chunk sizing, so it has to stay meaningful even when a caller configures a
// small maxTokens for its own chunking preferences — a legitimate reference
// table's real size has nothing to do with that per-call setting. At 5x the
// default ceiling (6000 tokens) it sits comfortably above the largest table
// this module is tested against (~5000 tokens) while leaving clear headroom
// under the embedding limit even with some buffered prose ahead of the table.
const UNCLOSED_TABLE_CEILING_MULTIPLE = 5;
const UNCLOSED_TABLE_TOKEN_BOUND =
  UNCLOSED_TABLE_CEILING_MULTIPLE * DEFAULTS.maxTokens;

/**
 * Tracks whether a scan is inside a fenced code block, aware of the
 * blockquote depth the fence opened at. A fence declared inside a
 * blockquote cannot outlive that blockquote: if the quote ends — a shallower
 * or blank line arrives — before a matching close marker does (the Nest
 * corpus has at least one file where it never does), the fence closes
 * there, mirroring how CommonMark terminates an unclosed fence at its
 * container's edge rather than letting it swallow the rest of the document.
 */
function createFenceTracker() {
  let insideFence = false;
  let openDepth = 0;

  return {
    get insideFence(): boolean {
      return insideFence;
    },
    /** Feeds one line to the tracker; returns whether it is a fence marker. */
    consume(line: string): boolean {
      if (insideFence && quoteDepth(line) < openDepth) {
        insideFence = false;
      }

      if (!FENCE.test(line)) {
        return false;
      }

      if (!insideFence) {
        insideFence = true;
        openDepth = quoteDepth(line);
      } else if (quoteDepth(line) === openDepth) {
        insideFence = false;
      }

      return true;
    },
  };
}

/**
 * Tracks whether a scan is inside an HTML table. A table is atomic for the
 * same reason a fenced block is: half a reference table is worse than a chunk
 * that runs long, and because chunks carry no overlap, the half that begins on
 * a bare cell can never be reassembled from what precedes it.
 *
 * Atomic still has to end somewhere. Like `createFenceTracker`, a table
 * closes without a literal `</table>` when the blockquote it opened in ends
 * first — the table cannot outlive its container any more than a fence can.
 * A table also needs a second escape a fence does not: `markdown-cleaner.ts`
 * deliberately forwards a table it cannot convert as raw, unclosed HTML
 * rather than dropping it, so a truncated or malformed source table can
 * reach here with no closing tag and no blockquote to bound it either. For
 * that case, the table closes once it has run past
 * `UNCLOSED_TABLE_TOKEN_BOUND` without meeting `</table>`.
 */
function createTableTracker() {
  let insideTable = false;
  let openDepth = 0;
  let tokensSinceOpen = 0;

  return {
    get insideTable(): boolean {
      return insideTable;
    },
    /**
     * Feeds one line; returns whether it belongs to a table. The closing line
     * counts as part of the table, so a caller cannot flush between the last
     * row and `</table>`.
     */
    consume(line: string): boolean {
      if (
        insideTable &&
        (quoteDepth(line) < openDepth ||
          tokensSinceOpen > UNCLOSED_TABLE_TOKEN_BOUND)
      ) {
        insideTable = false;
      }

      if (!insideTable && TABLE_OPEN.test(line)) {
        insideTable = true;
        openDepth = quoteDepth(line);
        tokensSinceOpen = 0;
      }

      const partOfTable = insideTable;

      if (insideTable) {
        tokensSinceOpen += countTokens(line);
      }

      if (insideTable && TABLE_CLOSE.test(line)) {
        insideTable = false;
      }

      return partOfTable;
    },
  };
}

/**
 * Splits a document on its section headings. Boundaries follow the document's
 * own structure rather than a fixed window, which is why chunks carry no
 * overlap: the heading trail supplies the context an overlap would try to
 * recover, without duplicating text into the index.
 */
export function chunkMarkdown(
  content: string,
  options: ChunkOptions = {},
): Chunk[] {
  const { targetTokens, maxTokens, minTokens } = { ...DEFAULTS, ...options };

  const sections = splitIntoSections(content);
  const merged = mergeUndersizedSections(sections, minTokens);

  const chunks: Chunk[] = [];

  for (const section of merged) {
    for (const body of splitOversizedSection(
      section.lines,
      targetTokens,
      maxTokens,
      minTokens,
    )) {
      const trimmed = body.trim();

      if (trimmed.length === 0) {
        continue;
      }

      chunks.push({
        content: trimmed,
        headingPath: section.headingPath,
        tokenCount: countTokens(trimmed),
        ordinal: chunks.length,
      });
    }
  }

  return chunks;
}

function splitIntoSections(content: string): Section[] {
  const sections: Section[] = [];

  let pageTitle: string | null = null;
  let current: Section = { headingPath: [], lines: [] };
  const fence = createFenceTracker();

  const flush = (): void => {
    if (current.lines.join('').trim().length > 0) {
      sections.push(current);
    }
  };

  for (const line of content.split('\n')) {
    if (fence.consume(line)) {
      current.lines.push(line);
      continue;
    }

    // A heading inside a fence is code, not structure.
    if (!fence.insideFence) {
      const page = PAGE_HEADING.exec(line);

      if (page?.[1] !== undefined) {
        flush();
        pageTitle = page[1];
        current = { headingPath: [pageTitle], lines: [] };
        continue;
      }

      const section = SECTION_HEADING.exec(line);

      if (section?.[1] !== undefined) {
        flush();
        current = {
          headingPath:
            pageTitle === null ? [section[1]] : [pageTitle, section[1]],
          lines: [],
        };
        continue;
      }
    }

    current.lines.push(line);
  }

  flush();

  return sections;
}

interface Contribution {
  headingPath: string[];
  tokens: number;
}

interface MergeGroup {
  lines: string[];
  contributions: Contribution[];
}

/**
 * Folds sections under `minTokens` into their neighbors so a stray one-line
 * section never ships as its own chunk. Merging always happens forward
 * (into whatever comes next) except for a trailing run, which has no "next"
 * and instead folds backward into whatever was emitted before it — unless
 * it is the only content in the document, in which case there is nothing to
 * fold into and it ships alone.
 */
function mergeUndersizedSections(
  sections: Section[],
  minTokens: number,
): Section[] {
  if (minTokens <= 0) {
    return sections;
  }

  const groups = groupByMinimum(sections, minTokens);
  const finalized = foldTrailingShortfallBackward(groups, minTokens);

  return finalized.map((group) => ({
    headingPath: dominantHeadingPath(group.contributions),
    lines: group.lines,
  }));
}

function groupByMinimum(sections: Section[], minTokens: number): MergeGroup[] {
  const groups: MergeGroup[] = [];

  let pending: MergeGroup = { lines: [], contributions: [] };

  for (const section of sections) {
    pending = {
      lines: [...pending.lines, ...section.lines],
      contributions: [
        ...pending.contributions,
        {
          headingPath: section.headingPath,
          tokens: countTokens(section.lines.join('\n')),
        },
      ],
    };

    if (countTokens(pending.lines.join('\n')) >= minTokens) {
      groups.push(pending);
      pending = { lines: [], contributions: [] };
    }
  }

  // A trailing run that never reached the minimum still has to surface
  // somewhere; foldTrailingShortfallBackward decides where.
  if (pending.contributions.length > 0) {
    groups.push(pending);
  }

  return groups;
}

function foldTrailingShortfallBackward(
  groups: MergeGroup[],
  minTokens: number,
): MergeGroup[] {
  if (groups.length < 2) {
    return groups;
  }

  const last = groups[groups.length - 1];
  const previous = groups[groups.length - 2];

  if (
    last === undefined ||
    previous === undefined ||
    countTokens(last.lines.join('\n')) >= minTokens
  ) {
    return groups;
  }

  const combined: MergeGroup = {
    lines: [...previous.lines, ...last.lines],
    contributions: [...previous.contributions, ...last.contributions],
  };

  return [...groups.slice(0, -2), combined];
}

function dominantHeadingPath(contributions: Contribution[]): string[] {
  const dominant = contributions.reduce(
    (best, contribution) =>
      contribution.tokens > best.tokens ? contribution : best,
    contributions[0] ?? { headingPath: [], tokens: -1 },
  );

  return dominant.headingPath;
}

function splitOversizedSection(
  lines: string[],
  targetTokens: number,
  maxTokens: number,
  minTokens: number,
): string[] {
  const whole = lines.join('\n');

  if (countTokens(whole) <= maxTokens) {
    return [whole];
  }

  const bodies = splitAtSafeBoundaries(lines, targetTokens, maxTokens);

  return foldShortTrailingBody(bodies, minTokens, maxTokens);
}

function splitAtSafeBoundaries(
  lines: string[],
  targetTokens: number,
  maxTokens: number,
): string[] {
  const bodies: string[] = [];

  let buffer: string[] = [];
  const fence = createFenceTracker();
  const table = createTableTracker();

  const flush = (): void => {
    if (buffer.join('').trim().length > 0) {
      bodies.push(buffer.join('\n'));
    }

    buffer = [];
  };

  for (const line of lines) {
    if (fence.consume(line)) {
      buffer.push(line);
      continue;
    }

    // A table is only a table outside a fence; inside one it is an example of
    // markup, not content.
    const opensTable =
      !fence.insideFence && !table.insideTable && TABLE_OPEN.test(line);

    // Flushing before the table opens, rather than after its first row, lets a
    // full buffer close cleanly and the table start a chunk of its own.
    if (
      opensTable &&
      buffer.length > 0 &&
      countTokens(buffer.join('\n')) >= targetTokens
    ) {
      flush();
    }

    if (!fence.insideFence && table.consume(line)) {
      // Never a safe place to break, for the same reason as a fence: a
      // reference table split in half loses the half that has no header.
      buffer.push(line);
      continue;
    }

    // Checked before the line is appended, so maxTokens is a true ceiling
    // rather than a threshold the buffer is allowed to run past by one
    // line's worth of tokens. A run with no blank line to break at (a raw
    // HTML table with no gap between rows, for instance) would otherwise
    // grow unbounded; falling back to a line break here still bounds it.
    // The fence check above still wins: a buffer left oversized by an
    // atomic fence is flushed whole once the fence closes.
    if (
      !fence.insideFence &&
      buffer.length > 0 &&
      countTokens([...buffer, line].join('\n')) > maxTokens
    ) {
      flush();
    }

    buffer.push(line);

    if (fence.insideFence) {
      // Content inside a fence is never a safe place to break, no matter how
      // large the buffer grows: half an example retrieves worse than a
      // chunk that runs long.
      continue;
    }

    const bufferTokens = countTokens(buffer.join('\n'));
    const atParagraphBreak = line.trim().length === 0;

    if (atParagraphBreak && bufferTokens >= targetTokens) {
      flush();
    }
  }

  flush();

  return bodies;
}

function foldShortTrailingBody(
  bodies: string[],
  minTokens: number,
  maxTokens: number,
): string[] {
  if (bodies.length < 2) {
    return bodies;
  }

  const last = bodies[bodies.length - 1];
  const previous = bodies[bodies.length - 2];

  if (
    last === undefined ||
    previous === undefined ||
    countTokens(last) >= minTokens
  ) {
    return bodies;
  }

  const combined = `${previous}\n${last}`;

  // Only fold when it keeps the ceiling: a small-but-bounded trailing
  // fragment is preferable to reopening the defect this function fixes.
  if (countTokens(combined) > maxTokens) {
    return bodies;
  }

  return [...bodies.slice(0, -2), combined];
}
