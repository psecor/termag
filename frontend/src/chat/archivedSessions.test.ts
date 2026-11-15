// Which sessions leave the redesigned sidebar's list for Archived (chat/archivedSessions.ts).
import { describe, expect, it } from 'vitest';
import { archivedOutKeys, unarchiveKeys } from './archivedSessions';

const row = (workstream: string, over: { explorerArchived?: boolean; shared?: boolean; live?: boolean } = {}) => ({
  key: `p|${workstream}`, projectId: 'p', workstream, explorerArchived: over.explorerArchived, shared: over.shared ?? false, live: over.live ?? false,
});
const link = (child: string, parent: string) => ({ projectId: 'p', workstream: child, parentProjectId: 'p', parentWorkstream: parent });
const keep = (r: { live: boolean }) => r.live;

describe('archivedOutKeys', () => {
  it('takes an archived session, with the sessions under it', () => {
    const rows = [row('main'), row('a', { explorerArchived: true }), row('ask-1'), row('b')];
    expect([...archivedOutKeys(rows, [link('ask-1', 'a')], keep)].sort()).toEqual(['p|a', 'p|ask-1']);
  });

  it('keeps an archived session where it is while it, or one under it, works, needs you or is open', () => {
    expect(archivedOutKeys([row('a', { explorerArchived: true, live: true })], [], keep).size).toBe(0);
    const rows = [row('a', { explorerArchived: true }), row('ask-1', { live: true })];
    expect(archivedOutKeys(rows, [link('ask-1', 'a')], keep).size).toBe(0);
  });

  it("leaves a shared session where it is: only its owner can unarchive it", () => {
    expect(archivedOutKeys([row('a', { explorerArchived: true, shared: true })], [], keep).size).toBe(0);
  });

  it('survives a link loop', () => {
    const rows = [row('a', { explorerArchived: true }), row('b')];
    expect([...archivedOutKeys(rows, [link('b', 'a'), link('a', 'b')], keep)].sort()).toEqual(['p|a', 'p|b']);
  });
});

describe('unarchiveKeys', () => {
  it('clears the session and every one under it that has a mark of its own, so they come back together', () => {
    const rows = [row('a', { explorerArchived: true }), row('ask-1', { explorerArchived: true }), row('ask-2'), row('b', { explorerArchived: true })];
    const links = [link('ask-1', 'a'), link('ask-2', 'ask-1')];
    expect(unarchiveKeys('p|a', rows, links).map(r => r.key)).toEqual(['p|a', 'p|ask-1']);
    expect(unarchiveKeys('p|b', rows, links).map(r => r.key)).toEqual(['p|b']);
  });
});
