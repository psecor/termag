import { describe, expect, it } from 'vitest';
import type { InboxRow } from '../mobile/inbox';
import type { PaneSearchHit, PaneSearchResult, PrRow } from '../services/api';
import { clampIndex, hitStatus, matchActions, paletteItems, paletteSelectEvent, type PaletteAction } from './searchPalette';

const row = (key: string) => ({ key }) as InboxRow;
const hit = (projectId: string) => ({ projectId, workstream: 'main', role: 'agent' }) as PaneSearchHit;
const result = (hits: PaneSearchHit[]) => ({ hits, searched: 2, unreachable: 0, skipped: 0 }) as unknown as PaneSearchResult;
const action = (label: string, keywords?: string[]): PaletteAction => ({ id: label, label, keywords, run: () => {} });
const pr = (number: number) => ({ kind: 'pr', number }) as PrRow;
const base = { q: '', actions: [], history: [], recent: [], hits: [], paneQuery: null, paneResult: null };

describe('paletteItems', () => {
  it('empty query: recent searches, then recent sessions', () => {
    const items = paletteItems({ ...base, history: ['foo'], recent: [row('a')] });
    expect(items.map(i => i.kind)).toEqual(['recent-query', 'row']);
  });

  it('typing: matching sessions, then the pane-text item', () => {
    const items = paletteItems({ ...base, q: 'sam', hits: [row('a'), row('b')] });
    expect(items.map(i => i.kind)).toEqual(['row', 'row', 'cta']);
  });

  it('typing: matching actions come first', () => {
    const items = paletteItems({ ...base, q: 'b', actions: [action('Branch off…')], hits: [row('a')] });
    expect(items.map(i => i.kind)).toEqual(['action', 'row']);
  });

  it('typing: pull requests after the sessions, before the pane text', () => {
    const items = paletteItems({ ...base, q: '2828', hits: [row('a')], prs: [pr(28280)], paneQuery: '2828', paneResult: result([hit('p1')]) });
    expect(items.map(i => i.kind)).toEqual(['row', 'pr', 'hit']);
  });

  it('empty query: no pull requests, even when given', () => {
    expect(paletteItems({ ...base, prs: [pr(1)] })).toEqual([]);
  });

  it('empty query: no actions, even when given', () => {
    expect(paletteItems({ ...base, actions: [action('Branch off…')] })).toEqual([]);
  });

  it('offers no pane search under 2 characters', () => {
    expect(paletteItems({ ...base, q: 's' })).toEqual([]);
  });

  it('pane hits replace the pane-text item once the search for this query is done', () => {
    const items = paletteItems({ ...base, q: 'sam', hits: [row('a')], paneQuery: 'sam', paneResult: result([hit('p1'), hit('p2')]) });
    expect(items.map(i => i.kind)).toEqual(['row', 'hit', 'hit']);
  });

  it('a search in flight for this query shows neither the item nor stale hits', () => {
    expect(paletteItems({ ...base, q: 'sam', paneQuery: 'sam', paneResult: null })).toEqual([]);
  });

  it('a result for another query offers a new search', () => {
    const items = paletteItems({ ...base, q: 'samp', paneQuery: 'sam', paneResult: result([hit('p1')]) });
    expect(items).toEqual([{ kind: 'cta', q: 'samp' }]);
  });
});

describe('clampIndex', () => {
  it('keeps the highlight inside a shrunk list', () => {
    expect(clampIndex(3, 2)).toBe(1);
    expect(clampIndex(1, 5)).toBe(1);
    expect(clampIndex(2, 0)).toBe(0);
  });
});

describe('hitStatus', () => {
  it('passes known statuses and nothing inherited', () => {
    expect(hitStatus('working')).toBe('working');
    expect(hitStatus('toString')).toBe('not_running');
    expect(hitStatus('bogus')).toBe('not_running');
  });
});

describe('matchActions', () => {
  const branch = action('Branch off…', ['new workstream']);
  it('matches the start of the label or of any of its words, ignoring case', () => {
    expect(matchActions([branch], 'b')).toEqual([branch]);
    expect(matchActions([branch], 'BRANCH O')).toEqual([branch]);
    expect(matchActions([branch], 'off')).toEqual([branch]);
  });
  it('matches keywords', () => {
    expect(matchActions([branch], 'workst')).toEqual([branch]);
  });
  it('one or two characters only match the start of the label', () => {
    for (const q of ['o', 'n', 'w', 'of', 'ne', 'wo']) expect(matchActions([branch], q)).toEqual([]);
    expect(matchActions([branch], 'br')).toEqual([branch]);
  });
  it('does not match mid-word, or an empty query', () => {
    expect(matchActions([branch], 'ranch')).toEqual([]);
    expect(matchActions([branch], ' ')).toEqual([]);
  });
  it('b still finds only Branch off… beside Delete branch and Archive project', () => {
    const del = action('Delete branch', ['remove workstream', 'worktree']);
    const archive = action('Archive project');
    const all = [branch, del, archive];
    expect(matchActions(all, 'b')).toEqual([branch]);
    expect(matchActions(all, 'd')).toEqual([del]);
    expect(matchActions(all, 'a')).toEqual([archive]);
    expect(matchActions(all, 'branch')).toEqual([branch, del]);
    expect(matchActions(all, 'proj')).toEqual([archive]);
  });
});

describe('paletteSelectEvent', () => {
  it('names an action by its id', () => {
    expect(paletteSelectEvent({ kind: 'action', action: action('Branch off…') }, 'b'))
      .toEqual({ key: 'palette-action', data: { action: 'Branch off…', queryLength: 1 } });
  });
  it('sends the kind and query length, never the query', () => {
    const e = paletteSelectEvent({ kind: 'cta', q: 'secret-project' }, 'secret-project');
    expect(e).toEqual({ key: 'palette-select', data: { kind: 'cta', queryLength: 14 } });
    expect(JSON.stringify(e)).not.toContain('secret');
  });
});
