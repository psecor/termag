import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { coalesceWorkspaceChanges, setWorkspaceChangeCallback } from './workspaceEvents';
import { touchesList, workspaceWriteMiddleware, type AudienceReader } from './workspaceWrites';

/**
 * Any write to a row behind the project list tells everyone who can see it
 * (services/workspaceWrites.ts), and a burst of them is one push per window
 * (coalesceWorkspaceChanges).
 */

const changed = vi.fn();
const reader = {
  projectAudience: vi.fn(async (ids: string[]) => (ids.includes('p1') ? ['owner', 'collab'] : [])),
  rowsMatching: vi.fn(async (): Promise<Record<string, unknown>[]> => [{ id: 'p1', userId: 'owner' }]),
  rowById: vi.fn(async (): Promise<Record<string, unknown> | null> => ({ projectId: 'p1' })),
} satisfies AudienceReader;
const mw = workspaceWriteMiddleware(reader);

function run(model: string, action: string, args: unknown, result: unknown = {}) {
  const next = vi.fn(async () => result);
  return { done: mw({ model, action, args, dataPath: [], runInTransaction: false } as unknown as Prisma.MiddlewareParams, next), next };
}
const pushed = () => changed.mock.calls.map(c => c[0]).sort();

beforeEach(() => { vi.clearAllMocks(); setWorkspaceChangeCallback(changed); });
afterEach(() => setWorkspaceChangeCallback(null));

describe('workspaceWriteMiddleware', () => {
  it("tells the project's owner and collaborators when a workstream is made, even when the select leaves out projectId", async () => {
    const { done } = run('Workstream', 'create', { data: { projectId: 'p1', name: 'ask-t1' }, select: { id: true, name: true } }, { id: 'ws1', name: 'ask-t1' });
    expect(await done).toEqual({ id: 'ws1', name: 'ask-t1' });
    await vi.waitFor(() => expect(pushed()).toEqual(['collab', 'owner']));
    expect(reader.rowById).toHaveBeenCalledWith('Workstream', 'ws1');
    expect(changed.mock.calls.every(c => c[1] === 'projects')).toBe(true);
  });

  it('tells the owner of a new project from its row', async () => {
    reader.projectAudience.mockResolvedValueOnce(['owner']);
    await run('Project', 'create', { data: { name: 'x', userId: 'owner' } }, { id: 'p1', userId: 'owner' }).done;
    await vi.waitFor(() => expect(pushed()).toEqual(['owner']));
    expect(reader.rowById).not.toHaveBeenCalled();
  });

  it('reads a delete\'s audience before the row (and its shares) goes', async () => {
    const order: string[] = [];
    reader.rowsMatching.mockImplementationOnce(async () => { order.push('read'); return [{ id: 'p1', userId: 'owner' }]; });
    const next = vi.fn(async () => { order.push('delete'); return { id: 'p1' }; });
    await mw({ model: 'Project', action: 'delete', args: { where: { id: 'p1' } } } as unknown as Prisma.MiddlewareParams, next);
    expect(order).toEqual(['read', 'delete']);
    expect(pushed()).toEqual(['collab', 'owner']);
  });

  it('tells a collaborator whose share was removed, though the project no longer lists them', async () => {
    reader.rowsMatching.mockResolvedValueOnce([{ projectId: 'p1', userId: 'gone' }]);
    reader.projectAudience.mockResolvedValueOnce(['owner']);
    await run('ProjectShare', 'deleteMany', { where: { projectId: 'p1', userId: 'gone' } }, { count: 1 }).done;
    expect(pushed()).toEqual(['gone', 'owner']);
  });

  it('says nothing for an activity touch, a write that matched nothing, or one that failed', async () => {
    await run('Project', 'updateMany', { where: { userId: 'owner', name: 'x' }, data: { lastActiveAt: new Date() } }, { count: 1 }).done;
    await run('Workstream', 'update', { where: { id: 'ws1' }, data: { slackChannelId: 'C1' } }).done;
    await run('Project', 'updateMany', { where: { id: 'p1' }, data: { archived: true } }, { count: 0 }).done;
    const next = vi.fn(async () => { throw new Error('P2002'); });
    await expect(mw({ model: 'Workstream', action: 'create', args: { data: { projectId: 'p1' } } } as unknown as Prisma.MiddlewareParams, next)).rejects.toThrow('P2002');
    await run('User', 'update', { where: { id: 'owner' }, data: { name: 'x' } }).done;
    await new Promise(r => setTimeout(r, 0));
    expect(changed).not.toHaveBeenCalled();
    expect(reader.rowsMatching).toHaveBeenCalledTimes(1); // only the archive, which counts as a list change
  });

  it('never fails the write when the audience lookup does', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reader.rowsMatching.mockRejectedValueOnce(new Error('db gone'));
    reader.projectAudience.mockRejectedValueOnce(new Error('db gone'));
    await expect(run('Workstream', 'deleteMany', { where: { projectId: 'p1' } }, { count: 2 }).done).resolves.toEqual({ count: 2 });
    await expect(run('Workstream', 'create', { data: { projectId: 'p1' } }, { id: 'w', projectId: 'p1' }).done).resolves.toEqual({ id: 'w', projectId: 'p1' });
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    vi.restoreAllMocks();
  });
});

describe('touchesList', () => {
  it('counts the fields the list shows and nested writes through its relations', () => {
    expect(touchesList('Project', 'update', { data: { name: 'n' } })).toBe(true);
    expect(touchesList('Project', 'update', { data: { instanceId: 'box2' } })).toBe(true);
    expect(touchesList('Project', 'update', { data: { workstreams: { create: {} } } })).toBe(true);
    expect(touchesList('Project', 'update', { data: { lastActiveAt: new Date(), chatTrustedAt: new Date() } })).toBe(false);
    expect(touchesList('Workflow', 'update', { data: { provider: 'codex' } })).toBe(true);
    expect(touchesList('Workstream', 'upsert', { create: {}, update: {} })).toBe(true);
    // A chat's session title is what the simple UI's sidebar leads with.
    expect(touchesList('Workstream', 'updateMany', { data: { sessionTitle: 'Auth fix' } })).toBe(true);
    expect(touchesList('Workstream', 'update', { data: { lastActiveAt: new Date() } })).toBe(false);
    expect(touchesList('Project', 'findMany', {})).toBe(false);
  });
});

describe('coalesceWorkspaceChanges', () => {
  afterEach(() => vi.useRealTimers());

  it('turns a box, project and workstream burst into one push per list per owner', () => {
    vi.useFakeTimers();
    const push = vi.fn();
    const notify = coalesceWorkspaceChanges(push, 500);
    notify('u1', 'boxes');
    notify('u1', 'projects');
    vi.advanceTimersByTime(200);
    notify('u1', 'projects');
    notify('u2', 'projects');
    expect(push).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(push.mock.calls).toEqual([['u1', 'boxes'], ['u1', 'projects']]);
    vi.advanceTimersByTime(200);
    expect(push.mock.calls.at(-1)).toEqual(['u2', 'projects']);
    // A change after the push is never lost: it opens the next window.
    notify('u1', 'projects');
    vi.advanceTimersByTime(500);
    expect(push).toHaveBeenCalledTimes(4);
  });
});
