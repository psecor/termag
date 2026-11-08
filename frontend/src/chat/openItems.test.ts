import { describe, expect, it } from 'vitest';
import {
  activeTab, arrangeItems, dismissItem, duplicateItem, EMPTY_OPEN_ITEMS, groupOpenItems, folderForRoute, folderHref, itemForRoute, spaceLinkTarget, itemHref, itemKey, openItem,
  noteActive, noteSent, parseOpenItems, pickItem, placeUnplacedItems, RECENT_TABS_MAX, RECONCILE_GRACE_MS, reconcileItems, reorderItem, seedItems, serializeOpenItems, tabAfterClose, tabForRoute,
  type ChatListing, type OpenItemRef, type OpenItemsState } from './openItems';

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
  it('puts a new tab on top, and a route to one already showing it changes nothing', () => {
    const make = counter();
    let s: OpenItemsState = { seeded: true, items: [] };
    s = open(s, chat('a'), 1, make);
    s = open(s, file('notes', 'plan.md'), 2, make);
    const before = s;
    s = open(s, chat('a'), 3, make);
    s = open(s, chat('a'), 4, make, 't1');
    expect(s).toBe(before);
    expect(keys(s)).toEqual(['file:notes:plan.md', 'chat:a|main']);
    expect(ids(s)).toEqual(['t2', 't1']);
    expect(s.items[1].openedAt).toBe(1);
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

  it('duplicates a tab just below it', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, chat('a'), 1, make);
    s = open(s, file('n', 'x'), 2, make);
    s = duplicateItem(s, 't1', 'd1', 3);
    expect(s.items.map(i => [i.id, itemKey(i)])).toEqual([['t2', 'file:n:x'], ['t1', 'chat:a|main'], ['d1', 'chat:a|main']]);
    expect(s.items[2]).toMatchObject({ openedAt: 3 });
    expect(duplicateItem(s, 'nope', 'd2', 4)).toBe(s);
  });

  it('keeps every tab, however many: opening, duplicating, seeding and loading from storage close none', () => {
    const make = counter();
    let s: OpenItemsState = { seeded: true, items: [] };
    for (let i = 0; i < 55; i++) s = open(s, chat(`p${i}`), 100 + i, make);
    s = open(s, chat('new'), 1, make);
    expect(s.items).toHaveLength(56);
    // The one opened longest ago is still there.
    expect(keys(s)).toContain('chat:p0|main');
    s = duplicateItem(s, s.items[0].id, 'copy', 2);
    expect(s.items).toHaveLength(57);
    expect(parseOpenItems(serializeOpenItems(s)).items).toHaveLength(57);
    const chats = Array.from({ length: 60 }, (_, i) => ({ projectId: `q${i}`, workstream: 'main', lastActiveAt: 1000 - i }));
    expect(seedItems(EMPTY_OPEN_ITEMS, chats, 2000, counter('s')).items).toHaveLength(60);
  });

  it('closes one tab, not another showing the same thing', () => {
    const make = counter();
    let s = open(open(EMPTY_OPEN_ITEMS, chat('a'), 1, make), explorer('notes'), 2, make);
    s = duplicateItem(s, 't2', 'd', 3);
    s = dismissItem(s, 't2');
    expect(s.items.map(i => [i.id, itemKey(i)])).toEqual([['d', 'explorer:notes'], ['t1', 'chat:a|main']]);
  });

  it('closes many tabs at once, and closing none changes nothing', () => {
    const make = counter();
    let s = open(open(open(EMPTY_OPEN_ITEMS, chat('a'), 1, make), file('notes', 'x'), 2, make), explorer('notes'), 3, make);
    expect(dismissItem(s, [])).toBe(s);
    expect(dismissItem(s, ['gone'])).toBe(s);
    s = dismissItem(s, ['t1', 't3']);
    expect(ids(s)).toEqual(['t2']);
  });

  it('arranges one group in a given order around the other groups\' tabs, and ignores an order that isn\'t the group\'s', () => {
    const s: OpenItemsState = { seeded: true, items: [
      { ...file('notes', 'a'), id: 'a', openedAt: 1 }, { ...file('design', 'x'), id: 'x', openedAt: 1 },
      { ...file('notes', 'b'), id: 'b', openedAt: 1 }, { ...file('notes', 'c'), id: 'c', openedAt: 1 },
    ] };
    expect(ids(arrangeItems(s, ['a', 'b', 'c'], ['c', 'a', 'b']))).toEqual(['c', 'x', 'a', 'b']);
    expect(arrangeItems(s, ['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(s);
    expect(arrangeItems(s, ['a', 'b', 'c'], ['a', 'b'])).toBe(s);
    expect(arrangeItems(s, ['a', 'b', 'c'], ['a', 'b', 'x'])).toBe(s);
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

  it('keeps no space on an agent\'s tab: the chat has its own (plan-outbox #38)', () => {
    let s = open(EMPTY_OPEN_ITEMS, chat('a'), 1);
    s = open(s, chat('a'), 2);
    expect(s.items[0]).toEqual({ kind: 'chat', projectId: 'a', workstream: 'main', id: 't1', openedAt: 1 });
    // A list from before kept the space it was opened in: it is dropped on load.
    const old = parseOpenItems(JSON.stringify({ v: 2, seeded: true, items: [{ ...s.items[0], space: 'design' }] }));
    expect(old.items[0]).not.toHaveProperty('space');
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
    let s = open(open({ seeded: true, items: [] }, chat('a', 'ws'), 9, make), file('sp', 'd/e.png'), 2, make);
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
      { kind: 'chat', projectId: 'a', workstream: 'main', id: 'm5', openedAt: 5 },
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

  it('names a folder to show in a space\'s explorer on its new tab\'s route', () => {
    expect(folderHref('notes', 'docs/deep/')).toBe('/chat/files/notes?dir=docs%2Fdeep%2F');
    expect(folderHref('notes', '', 'k2')).toBe('/chat/files/notes?tab=k2&dir=');
    expect(itemForRoute('/chat/files/notes', '?tab=k2&dir=docs%2F')).toEqual(explorer('notes'));
    expect(folderForRoute('?tab=k2&dir=My%20Docs%2F')).toBe('My Docs/');
    expect(folderForRoute('?dir=')).toBe('');
    expect(folderForRoute('?tab=k2')).toBeNull();
    // Only a folder: a bare name is one, a climb or an empty segment is nothing.
    expect(folderForRoute('?dir=docs')).toBe('docs/');
    expect(folderForRoute('?dir=..%2F')).toBeNull();
    expect(folderForRoute('?dir=a%2F%2Fb%2F')).toBeNull();
    expect(folderForRoute('?dir=%2Fa%2F')).toBeNull();
  });

  it('reads a space link in a reply as the file, or the folder in its space\'s explorer, it opens in the app', () => {
    const origin = 'https://app.example';
    const at = (path: string) => spaceLinkTarget(`${origin}${path}`, origin, '/termag/');
    expect(at('/termag/files/notes/docs/plan.md')).toEqual({ ref: file('notes', 'docs/plan.md') });
    expect(at('/termag/files/improve-termag/artifacts/file-workaround-bugs/'))
      .toEqual({ ref: explorer('improve-termag'), dir: 'artifacts/file-workaround-bugs/' });
    expect(at('/termag/files/notes/')).toEqual({ ref: explorer('notes'), dir: '' });
    expect(at('/termag/chat/files/notes')).toBeNull();
    expect(spaceLinkTarget('https://elsewhere.example/termag/files/notes/a/', origin, '/termag/')).toBeNull();
  });

  it('groups by space, by name, in the list\'s order within each, then No space: a chat under its own space', () => {
    const make = counter();
    let st: OpenItemsState = { seeded: true, items: [] };
    st = open(st, chat('in-notes'), 1, make);
    st = open(st, file('assets', 'logo.png'), 2, make);
    st = open(st, chat('loose'), 3, make);
    st = open(st, explorer('notes'), 4, make);
    st = open(st, file('notes', 'plan.md'), 5, make);
    st = open(st, file('left', 'old.txt'), 6, make);
    st = open(st, chat('unknown'), 7, make);
    st = open(st, chat('in-assets'), 8, make);
    st = open(st, chat('in-gone'), 9, make);
    const homes: Record<string, string | null> = { 'in-notes': 'notes', loose: null, 'in-assets': 'assets', 'in-gone': 'gone' };
    const spaceOf = (c: { projectId: string }) => (c.projectId in homes ? homes[c.projectId] : undefined);
    const groups = groupOpenItems(st.items, ['notes', 'assets', 'empty'], spaceOf);
    expect(groups.map(g => [g.space, g.items.map(itemKey)])).toEqual([
      ['assets', ['chat:in-assets|main', 'file:assets:logo.png']],
      ['empty', []],
      ['notes', ['file:notes:plan.md', 'explorer:notes', 'chat:in-notes|main']],
      // A space the user no longer has is No space for its chats.
      [null, ['chat:in-gone|main', 'chat:loose|main']],
    ]);
  });
});

describe('an access: a pick from an explorer, recents or a chat link, or a message sent', () => {
  const pick = (s: OpenItemsState, ref: OpenItemRef, current: string | null, now: number) => pickItem(s, ref, current, now, counter('n'));
  const notes = (s: OpenItemsState) => groupOpenItems(s.items, ['notes'], () => 'notes')[0].items.map(i => i.id);

  it('opens a new tab on top for something no tab shows, leaving the current tab as it was', () => {
    const s = open(EMPTY_OPEN_ITEMS, chat('a'), 1);
    const r = pick(s, file('notes', 'plan.md'), 't1', 5);
    expect(r.id).toBe('n1');
    expect(r.state.items.map(i => [i.id, itemKey(i), i.openedAt])).toEqual([['n1', 'file:notes:plan.md', 5], ['t1', 'chat:a|main', 1]]);
  });

  it('goes to the tab already showing a file and moves it to the top of its space', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, file('notes', 'plan.md'), 1, make);
    s = open(s, file('design', 'logo.svg'), 2, make);
    s = open(s, file('notes', 'deck.pdf'), 3, make);
    const r = pick(s, file('notes', 'plan.md'), 't3', 9);
    expect(r.id).toBe('t1');
    expect(ids(r.state)).toEqual(['t1', 't3', 't2']);
    expect(r.state.items[0].openedAt).toBe(9);
  });

  it('goes to the tab already showing an agent without moving it', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, chat('a'), 1, make);
    s = open(s, file('notes', 'x.md'), 2, make);
    const r = pick(s, chat('a'), 't2', 9);
    expect(r.id).toBe('t1');
    expect(ids(r.state)).toEqual(['t2', 't1']);
    expect(r.state.items[1]).toMatchObject({ openedAt: 1 });
  });

  it('prefers the current tab when two show it, else the first', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, file('n', 'a'), 1, make);
    s = duplicateItem(s, 't1', 'd1', 2);
    s = open(s, file('n', 'b'), 3, make);
    expect(pick(s, file('n', 'a'), 'd1', 9).id).toBe('d1');
    expect(pick(s, file('n', 'a'), 't2', 9).id).toBe('t1');
  });

  it('shows it instead of the new tab it was picked from, on top', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, explorer('notes'), 1, make);
    s = open(s, chat('a'), 2, make);
    const r = pick(s, file('notes', 'plan.md'), 't1', 9);
    expect(r.id).toBe('t1');
    expect(r.state.items.map(i => [i.id, itemKey(i), i.openedAt])).toEqual([['t1', 'file:notes:plan.md', 9], ['t2', 'chat:a|main', 2]]);
    expect(pick(r.state, chat('a'), 'gone', 10).id).toBe('t2');
  });

  it('an agent of another space picked from a space\'s new tab gets its own tab, in its own space; one of this space takes the new tab (plan-outbox #38)', () => {
    const make = counter();
    const s = open(EMPTY_OPEN_ITEMS, explorer('notes'), 1, make);
    const other = pickItem(s, chat('a'), 't1', 9, counter('n'), 'design');
    expect(other.id).toBe('n1');
    expect(other.state.items.map(i => [i.id, itemKey(i)])).toEqual([['n1', 'chat:a|main'], ['t1', 'explorer:notes']]);
    const homes: Record<string, string> = { a: 'design' };
    const groups = groupOpenItems(other.state.items, ['design', 'notes'], c => homes[c.projectId]);
    expect(groups.map(g => [g.space, g.items.map(i => i.id)])).toEqual([['design', ['n1']], ['notes', ['t1']]]);
    const own = pickItem(s, chat('b'), 't1', 9, counter('n'), 'notes');
    expect(own.id).toBe('t1');
  });

  it('moves an agent\'s tabs to the top of their spaces when it is sent a message', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, chat('a'), 1, make);
    s = open(s, chat('b'), 2, make);
    s = open(s, file('notes', 'f'), 3, make);
    s = noteSent(s, chat('a'), 10);
    expect(keys(s)).toEqual(['chat:a|main', 'file:notes:f', 'chat:b|main']);
    expect(s.items[0].openedAt).toBe(10);
    expect(noteSent(s, chat('nobody'), 11)).toBe(s);
  });

  it('keeps a dragged tab where it was dropped until its next access', () => {
    const make = counter();
    let s = open(EMPTY_OPEN_ITEMS, file('notes', 'a'), 1, make);
    s = open(s, file('notes', 'b'), 2, make);
    s = open(s, chat('c'), 3, make);
    expect(notes(s)).toEqual(['t3', 't2', 't1']);
    s = reorderItem(s, notes(s), 't3', 2);
    expect(notes(s)).toEqual(['t2', 't1', 't3']);
    s = open(s, chat('c'), 4, make, 't3');
    s = pick(s, file('notes', 'b'), 't3', 5).state;
    expect(notes(s)).toEqual(['t2', 't1', 't3']);
    s = noteSent(s, chat('c'), 6);
    expect(notes(s)).toEqual(['t3', 't2', 't1']);
  });
});

