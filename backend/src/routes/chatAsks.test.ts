// The asks a chat sent: GET
// …/chat/asks reads the caller's own threads that the chat sent or that its
// `termag ask` calls named, behind chat-subagents-enabled.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({ agentThread: { findMany: vi.fn() } }));
vi.mock('../db', () => ({ prisma }));
const ld = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async (key: string) => ld.on.has(key)) }));
vi.mock('../services/chatRunner', () => ({ CHAT_SUBAGENTS_FLAG: 'chat-subagents-enabled' }));

import { chatAsksFor, desktopChatAsksFor } from './chatAsks';

const me = { id: 'u1', googleEmail: 'j@example.com', displayName: 'J', unixUsername: 'jsmith', defaultAgentProvider: 'claude' } as never;
const T1 = 'cmvtr5x6r0i0lafsfuclk9ed5';
const T2 = 'cmvtr5y1k0i0qbm2pz7xw3d8c';

function row(id: string, minute: number) {
  return {
    id, title: null, hopCount: 1, branch: null, prNumber: null, prUrl: null, prs: [],
    projectId: 'p4', workstream: 'main', repoName: null, instanceId: 'i4', createdAt: new Date(Date.UTC(2026, 9, 29, 13, minute)),
    project: { name: 'termag-4', instance: { name: 'termag-4' } }, chatWorkstream: { name: `ask-${id}` },
    messages: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ld.on = new Set(['chat-subagents-enabled']);
  prisma.agentThread.findMany.mockResolvedValue([]);
});

describe('GET …/chat/asks', () => {
  it('is not found with chat-subagents-enabled off, and reads nothing', async () => {
    ld.on = new Set();
    const r = await chatAsksFor('u1', 'p1', { workstream: 'main' }, me);
    expect(r).toEqual({ status: 404, body: { error: 'Not found', code: 'subagents-off' } });
    expect(prisma.agentThread.findMany).not.toHaveBeenCalled();
  });

  it('reads only the caller\'s threads: the ones this chat sent, and the ones its calls named', async () => {
    await chatAsksFor('u1', 'p1', { workstream: 'review', threads: `${T1},${T2}` }, me);
    const where = prisma.agentThread.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      originUserId: 'u1',
      OR: [{ parentProjectId: 'p1', parentWorkstream: 'review' }, { id: { in: [T1, T2] } }],
    });
  });

  it('defaults to the main workstream and names no ids when none are given', async () => {
    await chatAsksFor('u1', 'p1', {}, me);
    expect(prisma.agentThread.findMany.mock.calls[0][0].where).toEqual({ originUserId: 'u1', OR: [{ parentProjectId: 'p1', parentWorkstream: 'main' }] });
  });

  it('never selects a reply, and reads a prompt only to say the message is queued', async () => {
    await chatAsksFor('u1', 'p1', {}, me);
    const select = prisma.agentThread.findMany.mock.calls[0][0].select;
    expect(Object.keys(select.messages.select)).not.toContain('reply');
    const r = await (async () => {
      prisma.agentThread.findMany.mockResolvedValue([{ ...row(T1, 23), messages: [{ id: 'a9525f4870115a431e32d6a46', hop: 1, status: 'submitted', error: null, replyBytes: null, publish: null, publishDetail: null, createdAt: new Date(), startedAt: null, completedAt: null, readAt: null, queuedPrompt: 'the whole prompt', supersededById: null }] }]);
      return chatAsksFor('u1', 'p1', {}, me);
    })();
    expect(JSON.stringify(r.body)).not.toContain('the whole prompt');
    expect((r.body as { threads: Array<{ messages: Array<{ queued: boolean }> }> }).threads[0].messages[0].queued).toBe(true);
  });

  it('answers the threads oldest first', async () => {
    prisma.agentThread.findMany.mockResolvedValue([row(T2, 24), row(T1, 23)]);
    const r = await chatAsksFor('u1', 'p1', {}, me);
    expect(r.status).toBe(200);
    expect((r.body as { threads: Array<{ id: string }> }).threads.map(t => t.id)).toEqual([T1, T2]);
  });

  it('refuses a threads list that is not ids, and an overlong workstream', async () => {
    expect((await chatAsksFor('u1', 'p1', { threads: `${T1},nope!` }, me)).status).toBe(400);
    expect((await chatAsksFor('u1', 'p1', { workstream: 'w'.repeat(201) }, me)).status).toBe(400);
    expect(prisma.agentThread.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/cli/v1/chat/asks (a desktop thread\'s asks)', () => {
  const SESSION = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';
  const where = () => (prisma.agentThread.findMany.mock.calls[0][0] as { where: unknown }).where;

  it("reads the caller's own threads its calls named or that recorded its Claude session, oldest first", async () => {
    prisma.agentThread.findMany.mockResolvedValue([row(T2, 9), row(T1, 2)]);
    const r = await desktopChatAsksFor('u1', { threads: T1, claudeSession: SESSION }, me);
    expect(r.status).toBe(200);
    expect((r.body as { threads: Array<{ id: string }> }).threads.map(t => t.id)).toEqual([T1, T2]);
    expect(where()).toEqual({ originUserId: 'u1', OR: [{ id: { in: [T1] } }, { parentClaudeSession: SESSION }] });
  });

  it('takes a session alone, or ids alone', async () => {
    await desktopChatAsksFor('u1', { claudeSession: SESSION }, me);
    expect(where()).toEqual({ originUserId: 'u1', OR: [{ parentClaudeSession: SESSION }] });
  });

  it('asks for something to look for, and a session id it can read', async () => {
    expect((await desktopChatAsksFor('u1', {}, me)).status).toBe(400);
    expect((await desktopChatAsksFor('u1', { claudeSession: '../x' }, me)).status).toBe(400);
    expect((await desktopChatAsksFor('u1', { threads: 'not an id' }, me)).status).toBe(400);
    expect(prisma.agentThread.findMany).not.toHaveBeenCalled();
  });

  it('is not found with chat-subagents-enabled off, as on web', async () => {
    ld.on = new Set();
    expect(await desktopChatAsksFor('u1', { claudeSession: SESSION }, me)).toEqual({ status: 404, body: { error: 'Not found', code: 'subagents-off' } });
    expect(prisma.agentThread.findMany).not.toHaveBeenCalled();
  });
});
