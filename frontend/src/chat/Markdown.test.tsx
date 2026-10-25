import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

const html = (text: string, streaming = false) => renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);

describe('Markdown', () => {
  it('renders a table with alignment and inline markup in its cells', () => {
    const out = html('| a | b |\n|:-:|--:|\n| **x** | `y` |');
    expect(out).toContain('<div class="md-table"><table><thead><tr><th style="text-align:center">a</th><th style="text-align:right">b</th></tr></thead>');
    expect(out).toContain('<tbody><tr><td style="text-align:center"><strong>x</strong></td><td style="text-align:right"><code class="md-code">y</code></td></tr></tbody>');
  });

  it('renders nested lists, task items, quotes and strikethrough', () => {
    expect(html('3. a\n   - b')).toBe('<div class="md"><ol start="3" class="md-tight"><li><p>a</p><ul class="md-tight"><li><p>b</p></li></ul></li></ol></div>');
    // React 18 writes readonly="", React 19 keeps the prop's casing (readOnly=""); HTML attribute names are case-insensitive.
    expect(html('- [x] done')).toMatch(/<li class="md-task"><input type="checkbox" disabled="" readonly="" aria-label="done" checked=""\/><p>done<\/p><\/li>/i);
    expect(html('> ~~no~~')).toBe('<div class="md"><blockquote><p><del>no</del></p></blockquote></div>');
  });

  it('never renders HTML from a reply, and never loads an image', () => {
    const out = html('<img src=x onerror=alert(1)> [a](javascript:alert(1)) ![p](https://x.dev/p.png)\n\n| <script>x</script> |\n|---|');
    expect(out).not.toMatch(/<img|<script|javascript:/);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('<a class="md-img" href="https://x.dev/p.png" target="_blank" rel="noopener noreferrer" title="https://x.dev/p.png">p</a>');
    expect(out).toContain('<th>&lt;script&gt;x&lt;/script&gt;</th>');
  });

  it('never nests an anchor inside an anchor', () => {
    const out = html('[https://a.dev](https://b.dev) [![x](https://a.dev/x.png)](https://b.dev) [<https://a.dev>](https://b.dev)\n\n| [https://a.dev](https://b.dev) |\n|---|');
    expect(out).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>).)*<a\b/);
    expect(out.match(/<a /g)).toHaveLength(4);
  });

  it('renders a surrogate entity without throwing', () => {
    expect(html('&#xD800; ok')).toBe('<div class="md"><p>\ud800 ok</p></div>');
  });

  it('renders a streaming table header before its delimiter row arrives', () => {
    expect(html('| a | b |', true)).toContain('<table><thead><tr><th>a</th><th>b</th></tr></thead></table>');
    expect(html('| a | b |')).toBe('<div class="md"><p>| a | b |</p></div>');
  });
});
