import { describe, expect, it } from 'vitest';
import type { InboxRow } from '../mobile/inbox';
import type { PaneSearchHit, PaneSearchResult } from '../services/api';
import { clampIndex, hitStatus, paletteItems } from './searchPalette';

const row = (key: string) => ({ key }) as InboxRow;
const hit = (projectId: string) => ({ projectId, workstream: 'main', role: 'agent' }) as PaneSearchHit;
const result = (hits: PaneSearchHit[]) => ({ hits, searched: 2, unreachable: 0, skipped: 0 }) as unknown as PaneSearchResult;
const base = { q: '', history: [], recent: [], hits: [], paneQuery: null, paneResult: null };

describe('paletteItems', () => {
  it('empty query: recent searches, then recent sessions', () => {
    const items = paletteItems({ ...base, history: ['foo'], recent: [row('a')] });
    expect(items.map(i => i.kind)).toEqual(['recent-query', 'row']);
  });

  it('typing: matching sessions, then the pane-text item', () => {
    const items = paletteItems({ ...base, q: 'sam', hits: [row('a'), row('b')] });
    expect(items.map(i => i.kind)).toEqual(['row', 'row', 'cta']);
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
