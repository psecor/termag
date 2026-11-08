// The asks a chat sent: GET
// …/chat/asks reads the caller's own threads that the chat sent or that its
// `termag ask` calls named, behind chat-subagents-enabled.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({ agentThread: { findMany: vi.fn() } }));
vi.mock('../db', () => ({ prisma }));
const ld = vi.hoisted(() => ({ on: new Set<string>(), surfaces: new Map<string, string | undefined>() }));
vi.mock('../services/featureFlags', async () => {
  const { currentSurface } = await import('../services/requestSurface');
  // Records the surface each flag was read under: buildFlagContext puts it on the user context.
  return { boolVariation: vi.fn(async (key: string) => { ld.surfaces.set(key, currentSurface()); return ld.on.has(key); }) };
});
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

  it('says a message\'s sender is told when it finishes only with ask-completion-notify-enabled on for the caller', async () => {
    const m = { id: 'a9525f4870115a431e32d6a46', hop: 1, status: 'working', error: null, replyBytes: null, publish: null, publishDetail: null, createdAt: new Date(), startedAt: null, completedAt: null, readAt: null, queuedPrompt: null, supersededById: null, notifyVia: 'chat', notifyProjectId: 'p1', notifyWorkstream: 'main', notice: null };
    prisma.agentThread.findMany.mockResolvedValue([{ ...row(T1, 23), messages: [m] }]);
    const notice = async () => ((await chatAsksFor('u1', 'p1', {}, me)).body as { threads: Array<{ messages: Array<{ notice: string }> }> }).threads[0].messages[0].notice;
    expect(await notice()).toBe('none');
    ld.on.add('ask-completion-notify-enabled');
    expect(await notice()).toBe('due');
    expect(Object.keys(prisma.agentThread.findMany.mock.calls[0][0].select.messages.select)).toEqual(expect.arrayContaining(['notifyVia', 'notifyProjectId', 'notifyWorkstream', 'notice']));
    // Another chat's notice (a follow-up it sent) doesn't tell this one.
    expect(((await chatAsksFor('u1', 'p1', { workstream: 'review' }, me)).body as { threads: Array<{ messages: Array<{ notice: string }> }> }).threads[0].messages[0].notice).toBe('none');
  });

  it('reads the notice flag in the sweep\'s context, with no request surface, and the subagents flag in the request\'s', async () => {
    const { withSurface } = await import('../services/requestSurface');
    ld.on.add('ask-completion-notify-enabled');
    await withSurface('web', () => chatAsksFor('u1', 'p1', {}, me));
    expect(ld.surfaces.get('ask-completion-notify-enabled')).toBeUndefined();
    expect(ld.surfaces.get('chat-subagents-enabled')).toBe('web');
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

// A chat that has sent more asks than one read answers (MAX_CHAT_ASK_THREADS):
// the threads in memory, and findMany read as Prisma would for the where
// clauses askThreadsOf writes.
describe('past the newest MAX_CHAT_ASK_THREADS threads', () => {
  type Stored = ReturnType<typeof row> & { originUserId: string; parentProjectId: string | null; parentWorkstream: string | null; parentClaudeSession: string | null };
  type Where = Record<string, unknown>;
  const id = (i: number) => `cmvtr5x6r0i0lafsfuclk${String(i).padStart(4, '0')}`;
  const HOUR = 60 * 60 * 1000;
  /** A message in `status`; one that ended did so `endedAgo` ms ago (two hours, past what an ended one is kept for, unless said). */
  const msg = (status: string, endedAgo = 2 * HOUR) => ({
    id: 'a9525f4870115a431e32d6a46', hop: 1, status, error: null, replyBytes: null, publish: null, publishDetail: null,
    createdAt: new Date(Date.UTC(2026, 10, 5)), startedAt: null, readAt: null, queuedPrompt: null, supersededById: null,
    completedAt: status === 'submitted' || status === 'working' ? null : new Date(Date.now() - endedAgo),
  });
  function matches(t: Stored, where: Where): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Where[]).some(w => matches(t, w));
      if (k === 'messages') {
        const some = (v as { some: { status?: { in: string[] }; completedAt?: { gte: Date } } }).some;
        return t.messages.some(m => (some.status ? some.status.in.includes(m.status) : true)
          && (some.completedAt ? m.completedAt !== null && m.completedAt.getTime() >= some.completedAt.gte.getTime() : true));
      }
      if (v && typeof v === 'object' && 'in' in v) return (v as { in: unknown[] }).in.includes(t[k as keyof Stored]);
      if (v && typeof v === 'object' && 'notIn' in v) return !(v as { notIn: unknown[] }).notIn.includes(t[k as keyof Stored]);
      return t[k as keyof Stored] === v;
    });
  }
  let store: Stored[] = [];
  /** `n` threads this chat (p1, main) sent, a minute apart, oldest first, each finished. */
  function sent(n: number, from = 0, parent: Partial<Stored> = { parentProjectId: 'p1', parentWorkstream: 'main' }): Stored[] {
    return Array.from({ length: n }, (_, i) => ({
      ...row(id(from + i), 0), createdAt: new Date(Date.UTC(2026, 10, 5, 12, from + i)),
      originUserId: 'u1', parentProjectId: null, parentWorkstream: null, parentClaudeSession: null, ...parent,
      messages: [msg('completed')],
    }));
  }
  const answered = (r: { body: unknown }) => (r.body as { threads: Array<{ id: string; messages: Array<{ status: string }> }> }).threads;

  beforeEach(() => {
    prisma.agentThread.findMany.mockImplementation(async (q: { where: Where; orderBy?: { createdAt: 'desc' }; take: number }) => {
      const hits = store.filter(t => matches(t, q.where));
      if (q.orderBy) hits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return hits.slice(0, q.take);
    });
  });

  it('still answers the oldest of 51 when it is still going, oldest first, and polls see it end', async () => {
    store = sent(51);
    store[0].messages = [msg('working')];
    const r = await chatAsksFor('u1', 'p1', { workstream: 'main' }, me);
    expect(r.status).toBe(200);
    expect(answered(r).map(t => t.id)).toEqual(store.map(t => t.id));
    expect(answered(r)[0].messages[0].status).toBe('working');
    // Once it ends it is one of the finished, and the newest 50 are what a read answers.
    store[0].messages = [msg('completed')];
    expect(answered(await chatAsksFor('u1', 'p1', { workstream: 'main' }, me)).map(t => t.id)).toEqual(store.slice(1).map(t => t.id));
  });

  it('keeps a queued (submitted) ask too, and every one going however far back, but never another chat\'s or another person\'s', async () => {
    store = [
      ...sent(3, 0, { parentProjectId: 'p1', parentWorkstream: 'review' }),
      ...sent(3, 3, { originUserId: 'u2' } as Partial<Stored>),
      ...sent(80, 6),
    ];
    for (const t of store.slice(0, 8)) t.messages = [msg('submitted')];
    const ids = answered(await chatAsksFor('u1', 'p1', { workstream: 'main' }, me)).map(t => t.id);
    expect(ids).toEqual([id(6), id(7), ...store.slice(-50).map(t => t.id)]);
  });

  it('answers every thread the chat\'s calls named, past the newest 50', async () => {
    store = sent(60);
    const named = [id(0), id(1)];
    const ids = answered(await chatAsksFor('u1', 'p1', { workstream: 'main', threads: named.join(',') }, me)).map(t => t.id);
    expect(ids).toEqual([...named, ...store.slice(-50).map(t => t.id)]);
  });

  it('answers one past the newest 50 that ended in the last hour, so the drawer shows how it ended, and not one that ended before', async () => {
    store = sent(53);
    store[0].messages = [msg('completed', 10 * 60 * 1000)];
    store[1].messages = [msg('failed', HOUR - 60 * 1000)];
    store[2].messages = [msg('completed', HOUR + 60 * 1000)];
    const ids = answered(await chatAsksFor('u1', 'p1', { workstream: 'main' }, me)).map(t => t.id);
    expect(ids).toEqual([id(0), id(1), ...store.slice(-50).map(t => t.id)]);
  });

  it('never lets ones that ended crowd out one still going', async () => {
    store = sent(160);
    store[0].messages = [msg('working')];
    for (const t of store.slice(1, 110)) t.messages = [msg('completed', 60 * 1000)];
    const ids = answered(await chatAsksFor('u1', 'p1', { workstream: 'main' }, me)).map(t => t.id);
    // The one going, the newest 50 of those that ended past the page, and the page.
    expect(ids).toEqual([id(0), ...store.slice(60, 110).map(t => t.id), ...store.slice(-50).map(t => t.id)]);
  });

  it('never lets one going take a place among those that ended (Devin: a follow-up on a thread that finished a turn)', async () => {
    store = sent(120);
    for (const t of store.slice(0, 50)) t.messages = [msg('completed', 5 * 60 * 1000)];
    for (const t of store.slice(50, 70)) t.messages = [msg('completed', 60 * 1000), msg('working')];
    const ids = answered(await chatAsksFor('u1', 'p1', { workstream: 'main' }, me)).map(t => t.id);
    expect(ids).toEqual(store.map(t => t.id));
  });

  it('reads once while every thread fits in one read', async () => {
    store = sent(49);
    store[0].messages = [msg('working')];
    expect(answered(await chatAsksFor('u1', 'p1', {}, me))).toHaveLength(49);
    expect(prisma.agentThread.findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps a desktop thread\'s running ask past the newest 50 that recorded its session', async () => {
    const SESSION = '5109190e-c0d2-4f72-9c15-3c4c57fb126c';
    store = sent(55, 0, { parentClaudeSession: SESSION });
    store[2].messages = [msg('working')];
    const ids = answered(await desktopChatAsksFor('u1', { claudeSession: SESSION }, me)).map(t => t.id);
    expect(ids).toEqual([id(2), ...store.slice(-50).map(t => t.id)]);
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
