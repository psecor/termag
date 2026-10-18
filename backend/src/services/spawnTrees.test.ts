import { describe, expect, it } from 'vitest';
import { buildSpawnTrees, tokensBySpawn, type TreeInput } from './spawnTrees';

const t0 = Date.parse('2026-10-18T10:00:00Z');
const s = (id: string, over: Partial<TreeInput>): TreeInput => ({
  id, rootSpawnId: null, depth: 1, createdAt: new Date(t0), childProjectId: 'p1', childWorkstream: id,
  parentProjectId: 'p1', parentWorkstream: 'main', ...over,
});

describe('buildSpawnTrees', () => {
  it('nests children under the spawn whose workstream they came from, depth-first, oldest sibling first', () => {
    const rows = [
      s('a', { rootSpawnId: 'a' }),
      s('b', { rootSpawnId: 'a', depth: 2, parentWorkstream: 'a', createdAt: new Date(t0 + 2000) }),
      s('c', { rootSpawnId: 'a', depth: 2, parentWorkstream: 'a', createdAt: new Date(t0 + 1000) }),
      s('d', { rootSpawnId: 'a', depth: 3, parentWorkstream: 'c', createdAt: new Date(t0 + 3000) }),
    ];
    const [tree] = buildSpawnTrees(rows);
    expect(tree.rootId).toBe('a');
    expect(tree.nodes.map(n => [n.spawn.id, n.level])).toEqual([['a', 0], ['c', 1], ['d', 2], ['b', 1]]);
  });

  it('keeps separate roots apart, newest tree first, and treats a missing root id as its own tree', () => {
    const rows = [s('x', { createdAt: new Date(t0) }), s('y', { createdAt: new Date(t0 + 60_000) })];
    expect(buildSpawnTrees(rows).map(t => t.rootId)).toEqual(['y', 'x']);
  });

  it('shows a node whose parent fell out of the window at the top of its tree', () => {
    const rows = [s('b', { rootSpawnId: 'a', depth: 2, parentWorkstream: 'a' })];
    expect(buildSpawnTrees(rows)[0].nodes).toEqual([{ spawn: rows[0], level: 0 }]);
  });
});

describe('tokensBySpawn', () => {
  it('sums a spawned workstream\'s tokens from its spawn day, with reasoning in output', () => {
    const spawns = [s('a', { createdAt: new Date('2026-10-17T23:00:00Z') }), s('m', { childProjectId: 'p2', childWorkstream: 'main' })];
    const rows = [
      { projectId: 'p1', workstream: 'a', date: '2026-10-16', input: 999, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 },
      { projectId: 'p1', workstream: 'a', date: '2026-10-17', input: 10, output: 5, cacheRead: 100, cacheCreate: 2, reasoning: 1 },
      { projectId: 'p1', workstream: 'a', date: '2026-10-18', input: 20n, output: 5n, cacheRead: 0n, cacheCreate: 0n, reasoning: 0n },
      { projectId: 'p2', workstream: 'main', date: '2026-10-18', input: 7, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 },
      { projectId: 'p1', workstream: 'other', date: '2026-10-18', input: 50, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 },
    ];
    const t = tokensBySpawn(spawns, rows);
    expect(t.get('a')).toEqual({ input: 30, output: 11, cacheRead: 100, cacheCreate: 2 });
    expect(t.get('m')).toEqual({ input: 7, output: 0, cacheRead: 0, cacheCreate: 0 });
  });
});
