import { cleanMarkdown } from './markdown-cleaner';

describe('cleanMarkdown', () => {
  it('drops the JavaScript half of a @@switch block', () => {
    const raw = [
      '```typescript',
      '@@filename(auth.guard)',
      'export class AuthGuard implements CanActivate {}',
      '@@switch',
      'export class AuthGuard {}',
      '```',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).toContain('implements CanActivate');
    expect(content).not.toContain('@@switch');
    expect(content).not.toContain('export class AuthGuard {}');
  });

  it('lifts @@filename out of the text and reports it', () => {
    const raw = [
      '```typescript',
      '@@filename(auth.guard)',
      'const x = 1;',
      '```',
    ].join('\n');

    const { content, filenames } = cleanMarkdown(raw);

    expect(filenames).toEqual(['auth.guard']);
    expect(content).not.toContain('@@filename');
    expect(content).toContain('const x = 1;');
  });

  it('leaves a fence without Nest markup untouched', () => {
    const raw = ['```typescript', 'const x = 1;', 'const y = 2;', '```'].join(
      '\n',
    );

    expect(cleanMarkdown(raw).content).toBe(raw);
  });

  it('removes Angular banner components', () => {
    const raw = [
      '### Guards',
      '',
      '<app-banner-courses></app-banner-courses>',
      '',
      'Text.',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).not.toContain('app-banner');
    expect(content).toContain('### Guards');
    expect(content).toContain('Text.');
  });

  it('removes figure blocks', () => {
    const raw = [
      '### Guards',
      '<figure><img class="illustrative-image" src="/assets/Guards_1.png" /></figure>',
      'Text.',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).not.toContain('<figure>');
    expect(content).not.toContain('<img');
    expect(content).toContain('Text.');
  });

  it('does not treat @@switch outside a fence as a directive', () => {
    const raw = 'Prose mentioning @@switch literally.';

    expect(cleanMarkdown(raw).content).toContain('@@switch');
  });

  it('handles several fences independently', () => {
    const raw = [
      '```typescript',
      'const a = 1;',
      '@@switch',
      'var a = 1;',
      '```',
      'Between.',
      '```typescript',
      'const b = 2;',
      '```',
    ].join('\n');

    const { content } = cleanMarkdown(raw);

    expect(content).not.toContain('var a = 1;');
    expect(content).toContain('const a = 1;');
    expect(content).toContain('const b = 2;');
    expect(content).toContain('Between.');
  });
});
