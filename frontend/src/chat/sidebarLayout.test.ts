// Pinned and Older (chat/sidebarLayout.ts).
import { describe, expect, it } from 'vitest';
import type { RowStateKind } from './rowState';
import { splitSidebar, type LayoutRow, type SplitInput } from './sidebarLayout';

const NOW = Date.parse('2026-11-13T20:00:00Z');
const DAY = 86_400_000;

interface Row extends LayoutRow { state: RowStateKind; touched: number | null }
const row = (workstream: string, state: RowStateKind, daysAgo: number | null, extra: Partial<Row> = {}): Row => ({
  key: `p|${workstream}`, projectId: 'p', workstream, state, touched: daysAgo === null ? null : NOW - daysAgo * DAY, ...extra,
});

function split(rows: Row[], over: Partial<SplitInput<Row>> = {}) {
  const out = splitSidebar(rows, {
    links: [], stateOf: r => r.state, touchedAt: r => r.touched, now: NOW, olderDays: 3, pinOrder: () => null, ...over,
  });
  const names = (list: Row[]) => list.map(r => r.workstream);
  return { pinned: names(out.pinned), older: names(out.older), rest: names(out.rest) };
}

describe('splitSidebar', () => {
  it('moves what you haven\'t touched past the threshold to Older, most recent first, whatever its box', () => {
    const rows = [row('a', 'done', 1), row('b', 'off', 4), row('c', 'done', 9), row('d', 'off', 2)];
    expect(split(rows)).toEqual({ pinned: [], older: ['b', 'c'], rest: ['a', 'd'] });
    expect(split(rows, { olderDays: 1 }).older).toEqual(['d', 'b', 'c']);
    expect(split(rows, { olderDays: 7 }).older).toEqual(['c']);
    expect(split(rows, { olderDays: 0 }).older).toEqual([]);
  });

  it('never ages out Needs you, Working, the open session or a pin', () => {
    const rows = [row('w', 'working', 9), row('n', 'approval', 9), row('q', 'unread', 9), row('e', 'error', 9), row('o', 'done', 9), row('x', 'done', 9)];
    const out = split(rows, { openKey: 'p|o', pinOrder: r => (r.workstream === 'x' ? 0 : null) });
    expect(out).toEqual({ pinned: ['x'], older: [], rest: ['w', 'n', 'q', 'e', 'o'] });
  });

  it('puts pins on top in the order they were pinned, Needs you included', () => {
    const rows = [row('a', 'done', 0), row('b', 'approval', 0), row('c', 'off', 30)];
    const order = new Map([['c', 0], ['b', 1]]);
    expect(split(rows, { pinOrder: r => order.get(r.workstream) ?? null })).toEqual({ pinned: ['c', 'b'], older: [], rest: ['a'] });
  });

  it('leaves shared sessions and automation runs to their own sections', () => {
    const rows = [row('s', 'off', 9, { shared: true }), row('run', 'done', 9, { kind: 'automation' })];
    expect(split(rows).older).toEqual([]);
  });

  it('moves a session with what it started, and a busy ask keeps its parent where it is', () => {
    const link = (child: string, parent: string) => ({ projectId: 'p', workstream: child, parentProjectId: 'p', parentWorkstream: parent });
    const quiet = [row('parent', 'done', 9), row('ask', 'done', 8)];
    expect(split(quiet, { links: [link('ask', 'parent')] }).older).toEqual(['parent', 'ask']);
    const busy = [row('parent', 'done', 9), row('ask', 'working', 9)];
    expect(split(busy, { links: [link('ask', 'parent')] })).toEqual({ pinned: [], older: [], rest: ['parent', 'ask'] });
    // A pinned parent takes what it started up with it.
    expect(split(busy, { links: [link('ask', 'parent')], pinOrder: r => (r.workstream === 'parent' ? 0 : null) }).pinned).toEqual(['parent', 'ask']);
    // A pinned ask goes to Pinned on its own, and its parent ages as the rest do.
    expect(split(quiet, { links: [link('ask', 'parent')], pinOrder: r => (r.workstream === 'ask' ? 0 : null) }))
      .toEqual({ pinned: ['ask'], older: ['parent'], rest: [] });
    // Pinned twice down one line: the parent's pin places both, once.
    expect(split(quiet, { links: [link('ask', 'parent')], pinOrder: r => (r.workstream === 'ask' ? 0 : 1) }).pinned).toEqual(['parent', 'ask']);
  });

  it('counts a session it knows no touch for as untouched', () => {
    expect(split([row('u', 'off', null)]).older).toEqual(['u']);
  });
});

describe('sectionsByStatus', () => {
  it('is Working, Idle and Not running, most recent first, without empty ones or what needs you', async () => {
    const { sectionsByStatus } = await import('./sidebarLayout');
    const rows = [row('a', 'done', 2), row('b', 'working', 1), row('c', 'done', 0), row('d', 'approval', 0)];
    const out = sectionsByStatus(rows, r => r.state, r => r.touched);
    expect(out.map(s => [s.key, s.name, s.tone, s.rows.map(r => r.workstream)])).toEqual([
      ['status:working', 'Working', 'working', ['b']],
      ['status:recent', 'Idle', 'idle', ['c', 'a']],
    ]);
  });
});
