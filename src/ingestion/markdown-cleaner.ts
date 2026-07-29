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

  const content = output
    .join('\n')
    .replace(FIGURE_BLOCK, '')
    .replace(ANGULAR_COMPONENT, '')
    // Collapse the blank runs the removals leave behind.
    .replace(/\n{3,}/g, '\n\n');

  return { content, filenames };
}
