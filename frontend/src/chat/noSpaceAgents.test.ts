import { describe, expect, it } from 'vitest';
import { groupOpenItems, itemForRoute, itemHref, itemKey, NO_SPACE_EXPLORER, type OpenItem } from './openItems';
import { boxesKnown, noSpaceAgents, noSpaceRecents, noSpaceRows } from './noSpaceAgents';

const row = (projectId: string, instanceId: string | null, workstream = 'main') => ({ projectId, workstream, projectName: projectId, instanceId });
const known = [{ id: 's-notes', name: 'notes' }];
const index = new Map<string, readonly string[]>([['box-n', ['notes']], ['box-gone', ['old-space']]]);

describe('noSpaceRows', () => {
  it('keeps the agents not fixed yet whose box reaches none of the user\'s spaces', () => {
    const rows = [row('a', 'box-n'), row('b', 'box-x'), row('c', 'box-gone'), row('d', null)];
    expect(noSpaceRows(rows, known, index).map(r => r.projectId)).toEqual(['b', 'c', 'd']);
    // While the index reloads for a new box, that box is not known to be in no space yet.
    expect(noSpaceRows(rows, known, index, box => box !== 'box-x').map(r => r.projectId)).toEqual(['c', 'd']);
    // No spaces (or spaces off): every agent.
    expect(noSpaceRows(rows, [], new Map()).map(r => r.projectId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('goes by a fixed chat\'s own space, not its box, even while the index reloads', () => {
    const rows = [
      { ...row('started-in-none', 'box-n'), spaceId: null, spaceFixed: true },
      { ...row('in-notes', 'box-x'), spaceId: 's-notes', spaceFixed: true },
    ];
    expect(noSpaceRows(rows, known, index, () => false).map(r => r.projectId)).toEqual(['started-in-none']);
  });
});

describe('noSpaceAgents', () => {
  it('nests an agent under the one that started it, by name', () => {
    const rows = [row('zed', 'box-x'), row('kid', 'box-x'), row('boss', 'box-x'), row('inspace', 'box-n')];
    const links = [{ projectId: 'kid', workstream: 'main', parentProjectId: 'boss', parentWorkstream: 'main' }];
    const tree = noSpaceAgents(rows, known, index, links);
    expect(tree.map(n => [n.row.projectId, n.children.map(c => c.row.projectId)])).toEqual([['boss', ['kid']], ['zed', []]]);
  });
});

describe('noSpaceRecents', () => {
  it('lists the tabs on agents in no space newest first, then the other agents by activity', () => {
    const agents = [
      { projectId: 'a', workstream: 'main', instanceId: 'box-x', lastActiveAt: 10 },
      { projectId: 'b', workstream: 'main', instanceId: 'box-x', lastActiveAt: 30 },
      { projectId: 'c', workstream: 'main', instanceId: 'box-n', lastActiveAt: 99 },
      { projectId: 'd', workstream: 'main', instanceId: null, lastActiveAt: null },
      { projectId: 'e', workstream: 'main', instanceId: 'box-x', lastActiveAt: 20 },
    ];
    const items: OpenItem[] = [
      { id: 't1', kind: 'chat', projectId: 'a', workstream: 'main', openedAt: 5 },
      { id: 't2', kind: 'chat', projectId: 'c', workstream: 'main', openedAt: 9 },
      { id: 't3', kind: 'explorer', space: 'notes', openedAt: 20 },
      { id: 't4', kind: 'chat', projectId: 'a', workstream: 'main', openedAt: 1 },
    ];
    expect(noSpaceRecents(items, agents, known, index).map(r => r.projectId)).toEqual(['a', 'b', 'e', 'd']);
    expect(noSpaceRecents(items, agents, known, index, 2)).toHaveLength(2);
  });
});

describe('a new tab on the agents in no space', () => {
  const none = { kind: 'explorer' as const, space: NO_SPACE_EXPLORER };
  it('is at /chat/agents, and no space has its name', () => {
    expect(itemForRoute('/chat/agents', '?tab=k3')).toEqual(none);
    expect(itemHref(none, 'k3')).toBe('/chat/agents?tab=k3');
    expect(/^[a-z0-9-]{2,40}$/.test(NO_SPACE_EXPLORER)).toBe(false);
  });

  it('goes under No space, the user\'s spaces first', () => {
    const items: OpenItem[] = [
      { id: 't1', kind: 'chat', projectId: 'loose', workstream: 'main', openedAt: 1 },
      { id: 't2', ...none, openedAt: 2 },
      { id: 't3', kind: 'explorer', space: 'gone', openedAt: 3 },
    ];
    const shape = (spaces: string[]) => groupOpenItems(items, spaces, () => null).map(g => [g.space, g.items.map(itemKey)]);
    expect(shape([])).toEqual([[null, ['chat:loose|main', `explorer:${NO_SPACE_EXPLORER}`]]]);
    expect(shape(['notes'])).toEqual([['notes', []], [null, ['chat:loose|main', `explorer:${NO_SPACE_EXPLORER}`]]]);
  });
});

describe('boxesKnown', () => {
  const idx = new Map<string, readonly string[]>([['bk-in', ['notes']]]);
  it('knows every box while the index is current, and the ones it saw then while it reloads', () => {
    expect(boxesKnown(['bk-in', 'bk-old'], idx, true, true)('bk-anything')).toBe(true);
    const reloading = boxesKnown(['bk-in', 'bk-old', 'bk-new'], idx, false, true);
    expect(reloading('bk-old')).toBe(true);
    expect(reloading('bk-in')).toBe(true);
    expect(reloading(null)).toBe(true);
    expect(reloading('bk-new')).toBe(false);
  });

  it('knows every box for someone with no spaces, even while it reloads', () => {
    expect(boxesKnown(['bk-other'], new Map(), false, false)('bk-never-seen')).toBe(true);
  });
});
