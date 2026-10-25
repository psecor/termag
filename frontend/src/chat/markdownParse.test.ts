import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, splitRow, type MdBlock } from './markdownParse';

const text = (v: string) => ({ t: 'text', v });
const para = (v: string) => ({ type: 'p', inline: [text(v)] });
const item = (...blocks: unknown[]) => ({ task: null, blocks });

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
    expect(blocks[1]).toEqual({ type: 'h', level: 2, inline: [text('Steps')] });
    expect(blocks[2]).toEqual({
      type: 'ul', tight: true,
      items: [item(para('install')), item({ type: 'p', inline: [text('run '), { t: 'code', v: 'npm test' }] })],
    });
    expect(blocks[3]).toMatchObject({ type: 'ol', start: 1, tight: true });
    expect(blocks[4]).toEqual({ type: 'code', lang: 'bash', text: 'npm install\nnpm test', open: false });
    expect(blocks[5]).toEqual({ type: 'quote', blocks: [para('careful')] });
  });

  it('keeps a fence still open mid-stream as code to the end', () => {
    const blocks = parseMarkdown('Run:\n```ts\nconst a = 1;\nconst b');
    expect(blocks[1]).toEqual({ type: 'code', lang: 'ts', text: 'const a = 1;\nconst b', open: true });
  });

  it('closes a fence only on a bare fence of the same kind and length', () => {
    const blocks = parseMarkdown('````md\n```js\nx\n```\n````\nafter');
    expect(blocks[0]).toEqual({ type: 'code', lang: 'md', text: '```js\nx\n```', open: false });
    expect(blocks[1]).toEqual(para('after'));
    expect(parseMarkdown('~~~\n```\n~~~')[0]).toMatchObject({ text: '```', open: false });
  });

  it('keeps a paragraph\'s line breaks, also in an indented list continuation', () => {
    expect(parseMarkdown('one\ntwo')).toEqual([para('one\ntwo')]);
    expect(parseMarkdown('- a long\n  item')).toEqual([{ type: 'ul', tight: true, items: [item(para('a long\nitem'))] }]);
  });

  it('never makes markup out of HTML', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([para('<script>alert(1)</script>')]);
    expect(parseMarkdown('<img src=x onerror=alert(1)>')).toEqual([para('<img src=x onerror=alert(1)>')]);
  });

  it('reads every heading level, closing hashes and setext headings', () => {
    const blocks = parseMarkdown('# One #\n###### Six\n#hashtag\n\nTitle\n=====\n\nSub\n---');
    expect(blocks).toEqual([
      { type: 'h', level: 1, inline: [text('One')] },
      { type: 'h', level: 4, inline: [text('Six')] },
      para('#hashtag'),
      { type: 'h', level: 1, inline: [text('Title')] },
      { type: 'h', level: 2, inline: [text('Sub')] },
    ]);
  });

  it('nests lists by indentation, with code and paragraphs inside items', () => {
    const blocks = parseMarkdown([
      '1. Install',
      '   - with npm',
      '     - or pnpm',
      '',
      '   ```bash',
      '   npm i',
      '   ```',
      '2. Run',
    ].join('\n'));
    expect(blocks).toHaveLength(1);
    const ol = blocks[0] as Extract<MdBlock, { type: 'ol' }>;
    expect(ol.type).toBe('ol');
    expect(ol.tight).toBe(false);
    expect(ol.items).toHaveLength(2);
    expect(ol.items[0].blocks.map(b => b.type)).toEqual(['p', 'ul', 'code']);
    const inner = ol.items[0].blocks[1] as Extract<MdBlock, { type: 'ul' }>;
    expect(inner.items[0].blocks.map(b => b.type)).toEqual(['p', 'ul']);
    expect(ol.items[0].blocks[2]).toEqual({ type: 'code', lang: 'bash', text: 'npm i', open: false });
    expect(ol.items[1].blocks).toEqual([para('Run')]);
  });

  it('nests a list indented four spaces under a dash', () => {
    const [ul] = parseMarkdown('- a\n    - b\n- c') as Array<Extract<MdBlock, { type: 'ul' }>>;
    expect(ul.items).toHaveLength(2);
    expect(ul.items[0].blocks[1]).toMatchObject({ type: 'ul', items: [item(para('b'))] });
  });

  it('keeps an ordered list\'s start, and only lets 1. interrupt a paragraph', () => {
    expect(parseMarkdown('3. c\n4. d')[0]).toMatchObject({ type: 'ol', start: 3 });
    expect(parseMarkdown('In\n2024. it shipped')).toEqual([para('In\n2024. it shipped')]);
    expect(parseMarkdown('Steps:\n1. go').map(b => b.type)).toEqual(['p', 'ol']);
  });

  it('marks a list loose when its items are apart', () => {
    expect(parseMarkdown('- a\n\n- b')[0]).toMatchObject({ type: 'ul', tight: false, items: [item(para('a')), item(para('b'))] });
  });

  it('starts a new list when the marker kind changes', () => {
    expect(parseMarkdown('- a\n* b').map(b => b.type)).toEqual(['ul', 'ul']);
  });

  it('reads task list items', () => {
    const [ul] = parseMarkdown('- [ ] todo\n- [x] done\n- [X] also\n- [link](https://x.dev)') as Array<Extract<MdBlock, { type: 'ul' }>>;
    expect(ul.items.map(it => it.task)).toEqual([false, true, true, null]);
    expect(ul.items[0].blocks).toEqual([para('todo')]);
  });

  it('reads block content inside a quote, and nested quotes', () => {
    expect(parseMarkdown('> **Note**\n> - one\n> > deeper')).toEqual([{
      type: 'quote',
      blocks: [
        { type: 'p', inline: [{ t: 'b', c: [text('Note')] }] },
        { type: 'ul', tight: true, items: [item(para('one'))] },
        { type: 'quote', blocks: [para('deeper')] },
      ],
    }]);
  });

  it('reads rules made of any marker', () => {
    expect(parseMarkdown('***\n\n_ _ _\n\n- - -').map(b => b.type)).toEqual(['hr', 'hr', 'hr']);
  });
});

