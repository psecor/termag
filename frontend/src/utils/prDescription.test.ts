import { describe, expect, it } from 'vitest';
import { prDescription } from './prDescription';

describe('prDescription', () => {
  it('drops a PR template’s HTML comments, one line or several', () => {
    const body = '<!-- Describe the change. -->\n## What\n\nThe fix.\n\n<!--\nChecklist:\n- tests\n-->\n- [x] tests';
    expect(prDescription(body)).toBe('## What\n\nThe fix.\n\n- [x] tests');
  });

  it('keeps a comment inside fenced code, which GitHub shows as code', () => {
    const body = 'Before\n\n```html\n<!-- kept -->\n```\n\n<!-- dropped -->After';
    expect(prDescription(body)).toBe('Before\n\n```html\n<!-- kept -->\n```\n\nAfter');
  });

  it('keeps a comment inside an inline code span, and a fence’s blank lines', () => {
    expect(prDescription('Use `<!-- prettier-ignore -->` here<!-- gone -->.')).toBe('Use `<!-- prettier-ignore -->` here.');
    expect(prDescription('``a <!-- b --> `c` ``<!-- x -->')).toBe('``a <!-- b --> `c` ``');
    expect(prDescription('```\na\n\n\n\nb\n```')).toBe('```\na\n\n\n\nb\n```');
    expect(prDescription('<!-- has `code` -->Text')).toBe('Text');
  });

  it('ends a fence only on a closing fence of its own kind', () => {
    const body = '~~~\n```\n<!-- still code -->\n~~~\n<!-- gone -->';
    expect(prDescription(body)).toBe('~~~\n```\n<!-- still code -->\n~~~');
  });

  it('leaves an unclosed comment as text, and an empty body empty', () => {
    expect(prDescription('Text <!-- never closed')).toBe('Text <!-- never closed');
    expect(prDescription('')).toBe('');
    expect(prDescription(null)).toBe('');
    expect(prDescription('<!-- only a template -->\n')).toBe('');
  });

  it('reads Windows line endings', () => {
    expect(prDescription('a\r\n<!-- x -->\r\nb')).toBe('a\n\nb');
  });
});
