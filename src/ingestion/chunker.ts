import { encode } from 'gpt-tokenizer';

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
const FENCE = /^\s*```/;

function countTokens(text: string): number {
  return encode(text).length;
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
  let insideFence = false;

  const flush = (): void => {
    if (current.lines.join('').trim().length > 0) {
      sections.push(current);
    }
  };

  for (const line of content.split('\n')) {
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      current.lines.push(line);
      continue;
    }

    // A heading inside a fence is code, not structure.
    if (!insideFence) {
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

function mergeUndersizedSections(
  sections: Section[],
  minTokens: number,
): Section[] {
  if (minTokens <= 0) {
    return sections;
  }

  const merged: Section[] = [];

  let pending: Section | null = null;

  for (const section of sections) {
    const combined: Section = pending
      ? {
          headingPath: pending.headingPath,
          lines: [...pending.lines, ...section.lines],
        }
      : section;

    if (countTokens(combined.lines.join('\n')) < minTokens) {
      pending = combined;
      continue;
    }

    merged.push(combined);
    pending = null;
  }

  // A trailing run that never reached the minimum still has to be emitted.
  if (pending !== null) {
    merged.push(pending);
  }

  return merged;
}

function splitOversizedSection(
  lines: string[],
  targetTokens: number,
  maxTokens: number,
): string[] {
  const whole = lines.join('\n');

  if (countTokens(whole) <= maxTokens) {
    return [whole];
  }

  const bodies: string[] = [];

  let buffer: string[] = [];
  let insideFence = false;

  const flush = (): void => {
    if (buffer.join('').trim().length > 0) {
      bodies.push(buffer.join('\n'));
    }

    buffer = [];
  };

  for (const line of lines) {
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      buffer.push(line);
      continue;
    }

    buffer.push(line);

    // A blank line outside a fence is the only place a split is safe: breaking
    // inside a code block would hand the reader half an example.
    const atParagraphBreak = !insideFence && line.trim().length === 0;

    if (atParagraphBreak && countTokens(buffer.join('\n')) >= targetTokens) {
      flush();
    }
  }

  flush();

  return bodies;
}
