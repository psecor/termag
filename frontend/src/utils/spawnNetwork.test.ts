import { describe, expect, it } from 'vitest';
import type { SpawnNode } from '../services/api';
import { COL_W, NODE_W, ORIGIN_ID, PAD, ROW_H, edgePath, firstLine, fmtDuration, latestOnly, networkLink, networkTone, tidyLayout } from './spawnNetwork';

const node = (id: string, over: Partial<SpawnNode> = {}): SpawnNode => ({
  id, level: 0, parentId: null, relationship: 'delegate', state: 'running', title: id, provider: 'claude', depth: 1,
  child: { projectId: 'p1', projectName: 'proj', workstream: id, session: `me-proj-${id}-agent`, status: 'idle' },
  parent: { projectId: 'p1', workstream: 'main', session: 'me-proj-agent' },
  report: null, error: null, createdAt: '2026-10-19T10:00:00Z', launchedAt: null, reportedAt: null, endedAt: null,
  parkedAt: null, retiredAt: null, keptReason: null, lifecycle: null, foster: null, orphanedAt: null, tokens: null, ...over,
});
const origin = { projectId: 'p1', workstream: 'main', session: 'me-proj-agent', label: 'proj', status: 'idle' };

describe('tidyLayout', () => {
  it('puts the origin first, depth across and depth-first order down, with parent edges', () => {
    const l = tidyLayout({
      rootId: 'a',
      origin,
      nodes: [node('a'), node('b', { level: 1, parentId: 'a' }), node('c', { level: 2, parentId: 'b' }), node('d', { level: 1, parentId: 'a' })],
    });
    expect(l.nodes.map(n => [n.id, n.x, n.y])).toEqual([
      [ORIGIN_ID, PAD, PAD], ['a', PAD + COL_W, PAD], ['b', PAD + 2 * COL_W, PAD + ROW_H], ['c', PAD + 3 * COL_W, PAD + 2 * ROW_H], ['d', PAD + 2 * COL_W, PAD + 3 * ROW_H],
    ]);
    expect(l.edges).toEqual([
      { from: ORIGIN_ID, to: 'a', kind: 'spawn' }, { from: 'a', to: 'b', kind: 'spawn' }, { from: 'b', to: 'c', kind: 'spawn' }, { from: 'a', to: 'd', kind: 'spawn' },
    ]);
    expect(l.width).toBe(PAD * 2 + 3 * COL_W + NODE_W);
  });

  it('draws a dashed edge from a foster in the tree, names one outside it, and none for an orphan', () => {
    const l = tidyLayout({
      rootId: 'a',
      origin,
      nodes: [
        node('a'),
        node('b', { level: 1, parentId: 'a', endedAt: '2026-10-19T11:00:00Z' }),
        node('c', { level: 2, parentId: 'b', foster: { projectId: 'p1', workstream: 'main', by: 'ancestor', at: null } }),
        node('d', { level: 2, parentId: 'b', foster: { projectId: 'p9', workstream: 'home', by: 'home', at: null } }),
        node('e', { level: 2, parentId: 'b', orphanedAt: '2026-10-19T11:10:00Z', foster: { projectId: 'p1', workstream: 'a', by: 'ancestor', at: null } }),
      ],
    });
    expect(l.edges.filter(e => e.kind === 'adopted')).toEqual([{ from: ORIGIN_ID, to: 'c', kind: 'adopted' }]);
    expect([...l.fosteredOutside]).toEqual(['d']);
  });

  it('starts at the root when nobody\'s session started it', () => {
    const l = tidyLayout({ rootId: 'a', origin: null, nodes: [node('a')] });
    expect(l.nodes.map(n => [n.id, n.x])).toEqual([['a', PAD]]);
    expect(l.edges).toEqual([]);
  });

  it('draws the origin edge to the root only, not to another top whose parent is missing', () => {
    const l = tidyLayout({ rootId: 'a', origin, nodes: [node('a'), node('stray', { depth: 3 })] });
    expect(l.edges).toEqual([{ from: ORIGIN_ID, to: 'a', kind: 'spawn' }]);
  });
});

describe('networkTone', () => {
  it('follows the lifecycle first, then the pane', () => {
    expect(networkTone(node('a', { retiredAt: 'x' }))).toBe('ended');
    expect(networkTone(node('a', { parkedAt: 'x' }))).toBe('parked');
    expect(networkTone(node('a', { state: 'needs_input' }))).toBe('waiting');
    expect(networkTone(node('a', { child: { ...node('a').child, status: 'working' } }))).toBe('working');
    expect(networkTone(node('a', { state: 'done' }))).toBe('done');
    expect(networkTone(node('a', { state: 'failed' }))).toBe('failed');
    expect(networkTone(node('a'))).toBe('idle');
  });
});

describe('helpers', () => {
  it('curves forward edges right-to-left and drops back-edges from below', () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 300, y: 64 })).toMatch(/^M210,24 C/);
    expect(edgePath({ x: 300, y: 0 }, { x: 300, y: 128 })).toMatch(/^M405,48 C/);
    // An adoption drops from the foster's bottom-left and comes in from the left.
    expect(edgePath({ x: 0, y: 0 }, { x: 500, y: 128 }, 'adopted')).toBe('M24,48 C24,152 440,152 500,152');
  });

  it('formats', () => {
    expect(firstLine('\n  Fix the tests\nmore')).toBe('Fix the tests');
    expect(fmtDuration(20)).toBe('<1m');
    expect(fmtDuration(12 * 60)).toBe('12m');
    expect(fmtDuration(65 * 60)).toBe('1h 05m');
    expect(fmtDuration(51 * 3600)).toBe('2d 3h');
    expect(networkLink('ck 1')).toBe('/spawns/ck%201');
  });
});

describe('latestOnly', () => {
  it('lets only the newest request land, and none after a cancel', () => {
    const l = latestOnly();
    const slow = l.start();
    const fast = l.start();
    expect([slow(), fast()]).toEqual([false, true]);
    l.cancel();
    expect(fast()).toBe(false);
    expect(l.start()()).toBe(true);
  });
});

describe('a session\'s view (every tree it started)', () => {
  it('draws an edge from the session to each tree\'s root', () => {
    const l = tidyLayout({ rootId: 'session:p1:main', rootIds: ['a', 'b'], origin, nodes: [node('a'), node('a1', { level: 1, parentId: 'a' }), node('b')] });
    expect(l.edges.filter(e => e.from === ORIGIN_ID).map(e => e.to)).toEqual(['a', 'b']);
  });
});
