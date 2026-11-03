// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { CodeFence } from '../../chat/codeFence';
import { GenUiItemContext } from '../../chat/genui/SpecFence';
import { renderReviewFence } from './ReviewCard';

const FINDINGS = JSON.stringify({
  kind: 'findings', round: 1, head: '9c3e1f2', verdict: 'COMMENT', take: 'One nit.', summary: 'A nit.',
  findings: [{ id: 'f1', tier: 'recommend', title: 'Name it', why: 'Clearer.', ticked: true }],
});
const fence = (text: string, open: boolean) => ({ type: 'code', lang: 'review', text, open } as unknown as CodeFence);
function drawn(block: CodeFence, streaming: boolean): string {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => { root.render(<GenUiItemContext.Provider value={{ key: 'k', streaming }}>{renderReviewFence(block)}</GenUiItemContext.Provider>); });
  const html = host.innerHTML;
  act(() => root.unmount());
  return html;
}

describe('a follow-up fence', () => {
  it('shows what it found, read-only, with no review session to approve from', () => {
    const text = JSON.stringify({ kind: 'followup', round: 2, head: 'a1b2c3d', addressed: [{ title: 'A slow service is cut', how: 'Fixed in retry.ts.', fixed: true }], fresh: [] });
    const html = drawn(fence(text, false), false);
    expect(html).toContain('A slow service is cut');
    expect(html).toContain('Approve from the PR');
  });
});

describe('a ```review fence the reply has not closed', () => {
  it('is being written while the reply streams', () => {
    expect(drawn(fence(FINDINGS.slice(0, 40), true), true)).toContain('Writing the review');
  });

  it('is the card once its JSON is whole, closed or not', () => {
    const html = drawn(fence(FINDINGS, true), false);
    expect(html).toContain('My take: comment.');
    expect(html).not.toContain('Writing the review');
  });

  it('is its code when the reply ended on half of it, not a spinner that never stops', () => {
    const html = drawn(fence(FINDINGS.slice(0, 40), true), false);
    expect(html).not.toContain('Writing the review');
    expect(html).toContain('kind');
  });
});