describe('tables', () => {
  it('reads a header, alignment and rows with inline markup', () => {
    const blocks = parseMarkdown([
      'Results:',
      '| Name | Count | Status |',
      '| :--- | ---: | :---: |',
      '| `a|b` | 1 | **ok** |',
      '| [x](https://x.dev) | 22 |',
      '',
      'after',
    ].join('\n'));
    expect(blocks.map(b => b.type)).toEqual(['p', 'table', 'p']);
    expect(blocks[1]).toEqual({
      type: 'table',
      align: ['left', 'right', 'center'],
      head: [[text('Name')], [text('Count')], [text('Status')]],
      rows: [
        [[{ t: 'code', v: 'a|b' }], [text('1')], [{ t: 'b', c: [text('ok')] }]],
        [[{ t: 'a', href: 'https://x.dev', c: [text('x')] }], [text('22')], []],
      ],
    });
  });

  it('reads a table without outer pipes, and escaped pipes', () => {
    expect(parseMarkdown('a | b\n--- | ---\n1 \\| 2 | 3')[0]).toEqual({
      type: 'table', align: [null, null], head: [[text('a')], [text('b')]], rows: [[[text('1 | 2')], [text('3')]]],
    });
  });

  it('turns <br> in a cell into a line break', () => {
    const t = parseMarkdown('| a |\n|---|\n| one<br>two<br/>three |')[0] as Extract<MdBlock, { type: 'table' }>;
    expect(t.rows[0][0]).toEqual([text('one'), { t: 'br' }, text('two'), { t: 'br' }, text('three')]);
  });

  it('is not a table when the delimiter row does not match the header', () => {
    expect(parseMarkdown('| a | b |\n| --- |').map(b => b.type)).toEqual(['p']);
    expect(parseMarkdown('x | y\n---').map(b => b.type)).toEqual(['h']);
  });

  it('ends at a blank line or a line without a pipe', () => {
    expect(parseMarkdown('| a |\n|---|\n| 1 |\nplain').map(b => b.type)).toEqual(['table', 'p']);
  });

  it('shows a table\'s header while its delimiter row is still streaming', () => {
    const pending = (src: string) => parseMarkdown(src, { streaming: true });
    expect(pending('Here:\n| Name | Count |')[1]).toEqual({ type: 'table', align: [null, null], head: [[text('Name')], [text('Count')]], rows: [] });
    expect(pending('| Name | Count |\n| :--- | -')[0]).toMatchObject({ type: 'table', rows: [] });
    expect(pending('| Name | Count |\n| :--- | --: |')[0]).toMatchObject({ type: 'table', align: ['left', 'right'] });
    expect(pending('| a | b |\n|---|---|\n| 1 | 2')[0]).toMatchObject({ type: 'table', rows: [[[text('1')], [text('2')]]] });
    // Finished, the same text is a paragraph.
    expect(parseMarkdown('Here:\n| Name | Count |').map(b => b.type)).toEqual(['p']);
  });

  it('splits rows on unescaped pipes outside code spans', () => {
    expect(splitRow('| a | `b | c` | d \\| e |')).toEqual(['a', '`b | c`', 'd | e']);
    expect(splitRow('| a | |')).toEqual(['a', '']);
  });
});

