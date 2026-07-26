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
});
