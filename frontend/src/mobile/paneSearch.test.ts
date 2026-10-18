import { describe, it, expect } from 'vitest';
import { asPaneSearchResult, focusLine, paneHitKey, NoPaneSearchError, paneHitHref, paneSearchError, paneSearchScope } from './paneSearch';

describe('paneHitHref', () => {
  it('opens the workstream on the tab for the pane role', () => {
    expect(paneHitHref({ projectId: 'p1', workstream: 'main', role: 'agent' })).toBe('/m/p/p1');
    expect(paneHitHref({ projectId: 'p1', workstream: 'feat/x', role: 'ctrl' })).toBe('/m/p/p1?ws=feat%2Fx&role=ctrl');
    expect(paneHitHref({ projectId: 'p 1', workstream: 'main', role: 'review' })).toBe('/m/p/p%201?role=review');
    expect(paneHitHref({ projectId: 'p1', workstream: 'main', role: 'data' })).toBe('/m/p/p1');
  });
});

describe('asPaneSearchResult', () => {
  it('passes a search result through and rejects what an older backend sends', () => {
    const ok = { query: 'x', lines: 500, roles: ['agent'], searched: 1, unreachable: 0, skipped: 0, hits: [] };
    expect(asPaneSearchResult(ok)).toBe(ok);
    // The SPA fallback: index.html with a 200.
    expect(() => asPaneSearchResult('<!doctype html><html>…</html>')).toThrow(NoPaneSearchError);
    expect(() => asPaneSearchResult({ error: 'nope' })).toThrow(NoPaneSearchError);
    expect(() => asPaneSearchResult(null)).toThrow(NoPaneSearchError);
    expect(paneSearchError(new NoPaneSearchError())).toMatch(/does not have pane search/);
  });
});

describe('paneHitKey', () => {
  it('keeps same-named projects on two boxes apart', () => {
    const a = { projectId: 'p1', role: 'agent', workstream: 'main', session: 'ada-termag-agent' };
    const b = { ...a, projectId: 'p2' }; // same tmux name, other box
    expect(paneHitKey(a)).not.toBe(paneHitKey(b));
    expect(paneHitKey(a)).not.toBe(paneHitKey({ ...a, role: 'ctrl' }));
  });
});

describe('paneSearch copy', () => {
  it('explains rate limits and old backends', () => {
    expect(paneSearchError({ response: { status: 429 } })).toMatch(/try again/);
    expect(paneSearchError({ response: { status: 404 } })).toMatch(/does not have pane search/);
    expect(paneSearchError(new Error('x'))).toBe('Pane search failed.');
  });
  it('summarises what was covered', () => {
    expect(paneSearchScope({ searched: 1, unreachable: 0, skipped: 0 })).toBe('searched 1 pane');
    expect(paneSearchScope({ searched: 12, unreachable: 1, skipped: 3 })).toBe('searched 12 panes · 1 unreachable · 3 not searched');
  });
});

describe('focusLine', () => {
  it('starts a long line shortly before the match and leaves short ones alone', () => {
    expect(focusLine('error: ECONNREFUSED', 'econnrefused')).toBe('error: ECONNREFUSED');
    const long = `${'x'.repeat(80)}ECONNREFUSED tail`;
    expect(focusLine(long, 'econnrefused')).toBe(`…${'x'.repeat(16)}ECONNREFUSED tail`);
    expect(focusLine(`…${'y'.repeat(40)}hit`, 'hit')).toBe(`…${'y'.repeat(16)}hit`);
    expect(focusLine('no match here', 'zz')).toBe('no match here');
  });
});
