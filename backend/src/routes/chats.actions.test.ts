import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The redesigned sidebar's card actions on a chat (routes/chats.ts): the
 * archive's dry run, which decides exactly as the archive does, and a person's rename of a session.
 * Both behind user-projects-enabled.
 */

const state = vi.hoisted(() => ({ on: true, otherProjects: 0, archived: false, status: 'ready', kind: 'ec2', box: true, ws: true as boolean }));

const chat = () => ({
  id: 'p1', userId: 'u1', archived: state.archived,
  instance: state.box ? { id: 'b1', userId: 'u1', name: 'olive', kind: state.kind, status: state.status, hibernationConfigured: true } : null,
  workstreams: [{ id: 'w1', name: 'main' }],
  workflows: [{ type: 'agent', provider: 'claude-chat', workstream: { id: 'w1', name: 'main' } }],
});

const prisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn(), count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn(async () => []) },
  workstream: { findFirst: vi.fn() },
}));

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), sendForProject: vi.fn() }));
vi.mock('../services/agentRuntime', () => ({ ensureAgentSessionsAndLaunch: vi.fn() }));
vi.mock('../services/boxProvisioner', () => ({ isBoxProvisioningConfigured: () => true }));
vi.mock('../services/chatRevoke', () => ({ revokeChats: vi.fn(async () => null) }));
vi.mock('../services/chatTranscriptSync', () => ({ projectsWithStoredHistory: vi.fn(async () => new Set()) }));
vi.mock('../services/userProjects', () => ({ userProjectsEnabled: vi.fn(async () => state.on) }));
const renamed = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../services/chatRunner', () => ({
  renameSessionFor: vi.fn(async (...args: unknown[]) => {
    renamed.calls.push(args);
    return typeof args[2] === 'string' && args[2].trim() ? { title: args[2].trim(), titleAt: '2026-11-14T01:00:00.000Z' } : null;
  }),
}));
const recordSessionTitle = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/sessionTitleEvent', () => ({ recordSessionTitle }));
const notifyWorkspaceChange = vi.hoisted(() => vi.fn());
vi.mock('../services/workspaceEvents', () => ({ notifyWorkspaceChange }));
const powerOwnedBox = vi.fn(async () => ({ status: 202, body: { ok: true, status: 'stopping' } }));
const guard = vi.hoisted(() => ({ refuses: false }));
vi.mock('./instances', () => ({
  powerOwnedBox, terminateOwnedBox: vi.fn(),
  cloudSessionStopRefusal: vi.fn(async () => (guard.refuses ? { busy: { status: 409, code: 'box_busy' }, live: 1 } : null)),
}));
vi.mock('./projects', () => ({ archiveOwnedProject: vi.fn(async () => ({ status: 200, body: {} })), ensureDataSessions: vi.fn() }));

const { archiveChatFor, archivedChatsFor, archivePlanFor, renameChatFor, CHAT_ACTIONS_DISABLED } = await import('./chats');

const user = { id: 'u1', unixUsername: 'alice' } as unknown as Express.User;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { on: true, otherProjects: 0, archived: false, status: 'ready', kind: 'ec2', box: true, ws: true });
  guard.refuses = false;
  prisma.project.findFirst.mockImplementation(async () => chat());
  prisma.project.count.mockImplementation(async () => state.otherProjects);
  prisma.workstream.findFirst.mockImplementation(async () => (state.ws ? { id: 'w1' } : null));
  renamed.calls = [];
});

