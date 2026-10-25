import { describe, expect, it } from 'vitest';
import {
  activeTab, dismissItem, duplicateItem, EMPTY_OPEN_ITEMS, groupOpenItems, itemForRoute, itemHref, itemKey, OPEN_ITEMS_MAX, openItem,
  parseOpenItems, RECONCILE_GRACE_MS, reconcileItems, reorderItem, seedItems, serializeOpenItems, tabForRoute,
  type OpenItemRef, type OpenItemsState,
} from './openItems';

const chat = (projectId: string, workstream = 'main') => ({ kind: 'chat' as const, projectId, workstream });
const file = (space: string, path: string) => ({ kind: 'file' as const, space, path });
const explorer = (space: string) => ({ kind: 'explorer' as const, space });
const keys = (s: OpenItemsState) => s.items.map(itemKey);
const ids = (s: OpenItemsState) => s.items.map(i => i.id);

/** Ids t1, t2, … in order. */
function counter(prefix = 't') {
  let n = 0;
  return () => `${prefix}${++n}`;
}
/** `ref` opened with no tab named, at `now`. */
function open(s: OpenItemsState, ref: OpenItemRef, now: number, make = counter(), tab: string | null = null) {
  return openItem(s, ref, tab, now, make).state;
}

describe('tabs', () => {
  it('puts a new tab on top and leaves one already showing it where it is', () => {
    const make = counter();
    let s: OpenItemsState = { seeded: true, items: [] };
    s = open(s, chat('a'), 1, make);
    s = open(s, file('notes', 'plan.md'), 2, make);
    s = open(s, chat('a'), 3, make);
    expect(keys(s)).toEqual(['file:notes:plan.md', 'chat:a|main']);
    expect(ids(s)).toEqual(['t2', 't1']);
    expect(s.items[1].openedAt).toBe(3);
  });

  it('shows a pick in the tab the route names, in its place, and opens a tab for an id it doesn\'t know', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, explorer('notes'), 1, make);
    s = open(s, chat('a'), 2, make);
    expect(ids(s)).toEqual(['t2', 't1']);
    s = openItem(s, file('notes', 'deck.pdf'), 't1', 3, make).state;
    expect(s.items.map(i => [i.id, itemKey(i)])).toEqual([['t2', 'chat:a|main'], ['t1', 'file:notes:deck.pdf']]);
    s = openItem(s, file('notes', 'README.md'), 't1', 4, make).state;
    expect(s.items[1]).toEqual({ ...file('notes', 'README.md'), id: 't1', openedAt: 4 });
    const fresh = openItem(s, file('notes', 'README.md'), 'zz9', 5, make);
    expect(fresh.id).toBe('zz9');
    expect(ids(fresh.state)).toEqual(['zz9', 't2', 't1']);
  });

  it('knows the tab a route shows: the one it names, else the first showing it', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, file('n', 'a'), 1, make);
    s = duplicateItem(s, 't1', 'copy', 2);
    expect(activeTab(s, file('n', 'a'), null)).toBe('t1');
    expect(activeTab(s, file('n', 'a'), 'copy')).toBe('copy');
    expect(activeTab(s, file('n', 'a'), 'gone')).toBe('t1');
    expect(activeTab(s, file('n', 'b'), null)).toBeNull();
    expect(activeTab(s, null, 'copy')).toBeNull();
  });

  it('duplicates a tab just below it, keeping a chat\'s space', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, { ...chat('a'), space: 'design' }, 1, make);
    s = open(s, file('n', 'x'), 2, make);
    s = duplicateItem(s, 't1', 'd1', 3);
    expect(s.items.map(i => [i.id, itemKey(i)])).toEqual([['t2', 'file:n:x'], ['t1', 'chat:a|main'], ['d1', 'chat:a|main']]);
    expect(s.items[2]).toMatchObject({ space: 'design', openedAt: 3 });
    expect(duplicateItem(s, 'nope', 'd2', 4)).toBe(s);
  });

  it('keeps at most OPEN_ITEMS_MAX, dropping the one opened longest ago, never the new one', () => {
    const make = counter();
    let s: OpenItemsState = { seeded: true, items: [] };
    for (let i = 0; i < OPEN_ITEMS_MAX; i++) s = open(s, chat(`p${i}`), 100 + i, make);
    s = open(s, chat('p0'), 1000, make);
    s = open(s, chat('new'), 1, make);
    expect(s.items).toHaveLength(OPEN_ITEMS_MAX);
    expect(keys(s)[0]).toBe('chat:new|main');
    expect(keys(s)).toContain('chat:p0|main');
    expect(keys(s)).not.toContain('chat:p1|main');
  });

  it('closes one tab, not another showing the same thing', () => {
    const make = counter();
    let s = open(open(EMPTY_OPEN_ITEMS, chat('a'), 1, make), explorer('notes'), 2, make);
    s = duplicateItem(s, 't2', 'd', 3);
    s = dismissItem(s, 't2');
    expect(s.items.map(i => [i.id, itemKey(i)])).toEqual([['d', 'explorer:notes'], ['t1', 'chat:a|main']]);
  });

  it('moves a tab within its group without touching the other groups', () => {
    const s: OpenItemsState = { seeded: true, items: [
      { ...file('notes', 'a'), id: 'a', openedAt: 1 }, { ...file('design', 'x'), id: 'x', openedAt: 1 },
      { ...file('notes', 'b'), id: 'b', openedAt: 1 }, { ...file('notes', 'c'), id: 'c', openedAt: 1 },
    ] };
    const group = ['a', 'b', 'c'];
    expect(ids(reorderItem(s, group, 'c', 0))).toEqual(['c', 'x', 'a', 'b']);
    expect(ids(reorderItem(s, group, 'a', 9))).toEqual(['b', 'x', 'c', 'a']);
    expect(reorderItem(s, group, 'b', 1)).toBe(s);
    expect(reorderItem(s, group, 'missing', 0)).toBe(s);
  });

  it('remembers the space an agent was opened in, and keeps it on reopen', () => {
    let s = open(EMPTY_OPEN_ITEMS, { ...chat('a'), space: 'design' }, 1);
    s = open(s, chat('a'), 2);
    expect(s.items[0]).toEqual({ kind: 'chat', projectId: 'a', workstream: 'main', space: 'design', id: 't1', openedAt: 2 });
    s = open(s, { ...chat('a'), space: 'notes' }, 3);
    expect(s.items[0]).toMatchObject({ space: 'notes' });
  });

  it('seeds once: what was open first, then a tab for each session that exists', () => {
    const before = open(EMPTY_OPEN_ITEMS, file('s', 'a.md'), 500);
    const s = seedItems(before, [
      { projectId: 'new', workstream: 'fix', lastActiveAt: 20 },
      { projectId: 'old', workstream: 'main', lastActiveAt: 10 },
    ], 100, counter('s'));
    expect(s.seeded).toBe(true);
    expect(keys(s)).toEqual(['file:s:a.md', 'chat:new|fix', 'chat:old|main']);
    expect(new Set(ids(s)).size).toBe(3);
    expect(seedItems(s, [{ projectId: 'x', workstream: 'main', lastActiveAt: 1 }], 200)).toBe(s);
  });

  it('closes tabs on sessions that are gone, except one opened moments ago', () => {
    const now = 10 * RECONCILE_GRACE_MS;
    const make = counter();
    let s: OpenItemsState = { seeded: true, items: [] };
    s = open(s, chat('gone'), 1, make);
    s = open(s, chat('fresh'), now - 1000, make);
    s = open(s, chat('live'), 2, make);
    s = open(s, file('s', 'f.txt'), 3, make);
    const next = reconcileItems(s, new Set(['chat:live|main']), now);
    expect(keys(next)).toEqual(['file:s:f.txt', 'chat:live|main', 'chat:fresh|main']);
    expect(reconcileItems(next, new Set(['chat:live|main', 'chat:fresh|main']), now)).toBe(next);
  });

  it('round-trips through storage in its order, duplicates included, and refuses junk', () => {
    const make = counter();
    let s = open(open({ seeded: true, items: [] }, { ...chat('a', 'ws'), space: 'sp' }, 9, make), file('sp', 'd/e.png'), 2, make);
    s = duplicateItem(s, 't2', 'dup', 3);
    expect(parseOpenItems(serializeOpenItems(s))).toEqual(s);
    expect(parseOpenItems(null)).toBe(EMPTY_OPEN_ITEMS);
    expect(parseOpenItems('{')).toBe(EMPTY_OPEN_ITEMS);
    expect(parseOpenItems('{"v":3,"items":[]}')).toBe(EMPTY_OPEN_ITEMS);
  });

  it('reads a version 1 list (no ids) with ids by position, one tab per thing', () => {
    const raw = JSON.stringify({ v: 1, seeded: true, items: [
      { kind: 'chat', projectId: '', workstream: 'main', openedAt: 1 }, { kind: 'explorer', openedAt: 4 },
      { kind: 'explorer', space: 'notes', openedAt: 2 }, { kind: 'explorer', space: 'notes', openedAt: 1 }, { kind: 'nope', openedAt: 3 },
      { kind: 'chat', projectId: 'a', workstream: 'main', space: 'notes', openedAt: 5 },
    ] });
    const s = parseOpenItems(raw);
    expect(s.items).toEqual([
      { kind: 'explorer', space: 'notes', id: 'm2', openedAt: 2 },
      { kind: 'chat', projectId: 'a', workstream: 'main', space: 'notes', id: 'm5', openedAt: 5 },
    ]);
    expect(parseOpenItems(raw)).toEqual(s);
    expect(JSON.parse(serializeOpenItems(s)).v).toBe(2);
  });

  it('maps routes to what they show and back, with the tab they name', () => {
    expect(itemForRoute('/chat/p/abc', '?ws=fix')).toEqual(chat('abc', 'fix'));
    expect(itemForRoute('/chat/p/abc', '')).toEqual(chat('abc'));
    expect(itemForRoute('/chat/files/my-notes', '')).toEqual(explorer('my-notes'));
    expect(itemForRoute('/chat/files', '')).toBeNull();
    expect(itemForRoute('/chat/f/notes/a%20b/c.md', '?tab=x1')).toEqual(file('notes', 'a b/c.md'));
    expect(itemForRoute('/chat/f/notes/50%25.md', '')).toEqual(file('notes', '50%.md'));
    expect(itemForRoute('/chat/f/notes/50%.md', '')).toEqual(file('notes', '50%.md'));
    expect(itemForRoute('/chat/p/a%E0b', '')).toEqual(chat('a%E0b'));
    expect(itemForRoute('/chat/new', '')).toBeNull();
    expect(itemForRoute('/chat', '')).toBeNull();
    expect(itemHref(file('notes', 'a b/c.md'))).toBe('/chat/f/notes/a%20b/c.md');
    expect(itemHref(chat('abc', 'fix'))).toBe('/chat/p/abc?ws=fix');
    expect(itemHref(explorer('my-notes'))).toBe('/chat/files/my-notes');
    expect(itemHref(chat('abc', 'fix'), 'k2')).toBe('/chat/p/abc?ws=fix&tab=k2');
    expect(itemHref(explorer('my-notes'), 'k2')).toBe('/chat/files/my-notes?tab=k2');
    expect(tabForRoute('?ws=fix&tab=k2')).toBe('k2');
    expect(tabForRoute('?tab=<script>')).toBeNull();
    expect(tabForRoute('')).toBeNull();
  });

  it('groups by space, by name, in the list\'s order within each, then No space', () => {
    const make = counter();
    let st: OpenItemsState = { seeded: true, items: [] };
    st = open(st, chat('in-notes'), 1, make);
    st = open(st, file('assets', 'logo.png'), 2, make);
    st = open(st, chat('loose'), 3, make);
    st = open(st, explorer('notes'), 4, make);
    st = open(st, file('notes', 'plan.md'), 5, make);
    st = open(st, file('left', 'old.txt'), 6, make);
    st = open(st, chat('unknown'), 7, make);
    st = open(st, { ...chat('pinned'), space: 'notes' }, 8, make);
    st = open(st, { ...chat('stale-pin'), space: 'gone' }, 9, make);
    const boxes: Record<string, string | null> = { 'in-notes': 'b1', loose: null, pinned: 'b2', 'stale-pin': 'b2' };
    const boxOf = (c: { projectId: string }) => (c.projectId in boxes ? boxes[c.projectId] : undefined);
    const index = new Map([['b1', ['gone', 'notes']], ['b2', ['assets', 'notes']]]);
    const groups = groupOpenItems(st.items, ['notes', 'assets', 'empty'], boxOf, index);
    expect(groups.map(g => [g.space, g.items.map(itemKey)])).toEqual([
      ['assets', ['chat:stale-pin|main', 'file:assets:logo.png']],
      ['empty', []],
      ['notes', ['chat:pinned|main', 'file:notes:plan.md', 'explorer:notes', 'chat:in-notes|main']],
      [null, ['chat:loose|main']],
    ]);
  });

  it('keeps a pinned session in its space while the index has yet to load its new box', () => {
    const make = counter();
    let st: OpenItemsState = { seeded: true, items: [] };
    st = open(st, { ...chat('moved'), space: 'notes' }, 1, make);
    st = open(st, chat('unpinned'), 2, make);
    const boxOf = () => 'new-box';
    const index = new Map([['b1', ['notes']]]);
    const shape = (settled: boolean) => groupOpenItems(st.items, ['notes'], boxOf, index, settled).map(g => [g.space, g.items.map(itemKey)]);
    expect(shape(false)).toEqual([['notes', ['chat:moved|main']], [null, ['chat:unpinned|main']]]);
    expect(shape(true)).toEqual([['notes', []], [null, ['chat:unpinned|main', 'chat:moved|main']]]);
  });
});

describe('a stored tab from before the single flag', () => {
  it('drops its explorer fold (`collapsed`) on load', () => {
    const s = openItem(EMPTY_OPEN_ITEMS, file('notes', 'a.md'), 't1', 1).state;
    const items = parseOpenItems(JSON.stringify({ v: 2, seeded: true, items: [{ ...s.items[0], collapsed: true }] })).items;
    expect(items).toEqual([{ kind: 'file', space: 'notes', path: 'a.md', id: 't1', openedAt: 1 }]);
  });
});
