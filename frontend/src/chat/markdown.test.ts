import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseMarkdown', () => {
  it('reads headings, paragraphs, lists and fenced code', () => {
    const blocks = parseMarkdown([
      'Here is **the plan**:',
      '',
      '## Steps',
      '- install',
      '- run `npm test`',
      '1. first',
      '2. second',
      '',
      '```bash',
      'npm install',
      'npm test',
      '```',
      '> careful',
      '---',
    ].join('\n'));
    expect(blocks.map(b => b.type)).toEqual(['p', 'h', 'ul', 'ol', 'code', 'quote', 'hr']);
    expect(blocks[1]).toEqual({ type: 'h', level: 2, inline: [{ t: 'text', v: 'Steps' }] });
    expect(blocks[2]).toMatchObject({ type: 'ul', items: [[{ t: 'text', v: 'install' }], [{ t: 'text', v: 'run ' }, { t: 'code', v: 'npm test' }]] });
    expect(blocks[4]).toEqual({ type: 'code', lang: 'bash', text: 'npm install\nnpm test', open: false });
  });

  it('keeps a fence still open mid-stream as code to the end', () => {
    const blocks = parseMarkdown('Run:\n```ts\nconst a = 1;\nconst b');
    expect(blocks[1]).toEqual({ type: 'code', lang: 'ts', text: 'const a = 1;\nconst b', open: true });
  });

  it('keeps a paragraph\'s line breaks and joins an indented list continuation', () => {
    expect(parseMarkdown('one\ntwo')).toEqual([{ type: 'p', inline: [{ t: 'text', v: 'one\ntwo' }] }]);
    expect(parseMarkdown('- a long\n  item')).toEqual([{ type: 'ul', items: [[{ t: 'text', v: 'a long item' }]] }]);
  });

  it('never makes markup out of HTML', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([{ type: 'p', inline: [{ t: 'text', v: '<script>alert(1)</script>' }] }]);
  });
});

describe('parseInline', () => {
  it('reads code, bold, italics and links', () => {
    expect(parseInline('a `b` **c** *d* [e](https://x.dev/y)')).toEqual([
      { t: 'text', v: 'a ' }, { t: 'code', v: 'b' }, { t: 'text', v: ' ' },
      { t: 'b', c: [{ t: 'text', v: 'c' }] }, { t: 'text', v: ' ' },
      { t: 'i', c: [{ t: 'text', v: 'd' }] }, { t: 'text', v: ' ' },
      { t: 'a', href: 'https://x.dev/y', c: [{ t: 'text', v: 'e' }] },
    ]);
  });

  it('leaves snake_case, stray markers and unsafe links as text', () => {
    expect(parseInline('run my_test_name now')).toEqual([{ t: 'text', v: 'run my_test_name now' }]);
    expect(parseInline('2 * 3 and a `')).toEqual([{ t: 'text', v: '2 * 3 and a `' }]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: '[x](javascript:alert(1))' }]);
    expect(parseInline('_emphasis_.')).toEqual([{ t: 'i', c: [{ t: 'text', v: 'emphasis' }] }, { t: 'text', v: '.' }]);
  });
});