describe('streaming', () => {
  it('hides a fence\'s first backticks and lets the last paragraph\'s bold and code run on', () => {
    expect(parseMarkdown('Run:\n``', { streaming: true })).toEqual([para('Run:')]);
    expect(parseMarkdown('so **this is', { streaming: true })).toEqual([{ type: 'p', inline: [text('so '), { t: 'b', c: [text('this is')] }] }]);
    expect(parseMarkdown('use `npm', { streaming: true })).toEqual([{ type: 'p', inline: [text('use '), { t: 'code', v: 'npm' }] }]);
    expect(parseMarkdown('so **this is')).toEqual([para('so **this is')]);
  });

  it('reads one trailing newline as a line still to come, two as a closed block', () => {
    const s = (src: string) => parseMarkdown(src, { streaming: true });
    expect(s('Here:\n| Name | Count |\n')[1]).toEqual({ type: 'table', align: [null, null], head: [[text('Name')], [text('Count')]], rows: [] });
    expect(s('| Name | Count |\n| :--- | -\n')[0]).toMatchObject({ type: 'table', rows: [] });
    expect(s('so **this is\n')).toEqual([{ type: 'p', inline: [text('so '), { t: 'b', c: [text('this is')] }] }]);
    expect(s('Run:\n``\n')).toEqual([para('Run:')]);
    expect(s('| a | b |\n\n')).toEqual([para('| a | b |')]);
    expect(s('so **this is\n\n')).toEqual([para('so **this is')]);
  });
});

