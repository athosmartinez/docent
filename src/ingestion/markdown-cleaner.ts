import { convertHtmlTable, TABLE_CLOSE, TABLE_OPEN } from './html-table';

export interface CleanedMarkdown {
  content: string;
  filenames: string[];
}

const FENCE = /^\s*```/;
const FILENAME_DIRECTIVE = /^\s*@@filename\(([^)]*)\)\s*$/;
const SWITCH_DIRECTIVE = /^\s*@@switch\s*$/;
const ANGULAR_COMPONENT = /<app-[a-z-]+[\s\S]*?(?:<\/app-[a-z-]+>|\/>)/g;
const FIGURE_BLOCK = /<figure>[\s\S]*?<\/figure>/g;
// Matched on the joined document rather than per line, so a fenced block or
// an Angular component that spans several lines is still recognised as one
// unit. Fences are extracted before inline spans so a fence's own triple
// backtick is never mistaken for the start of an inline one.
const FENCED_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
// FIGURE_BLOCK and ANGULAR_COMPONENT match on raw substrings, so a page
// documenting that markup — an entity-encoded example inside a table cell's
// <code> body, or a literal `<app-foo></app-foo>` typed in prose backticks
// — reads identically to the real thing once entities are decoded. Both
// strips are run only after fences and inline code spans are lifted out to
// a placeholder, and restored once the strip has passed; the same technique
// the table converter uses to protect a cell's <code> body from its own
// tag-stripping pass. Distinct private-use codepoints from the converter's
// sentinel, spelled out via fromCodePoint rather than as a literal
// character in the source, so the placeholder stays visible on review
// instead of looking like an empty string.
const FENCE_PLACEHOLDER = String.fromCodePoint(0xe001);
const INLINE_CODE_PLACEHOLDER = String.fromCodePoint(0xe002);

/**
 * The Nest documentation carries markup that is not standard markdown: a
 * `@@filename` directive naming the file an example belongs to, and a
 * `@@switch` marker after which the same example is repeated in JavaScript.
 *
 * The JavaScript half is discarded rather than indexed. Keeping it would turn
 * every example into two near-duplicate chunks competing for the same retrieval
 * slots, which costs more than it gains for readers who asked in either
 * language.
 */
export function cleanMarkdown(raw: string): CleanedMarkdown {
  const filenames: string[] = [];
  const output: string[] = [];

  let insideFence = false;
  let skippingSwitchBranch = false;
  let tableBuffer: string[] | null = null;

  for (const line of raw.split('\n')) {
    if (FENCE.test(line)) {
      if (insideFence) {
        insideFence = false;
        skippingSwitchBranch = false;
      } else {
        insideFence = true;
      }

      output.push(line);
      continue;
    }

    if (skippingSwitchBranch) {
      continue;
    }

    if (tableBuffer !== null) {
      tableBuffer.push(line);

      if (TABLE_CLOSE.test(line)) {
        output.push(convertHtmlTable(tableBuffer.join('\n')));
        tableBuffer = null;
      }

      continue;
    }

    if (!insideFence && TABLE_OPEN.test(line)) {
      tableBuffer = [line];

      if (TABLE_CLOSE.test(line)) {
        output.push(convertHtmlTable(tableBuffer.join('\n')));
        tableBuffer = null;
      }

      continue;
    }

    if (insideFence) {
      const filenameMatch = FILENAME_DIRECTIVE.exec(line);

      if (filenameMatch?.[1] !== undefined) {
        filenames.push(filenameMatch[1]);
        continue;
      }

      if (SWITCH_DIRECTIVE.test(line)) {
        skippingSwitchBranch = true;
        continue;
      }
    }

    output.push(line);
  }

  // A table the document never closes is emitted as found. Dropping it would
  // lose content; converting a fragment would invent structure.
  if (tableBuffer !== null) {
    output.push(tableBuffer.join('\n'));
  }

  const content = stripDecorativeMarkup(output.join('\n'))
    // Collapse the blank runs the removals leave behind.
    .replace(/\n{3,}/g, '\n\n');

  return { content, filenames };
}

/**
 * Removes the illustrative markup the Nest docs carry — `<figure>` image
 * wrappers and Angular banner components — without touching a fenced code
 * block or an inline code span, either of which may hold that exact markup
 * as the subject being documented rather than decoration to drop.
 */
function stripDecorativeMarkup(text: string): string {
  // A pre-existing occurrence of either sentinel in the source would be
  // mistaken for one of ours and stolen by the restore step below, so any
  // prior occurrence is discarded first — the same collision the table
  // converter had to close off for its own placeholder.
  const sanitized = text
    .replaceAll(FENCE_PLACEHOLDER, '')
    .replaceAll(INLINE_CODE_PLACEHOLDER, '');

  const fences: string[] = [];
  const withoutFences = sanitized.replace(FENCED_BLOCK, (match) => {
    fences.push(match);
    return FENCE_PLACEHOLDER;
  });

  const inlineSpans: string[] = [];
  const withoutInlineCode = withoutFences.replace(INLINE_CODE, (match) => {
    inlineSpans.push(match);
    return INLINE_CODE_PLACEHOLDER;
  });

  const stripped = withoutInlineCode
    .replace(FIGURE_BLOCK, '')
    .replace(ANGULAR_COMPONENT, '');

  let nextInlineSpan = 0;
  const withInlineCodeRestored = stripped.replaceAll(
    INLINE_CODE_PLACEHOLDER,
    () => {
      const span = inlineSpans[nextInlineSpan];
      nextInlineSpan += 1;
      return span ?? '';
    },
  );

  let nextFence = 0;
  return withInlineCodeRestored.replaceAll(FENCE_PLACEHOLDER, () => {
    const fence = fences[nextFence];
    nextFence += 1;
    return fence ?? '';
  });
}