describe('a stored tab from before the single flag', () => {
  it('drops its explorer fold (`collapsed`) on load', () => {
    const s = openItem(EMPTY_OPEN_ITEMS, file('notes', 'a.md'), 't1', 1).state;
    const items = parseOpenItems(JSON.stringify({ v: 2, seeded: true, items: [{ ...s.items[0], collapsed: true }] })).items;
    expect(items).toEqual([{ kind: 'file', space: 'notes', path: 'a.md', id: 't1', openedAt: 1 }]);
  });
});


describe('a chat in no space of its own goes under the space its tab was opened from', () => {
  // Ask threads fixed to "No space" (their box was granted the space after their first use) that a space's explorer lists.
  const homes: Record<string, string | null> = { ask1: null, ask2: null, mine: 'design' };
  const spaceOf = (c: { projectId: string }) => (c.projectId in homes ? homes[c.projectId] : undefined);
  const grouped = (s: OpenItemsState, spaces = ['design', 'improve-termag']) =>
    groupOpenItems(s.items, spaces, spaceOf).map(g => [g.space, g.items.map(i => i.id)]);

  it('opened from a space\'s explorer, it is under that space, in a new tab or in the new tab it was picked from', () => {
    let s = open(EMPTY_OPEN_ITEMS, explorer('improve-termag'), 1);
    let r = pickItem(s, chat('ask1'), 't1', 2, counter('n'), null, 'improve-termag');
    expect(r.id).toBe('t1');
    expect(r.state.items[0]).toMatchObject({ kind: 'chat', projectId: 'ask1', openedIn: 'improve-termag' });
    s = r.state;
    r = pickItem(s, chat('ask2'), 't1', 3, counter('n'), null, 'improve-termag');
    s = openItem(r.state, chat('ask2'), null, 4).state;
    s = openItem(s, chat('ask1'), 'x1', 5, counter(), 'improve-termag').state;
    expect(grouped(s)).toEqual([['design', []], ['improve-termag', ['x1', 'n1', 't1']]]);
    // Two tabs on one chat (Duplicate) keep where the first was opened.
    s = duplicateItem(s, 'x1', 'd1', 6);
    expect(s.items.find(i => i.id === 'd1')).toMatchObject({ openedIn: 'improve-termag' });
  });

  it('a chat with a space of its own stays in it, wherever it was opened from (plan-outbox #38)', () => {
    const s = openItem(EMPTY_OPEN_ITEMS, chat('mine'), null, 1, counter(), 'improve-termag').state;
    expect(grouped(s)).toEqual([['design', ['t1']], ['improve-termag', []]]);
  });

  it('opened from No space, or from a space the user no longer has, it is under No space', () => {
    let s = openItem(EMPTY_OPEN_ITEMS, chat('ask1'), null, 1, counter('a'), null).state;
    s = openItem(s, chat('ask2'), null, 2, counter('b'), 'gone').state;
    expect(grouped(s)).toEqual([['design', []], ['improve-termag', []], [null, ['b1', 'a1']]]);
  });

  it('opening it again from another space moves no tab', () => {
    const s = openItem(EMPTY_OPEN_ITEMS, chat('ask1'), null, 1, counter(), null).state;
    const r = pickItem(s, chat('ask1'), null, 9, counter('n'), null, 'improve-termag');
    expect(r.id).toBe('t1');
    expect(r.state).toEqual(s);
    const back = pickItem(openItem(EMPTY_OPEN_ITEMS, chat('ask1'), null, 1, counter(), 'improve-termag').state, chat('ask1'), null, 9, counter('n'), null, null);
    expect(back.state.items[0].openedIn).toBe('improve-termag');
    // A route to the same tab changes nothing either.
    expect(openItem(r.state, chat('ask1'), 't1', 10).state).toBe(r.state);
  });

  it('a space\'s new tab takes a picked agent of no space, as one of its own', () => {
    const s = open(EMPTY_OPEN_ITEMS, explorer('improve-termag'), 1);
    expect(pickItem(s, chat('ask1'), 't1', 2, counter('n'), null, 'improve-termag').id).toBe('t1');
    // From another space's new tab, it gets a tab of its own.
    expect(pickItem(s, chat('ask1'), 't1', 2, counter('n'), null, 'design').id).toBe('n1');
  });

  it('round-trips where it was opened from through storage, and drops junk', () => {
    let s = openItem(EMPTY_OPEN_ITEMS, chat('ask1'), null, 1, counter('a'), 'improve-termag').state;
    s = openItem(s, chat('ask2'), null, 2, counter('b'), null).state;
    s = open(s, chat('mine'), 3, counter('c'));
    const back = parseOpenItems(serializeOpenItems(s));
    expect(back.items.map(i => i.openedIn)).toEqual([undefined, null, 'improve-termag']);
    expect(back.items[0]).not.toHaveProperty('openedIn');
    const junk = parseOpenItems(JSON.stringify({ v: 2, seeded: true, items: [{ ...s.items[0], openedIn: 7 }, { ...s.items[1], openedIn: '' }] }));
    expect(junk.items.map(i => 'openedIn' in i)).toEqual([false, false]);
  });

  describe('a tab from before, on next load', () => {
    const listings: Record<string, ChatListing | undefined> = {
      ask1: { home: null, listedIn: ['improve-termag'] },
      ask2: { home: null, listedIn: ['design', 'improve-termag'] },
      loose: { home: null, listedIn: [] },
      mine: { home: 'design', listedIn: ['design', 'improve-termag'] },
    };
    const listingOf = (i: { projectId: string }) => listings[i.projectId];

    it('moves to the one space whose explorer lists it; otherwise it stays, and the pass is done for it', () => {
      const make = counter();
      let s: OpenItemsState = { seeded: true, items: [] };
      for (const p of ['ask1', 'ask2', 'loose', 'mine', 'unknown']) s = open(s, chat(p), 1, make);
      s = open(s, file('design', 'a.md'), 2, make);
      const placed = placeUnplacedItems(s, listingOf);
      expect(placed.items.map(i => [i.kind === 'chat' ? i.projectId : i.kind, i.openedIn])).toEqual([
        ['file', undefined], ['unknown', undefined], ['mine', undefined], ['loose', null], ['ask2', null], ['ask1', 'improve-termag'],
      ]);
      expect(groupOpenItems(placed.items, ['design', 'improve-termag'], i => listings[i.projectId]?.home)
        .map(g => [g.space, g.items.map(i => i.id)])).toEqual([['design', ['t6', 't4']], ['improve-termag', ['t1']], [null, ['t3', 't2']]]);
      // Placed once: a later grant doesn't move the ones left in No space, and nothing changes again.
      expect(placeUnplacedItems(placed, i => (i.projectId === 'ask2' ? { home: null, listedIn: ['design'] } : listingOf(i)))).toBe(placed);
    });

    it('leaves a tab opened from No space, or from a space, where it is', () => {
      let s = openItem(EMPTY_OPEN_ITEMS, chat('ask1'), null, 1, counter('a'), null).state;
      s = openItem(s, chat('ask2'), null, 2, counter('b'), 'design').state;
      expect(placeUnplacedItems(s, listingOf)).toBe(s);
    });
  });
});

