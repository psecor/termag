import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PrThread } from '../../services/api';
import { Thread } from './PrFilesView';

const thread = (body: string): PrThread => ({
  id: 't1', path: 'src/a.ts', line: 3, side: 'RIGHT', resolved: false, outdated: false,
  comments: [{ id: 'c1', author: 'cursor[bot]', bot: true, body, createdAt: null, url: null }],
});

describe('a review thread', () => {
  it('draws a comment as markdown, without its HTML comments, and no HTML from it', () => {
    const out = renderToStaticMarkup(<Thread t={thread('### Bug: off by one\n\n<!-- BUGBOT_ID -->**High** in `loop()`\n\n<img src="https://x.dev/p.png">')} />);
    expect(out).toContain('<strong>High</strong>');
    expect(out).toContain('<code class="md-code">loop()</code>');
    expect(out).toContain('Bug: off by one</h5>');
    expect(out).not.toContain('BUGBOT_ID');
    expect(out).not.toContain('<img');
  });
});
