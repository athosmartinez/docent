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
    // A dense run of list items with no blank line between them: the
    // paragraph-break split point never arrives, so the ceiling has to win
    // some other way. (An HTML table is the other case that produces a run
    // like this, but a table is atomic — see the dedicated table tests below
    // — so this uses non-table content to exercise the line-boundary
    // fallback on its own.)
    const denseLines = Array.from(
      { length: 200 },
      (_v, i) => `- Row ${i}: value ${i}`,
    ).join('\n');
    const content = ['### Page', '#### List', denseLines].join('\n');

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

  it('never splits an HTML table, even past the ceiling', () => {
    const rows = Array.from(
      { length: 200 },
      (_v, i) =>
        `  <tr><td><code>option${i}</code></td><td>Description number ${i}</td></tr>`,
    );
    const content = [
      '### Page',
      '#### Section',
      '<table>',
      ...rows,
      '</table>',
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 100,
      maxTokens: 150,
      minTokens: 0,
    });

    for (const chunk of chunks) {
      const opens = (chunk.content.match(/<table/gi) ?? []).length;
      const closes = (chunk.content.match(/<\/table>/gi) ?? []).length;

      expect(opens).toBe(closes);
    }
  });

  it('flushes before a table rather than cutting into it', () => {
    const prose = Array.from(
      { length: 40 },
      (_v, i) => `Paragraph ${i} of prose.\n`,
    );
    const content = [
      '### Page',
      '#### Section',
      ...prose,
      '<table>',
      '  <tr><td>a</td><td>1</td></tr>',
      '  <tr><td>b</td><td>2</td></tr>',
      '</table>',
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 60,
      maxTokens: 100,
      minTokens: 0,
    });

    const withTable = chunks.filter((c) => /<table/i.test(c.content));

    expect(withTable).toHaveLength(1);
    expect(withTable[0]?.content).toContain('</table>');
  });

  it('does not treat table markup inside a fence as a table', () => {
    const content = [
      '### Page',
      '#### Section',
      '```html',
      '<table>',
      '  <tr><td>example</td></tr>',
      '</table>',
      '```',
      '',
      'Prose after the example.',
    ].join('\n');

    const chunks = chunkMarkdown(content, { minTokens: 0 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const fences = (chunk.content.match(/```/g) ?? []).length;

      expect(fences % 2).toBe(0);
    }
  });

  it('recovers from an unclosed table once enough content has piled up behind it', () => {
    // No `</table>` anywhere in this document: a genuine source defect. Past
    // the tracker's bound, the table has to give up and let the paragraphs
    // behind it chunk normally rather than being read as table rows forever.
    const prose = Array.from(
      { length: 500 },
      (_v, i) =>
        `Paragraph ${i} filler sentence to accumulate tokens for the unclosed table bound test.\n`,
    );
    const content = [
      '### Page',
      '#### Section',
      '<table>',
      '  <tr><td>a</td><td>1</td></tr>',
      '  <tr><td>b</td><td>2</td></tr>',
      '  <tr><td>c</td><td>3</td></tr>',
      ...prose,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 100,
      maxTokens: 200,
      minTokens: 0,
    });

    // The whole 500-paragraph document is nowhere near this small if it were
    // swallowed into one chunk (it runs past 7000 tokens); recovering into
    // 20 chunks proves the fallback engaged instead of reading to the end.
    expect(chunks).toHaveLength(20);

    const [swallowed, ...rest] = chunks;

    // The unclosed table is still an open tag with nothing to balance it, so
    // it never contains a `</table>` — that is the defect, not something
    // this fix invents. What the fix bounds is how much it drags with it:
    // 6006 tokens is the tracker's 6000-token bound plus the one line whose
    // arrival crosses it, not the ~7000+ tokens the rest of the document
    // would have added if the swallow had continued unbounded.
    expect(swallowed?.content).toContain('<table>');
    expect(swallowed?.content).not.toContain('</table>');
    expect(swallowed?.tokenCount).toBe(6006);

    // Ordinary paragraph-break chunking resumes immediately after recovery,
    // each piece bounded by the call's own maxTokens rather than the escape
    // bound — proving the escape hands control back rather than replacing
    // the normal ceiling with a looser one.
    for (const chunk of rest) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(200);
    }
    expect(rest[rest.length - 1]?.content).toContain('Paragraph 499');
  });

  it('still emits a legitimate table whole when it is larger than maxTokens but under the escape bound', () => {
    // A properly closed table, well past maxTokens, proves the new escape
    // bound only catches a table that never closes — it does not quietly
    // turn into a second, smaller ceiling on tables that behave.
    const rows = Array.from(
      { length: 150 },
      (_v, i) =>
        `  <tr><td><code>option${i}</code></td><td>Description number ${i}</td></tr>`,
    );
    const content = [
      '### Page',
      '#### Section',
      '<table>',
      ...rows,
      '</table>',
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 100,
      maxTokens: 300,
      minTokens: 0,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokenCount).toBe(3755);
    expect(chunks[0]?.content).toContain('<table>');
    expect(chunks[0]?.content).toContain('</table>');
  });

  it('leaves a blockquoted table that closes normally unaffected', () => {
    const rows = Array.from(
      { length: 5 },
      (_v, i) => `> <tr><td>row${i}</td><td>value${i}</td></tr>`,
    );
    const content = [
      '### Page',
      '#### Section',
      '> <table>',
      ...rows,
      '> </table>',
      '',
      'Prose after the blockquoted table.',
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 20,
      maxTokens: 50,
      minTokens: 0,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.tokenCount).toBe(108);
    expect(chunks[0]?.content).toContain('> <table>');
    expect(chunks[0]?.content).toContain('> </table>');
    expect(chunks[1]?.content).toBe('Prose after the blockquoted table.');
  });

  it('closes a blockquoted table at the quote edge when the quote ends before </table> does', () => {
    // The blockquote ends (a blank, unprefixed line) with no closing tag
    // ever having appeared inside it — mirroring how a blockquoted fence
    // that never closes ends at its container's edge rather than at end of
    // document.
    const rows = Array.from(
      { length: 5 },
      (_v, i) => `> <tr><td>row${i}</td><td>value${i}</td></tr>`,
    );
    const content = [
      '### Page',
      '#### Section',
      '> <table>',
      ...rows,
      '',
      'Prose after the blockquote ends, before any closing tag.',
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 20,
      maxTokens: 50,
      minTokens: 0,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.tokenCount).toBe(104);
    expect(chunks[0]?.content).not.toContain('</table>');
    expect(chunks[1]?.content).toBe(
      'Prose after the blockquote ends, before any closing tag.',
    );
  });

  it('still recognizes a heading following an unclosed table', () => {
    const content = [
      '### Page',
      '#### First section',
      '<table>',
      '  <tr><td>a</td><td>1</td></tr>',
      '',
      '#### Second section',
      'Prose that must not be swallowed into the first section.',
    ].join('\n');

    const chunks = chunkMarkdown(content, { minTokens: 0 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.headingPath.join(' > ')).toBe('Page > First section');
    expect(chunks[1]?.headingPath.join(' > ')).toBe('Page > Second section');
    expect(chunks[1]?.content).toBe(
      'Prose that must not be swallowed into the first section.',
    );
  });

  it('bounds an unclosed table even when a fence larger than the bound is nested inside it', () => {
    // The fence alone is ~7000 tokens, past the 6000-token bound on its own.
    // A fence is still atomic — it cannot be split just because a table
    // around it is misbehaving — so the chunk containing it is exactly as
    // large as the fence forces it to be. What the fix guarantees is that
    // nothing *after* the fence gets pulled in on top of it.
    const fenceLines = Array.from(
      { length: 1000 },
      (_v, i) => `const v${i} = ${i};`,
    );
    const prose = Array.from(
      { length: 100 },
      (_v, i) => `Paragraph ${i} filler sentence after the fence.\n`,
    );
    const content = [
      '### Page',
      '#### Section',
      '<table>',
      '  <tr><td>a</td><td>1</td></tr>',
      '```typescript',
      ...fenceLines,
      '```',
      ...prose,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 100,
      maxTokens: 200,
      minTokens: 0,
    });

    expect(chunks).toHaveLength(10);

    const [swallowed, ...rest] = chunks;

    expect(swallowed?.content).toContain('<table>');
    expect(swallowed?.content).not.toContain('</table>');
    expect(swallowed?.tokenCount).toBe(7023);
    // An odd fence-marker count would mean the fence itself got cut in half
    // — still forbidden, table or no table.
    expect((swallowed?.content.match(/```/g) ?? []).length).toBe(2);

    // The prose after the fence chunks normally rather than continuing to
    // be swallowed — proving the bound picked up the fence's size instead of
    // treating it as invisible.
    for (const chunk of rest) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(200);
    }
    expect(rest[rest.length - 1]?.content).toContain('Paragraph 99');
  });

  it('bounds an unclosed table containing a small fence, keeping the fence intact within the swallowed chunk', () => {
    // At 50 lines the fence itself (~350 tokens) is nowhere near the bound on
    // its own; the swallow only stops once the fence's tokens plus enough
    // trailing prose add up to the same 6006-token trigger point the
    // no-fence case hits, proving the fence's own size was actually counted
    // rather than silently skipped.
    const fenceLines = Array.from(
      { length: 50 },
      (_v, i) => `const v${i} = ${i};`,
    );
    const prose = Array.from(
      { length: 500 },
      (_v, i) =>
        `Paragraph ${i} filler sentence to accumulate tokens for the unclosed table bound test.\n`,
    );
    const content = [
      '### Page',
      '#### Section',
      '<table>',
      '  <tr><td>a</td><td>1</td></tr>',
      '```typescript',
      ...fenceLines,
      '```',
      ...prose,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 100,
      maxTokens: 200,
      minTokens: 0,
    });

    expect(chunks).toHaveLength(23);

    const [swallowed, ...rest] = chunks;

    expect(swallowed?.content).toContain('<table>');
    expect(swallowed?.content).not.toContain('</table>');
    expect(swallowed?.tokenCount).toBe(6006);
    expect((swallowed?.content.match(/```/g) ?? []).length).toBe(2);

    for (const chunk of rest) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(200);
    }
    expect(rest[rest.length - 1]?.content).toContain('Paragraph 499');
  });

  it('leaves a closed table containing a fence unaffected, emitted whole', () => {
    const fenceLines = Array.from(
      { length: 20 },
      (_v, i) => `const v${i} = ${i};`,
    );
    const content = [
      '### Page',
      '#### Section',
      '<table>',
      '  <tr><td>a</td><td>1</td></tr>',
      '```typescript',
      ...fenceLines,
      '```',
      '  <tr><td>b</td><td>2</td></tr>',
      '</table>',
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 20,
      maxTokens: 50,
      minTokens: 0,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokenCount).toBe(184);
    expect(chunks[0]?.content).toContain('<table>');
    expect(chunks[0]?.content).toContain('</table>');
    expect((chunks[0]?.content.match(/```/g) ?? []).length).toBe(2);
  });

  it('still does not treat table markup inside a fence as a table, with the fence-inclusive bound in place', () => {
    // Guards the change in this round specifically: consume() is now fed on
    // every line including fence content, so this proves that feeding it
    // did not also loosen when a table is allowed to *open*. If it had, the
    // prose below would be swallowed toward the table's bound instead of
    // chunking normally at each paragraph break.
    const prose = Array.from(
      { length: 10 },
      (_v, i) => `Paragraph ${i} of prose after the fenced example.\n`,
    );
    const content = [
      '### Page',
      '#### Section',
      '```html',
      '<table>',
      '  <tr><td>example</td></tr>',
      '</table>',
      '```',
      ...prose,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 20,
      maxTokens: 50,
      minTokens: 0,
    });

    expect(chunks).toHaveLength(6);

    const [fenced, ...rest] = chunks;

    expect(fenced?.tokenCount).toBe(32);
    expect((fenced?.content.match(/```/g) ?? []).length).toBe(2);

    // Normal paragraph-break chunking, not a table's much larger bound —
    // proving the fence's example markup never opened a real table.
    for (const chunk of rest) {
      expect(chunk.content).not.toContain('<table');
      expect(chunk.tokenCount).toBeLessThanOrEqual(50);
    }
    expect(rest[rest.length - 1]?.content).toContain('Paragraph 9');
  });

  // A markdown pipe table is the shape convertHtmlTable emits for a table
  // that had a header row. It carries no blank line anywhere inside it, so
  // before this fix the only thing that could act on it was the ceiling
  // fallback below — which has no table awareness — landing a cut on a bare
  // row with no header and no separator, the same unrecoverable half the
  // HTML table tracker exists to prevent.
  it('keeps a real converted table whole at production defaults, with enough prose ahead to approach the ceiling', () => {
    // content/techniques/validation.md's ValidationPipe options table,
    // converted, plus a single unbroken paragraph of prose sized so the
    // combined total lands just past the default 1200-token ceiling. The
    // prose alone (601 tokens) stays under the 800-token target, so the
    // paragraph-break flush never fires before the table starts — this is
    // the exact shape the corpus reproduced the defect with, not a
    // convenient one.
    const table = [
      '| Option | Type | Description |',
      '| --- | --- | --- |',
      '| `enableDebugMessages` | `boolean` | If set to true, validator will print extra warning messages to the console when something is not right. |',
      '| `skipUndefinedProperties` | `boolean` | If set to true then validator will skip validation of all properties that are undefined in the validating object. |',
      '| `skipNullProperties` | `boolean` | If set to true then validator will skip validation of all properties that are null in the validating object. |',
      '| `skipMissingProperties` | `boolean` | If set to true then validator will skip validation of all properties that are null or undefined in the validating object. |',
      '| `whitelist` | `boolean` | If set to true, validator will strip validated (returned) object of any properties that do not use any validation decorators. |',
      '| `forbidNonWhitelisted` | `boolean` | If set to true, instead of stripping non-whitelisted properties validator will throw an exception. |',
      '| `forbidUnknownValues` | `boolean` | If set to true, attempts to validate unknown objects fail immediately. |',
      '| `disableErrorMessages` | `boolean` | If set to true, validation errors will not be returned to the client. |',
      '| `errorHttpStatusCode` | `number` | This setting allows you to specify which exception type will be used in case of an error. By default it throws `BadRequestException`. |',
      '| `exceptionFactory` | `Function` | Takes an array of the validation errors and returns an exception object to be thrown. |',
      '| `groups` | `string[]` | Groups to be used during validation of the object. |',
      '| `always` | `boolean` | Set default for `always` option of decorators. Default can be overridden in decorator options. |',
      '| `strictGroups` | `boolean` | If `groups` is not given or is empty, ignore decorators with at least one group. |',
      '| `dismissDefaultMessages` | `boolean` | If set to true, the validation will not use default messages. Error message always will be `undefined` if its not explicitly set. |',
      '| `validationError.target` | `boolean` | Indicates if target should be exposed in `ValidationError`. |',
      '| `validationError.value` | `boolean` | Indicates if validated value should be exposed in `ValidationError`. |',
      '| `stopAtFirstError` | `boolean` | When set to true, validation of the given property will stop after encountering the first error. Defaults to false. |',
      "| `errorFormat` | `'list' \\| 'grouped'` | Specifies the format of validation error messages. `'list'` (default) returns an array of error message strings. `'grouped'` returns an object with property paths as keys and arrays of unmodified error messages as values, preserving custom validation messages without prepending parent path prefixes. |",
    ].join('\n');
    const prose = `${'word '.repeat(600).trim()}.`;
    const content = [
      '### Validation',
      '#### Using the built-in ValidationPipe',
      prose,
      '',
      table,
    ].join('\n');

    const chunks = chunkMarkdown(content);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('| Option | Type | Description |');
    expect(chunks[0]?.content).toContain('| --- | --- | --- |');
    expect(chunks[0]?.content).toContain(
      "`errorFormat` | `'list' \\| 'grouped'`",
    );
  });

  it('emits a converted table whole even when it is larger than maxTokens, like an oversized fence', () => {
    const rows = Array.from(
      { length: 150 },
      (_v, i) =>
        `| \`option${i}\` | Description number ${i} that runs a little longer to add tokens. |`,
    );
    const content = [
      '### Page',
      '#### Section',
      '| Option | Description |',
      '| --- | --- |',
      ...rows,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 100,
      maxTokens: 300,
      minTokens: 0,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokenCount).toBeGreaterThan(300);
    expect(chunks[0]?.content).toContain('| Option | Description |');
    expect(chunks[0]?.content).toContain('| --- | --- |');
    expect(chunks[0]?.content).toContain('option149');
  });

  it('still splits a definition list of 200 entries normally, proving it was not made atomic', () => {
    // convertHtmlTable's headerless-table output — individually
    // self-contained "- `key` — value" lines with no shared header or
    // separator row to lose — is not the shape this fix protects.
    const items = Array.from(
      { length: 200 },
      (_v, i) =>
        `- \`option${i}\` — Description number ${i} that adds a bit of length to each entry.`,
    );
    const content = ['### Page', '#### Section', ...items].join('\n');

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

  it('does not treat a line beginning with `|` inside a fenced code block as a table row', () => {
    const prose = Array.from(
      { length: 10 },
      (_v, i) => `Paragraph ${i} of prose after the fenced example.\n`,
    );
    const content = [
      '### Page',
      '#### Section',
      '```',
      '| this looks like a table row |',
      '| but is example text |',
      '```',
      ...prose,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 20,
      maxTokens: 50,
      minTokens: 0,
    });

    // Normal paragraph-break chunking, not a table's much larger unclosed
    // bound — proving the fenced pipe lines never opened a markdown table.
    expect(chunks).toHaveLength(6);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(50);
    }
    expect(chunks[chunks.length - 1]?.content).toContain('Paragraph 9');
  });

  it('keeps a converted table intact between ordinary prose before and after it', () => {
    const beforeProse = Array.from(
      { length: 40 },
      (_v, i) => `Paragraph ${i} of prose before the table.\n`,
    );
    const afterProse = Array.from(
      { length: 40 },
      (_v, i) => `Paragraph ${i} of prose after the table.\n`,
    );
    const content = [
      '### Page',
      '#### Section',
      ...beforeProse,
      '| A | B |',
      '| --- | --- |',
      '| a | 1 |',
      '| b | 2 |',
      '',
      ...afterProse,
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 60,
      maxTokens: 100,
      minTokens: 0,
    });

    const withTable = chunks.filter((c) => c.content.includes('| A | B |'));

    expect(withTable).toHaveLength(1);
    expect(withTable[0]?.content).toContain('| --- | --- |');
    expect(withTable[0]?.content).toContain('| a | 1 |');
    expect(withTable[0]?.content).toContain('| b | 2 |');
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(100);
    }
  });

  it('keeps an HTML table whole even when one of its cells spans a line starting with `|`', () => {
    // Two atomic regions can compose into a gap neither has alone: if a `|`
    // line inside an already-open HTML table were allowed to also open a
    // markdown table, the "flush before a table opens" check would treat it
    // as a fresh boundary and split the still-open HTML table right there.
    const rows = Array.from(
      { length: 30 },
      (_v, i) =>
        `  <tr><td>Row ${i} has enough prose in it to accumulate real tokens toward the target.</td></tr>`,
    );
    const content = [
      '### Page',
      '#### Section',
      '<table>',
      ...rows,
      '  | this pipe-looking line is inside an HTML table cell, not a markdown table row |',
      ...rows,
      '</table>',
    ].join('\n');

    const chunks = chunkMarkdown(content, {
      targetTokens: 60,
      maxTokens: 100,
      minTokens: 0,
    });

    expect(chunks).toHaveLength(1);
    expect((chunks[0]?.content.match(/<table/gi) ?? []).length).toBe(1);
    expect((chunks[0]?.content.match(/<\/table>/gi) ?? []).length).toBe(1);
  });
});