describe('the tabs most recently shown, for a close that goes back', () => {
  const two = (): OpenItemsState => ({ seeded: true, items: [
    { ...chat('a'), id: 'ta', openedAt: 1 }, { ...chat('b'), id: 'tb', openedAt: 1 }, { ...file('notes', 'x.png'), id: 'tf', openedAt: 1 },
  ] });

  it('puts the shown tab first, once, and ignores an id no tab has', () => {
    let s = two();
    s = noteActive(s, 'tb');
    s = noteActive(s, 'ta');
    s = noteActive(s, 'tf');
    expect(s.recent).toEqual(['tf', 'ta', 'tb']);
    s = noteActive(s, 'ta');
    expect(s.recent).toEqual(['ta', 'tf', 'tb']);
    expect(noteActive(s, 'ta')).toBe(s);
    expect(noteActive(s, 'nope')).toBe(s);
  });

  it('keeps the newest RECENT_TABS_MAX', () => {
    let s: OpenItemsState = { seeded: true, items: Array.from({ length: RECENT_TABS_MAX + 5 }, (_, i) => ({ ...chat(`p${i}`), id: `t${i}`, openedAt: 1 })) };
    for (const i of s.items) s = noteActive(s, i.id);
    expect(s.recent).toHaveLength(RECENT_TABS_MAX);
    expect(s.recent![0]).toBe(`t${RECENT_TABS_MAX + 4}`);
  });

  it('a route open records its tab as shown only when asked', () => {
    const make = counter();
    let s: OpenItemsState = { seeded: true, items: [] };
    s = openItem(s, chat('a'), null, 1, make, undefined, true).state;
    s = openItem(s, file('notes', 'x.png'), null, 2, make).state;
    expect(s.recent).toEqual(['t1']);
    s = openItem(s, file('notes', 'x.png'), null, 3, make, undefined, true).state;
    expect(s.recent).toEqual(['t2', 't1']);
  });

  it('a closed tab leaves the list', () => {
    let s = noteActive(noteActive(noteActive(two(), 'ta'), 'tb'), 'tf');
    s = dismissItem(s, 'tb');
    expect(s.recent).toEqual(['tf', 'ta']);
    s = dismissItem(s, ['tf', 'ta']);
    expect(s.recent).toEqual([]);
  });

  it('is stored, without ids no tab has', () => {
    const s = noteActive(noteActive(two(), 'ta'), 'tf');
    expect(parseOpenItems(serializeOpenItems(s)).recent).toEqual(['tf', 'ta']);
    const raw = JSON.stringify({ v: 2, seeded: true, items: two().items, recent: ['tf', 'gone', 7, 'tf', 'tb'] });
    expect(parseOpenItems(raw).recent).toEqual(['tf', 'tb']);
    expect(parseOpenItems(JSON.stringify({ v: 2, seeded: true, items: two().items })).recent).toBeUndefined();
  });

  describe('where closing tabs leaves the person', () => {
    const groups = (s: OpenItemsState) => groupOpenItems(s.items, ['notes'], () => 'notes');
    const four = (): OpenItemsState => ({ seeded: true, items: [
      { ...file('notes', 'x.png'), id: 'tf', openedAt: 1 }, { ...chat('a'), id: 'ta', openedAt: 1 },
      { ...chat('b'), id: 'tb', openedAt: 1 }, { ...file('notes', 'y.md'), id: 'ty', openedAt: 1 },
    ] });

    it('nowhere new when the open tab stays', () => {
      expect(tabAfterClose(groups(four()), ['tb'], 'tf')).toBeNull();
      expect(tabAfterClose(groups(four()), ['tb'], null)).toBeNull();
    });

    it('goes to the tab acted on, else the first left in the open tab\'s space, else the first anywhere, else none', () => {
      const s = four();
      expect(tabAfterClose(groups(s), ['tf'], 'tf')?.id).toBe('ta');
      expect(tabAfterClose(groups(s), ['tf', 'ta'], 'tf', { stay: s.items[3] })?.id).toBe('ty');
      expect(tabAfterClose(groups(s), ['tf', 'ta', 'tb', 'ty'], 'tf')).toBeUndefined();
    });

    it('with `recent`, goes to the tab shown before it that is still open', () => {
      let s = four();
      for (const id of ['ty', 'tb', 'tf']) s = noteActive(s, id);
      expect(tabAfterClose(groups(s), ['tf'], 'tf', { recent: s.recent })?.id).toBe('tb');
      expect(tabAfterClose(groups(s), ['tf', 'tb'], 'tf', { recent: s.recent })?.id).toBe('ty');
      // None shown before it is still open: as without.
      expect(tabAfterClose(groups(s), ['tf', 'tb', 'ty'], 'tf', { recent: s.recent })?.id).toBe('ta');
      // A tab the groups leave out (a space the person left) is passed over.
      const hidden = groupOpenItems(s.items.filter(i => i.id !== 'tb'), ['notes'], () => 'notes');
      expect(tabAfterClose(hidden, ['tf'], 'tf', { recent: s.recent })?.id).toBe('ty');
      // Unless it is one of `also`, tabs listed outside the groups (a review session, in Reviews).
      expect(tabAfterClose(hidden, ['tf'], 'tf', { recent: s.recent, also: [s.items[2]] })?.id).toBe('tb');
      // `also` is for going back only: with nothing shown before, the first left in the group, as without it.
      expect(tabAfterClose(hidden, ['tf'], 'tf', { also: [s.items[2]] })?.id).toBe('ta');
    });
  });
});