describe('archivePlanFor (the archive dry run)', () => {
  it('says the box stops when nothing else lives on it, naming it, and powers nothing', async () => {
    expect(await archivePlanFor(user, 'p1')).toEqual({ status: 200, body: { box: { action: 'stop', id: 'b1', name: 'olive' } } });
    expect(powerOwnedBox).not.toHaveBeenCalled();
    // Every other live project on the box counts, as the archive counts them.
    expect(prisma.project.count).toHaveBeenCalledWith({ where: { instanceId: 'b1', archived: false, id: { not: 'p1' } } });
  });

  it("says why it doesn't, in the archive's own words", async () => {
    state.otherProjects = 2;
    expect(await archivePlanFor(user, 'p1')).toEqual({ status: 200, body: { box: { action: null, reason: 'other projects still use this box' } } });
    state.otherProjects = 0;
    state.status = 'stopped';
    expect(await archivePlanFor(user, 'p1')).toEqual({ status: 200, body: { box: { action: null, reason: 'the box is already stopped' } } });
    state.status = 'ready';
    state.kind = 'host';
    expect((await archivePlanFor(user, 'p1')).body).toEqual({ box: { action: null, reason: 'a self-managed host is not powered from termag' } });
    state.box = false;
    expect((await archivePlanFor(user, 'p1')).body).toEqual({ box: { action: null, reason: 'the chat has no box' } });
  });

  it("doesn't promise a stop the box's cloud-session guard would refuse", async () => {
    guard.refuses = true;
    expect(await archivePlanFor(user, 'p1')).toEqual({
      status: 200, body: { box: { action: null, reason: 'a Claude Code cloud session still runs on this box' } },
    });
  });

  it('agrees with the archive, whatever the box', async () => {
    for (const [status, others] of [['ready', 0], ['ready', 1], ['starting', 0], ['hibernated', 0], ['terminated', 0]] as const) {
      Object.assign(state, { status, otherProjects: others, archived: false });
      const plan = (await archivePlanFor(user, 'p1')).body as { box: { action: string | null } };
      const done = (await archiveChatFor(user, 'p1')).body as { box: { action: string | null } };
      expect([status, others, plan.box.action]).toEqual([status, others, done.box.action]);
    }
  });

  it("is the owner's only, and not for a chat already archived", async () => {
    prisma.project.findFirst.mockImplementation(async () => null);
    expect((await archivePlanFor(user, 'p1')).status).toBe(404);
    prisma.project.findFirst.mockImplementation(async () => chat());
    state.archived = true;
    expect((await archivePlanFor(user, 'p1')).status).toBe(409);
  });

  it('answers 404 chat_actions_disabled with the flag off', async () => {
    state.on = false;
    expect(await archivePlanFor(user, 'p1')).toMatchObject({ status: 404, body: { code: CHAT_ACTIONS_DISABLED } });
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });
});

describe('renameChatFor', () => {
  it("names one of the owner's sessions as a person's title, and tells their other tabs", async () => {
    expect(await renameChatFor(user, 'p1', { workstream: 'regex', title: ' Ship the fix ' }))
      .toEqual({ status: 200, body: { title: 'Ship the fix', titleAt: '2026-11-14T01:00:00.000Z', titleSource: 'person' } });
    expect(prisma.workstream.findFirst).toHaveBeenCalledWith({
      where: { name: 'regex', archived: false, project: { id: 'p1', userId: 'u1' } }, select: { id: true },
    });
    expect(renamed.calls).toEqual([['p1', 'w1', ' Ship the fix ']]);
    expect(recordSessionTitle).toHaveBeenCalledWith({ projectId: 'p1', workstream: 'regex', title: 'Ship the fix', source: 'person' });
    expect(notifyWorkspaceChange).toHaveBeenCalledWith('u1', 'projects');
  });

  it('renames main when no session is named', async () => {
    await renameChatFor(user, 'p1', { title: 'Main thing' });
    expect(prisma.workstream.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ name: 'main' }) }));
  });

  it('refuses an empty title, and a session that is not theirs', async () => {
    expect(await renameChatFor(user, 'p1', { title: '   ' })).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    expect(notifyWorkspaceChange).not.toHaveBeenCalled();
    state.ws = false;
    expect((await renameChatFor(user, 'p1', { title: 'Mine now' })).status).toBe(404);
    expect(renamed.calls).toHaveLength(1);
  });

  it('answers 404 chat_actions_disabled with the flag off', async () => {
    state.on = false;
    expect(await renameChatFor(user, 'p1', { title: 'x' })).toMatchObject({ status: 404, body: { code: CHAT_ACTIONS_DISABLED } });
    expect(prisma.workstream.findFirst).not.toHaveBeenCalled();
  });
});

describe('archivedChatsFor', () => {
  it("carries each chat's main session title and what its agent ran on, for the card", async () => {
    prisma.project.findMany.mockImplementation(async () => [{
      id: 'p1', name: 'termag-3', repoUrl: 'https://github.com/example-org/termag', updatedAt: new Date('2026-11-10T12:00:00Z'), instance: null,
      // Another session's agent comes first and runs another model: the card is main's, so main's agent decides.
      workflows: [
        { type: 'data', provider: null, backend: null, model: null, workstreamId: 'w-main' },
        { type: 'agent', provider: 'claude-chat', backend: null, model: null, workstreamId: 'w-review' },
        { type: 'agent', provider: 'claude-chat', backend: 'fireworks', model: 'kimi-k3', workstreamId: 'w-main' },
      ],
      workstreams: [{ id: 'w-main', sessionTitle: 'Clean up the old chat chrome', sessionTitleSource: 'claude' }],
    }]);
    const body = (await archivedChatsFor(user)).body as Array<Record<string, unknown>>;
    expect(body).toEqual([expect.objectContaining({
      id: 'p1', name: 'termag-3', sessionTitle: 'Clean up the old chat chrome', sessionTitleSource: 'claude',
      agent: { provider: 'claude-chat', backend: 'fireworks', model: 'kimi-k3' },
    })]);
    expect(prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ workstreams: { where: { name: 'main' }, select: { id: true, sessionTitle: true, sessionTitleSource: true } } }),
    }));
  });
});