describe('parseInline', () => {
  it('reads code, bold, italics and links', () => {
    expect(parseInline('a `b` **c** *d* [e](https://x.dev/y)')).toEqual([
      text('a '), { t: 'code', v: 'b' }, text(' '),
      { t: 'b', c: [text('c')] }, text(' '),
      { t: 'i', c: [text('d')] }, text(' '),
      { t: 'a', href: 'https://x.dev/y', c: [text('e')] },
    ]);
  });

  it('leaves snake_case and stray markers as text, and unsafe links as their label', () => {
    expect(parseInline('run my_test_name now')).toEqual([text('run my_test_name now')]);
    expect(parseInline('2 * 3 and a `')).toEqual([text('2 * 3 and a `')]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([text('x')]);
    expect(parseInline('see [the file](src/a.ts#L3)')).toEqual([text('see the file')]);
    expect(parseInline('_emphasis_.')).toEqual([{ t: 'i', c: [text('emphasis')] }, text('.')]);
  });

  it('reads strikethrough and bold italics', () => {
    expect(parseInline('~~old~~ new')).toEqual([{ t: 's', c: [text('old')] }, text(' new')]);
    expect(parseInline('***both***')).toEqual([{ t: 'b', c: [{ t: 'i', c: [text('both')] }] }]);
  });

  it('reads code spans of several backticks', () => {
    expect(parseInline('``a `b` c``')).toEqual([{ t: 'code', v: 'a `b` c' }]);
    expect(parseInline('`` `x` ``')).toEqual([{ t: 'code', v: '`x`' }]);
  });

  it('links bare and angle-bracket URLs without trailing punctuation', () => {
    expect(parseInline('see https://x.dev/a_(b). Or <https://y.dev>')).toEqual([
      text('see '), { t: 'a', href: 'https://x.dev/a_(b)', c: [text('https://x.dev/a_(b)')] },
      text('. Or '), { t: 'a', href: 'https://y.dev', c: [text('https://y.dev')] },
    ]);
    expect(parseInline('(https://x.dev)')).toEqual([text('('), { t: 'a', href: 'https://x.dev', c: [text('https://x.dev')] }, text(')')]);
    expect(parseInline('mail <mailto:a@b.dev>')).toEqual([text('mail '), { t: 'a', href: 'mailto:a@b.dev', c: [text('a@b.dev')] }]);
    expect(parseInline('nohttps://x')).toEqual([text('nohttps://x')]);
  });

  it('reads links with titles and parentheses in the destination', () => {
    expect(parseInline('[w](https://en.wikipedia.org/wiki/A_(b) "T")')).toEqual([
      { t: 'a', href: 'https://en.wikipedia.org/wiki/A_(b)', c: [text('w')] },
    ]);
  });

  it('never makes an anchor inside a link label', () => {
    expect(parseInline('[https://a.dev](https://b.dev)')).toEqual([{ t: 'a', href: 'https://b.dev', c: [text('https://a.dev')] }]);
    expect(parseInline('[see <https://a.dev>](https://b.dev)')).toEqual([{ t: 'a', href: 'https://b.dev', c: [text('see https://a.dev')] }]);
    expect(parseInline('[![logo](https://a.dev/l.png)](https://b.dev)')).toEqual([{ t: 'a', href: 'https://b.dev', c: [text('logo')] }]);
    expect(parseInline('[**go to https://a.dev**](https://b.dev)')).toEqual([{ t: 'a', href: 'https://b.dev', c: [{ t: 'b', c: [text('go to https://a.dev')] }] }]);
    expect(parseInline('[a [b](https://c.dev) d](https://e.dev)')).toEqual([{ t: 'a', href: 'https://e.dev', c: [text('a b d')] }]);
    expect(parseInline('[`code`](https://b.dev)')).toEqual([{ t: 'a', href: 'https://b.dev', c: [{ t: 'code', v: 'code' }] }]);
  });

  it('still links what an unsafe link\'s label holds, since no anchor wraps it', () => {
    expect(parseInline('[https://a.dev](javascript:x)')).toEqual([{ t: 'a', href: 'https://a.dev', c: [text('https://a.dev')] }]);
  });

  it('reads a surrogate code point as a lone surrogate instead of throwing', () => {
    expect(parseInline('&#xD800;&#57343;')).toEqual([text('\ud800\udfff')]);
  });

  it('links an image instead of loading it', () => {
    expect(parseInline('![chart](https://x.dev/c.png)')).toEqual([{ t: 'img', href: 'https://x.dev/c.png', alt: 'chart' }]);
    expect(parseInline('![chart](data:image/png;base64,AAA)')).toEqual([text('chart')]);
  });

  it('reads backslash escapes and entities as text', () => {
    expect(parseInline('\\*not\\* \\`code\\` a\\_b \\\\ \\q')).toEqual([text('*not* `code` a_b \\ \\q')]);
    expect(parseInline('a &amp; b &lt;i&gt; &#65;&#x42;&nbsp;&bogus;')).toEqual([text('a & b <i> AB\u00a0&bogus;')]);
  });

  it('turns a trailing backslash into a line break', () => {
    expect(parseInline('one\\\ntwo')).toEqual([text('one\ntwo')]);
  });
});
