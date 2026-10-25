import { describe, expect, it } from 'vitest';
import type { OpenItem } from './openItems';
import { spaceRecents, type RecentAgent } from './recents';

const known = new Set(['notes', 'design']);
const index = new Map<string, readonly string[]>([['box-n', ['notes']], ['box-nd', ['notes', 'design']], ['box-d', ['design']]]);
const agents: RecentAgent[] = [
  { projectId: 'a', workstream: 'main', instanceId: 'box-n', lastActiveAt: 10 },
  { projectId: 'b', workstream: 'main', instanceId: 'box-nd', lastActiveAt: 30 },
  { projectId: 'c', workstream: 'main', instanceId: 'box-d', lastActiveAt: 50 },
  { projectId: 'd', workstream: 'main', instanceId: 'box-n', lastActiveAt: null },
  { projectId: 'e', workstream: 'main', instanceId: null, lastActiveAt: 99 },
];

describe('spaceRecents', () => {
  it('lists the space\'s tabs newest first, once each, then its other agents by activity', () => {
    const items: OpenItem[] = [
      { id: 't1', kind: 'file', space: 'notes', path: 'README.md', openedAt: 5 },
      { id: 't2', kind: 'chat', projectId: 'a', workstream: 'main', openedAt: 8 },
      { id: 't3', kind: 'file', space: 'design', path: 'logo.svg', openedAt: 9 },
      { id: 't4', kind: 'explorer', space: 'notes', openedAt: 20 },
      { id: 't5', kind: 'file', space: 'notes', path: 'README.md', openedAt: 1 },
      { id: 't6', kind: 'chat', projectId: 'b', workstream: 'main', space: 'design', openedAt: 15 },
    ];
    expect(spaceRecents(items, 'notes', agents, known, index)).toEqual([
      { kind: 'chat', projectId: 'a', workstream: 'main', space: 'notes' },
      { kind: 'file', space: 'notes', path: 'README.md' },
      { kind: 'chat', projectId: 'b', workstream: 'main', space: 'notes' },
      { kind: 'chat', projectId: 'd', workstream: 'main', space: 'notes' },
    ]);
  });

  it('leaves out sessions the project list doesn\'t have, and stops at the cap', () => {
    const items: OpenItem[] = [{ id: 't1', kind: 'chat', projectId: 'gone', workstream: 'main', openedAt: 9 }];
    expect(spaceRecents(items, 'notes', agents, known, index, 2)).toEqual([
      { kind: 'chat', projectId: 'b', workstream: 'main', space: 'notes' },
      { kind: 'chat', projectId: 'a', workstream: 'main', space: 'notes' },
    ]);
  });
});
