import { describe, expect, it } from 'vitest';
import type { OpenItem } from './openItems';
import { spaceRecents, type RecentAgent } from './recents';

const sp = (name: string) => ({ id: `id-${name}`, name });
const spaces = [sp('notes'), sp('design')];
const index = new Map<string, readonly string[]>([['box-n', ['notes']], ['box-nd', ['notes', 'design']], ['box-d', ['design']]]);
const fixed = (spaceId: string | null) => ({ spaceId, spaceFixed: true });
// An agent is the space's when it belongs to it, not when its box reaches it: b's box reaches notes too, but b is design's.
const agents: RecentAgent[] = [
  { projectId: 'a', workstream: 'main', instanceId: 'box-n', ...fixed('id-notes'), lastActiveAt: 10 },
  { projectId: 'b', workstream: 'main', instanceId: 'box-nd', ...fixed('id-design'), lastActiveAt: 30 },
  { projectId: 'c', workstream: 'main', instanceId: 'box-d', ...fixed('id-design'), lastActiveAt: 50 },
  { projectId: 'd', workstream: 'main', instanceId: 'box-n', ...fixed('id-notes'), lastActiveAt: null },
  { projectId: 'e', workstream: 'main', instanceId: null, ...fixed(null), lastActiveAt: 99 },
  { projectId: 'f', workstream: 'main', instanceId: 'box-nd', ...fixed('id-notes'), lastActiveAt: 40 },
];

describe('spaceRecents', () => {
  it('lists the space\'s tabs newest first, once each, then its other agents by activity', () => {
    const items: OpenItem[] = [
      { id: 't1', kind: 'file', space: 'notes', path: 'README.md', openedAt: 5 },
      { id: 't2', kind: 'chat', projectId: 'a', workstream: 'main', openedAt: 8 },
      { id: 't3', kind: 'file', space: 'design', path: 'logo.svg', openedAt: 9 },
      { id: 't4', kind: 'explorer', space: 'notes', openedAt: 20 },
      { id: 't5', kind: 'file', space: 'notes', path: 'README.md', openedAt: 1 },
      { id: 't6', kind: 'chat', projectId: 'b', workstream: 'main', openedAt: 15 },
    ];
    expect(spaceRecents(items, 'notes', agents, spaces, index)).toEqual([
      { kind: 'chat', projectId: 'a', workstream: 'main' },
      { kind: 'file', space: 'notes', path: 'README.md' },
      { kind: 'chat', projectId: 'f', workstream: 'main' },
      { kind: 'chat', projectId: 'd', workstream: 'main' },
    ]);
  });

  it('lists a tab on an agent in no space of its own that was opened from the space, and no other space\'s', () => {
    const items: OpenItem[] = [
      { id: 't1', kind: 'chat', projectId: 'e', workstream: 'main', openedAt: 9, openedIn: 'notes' },
      { id: 't2', kind: 'chat', projectId: 'b', workstream: 'main', openedAt: 8, openedIn: 'notes' },
    ];
    expect(spaceRecents(items, 'notes', agents, spaces, index).slice(0, 2)).toEqual([
      { kind: 'chat', projectId: 'e', workstream: 'main' },
      { kind: 'chat', projectId: 'f', workstream: 'main' },
    ]);
    expect(spaceRecents(items, 'design', agents, spaces, index).map(r => r.kind === 'chat' && r.projectId)).not.toContain('e');
  });

  it('leaves out sessions the project list doesn\'t have, and stops at the cap', () => {
    const items: OpenItem[] = [{ id: 't1', kind: 'chat', projectId: 'gone', workstream: 'main', openedAt: 9 }];
    expect(spaceRecents(items, 'notes', agents, spaces, index, 2)).toEqual([
      { kind: 'chat', projectId: 'f', workstream: 'main' },
      { kind: 'chat', projectId: 'a', workstream: 'main' },
    ]);
  });
});