describe('the tabs shown most recently, through seeding and reconciling', () => {
  it('a first-load seed keeps the tabs a route recorded before it', () => {
    let s: OpenItemsState = { seeded: false, items: [] };
    s = openItem(s, chat('a'), null, 1, counter('r'), undefined, true).state;
    expect(s.recent).toEqual(['r1']);
    s = seedItems(s, [{ projectId: 'b', workstream: 'main', lastActiveAt: 5 }], 10, counter('s'));
    expect(s.seeded).toBe(true);
    expect(s.recent).toEqual(['r1']);
  });

  it('a reconcile that closes gone sessions drops their tabs from recent, as a close does', () => {
    let s: OpenItemsState = { seeded: true, items: [
      { ...chat('live'), id: 'tl', openedAt: 0 }, { ...chat('gone'), id: 'tg', openedAt: 0 }, { ...file('notes', 'x.md'), id: 'tf', openedAt: 0 },
    ] };
    for (const id of ['tf', 'tg', 'tl']) s = noteActive(s, id);
    s = reconcileItems(s, new Set([itemKey(chat('live'))]), RECONCILE_GRACE_MS + 1);
    expect(ids(s)).toEqual(['tl', 'tf']);
    expect(s.recent).toEqual(['tl', 'tf']);
  });

  it('gone sessions never push a tab that is still open out of recent', () => {
    let s: OpenItemsState = { seeded: true, items: [{ ...file('notes', 'a.md'), id: 'ta', openedAt: 0 }] };
    s = noteActive(s, 'ta');
    for (let i = 0; i < RECENT_TABS_MAX + 5; i++) {
      s = openItem(s, chat(`p${i}`), `c${i}`, 0, counter(), undefined, true).state;
      s = reconcileItems(s, new Set(), RECONCILE_GRACE_MS + 1);
    }
    expect(s.recent).toEqual(['ta']);
  });
});
