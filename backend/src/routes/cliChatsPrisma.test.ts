/**
 * routes/cliChatsPrisma.ts: the sidebar rows carry their checkout, their own
 * box and their stored session id; a shared row names no box of someone
 * else's; the archived list keeps web's order; history notes its cap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliUser } from '../services/cliStore';

const db = vi.hoisted(() => ({
  boxes: [] as Array<{ id: string; userId: string; name: string; status: string; hostHome: string | null }>,
  transcripts: [] as Array<{ workstreamId: string; sessionId: string; current: boolean; createdAt: Date }>,
  projects: [] as Array<Record<string, unknown> & { id: string; userId: string }>,
}));
vi.mock('../db', () => ({
  prisma: {
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, googleEmail: `${where.id}@x`, displayName: where.id, unixUsername: where.id, defaultAgentProvider: 'claude' }) },
    instance: {
      findMany: async ({ where }: { where: { id: { in: string[] }; userId: string } }) =>
        db.boxes.filter(b => where.id.in.includes(b.id) && b.userId === where.userId),
    },
    chatTranscript: {
      findMany: async ({ where }: { where: { workstreamId: { in: string[] }; current: boolean } }) =>
        db.transcripts.filter(t => where.workstreamId.in.includes(t.workstreamId) && t.current === where.current),
    },
    project: {
      findMany: async ({ where }: { where: { id: { in: string[] }; userId: string } }) =>
        db.projects.filter(p => where.id.in.includes(p.id) && p.userId === where.userId),
    },
    workstream: {
      // The owner's chat only: a collaborator's rename finds nothing.
      findFirst: async ({ where }: { where: { name: string; project: { id: string; userId: string } } }) =>
        where.project.userId === 'alice' && where.project.id === 'p-app' && where.name === 'main' ? { id: 'w-main' } : null,
    },
  },
}));
vi.mock('./cliLifecyclePrisma', () => ({
  fullUser: async (u: CliUser) => ({ ...u, defaultAgentProvider: 'claude' }),
}));
const listed = vi.hoisted(() => ({ projects: [] as unknown[], archived: [] as unknown[] }));
vi.mock('./projects', () => ({ listProjectsFor: async () => listed.projects }));
const chatActs = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./chats', () => ({
  archivedChatsFor: async () => ({ status: 200, body: listed.archived }),
  archiveChatFor: async (...args: unknown[]) => { chatActs.calls.push(['archive', ...args.slice(1)]); return { status: 200, body: { archived: true } }; },
  reopenChatFor: async (...args: unknown[]) => { chatActs.calls.push(['reopen', ...args.slice(1)]); return { status: 409, body: { code: 'box-stopped' } }; },
}));
vi.mock('./spawns', () => ({
  parentsFor: async () => ({ status: 200, body: { links: [{ projectId: 'p-app', workstream: 'feature', parentProjectId: 'p-app', parentWorkstream: 'main' }] } }),
}));
const history = vi.hoisted(() => ({ answer: { status: 200, body: {} as unknown }, calls: [] as unknown[][] }));
const turns = vi.hoisted(() => ({ calls: [] as unknown[][], owner: 'alice' }));
vi.mock('./chat', () => ({
  chatHistoryFor: async (...args: unknown[]) => { history.calls.push(args); return history.answer; },
  // The owner check's answer for p-app; any other project isn't the person's to see.
  chatOwnerRefusal: async (userId: string, projectId: string) => {
    turns.calls.push(['owner?', userId, projectId]);
    if (projectId !== 'p-app') return { status: 404, body: { error: 'Project not found' } };
    return userId === turns.owner ? null : { status: 403, body: { error: "Only the project's owner can continue this chat", code: 'not-owner' } };
  },
  chatSendFor: async (...args: unknown[]) => { turns.calls.push(['send', ...args]); return { status: 202, body: { queued: 0 } }; },
  chatInterruptFor: async (...args: unknown[]) => { turns.calls.push(['interrupt', ...args]); return { status: 200, body: { interrupted: true } }; },
}));
const renamed = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../services/chatRunner', () => ({
  renameSessionFor: async (...args: unknown[]) => {
    renamed.calls.push(args);
    return typeof args[2] === 'string' && args[2].trim() ? { title: args[2].trim(), titleAt: '2026-11-02T20:00:00.000Z' } : null;
  },
}));
vi.mock('../services/chatTranscriptStore', () => ({ VIEW_MAX_ENTRIES: 600 }));
const liveChatFlag = vi.hoisted(() => ({ on: false }));
vi.mock('../services/desktopAppFlag', () => ({ desktopLiveChatEnabled: async () => liveChatFlag.on }));
vi.mock('../services/status', () => ({ getAllStatuses: () => new Map() }));

const { createPrismaCliChats } = await import('./cliChatsPrisma');
const chats = createPrismaCliChats();
const alice: CliUser = { id: 'alice', googleEmail: 'alice@x', unixUsername: 'alice', displayName: 'alice' };

const agent = { type: 'agent', provider: 'claude-chat', workstreamId: null };
const ws = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, archived: false, sessionTitle: null, createdAt: new Date('2026-10-20T08:00:00Z'), updatedAt: new Date('2026-10-31T09:00:00Z'), hasTranscript: false, askThread: null, ...extra });

beforeEach(() => {
  db.boxes = [
    { id: 'box-a', userId: 'alice', name: 'alice-dev', status: 'stopped', hostHome: '/home/ubuntu' },
    { id: 'box-b', userId: 'bob', name: 'bob-dev', status: 'running', hostHome: '/home/bob' },
  ];
  db.transcripts = [
    { workstreamId: 'w-main', sessionId: 'sess-main', current: true, createdAt: new Date('2026-10-30T08:00:00Z') },
    { workstreamId: 'w-feat', sessionId: 'sess-old', current: false, createdAt: new Date('2026-10-01T08:00:00Z') },
    { workstreamId: 'w-bob', sessionId: 'sess-bob', current: true, createdAt: new Date('2026-10-29T08:00:00Z') },
  ];
  listed.projects = [
    { id: 'p-app', name: 'app', instanceId: 'box-a', kind: 'normal', role: 'owner', ownerUsername: 'alice', workflows: [agent], workstreams: [ws('w-main', 'main', { sessionTitle: 'Fix login' }), ws('w-feat', 'feature')] },
    {
      id: 'p-asked', name: 'svc', instanceId: 'box-a', kind: 'normal', role: 'owner', ownerUsername: 'alice', workflows: [agent],
      workstreams: [
        ws('w-asked-main', 'main', { hasTranscript: true }),
        ws('w-ask', 'ask-abcdef1234', { askThread: { id: 'abcdef1234', title: 'Why is CI red?', workstream: 'fix-ci', repoName: 'api' } }),
        ws('w-ask2', 'ask-1234abcdef', { askThread: { id: '1234abcdef', title: null, workstream: 'main', repoName: null } }),
      ],
    },
    { id: 'p-bob', name: 'shared', instanceId: 'box-b', kind: 'normal', role: 'collaborator', ownerUsername: 'bob', workflows: [agent], workstreams: [ws('w-bob', 'main')] },
  ];
  listed.archived = [];
  db.projects = [];
  history.calls = [];
});

describe('GET /api/cli/v1/chats rows', () => {
  it('carries each own session\'s checkout, box and stored session id, and none of a shared box\'s', async () => {
    const rows = await chats.list(alice, { archived: false });
    const pick = (key: string) => rows.find(r => r.key === key)!;
    expect(pick('p-app|main')).toMatchObject({
      directory: '/home/ubuntu/termag/projects/app', box: { id: 'box-a', name: 'alice-dev', status: 'stopped' },
      sessionId: 'sess-main', archived: false, status: { value: 'not_running' },
    });
    expect(pick('p-app|feature')).toMatchObject({
      directory: '/home/ubuntu/termag/projects/app/.worktrees/feature', sessionId: null,
      spawnParent: { projectId: 'p-app', workstream: 'main' },
    });
    expect(pick('p-app|main').spawnParent).toBeNull();
    // Where the desktop places the row among its threads: when its session began, as termag stored it, else the workstream's start.
    expect(pick('p-app|main').createdAt).toBe('2026-10-30T08:00:00.000Z');
    expect(pick('p-app|feature').createdAt).toBe('2026-10-20T08:00:00.000Z');
    // An ask has no worktree of its own: it runs in the checkout (and repository) it asks.
    expect(pick('p-asked|ask-abcdef1234').directory).toBe('/home/ubuntu/termag/projects/svc/.worktrees/fix-ci/api');
    expect(pick('p-asked|ask-1234abcdef').directory).toBe('/home/ubuntu/termag/projects/svc');
    expect(pick('p-app|main')).not.toHaveProperty('checkout');
    expect(pick('p-bob|main')).toMatchObject({ shared: true, boxId: 'box-b', box: null, directory: null, sessionId: 'sess-bob' });
  });

  it('leads with Claude\'s title for the session', async () => {
    expect((await chats.list(alice, { archived: false })).find(r => r.key === 'p-app|main')!.title).toBe('Fix login');
  });

  it('lists the Archived section in its order, one row a chat under its name', async () => {
    listed.archived = [
      { id: 'p-new', archivedAt: new Date('2026-10-30T10:00:00Z') },
      { id: 'p-old', archivedAt: '2026-10-01T10:00:00.000Z' },
    ];
    db.projects = [
      { id: 'p-old', userId: 'alice', name: 'old', instanceId: null, kind: 'normal', workflows: [agent], workstreams: [{ ...ws('w-old', 'main'), _count: { chatTranscripts: 2 } }] },
      { id: 'p-new', userId: 'alice', name: 'new', instanceId: 'box-a', kind: 'normal', workflows: [agent], workstreams: [{ ...ws('w-new', 'main', { sessionTitle: 'Ship it' }), _count: { chatTranscripts: 0 } }] },
    ];
    const rows = await chats.list(alice, { archived: true });
    expect(rows.map(r => [r.key, r.title, r.where, r.archived, r.archivedAt, r.hasTranscript, r.directory])).toEqual([
      ['p-new|main', null, 'new', true, '2026-10-30T10:00:00.000Z', false, '/home/ubuntu/termag/projects/new'],
      ['p-old|main', null, 'old', true, '2026-10-01T10:00:00.000Z', true, null],
    ]);
  });
});

describe('GET /api/cli/v1/projects/:id/chat', () => {
  it('answers web\'s history for the person, with its cap', async () => {
    history.answer = { status: 200, body: { entries: [{ type: 'user' }], stored: true } };
    expect(await chats.history(alice, 'p-app', 'feature')).toEqual({ status: 200, body: { entries: [{ type: 'user' }], stored: true, entriesMax: 600 } });
    expect(history.calls).toEqual([['alice', 'p-app', { workstream: 'feature' }]]);
  });

  it('passes a refusal through as it is', async () => {
    history.answer = { status: 404, body: { error: 'Chat not found' } };
    expect(await chats.history(alice, 'p-x', undefined)).toEqual({ status: 404, body: { error: 'Chat not found' } });
  });
});

describe('the desktop archives, reopens and renames a chat (H2d)', () => {
  it('archives without powering the box, and reopens without starting it', async () => {
    chatActs.calls = [];
    expect((await chats.archive(alice, 'p-app', { workstream: 'main', archived: true })).status).toBe(200);
    expect(await chats.archive(alice, 'p-app', { archived: false })).toEqual({ status: 409, body: { code: 'box-stopped' } });
    expect(chatActs.calls).toEqual([['archive', 'p-app', { powerBox: false }], ['reopen', 'p-app', { startBox: false }]]);
  });

  it("leaves a workstream's chat to termag web, and wants a yes or no", async () => {
    chatActs.calls = [];
    expect((await chats.archive(alice, 'p-app', { workstream: 'feature', archived: true })).body).toMatchObject({ code: 'workstream-chat' });
    expect((await chats.archive(alice, 'p-app', { archived: 'yes' })).status).toBe(400);
    expect(chatActs.calls).toEqual([]);
  });

  it("renames the owner's chat as a person's title, and nothing else", async () => {
    renamed.calls = [];
    expect(await chats.title(alice, 'p-app', { workstream: 'main', title: ' Ship the fix ' }))
      .toEqual({ status: 200, body: { title: 'Ship the fix', titleAt: '2026-11-02T20:00:00.000Z', titleSource: 'person' } });
    expect(renamed.calls[0].slice(0, 2)).toEqual(['p-app', 'w-main']);
    expect((await chats.title(alice, 'p-app', { title: '   ' })).status).toBe(400);
    expect((await chats.title({ ...alice, id: 'bob' }, 'p-app', { title: 'Mine now' })).status).toBe(404);
  });

  it('lists live and archived chats together with archived=all', async () => {
    listed.archived = [{ id: 'p-old', archivedAt: '2026-10-01T10:00:00.000Z' }];
    db.projects = [{ id: 'p-old', userId: 'alice', name: 'old', instanceId: null, kind: 'normal', workflows: [agent], workstreams: [{ ...ws('w-old', 'main'), _count: { chatTranscripts: 0 } }] }];
    const rows = await chats.list(alice, { archived: 'all' });
    expect(rows.filter(r => r.archived).map(r => r.key)).toEqual(['p-old|main']);
    expect(rows.some(r => r.key === 'p-app|main' && !r.archived)).toBe(true);
  });
});

describe("the desktop's live chat: a turn on the chat's runner (desktop-live-chat-enabled)", () => {
  beforeEach(() => { turns.calls = []; turns.owner = 'alice'; liveChatFlag.on = false; });

  it('follows the flag for the person', async () => {
    expect(await chats.liveChatEnabled(alice)).toBe(false);
    liveChatFlag.on = true;
    expect(await chats.liveChatEnabled(alice)).toBe(true);
  });

  it("sends the owner's turn as web's send does, with the full user for the turn's flags", async () => {
    const body = { workstream: 'main', text: 'hi', model: 'opus', effort: 'high' };
    expect(await chats.send(alice, 'p-app', body)).toEqual({ status: 202, body: { queued: 0 } });
    expect(turns.calls).toEqual([
      ['owner?', 'alice', 'p-app'],
      ['send', 'alice', 'p-app', body, expect.objectContaining({ id: 'alice', defaultAgentProvider: 'claude' })],
    ]);
  });

  it("stops the owner's turn as web's interrupt does", async () => {
    expect(await chats.interrupt(alice, 'p-app', { workstream: 'main', scope: 'all' })).toEqual({ status: 200, body: { interrupted: true } });
    expect(turns.calls).toEqual([['owner?', 'alice', 'p-app'], ['interrupt', 'alice', 'p-app', { workstream: 'main', scope: 'all' }]]);
  });

  it("refuses a collaborator and another's project before anything is sent or held", async () => {
    turns.owner = 'bob';
    expect(await chats.send(alice, 'p-app', { text: 'hi' })).toMatchObject({ status: 403, body: { code: 'not-owner' } });
    expect(await chats.interrupt(alice, 'p-app', {})).toMatchObject({ status: 403, body: { code: 'not-owner' } });
    expect((await chats.send(alice, 'p-x', { text: 'hi' })).status).toBe(404);
    expect(turns.calls.filter(c => c[0] !== 'owner?')).toEqual([]);
  });

  it('reads a body that is not an object as an empty one', async () => {
    await chats.send(alice, 'p-app', ['hi']);
    await chats.interrupt(alice, 'p-app', null);
    expect(turns.calls.filter(c => c[0] !== 'owner?').map(c => c[3])).toEqual([{}, {}]);
  });
});
