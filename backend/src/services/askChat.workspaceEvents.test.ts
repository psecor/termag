import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

/**
 * An ask's first run makes its `ask-<thread>` chat workstream with a plain
 * Prisma write (services/askChat.ts). The write notifier on the shared client
 * (services/workspaceWrites.ts, installed in index.ts) is what puts it in the
 * owner's and every collaborator's sidebar without a reload. The client here
 * runs its middleware the way Prisma does.
 */

const middlewares: Prisma.Middleware[] = [];
function through<A, R>(model: string, action: string, impl: (args: A) => Promise<R>) {
  return (args: A) => {
    const run = middlewares.reduceRight<(p: Prisma.MiddlewareParams) => Promise<unknown>>(
      (next, mw) => p => mw(p, next) as Promise<unknown>,
      p => impl(p.args as A),
    );
    return run({ model, action, args, dataPath: [], runInTransaction: false } as unknown as Prisma.MiddlewareParams) as Promise<R>;
  };
}

const prisma = {
  $use: (mw: Prisma.Middleware) => { middlewares.push(mw); },
  workstream: {
    create: vi.fn(through('Workstream', 'create', async (args: { data: { name: string } }) => ({ id: 'ws1', name: args.data.name }))),
    findUnique: vi.fn(async (args: { where: { id: string } }) => (args.where.id === 'ws1' ? { id: 'ws1', name: 'ask-t1', projectId: 'p1' } : null)),
    findUniqueOrThrow: vi.fn(),
  },
  agentThread: { update: vi.fn(through('AgentThread', 'update', async () => ({}))) },
  project: {
    findMany: vi.fn(async () => [{ userId: 'owner', shares: [{ userId: 'collab' }] }]),
  },
};
vi.mock('../db', () => ({ prisma }));

const { ensureAskChat } = await import('./askChat');
const { setWorkspaceChangeCallback } = await import('./workspaceEvents');
const { installWorkspaceWriteNotifier } = await import('./workspaceWrites');
installWorkspaceWriteNotifier(prisma);

const changed = vi.fn();
beforeEach(() => { vi.clearAllMocks(); setWorkspaceChangeCallback(changed); });
afterEach(() => setWorkspaceChangeCallback(null));

describe("an ask's chat workstream", () => {
  it("tells the project's owner and its collaborators the list changed when it is made", async () => {
    const chat = await ensureAskChat({ id: 't1', projectId: 'p1', chatWorkstreamId: null });
    expect(chat.workstreamId).toBe('ws1');
    await vi.waitFor(() => expect(changed.mock.calls.map(c => c[0]).sort()).toEqual(['collab', 'owner']));
    expect(changed.mock.calls.every(c => c[1] === 'projects')).toBe(true);
  });

  it('says nothing on a later run, which reuses the workstream', async () => {
    await ensureAskChat({ id: 't1', projectId: 'p1', chatWorkstreamId: 'ws1' });
    await new Promise(r => setTimeout(r, 0));
    expect(prisma.workstream.create).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
