import { describe, expect, it } from 'vitest';
import { askLinks, nestInOrder, overCapByTree, readFoldedAgents, toggleFoldedAgent } from './agentTree';
import type { SpawnLink } from './explorerAgents';

const link = (child: string, parent: string): SpawnLink => {
  const [projectId, workstream] = child.split('|');
  const [parentProjectId, parentWorkstream] = parent.split('|');
  return { projectId, workstream, parentProjectId, parentWorkstream };
};
const shape = <T,>(rows: ReturnType<typeof nestInOrder<T>>, name: (t: T) => string) => rows.map(r => `${'  '.repeat(r.depth)}${name(r.item)}`);
const id = (s: string) => s;

describe('askLinks', () => {
  it('links an ask chat to the session that sent it; an older thread has none', () => {
    expect(askLinks([
      { projectId: 'b2', workstream: 'ask-t1', askParent: { projectId: 'p', workstream: 'main' } },
      { projectId: 'b3', workstream: 'ask-t2', askParent: null },
      { projectId: 'p', workstream: 'main' },
    ])).toEqual([link('b2|ask-t1', 'p|main')]);
  });
});

describe('nestInOrder', () => {
  it('puts each child under its parent, in the list order, wherever it was', () => {
    const rows = ['b2|ask-1', 'other|main', 'p|main', 'b3|ask-2', 'b4|ask-3'];
    const links = [link('b2|ask-1', 'p|main'), link('b3|ask-2', 'p|main'), link('b4|ask-3', 'b3|ask-2')];
    // The subtree goes where its first member was: ask-1 needs you, so the orchestrator comes up with it.
    expect(shape(nestInOrder(rows, id, links), id)).toEqual(['p|main', '  b2|ask-1', '  b3|ask-2', '    b4|ask-3', 'other|main']);
  });

  it('leaves a child at the top when its parent is not in the list, or the links loop', () => {
    expect(shape(nestInOrder(['b2|ask-1'], id, [link('b2|ask-1', 'gone|main')]), id)).toEqual(['b2|ask-1']);
    const loop = [link('a|main', 'b|main'), link('b|main', 'a|main')];
    expect(nestInOrder(['a|main', 'b|main'], id, loop).map(r => r.item).sort()).toEqual(['a|main', 'b|main']);
  });

  it('folds a parent, counting what it hides, but never hides the open session', () => {
    const rows = ['p|main', 'b2|ask-1', 'b3|ask-2'];
    const links = [link('b2|ask-1', 'p|main'), link('b3|ask-2', 'p|main')];
    const folded = nestInOrder(rows, id, links, new Set(['p|main']));
    expect(folded.map(r => r.item)).toEqual(['p|main']);
    expect(folded[0]).toMatchObject({ childCount: 2, hidden: ['b2|ask-1', 'b3|ask-2'] });
    expect(nestInOrder(rows, id, links, new Set(['p|main']), 'b3|ask-2').map(r => r.item)).toEqual(rows);
  });

  it('keeps what is not a session where it is', () => {
    const rows = ['file:a', 'b2|ask-1', 'p|main'];
    const keyOf = (s: string) => (s.startsWith('file:') ? null : s);
    expect(shape(nestInOrder(rows, keyOf, [link('b2|ask-1', 'p|main')]), id)).toEqual(['file:a', 'p|main', '  b2|ask-1']);
  });
});

describe('folded agents', () => {
  it('round-trips through storage and survives junk', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    const on = toggleFoldedAgent(new Set(), 'p|main', storage);
    expect(readFoldedAgents(storage)).toEqual(on);
    expect(toggleFoldedAgent(on, 'p|main', storage).size).toBe(0);
    store.set('termag.chat.foldedAgents', '{nope');
    expect(readFoldedAgents(storage).size).toBe(0);
  });
});

describe('overCapByTree', () => {
  const tab = (key: string) => ({ id: key.replace('|', '-'), key });
  const keyOf = (t: { key: string }) => (t.key.startsWith('file:') ? null : t.key);
  const keys = (n: number, prefix = 's') => Array.from({ length: n }, (_, i) => `${prefix}${i}|main`);

  it('counts a parent and its nested children as one tab, and closes them together', () => {
    // 13 tabs, 11 places: s0 with its two (one nested twice), s1..s9, then tail.
    const items = ['s0|main', 'c1|ask', 'c2|ask', ...keys(10).slice(1), 'tail|main'].map(tab);
    const links = [link('c1|ask', 's0|main'), link('c2|ask', 'c1|ask')];
    expect(overCapByTree([{ space: 'x', items }], null, keyOf, links, 10)).toEqual(['tail-main']);
    // The children of a place past the cap close with it, never on their own.
    const late = [...keys(10).map(tab), tab('p|main'), tab('k|ask')];
    expect(overCapByTree([{ space: 'x', items: late }], null, keyOf, [link('k|ask', 'p|main')], 10)).toEqual(['p-main', 'k-ask']);
  });

  it('keeps the open tab\'s place, the one above it going instead, and leaves No space alone', () => {
    const items = keys(12).map(tab);
    expect(overCapByTree([{ space: 'x', items }], 's11-main', keyOf, [], 10)).toEqual(['s9-main', 's10-main']);
    expect(overCapByTree([{ space: null, items }], null, keyOf, [], 10)).toEqual([]);
    // A child that is the open tab keeps its whole place.
    const nested = [...keys(10).map(tab), tab('p|main'), tab('k|ask')];
    expect(overCapByTree([{ space: 'x', items: nested }], 'k-ask', keyOf, [link('k|ask', 'p|main')], 10)).toEqual(['s9-main']);
  });

  it('gives the flat answer for a group with no nesting', () => {
    const items = [tab('file:a'), ...keys(11).map(tab)];
    expect(overCapByTree([{ space: 'x', items }], null, keyOf, [], 10)).toEqual(['s9-main', 's10-main']);
  });
});
