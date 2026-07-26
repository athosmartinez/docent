import { chunkMarkdown } from './chunker';

describe('chunkMarkdown', () => {
  it('splits on #### and records the heading trail', () => {
    const content = [
      '### Guards',
      'Intro paragraph.',
      '',
      '#### Authorization guard',
      'First section body.',
      '',
      '#### Binding guards',
      'Second section body.',
    ].join('\n');

    const chunks = chunkMarkdown(content, { minTokens: 0 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(
      chunks.some(
        (c) => c.headingPath.join(' > ') === 'Guards > Authorization guard',
      ),
    ).toBe(true);
    expect(
      chunks.some(
        (c) => c.headingPath.join(' > ') === 'Guards > Binding guards',
      ),
    ).toBe(true);
  });

  it('numbers chunks consecutively from zero', () => {
    const content = [
      '### Page',
      '#### One',
      'Body one.',
      '#### Two',
      'Body two.',
      '#### Three',
      'Body three.',
    ].join('\n');

    const ordinals = chunkMarkdown(content, { minTokens: 0 }).map(
      (c) => c.ordinal,
    );

    expect(ordinals).toEqual(ordinals.map((_v, i) => i));
  });

  it('never splits a fenced code block, even past the ceiling', () => {
    const bigCodeBlock = [
      '```typescript',
      ...Array.from({ length: 400 }, (_v, i) => `const v${i} = ${i};`),
      '```',
    ].join('\n');
    const content = ['### Page', '#### Section', bigCodeBlock].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 100,
      maxTokens: 150,
      minTokens: 0,
    });

    const fenceCount = chunks.filter((c) => c.content.includes('```')).length;
    const opens = chunks.map((c) => (c.content.match(/```/g) ?? []).length);

    expect(fenceCount).toBeGreaterThan(0);
    // Every chunk that contains a fence marker must contain an even number of
    // them — an odd count means a block was cut in half.
    for (const count of opens) {
      expect(count % 2).toBe(0);
    }
  });

  it('merges a section below the minimum into the following one', () => {
    const content = [
      '### Page',
      '#### Tiny',
      'Short.',
      '#### Substantial',
      'A considerably longer body that comfortably exceeds the minimum on its own.',
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      minTokens: 50,
      targetTokens: 800,
      maxTokens: 1200,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('Short.');
    expect(chunks[0]?.content).toContain('considerably longer body');
  });

  it('splits an oversized prose section on paragraph boundaries', () => {
    const paragraph = `${'word '.repeat(200)}\n`;
    const content = [
      '### Page',
      '#### Long',
      paragraph,
      paragraph,
      paragraph,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 120,
      maxTokens: 200,
      minTokens: 0,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toEqual(['Page', 'Long']);
    }
  });

  it('reports a token count that tracks content length', () => {
    const chunks = chunkMarkdown('### Page\nSome prose here.', {
      minTokens: 0,
    });

    expect(chunks[0]?.tokenCount).toBeGreaterThan(0);
  });

  it('returns nothing for content with no prose', () => {
    expect(chunkMarkdown('   \n\n  ', { minTokens: 0 })).toEqual([]);
  });

  it('never splits a blockquoted fenced code block, even past the ceiling', () => {
    // Nest's admonitions render their code samples with a blockquote prefix
    // on every line, including the fence markers themselves.
    const bigQuotedCodeBlock = [
      '> ```typescript',
      ...Array.from({ length: 400 }, (_v, i) => `> const v${i} = ${i};`),
      '> ```',
    ].join('\n');
    const content = [
      '### Page',
      '#### Section',
      '> warning **Warning** Something important',
      bigQuotedCodeBlock,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 100,
      maxTokens: 150,
      minTokens: 0,
    });

    const opens = chunks.map((c) => (c.content.match(/```/g) ?? []).length);

    expect(opens.some((count) => count > 0)).toBe(true);
    // An odd count means a blockquoted fence was cut in half.
    for (const count of opens) {
      expect(count % 2).toBe(0);
    }
  });

  it('recovers the next heading after a blockquoted fence that never closes', () => {
    // A real file in the corpus (security/helmet.md) has an admonition whose
    // fence is never closed before the next heading — a genuine defect in
    // the source markdown. The fence cannot swallow the rest of the
    // document: it has to end where its blockquote ends, so the following
    // section is still recognized rather than merged into this one.
    const content = [
      '### Page',
      '#### First section',
      '> warning **Warning** Unclosed example below:',
      '>',
      '> ```typescript',
      '> app.use(helmet());',
      '',
      '#### Second section',
      'Prose that must not be swallowed into the first section.',
    ].join('\n');

    const chunks = chunkMarkdown(content, { minTokens: 0 });

    expect(
      chunks.some((c) => c.headingPath.join(' > ') === 'Page > Second section'),
    ).toBe(true);
    expect(
      chunks.some((c) =>
        c.content.includes('Prose that must not be swallowed'),
      ),
    ).toBe(true);
  });

  it('labels a merged chunk with the heading of its dominant contributor', () => {
    // 90 repeated words clears minTokens (50) on its own, deterministically —
    // unlike hand-counted prose, its token count doesn't depend on tokenizer
    // quirks around punctuation or contractions.
    const substantialBody = `${'word '.repeat(90).trim()}.`;
    const content = [
      '### Page',
      '#### Tiny1',
      'One.',
      '#### Tiny2',
      'Two.',
      '#### Tiny3',
      'Three.',
      '#### Substantial',
      substantialBody,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      minTokens: 50,
      targetTokens: 800,
      maxTokens: 1200,
    });

    expect(chunks).toHaveLength(1);
    // Three short sections contribute almost no text next to the fourth;
    // the label must follow the content, not the first section in the run.
    expect(chunks[0]?.headingPath).toEqual(['Page', 'Substantial']);
  });

  it('merges a trailing under-minimum section backward into the previous chunk', () => {
    const substantialBody = `${'word '.repeat(90).trim()}.`;
    const content = [
      '### Page',
      '#### Substantial',
      substantialBody,
      '#### Tiny',
      'Short.',
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      minTokens: 50,
      targetTokens: 800,
      maxTokens: 1200,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('Short.');
    expect(chunks[0]?.headingPath).toEqual(['Page', 'Substantial']);
  });

  it('emits a single short chunk when the whole document is one under-minimum section', () => {
    // A trailing shortfall merges backward only when there is a previous
    // chunk to absorb it; a document that is entirely one section has none.
    const content = ['### Page', '#### Only', 'Short only.'].join('\n');

    const chunks = chunkMarkdown(content, {
      minTokens: 50,
      targetTokens: 800,
      maxTokens: 1200,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toEqual(['Page', 'Only']);
  });

  it('folds a short trailing split fragment back into the piece before it', () => {
    const bigParagraph = `${'word '.repeat(500)}\n`;
    const hint = 'One final short hint line.';
    const content = [
      '### Page',
      '#### Long',
      bigParagraph,
      bigParagraph,
      hint,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 400,
      maxTokens: 600,
      minTokens: 100,
    });

    expect(chunks.length).toBeGreaterThan(0);
    const last = chunks[chunks.length - 1];
    // The trailing fragment ("One final short hint line.") must not ship on
    // its own below the minimum — it has to fold into the piece before it.
    expect(last?.tokenCount).toBeGreaterThanOrEqual(100);
    expect(last?.content).toContain('One final short hint line.');
  });

  it('falls back to a line-boundary split when a piece has no blank line to break at', () => {
    // A raw HTML table with no blank line between rows: the paragraph-break
    // split point never arrives, so the ceiling has to win some other way.
    const tableRows = Array.from(
      { length: 200 },
      (_v, i) => `<tr><td>Row ${i}</td><td>Value ${i}</td></tr>`,
    ).join('\n');
    const content = [
      '### Page',
      '#### Table',
      `<table>\n${tableRows}\n</table>`,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 100,
      maxTokens: 150,
      minTokens: 0,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(150);
    }
  });
});
