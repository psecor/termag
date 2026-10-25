import { describe, expect, it } from 'vitest';
import { normalizePrUrl, parseShared, sharedConversationHref } from './share';

describe('normalizePrUrl', () => {
  it('accepts a PR link and strips the tab, query and fragment', () => {
    expect(normalizePrUrl('https://github.com/example-org/termag/pull/312')).toEqual({ number: 312, url: 'https://github.com/example-org/termag/pull/312' });
    expect(normalizePrUrl('https://github.com/o/r/pull/7/files?w=1#diff-1')).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' });
  });

  it('refuses other hosts, schemes and paths', () => {
    expect(normalizePrUrl('http://github.com/o/r/pull/7')).toBeNull();
    expect(normalizePrUrl('https://github.com.evil.com/o/r/pull/7')).toBeNull();
    expect(normalizePrUrl('https://github.com/o/r/issues/7')).toBeNull();
    expect(normalizePrUrl('not a url')).toBeNull();
  });
});

describe('parseShared', () => {
  it('finds a PR in the url field (GitHub app)', () => {
    const s = parseShared({ title: 'Fix it by alice · Pull Request #12', url: 'https://github.com/o/r/pull/12' });
    expect(s.pr).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12' });
    expect(s.draft).toBe('Fix it by alice · Pull Request #12 https://github.com/o/r/pull/12');
  });

  it('finds a PR inside the text (Chrome, Slack)', () => {
    const s = parseShared({ text: 'look at https://github.com/o/r/pull/9/files please' });
    expect(s.pr?.number).toBe(9);
    expect(s.draft).toBe('look at https://github.com/o/r/pull/9/files please');
  });

  it('flattens newlines and never repeats the link', () => {
    const s = parseShared({ text: 'line one\nline two https://example.com', url: 'https://example.com' });
    expect(s.draft).toBe('line one line two https://example.com');
    expect(s.pr).toBeNull();
  });

  it('caps the draft at the send-keys limit', () => {
    expect(parseShared({ text: 'x'.repeat(5000) }).draft.length).toBe(4000);
  });

  it('handles an empty share', () => {
    expect(parseShared({})).toEqual({ draft: '', pr: null });
  });
});

describe('sharedConversationHref', () => {
  it('carries a draft or a review link, and the workstream', () => {
    expect(sharedConversationHref({ projectId: 'p1', workstream: 'main' }, { draft: 'hi there' })).toBe('/m/p/p1?draft=hi+there');
    expect(sharedConversationHref({ projectId: 'p1', workstream: 'ws-2' }, { reviewUrl: 'https://github.com/o/r/pull/3', draft: 'x' }))
      .toBe('/m/p/p1?ws=ws-2&review=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F3');
  });
});
