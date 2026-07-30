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
// tag-stripping pass.
//
// The placeholder carries its own array index rather than being a bare
// repeated character restored by counting occurrences left to right:
// FIGURE_BLOCK and ANGULAR_COMPONENT delete substrings, and a deleted
// region can itself contain a placeholder (a span written *inside* the
// figure or component being removed). A counter that just counts whatever
// placeholders are still standing shifts every one after the deleted slot
// onto the wrong content instead of dropping it — silently fabricating a
// citation instead of losing one. Baking the index into the token turns
// restoration into a lookup: a placeholder that survives always resolves
// to its own content no matter how many others were deleted around it, and
// one that gets deleted along with its enclosing block is simply never
// looked up.
//
// A private-use codepoint, distinct from the table converter's own
// (0xe000), sanitized out of the input first so source text cannot forge a
// token — without a stray sentinel to work with, no digit sequence in the
// source can ever read as one of ours.
const PLACEHOLDER_MARK = String.fromCodePoint(0xe001);
// Built via RegExp rather than a literal so the sentinel is written once,
// as explicit source text, instead of appearing twice as an invisible
// character inside a regex literal.
const PLACEHOLDER = new RegExp(
  `${PLACEHOLDER_MARK}(\\d+)${PLACEHOLDER_MARK}`,
  'g',
);

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

    // Checked against the line with inline code spans removed, not the raw
    // line: prose documenting the tag itself (`` `<table>` ``) reads
    // identically to a real opening tag once TABLE_OPEN sees the raw text,
    // and there is no later `</table>` to close a buffer that should never
    // have opened — it swallows the rest of the document instead.
    if (!insideFence && TABLE_OPEN.test(line.replace(INLINE_CODE, ''))) {
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
  // A pre-existing occurrence of the sentinel in the source would let
  // crafted text forge a fake placeholder token, so every occurrence is
  // discarded first — the same collision the table converter had to close
  // off for its own placeholder.
  const sanitized = text.replaceAll(PLACEHOLDER_MARK, '');

  const extracted: string[] = [];
  const extract = (match: string): string => {
    const index = extracted.push(match) - 1;
    return `${PLACEHOLDER_MARK}${index}${PLACEHOLDER_MARK}`;
  };

  // Fences first, so a fence's own triple backtick is never mistaken for
  // the start of an inline span; whatever backticks remain afterward are
  // genuinely inline.
  const withoutFences = sanitized.replace(FENCED_BLOCK, extract);
  const withoutInlineCode = withoutFences.replace(INLINE_CODE, extract);

  const stripped = withoutInlineCode
    .replace(FIGURE_BLOCK, '')
    .replace(ANGULAR_COMPONENT, '');

  // A lookup, not a walk: each surviving token names its own index, so it
  // resolves to its own content regardless of how many other tokens were
  // deleted along with the figure or component that enclosed them.
  return stripped.replace(PLACEHOLDER, (_match, indexText: string) => {
    return extracted[Number(indexText)] ?? '';
  });
}
