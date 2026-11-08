import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => {
  const p = {
    project: { findUnique: vi.fn(), findMany: vi.fn() },
    projectShare: { findUnique: vi.fn() },
    projectRepo: { findMany: vi.fn(async () => []) },
    agentMessage: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    agentBundle: { deleteMany: vi.fn(async () => ({ count: 0 })), findUnique: vi.fn() },
    agentThreadPr: { findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({})), count: vi.fn(async () => 1) },
    agentThread: { findUnique: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    instance: { findMany: vi.fn(async () => []), findUnique: vi.fn() },
    workstream: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() },
    // The thread chat's agent row: its stored model (askChat.ts askTurnTier).
    workflow: { findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn(async () => ({ claudeGatewayEnabled: false })) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(),
  };
  p.$transaction.mockImplementation(async (fn: (tx: typeof p) => unknown) => fn(p));
  return p;
});
vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({
  instanceAgentSettled: vi.fn(() => true),
  instanceAgentTransport: vi.fn(() => ({ capabilities: ['ask-v1', 'ask-cancel-v1'], helloReceived: true, conn: { kind: 'owned-box' } })),
  onBoxAgentHello: vi.fn(() => () => {}),
  sendToInstanceAgent: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./tmux', () => ({
  projectDirFor: vi.fn(() => '/home/ada/termag/projects/api'),
  sessionName: vi.fn((u: string, p: string, r: string) => `${u}-${p}-${r}`),
}));
vi.mock('./boxLifecycle', () => ({ registerBoxBusyCheck: vi.fn() }));
vi.mock('./productEvents', () => ({ recordProductEvent: vi.fn() }));
// The thread's chat belongs to a space, fixed at its first use (services/chatSpace.ts).
vi.mock('./chatSpace', () => ({ turnMemorySpace: vi.fn(async (wsId: string) => (wsId === 'ws-ask' ? 'design' : undefined)) }));
vi.mock('./boxPower', () => ({ PowerRequestConflict: class extends Error {}, requestPower: vi.fn() }));
vi.mock('./boxEvents', () => ({ openBoxEvent: vi.fn(async () => null), boxesWithOpenEvent: vi.fn(async () => new Set<string>()) }));
vi.mock('./boxProvisioner', () => ({ isBoxProvisioningConfigured: vi.fn(() => true) }));
vi.mock('./credentialStore', () => ({ githubTokenSource: vi.fn(async () => null) }));
vi.mock('./askPublish', () => ({ publishBundle: vi.fn(), publishConfigFromEnv: vi.fn(() => ({})), publishSummary: vi.fn(() => ({ publish: 'published', detail: 'ok' })), resolveTargetPr: vi.fn() }));
vi.mock('./askPushes', async (orig) => ({ ...(await orig<typeof import('./askPushes')>()), confirmPushes: vi.fn(), githubConfigFromEnv: vi.fn(() => ({})) }));
vi.mock('./askReplyListener', () => ({ startReplyListener: vi.fn(), stopReplyListener: vi.fn() }));
// Sharing on for everyone: an ask must stay owner-only whatever a flag says.
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => true), stringVariation: vi.fn(async () => ''), isLdEnabled: vi.fn(() => true) }));
// A pane's session resolves to its project and workstream (services/sessionResolver.ts); the role stays in the name.
vi.mock('./sessionResolver', () => ({
  isAmbiguousSession: vi.fn(() => false),
  resolveSessionProject: vi.fn(async (session: string) => (session.startsWith('ada-orch-')
    ? { userId: 'u-ada', instanceId: 'box1', projectId: 'p-orch', workstream: 'main' } : null)),
}));
vi.mock('./boxSharingFlag', () => ({ boxSharingEnabled: vi.fn(async () => true), BOX_SHARING_FLAG: 'box-sharing-enabled', SHARING_DISABLED_CODE: 'sharing_disabled' }));

import { prismaCliAsk, tickQueue } from './askService';
import { instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import { publishBundle, resolveTargetPr } from './askPublish';
import { githubTokenSource } from './credentialStore';
import { confirmPushes } from './askPushes';
import { boolVariation } from './featureFlags';
import { recordProductEvent } from './productEvents';
import { requestPower } from './boxPower';
import { boxesWithOpenEvent, openBoxEvent } from './boxEvents';
import { MAX_ACTIVE_ASKS, type AskRequest } from './agentMessages';
import type { CliUser } from './cliStore';

const ada = { id: 'u-ada', unixUsername: 'ada', displayName: 'Ada', googleEmail: 'ada@example.com' } as CliUser;

function projectRow(over: { userId?: string; boxOwner?: string | null; instance?: null; repos?: string[]; boxFor?: string; environmentId?: string; chatTrustedAt?: Date | null } = {}) {
  const userId = over.userId ?? 'u-ada';
  return {
    id: 'p1', name: over.repos ? 'shop' : 'api', userId, archived: false, instanceId: over.instance === null ? null : 'box1',
    setupStatus: 'ready', setupError: null, environmentId: over.environmentId ?? null, chatTrustedAt: over.chatTrustedAt ?? null,
    layout: over.repos ? 'workspace' : 'repo', repos: (over.repos ?? []).map(name => ({ name })),
    user: { id: userId, unixUsername: userId === 'u-ada' ? 'ada' : 'bob' },
    workstreams: [{ name: 'main' }],
    instance: over.instance === null ? null : {
      id: 'box1', name: 'devbox', hostHome: '/home/ada', status: 'ready', kind: 'ec2',
      userId: over.boxOwner === undefined ? userId : over.boxOwner, createdFor: over.boxFor ?? null,
    },
  };
}

const req = (over: Partial<AskRequest> = {}): AskRequest => ({
  ref: null, projectId: 'p1', workstream: 'main', repo: null, prompt: 'what does this do?', threadId: null, messageId: null, title: null, sender: null, senderClaudeSession: null, targetPr: null, newBox: false, notify: true, model: null, ...over,
});

function setup(project: ReturnType<typeof projectRow>, active = 0) {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  prisma.project.findUnique.mockResolvedValue(project);
  prisma.projectShare.findUnique.mockResolvedValue(project.userId === 'u-ada' ? null : { id: 's1', projectId: 'p1', userId: 'u-ada' });
  prisma.agentMessage.findUnique.mockResolvedValue(null);
  prisma.agentMessage.count.mockResolvedValue(active);
  prisma.agentThread.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'thr0000000001', projectId: 'p1', chatWorkstreamId: null, hopCount: 1, claudeSessionId: null, baseSha: null, repoName: null, ...data,
  }));
  prisma.workstream.findFirst.mockResolvedValue(null);
  prisma.workstream.create.mockResolvedValue({ id: 'ws-ask', name: 'ask-thr0000000001' });
  prisma.agentMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'msg0000000001', ...data }));
  prisma.agentMessage.updateMany.mockResolvedValue({ count: 1 });
}

const askRunCalls = () => vi.mocked(sendToInstanceAgent).mock.calls.filter(c => c[1] === 'ask-run');

describe("prismaCliAsk.ask: a project made from a shared environment", () => {
  it("caps its ask below bypassPermissions: auto on a box that has it, else dontAsk, so the checkout's config never loads", async () => {
    // Auto only once the owner trusted the project (Security Agent, #998); untrusted, dontAsk even where auto is there.
    setup(projectRow({ environmentId: 'e1', chatTrustedAt: new Date() }));
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1', 'ask-mode-cap-v1', 'chat-auto-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    await prismaCliAsk.ask(ada, null, req());
    expect(askRunCalls()[0][2]).toMatchObject({ permissionMode: 'auto' });
    setup(projectRow({ environmentId: 'e1', chatTrustedAt: null }));
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1', 'ask-mode-cap-v1', 'chat-auto-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    await prismaCliAsk.ask(ada, null, req());
    expect(askRunCalls()[0][2]).toMatchObject({ permissionMode: 'dontAsk' });
    setup(projectRow({ environmentId: 'e1' }));
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1', 'ask-mode-cap-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    await prismaCliAsk.ask(ada, null, req());
    expect(askRunCalls()[0][2]).toMatchObject({ permissionMode: 'dontAsk' });
  });

  it("refuses it, sending nothing, on a box whose agent can't cap it (no ask-mode-cap-v1): an older agent would run it as bypassPermissions", async () => {
    setup(projectRow({ environmentId: 'e1' }));
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1', 'chat-auto-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    const r = await prismaCliAsk.ask(ada, null, req());
    expect(askRunCalls()).toHaveLength(0);
    // A refusal, not a box error: refused before the message is made, as the ask chat's 409 is (Bugbot, #985).
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'ask-mode-cap', error: expect.stringContaining("can't keep it from loading") });
    expect(prisma.agentMessage.create).not.toHaveBeenCalled();
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
  });

  it('leaves any other project at the ask\'s own mode', async () => {
    setup(projectRow());
    await prismaCliAsk.ask(ada, null, req());
    expect(askRunCalls()[0][2]).not.toHaveProperty('permissionMode');
  });
});

describe('prismaCliAsk.ask: owner-only', () => {
  beforeEach(() => setup(projectRow()));

  it('runs an ask on the asker\'s own project on their own box', async () => {
    const r = await prismaCliAsk.ask(ada, null, req());
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'working', target: 'devbox/api' });
    expect(askRunCalls()).toHaveLength(1);
    const job = askRunCalls()[0][2] as { systemPrompt: string };
    expect(job.systemPrompt).toContain('as the box owner');
  });

  it('records one ask.sent for the message, by its sender', async () => {
    await prismaCliAsk.ask(ada, null, req());
    expect(recordProductEvent).toHaveBeenCalledTimes(1);
    expect(recordProductEvent).toHaveBeenCalledWith('ask.sent', { user: 'u-ada', box: 'box1' }, {
      thread: 'thr0000000001', hop: 1, followUp: false, via: 'cli', queued: false,
    });
  });

  it('records no ask.sent for an ask the cap refuses', async () => {
    setup(projectRow(), MAX_ACTIVE_ASKS);
    const r = await prismaCliAsk.ask(ada, null, req());
    expect(r.status).toBe(409);
    expect(recordProductEvent).not.toHaveBeenCalled();
  });

  it('refuses a project shared with the asker, with sharing switched on', async () => {
    setup(projectRow({ userId: 'u-bob' }));
    const r = await prismaCliAsk.ask(ada, null, req());
    expect(r).toEqual({ status: 403, body: { error: expect.stringContaining('api is not your project'), code: 'not_owner' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(askRunCalls()).toHaveLength(0);
  });

  it("refuses the asker's own project on somebody else's box", async () => {
    setup(projectRow({ boxOwner: 'u-bob' }));
    const r = await prismaCliAsk.ask(ada, null, req());
    expect(r).toMatchObject({ status: 403, body: { code: 'not_owner', error: expect.stringContaining('devbox is not your box') } });
    expect(askRunCalls()).toHaveLength(0);
  });

  it('refuses a shared project before a retried message id can replay it', async () => {
    setup(projectRow({ userId: 'u-bob' }));
    const r = await prismaCliAsk.ask(ada, null, req({ messageId: 'msg0000000001' }));
    expect(r.status).toBe(403);
    expect(prisma.agentMessage.findUnique).not.toHaveBeenCalled();
  });

  it('lists only own projects on own boxes as targets', async () => {
    prisma.project.findMany.mockResolvedValue([]);
    await prismaCliAsk.targets(ada);
    const where = prisma.project.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: 'u-ada', instance: { userId: 'u-ada' } });
    expect(where).not.toHaveProperty('OR');
  });

  it("gives each target its session's title, and lists the caller's own threads that have a chat", async () => {
    prisma.project.findMany.mockResolvedValue([{ ...projectRow(), description: 'API', workstreams: [{ name: 'main', sessionTitle: null }, { name: 'fix', sessionTitle: ' Fix login redirect ' }] }]);
    prisma.agentThread.findMany.mockResolvedValue([{
      id: 'thr0000000001', title: 'Members-only composer (#765)', workstream: 'fix', repoName: null, updatedAt: new Date('2026-10-28T12:00:00Z'),
      chatWorkstream: { sessionTitle: 'Gate the composer' }, project: { name: 'api', instance: { name: 'devbox' } },
    }]);
    const body = (await prismaCliAsk.targets(ada)).body as {
      agents: Array<{ name: string; capabilities: { extensions: Array<{ params: { sessionTitle: string | null } }> } }>;
      threads: unknown[];
    };
    expect(body.agents.map(a => [a.name, a.capabilities.extensions[0].params.sessionTitle])).toEqual([['devbox/api', null], ['devbox/api@fix', 'Fix login redirect']]);
    expect(body.threads).toEqual([{
      thread: 'thr0000000001', title: 'Members-only composer (#765)', sessionTitle: 'Gate the composer', target: 'devbox/api@fix', updatedAt: '2026-10-28T12:00:00.000Z',
    }]);
    // Owner-only like the cards: the caller's own threads, on their own projects on their own boxes, with a chat still open.
    expect(prisma.agentThread.findMany.mock.calls[0][0].where).toEqual({
      originUserId: 'u-ada', chatWorkstream: { archived: false }, project: { archived: false, userId: 'u-ada', instance: { userId: 'u-ada' } },
    });
  });
});

describe('prismaCliAsk.ask: a multi-repo project, one repository at a time', () => {
  beforeEach(() => setup(projectRow({ repos: ['shop-web', 'shop-api'] })));
  const multiRepoFlag = (on: boolean) => vi.mocked(boolVariation).mockImplementation(async (key: string) => key === 'multi-repo-projects-enabled' ? on : true);
  afterEach(() => vi.mocked(boolVariation).mockImplementation(async () => true));

  it('runs in the named repository\'s checkout, and the thread keeps it', async () => {
    const r = await prismaCliAsk.ask(ada, null, req({ repo: 'shop-api' }));
    expect(r).toMatchObject({ status: 202, body: { status: 'working', target: 'devbox/shop:shop-api' } });
    expect(prisma.agentThread.create.mock.calls[0][0].data).toMatchObject({ repoName: 'shop-api', workstream: 'main' });
    expect(askRunCalls()[0][2]).toMatchObject({ cwd: '/home/ada/termag/projects/api/shop-api' });
  });

  it('refuses a bare ask, listing the repositories, and starts nothing', async () => {
    setup({ ...projectRow({ repos: ['shop-web', 'shop-api'] }), workstreams: [{ name: 'main' }, { name: 'fix' }] });
    const r = await prismaCliAsk.ask(ada, null, req({ workstream: 'fix' }));
    expect(r).toMatchObject({
      status: 409,
      body: {
        status: 'rejected', code: 'repo_required', repos: ['shop-web', 'shop-api'],
        error: 'devbox/shop@fix holds several repositories (shop-web, shop-api); name one, as devbox/shop@fix:<repo>',
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(askRunCalls()).toHaveLength(0);
  });

  it('refuses a repository the project does not hold', async () => {
    const r = await prismaCliAsk.ask(ada, null, req({ repo: 'shop-db' }));
    expect(r).toMatchObject({ status: 409, body: { code: 'unknown_repo', repos: ['shop-web', 'shop-api'] } });
    expect(askRunCalls()).toHaveLength(0);
  });

  it('refuses every ask into it with multi-repo-projects-enabled off', async () => {
    multiRepoFlag(false);
    for (const repo of [null, 'shop-web']) {
      const r = await prismaCliAsk.ask(ada, null, req({ repo }));
      expect(r).toMatchObject({ status: 409, body: { code: 'multi_repo_disabled', status: 'rejected' } });
    }
    expect(askRunCalls()).toHaveLength(0);
  });

  it('refuses a repository on a single-repository project, flag or not', async () => {
    for (const on of [true, false]) {
      setup(projectRow());
      multiRepoFlag(on);
      const r = await prismaCliAsk.ask(ada, null, req({ repo: 'web' }));
      expect(r).toMatchObject({ status: 409, body: { code: 'not_multi_repo', error: 'devbox/api has one repository, so it takes no ":web"; ask devbox/api' } });
    }
    expect(askRunCalls()).toHaveLength(0);
  });

  // `termag ask --new-box --from a --from b box/shop:<repo>`: asked before every clone is ready.
  describe('a new one still being set up', () => {
    const cloning = () => {
      setup({ ...projectRow({ repos: [] }), name: 'shop', layout: 'workspace', setupStatus: 'cloning' });
      prisma.projectRepo.findMany.mockResolvedValue([
        { name: 'shop-web', setupStatus: 'ready' }, { name: 'shop-api', setupStatus: 'cloning' },
      ] as never);
    };

    it('holds an ask into a repository it was created with until the clone is done', async () => {
      cloning();
      const r = await prismaCliAsk.ask(ada, null, req({ repo: 'shop-api' }));
      expect(r).toMatchObject({ status: 202, body: { queued: true, queuedFor: 'setup', target: 'devbox/shop:shop-api' } });
      expect(prisma.agentThread.create.mock.calls[0][0].data).toMatchObject({ repoName: 'shop-api' });
      expect(prisma.projectRepo.findMany.mock.calls[0][0]).toMatchObject({ where: { projectId: 'p1' }, orderBy: { position: 'asc' } });
      expect(askRunCalls()).toHaveLength(0);
    });

    it('lists every repository it was created with, in order, for a bare ask or one it does not hold', async () => {
      cloning();
      expect(await prismaCliAsk.ask(ada, null, req())).toMatchObject({ status: 409, body: { code: 'repo_required', repos: ['shop-web', 'shop-api'] } });
      cloning();
      expect(await prismaCliAsk.ask(ada, null, req({ repo: 'shop-db' }))).toMatchObject({
        status: 409, body: { code: 'unknown_repo', repos: ['shop-web', 'shop-api'], error: 'devbox/shop has no repository shop-db; it holds shop-web, shop-api' },
      });
    });
  });

  it('refuses a follow-up that names another repository than its thread', async () => {
    prisma.agentThread.findUnique.mockResolvedValue({ id: 'thr0000000001', originUserId: 'u-ada', projectId: 'p1', workstream: 'main', repoName: 'shop-web', hopCount: 1 });
    const r = await prismaCliAsk.ask(ada, null, req({ repo: 'shop-api', threadId: 'thr0000000001' }));
    expect(r).toMatchObject({ status: 409, body: { code: 'thread_mismatch' } });
    expect(askRunCalls()).toHaveLength(0);
  });

  it('lists a card per workstream and repository, or one refused card with the flag off', async () => {
    const row = { ...projectRow({ repos: ['shop-web', 'shop-api'] }), description: 'Shop', workstreams: [{ name: 'main' }, { name: 'fix' }] };
    prisma.project.findMany.mockResolvedValue([row, { ...projectRow(), id: 'p2', description: 'API' }]);
    const names = async () => ((await prismaCliAsk.targets(ada)).body as { agents: Array<{ name: string; capabilities: { extensions: Array<{ params: { askable: boolean; reason: string | null } }> } }> }).agents
      .map(a => `${a.name} ${a.capabilities.extensions[0].params.askable}`);
    expect(await names()).toEqual([
      'devbox/shop:shop-web true', 'devbox/shop:shop-api true', 'devbox/shop@fix:shop-web true', 'devbox/shop@fix:shop-api true', 'devbox/api true',
    ]);
    multiRepoFlag(false);
    expect(await names()).toEqual(['devbox/shop false', 'devbox/shop@fix false', 'devbox/api true']);
  });
});

describe('prismaCliAsk.ask: the run as a chat', () => {
  beforeEach(() => setup(projectRow()));

  it('runs headless on a box without ask-chat-v1', async () => {
    await prismaCliAsk.ask(ada, null, req());
    expect(askRunCalls()[0][2]).not.toHaveProperty('chat');
    expect(prisma.workstream.create).not.toHaveBeenCalled();
  });

  it('gives the thread a chat workstream and names it in ask-run on a box with ask-chat-v1', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1', 'ask-chat-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    const r = await prismaCliAsk.ask(ada, null, req());
    expect(r.status).toBe(202);
    expect(prisma.workstream.create.mock.calls[0][0].data).toMatchObject({
      projectId: 'p1', name: 'ask-thr0000000001', workflows: { create: { type: 'agent', provider: 'claude-chat' } },
    });
    expect(prisma.agentThread.update).toHaveBeenCalledWith({ where: { id: 'thr0000000001' }, data: { chatWorkstreamId: 'ws-ask' } });
    expect(askRunCalls()[0][2]).toMatchObject({
      chat: { chatKey: 'p1--ws-ask', projectId: 'p1', workstream: 'ask-thr0000000001', workstreamId: 'ws-ask' },
    });
    vi.mocked(instanceAgentTransport).mockReset();
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
  });

  it('records a box ask --new-box made for the thread, only when the box says it was made for an ask', async () => {
    setup(projectRow({ boxFor: 'ask' }));
    await prismaCliAsk.ask(ada, null, req({ newBox: true }));
    expect(prisma.agentThread.create.mock.calls[0][0].data).toMatchObject({ newBox: true });
    setup(projectRow());
    await prismaCliAsk.ask(ada, null, req({ newBox: true }));
    expect(prisma.agentThread.create.mock.calls[0][0].data).not.toHaveProperty('newBox');
    setup(projectRow({ boxFor: 'ask' }));
    await prismaCliAsk.ask(ada, null, req());
    expect(prisma.agentThread.create.mock.calls[0][0].data).not.toHaveProperty('newBox');
  });

  it('names the thread chat\'s own space in ask-run for an agent with space-memory-v1, as its UI turns do (Bugbot, #769)', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1', 'ask-chat-v1', 'space-memory-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    await prismaCliAsk.ask(ada, null, req());
    expect(askRunCalls()[0][2]).toMatchObject({ chat: { workstreamId: 'ws-ask' }, spaceMemory: { space: 'design' } });
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1', 'ask-chat-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    await prismaCliAsk.ask(ada, null, req());
    expect(askRunCalls().at(-1)![2]).not.toHaveProperty('spaceMemory');
    vi.mocked(instanceAgentTransport).mockReset();
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
  });

  it('stores the title the caller gave, and none from the prompt', async () => {
    await prismaCliAsk.ask(ada, null, req({ prompt: '# A heading\n\nThe ask', title: null }));
    expect(prisma.agentThread.create.mock.calls[0][0].data.title).toBeNull();
    setup(projectRow());
    await prismaCliAsk.ask(ada, null, req({ title: 'Members-only file composer (#765)' }));
    expect(prisma.agentThread.create.mock.calls[0][0].data.title).toBe('Members-only file composer (#765)');
  });

  it('refuses an ask to an ask\'s own conversation', async () => {
    setup({ ...projectRow(), workstreams: [{ name: 'main' }, { name: 'ask-thr0000000001' }] });
    prisma.workstream.findFirst.mockResolvedValue({ id: 'ws-ask' });
    const r = await prismaCliAsk.ask(ada, null, req({ workstream: 'ask-thr0000000001' }));
    expect(r.status).toBe(409);
    expect(askRunCalls()).toHaveLength(0);
  });
});

describe('prismaCliAsk.ask: the active-ask cap', () => {
  it('refuses past the cap, under the per-person lock', async () => {
    setup(projectRow(), MAX_ACTIVE_ASKS);
    const r = await prismaCliAsk.ask(ada, null, req());
    expect(r).toMatchObject({ status: 409, body: { code: 'too_many_asks', status: 'rejected' } });
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.agentMessage.count.mock.calls[0][0].where).toMatchObject({ senderUserId: 'u-ada' });
    expect(prisma.agentMessage.count).toHaveBeenCalledTimes(1);
    expect(prisma.agentMessage.create).not.toHaveBeenCalled();
    expect(askRunCalls()).toHaveLength(0);
  });

  it('runs the last ask under the cap, whatever box or caller it comes from', async () => {
    setup(projectRow(), MAX_ACTIVE_ASKS - 1);
    expect((await prismaCliAsk.ask(ada, 'box1', req())).status).toBe(202);
  });
});

describe('prismaCliAsk.ask: steering a follow-up into a working turn', () => {
  const STEER_CAPS = ['ask-v1', 'ask-cancel-v1', 'ask-chat-v1', 'ask-steer-v1'];
  const busyA = { id: 'msga00000001', instanceId: 'box1', status: 'working', createdAt: new Date(0), queuedUntil: null, queuedPrompt: null };
  let answer: Record<string, unknown>;

  function steerSetup(caps = STEER_CAPS, busy: Record<string, unknown> = busyA) {
    setup(projectRow());
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: caps, helloReceived: true, conn: { kind: 'owned-box' } } as never);
    prisma.agentThread.findUnique.mockResolvedValue({
      id: 'thr0000000001', originUserId: 'u-ada', projectId: 'p1', workstream: 'main', instanceId: 'box1',
      hopCount: 1, chatWorkstreamId: 'ws-ask', claudeSessionId: null, baseSha: null,
    });
    prisma.agentThread.updateMany.mockResolvedValue({ count: 1 });
    prisma.workstream.findUnique.mockResolvedValue({ id: 'ws-ask', name: 'ask-thr0000000001' });
    prisma.agentMessage.findFirst.mockResolvedValue(busy);
    answer = { ok: true, started: true, steered: true };
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_box, type) => {
      // A live chat turn (agent/ask-chat.js status), the only kind a follow-up can join.
      if (type === 'ask-run-status') return { running: true, known: true, stage: 'sent', mode: 'chat', live: true };
      if (type === 'ask-run') return answer;
      return { ok: true };
    });
  }
  const follow = () => req({ threadId: 'thr0000000001', messageId: 'msgb00000001' });
  const supersedes = () => prisma.agentMessage.updateMany.mock.calls.filter(c => c[0].data?.status === 'superseded');

  beforeEach(() => steerSetup());

  it('a follow-up with --title names or renames the thread; without one it keeps the name', async () => {
    const r = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', messageId: 'msgb00000001', title: 'Members-only file composer (#765)' }));
    expect(r).toMatchObject({ status: 202, body: { title: 'Members-only file composer (#765)' } });
    expect(prisma.agentThread.update).toHaveBeenCalledWith({ where: { id: 'thr0000000001' }, data: { title: 'Members-only file composer (#765)' } });
    steerSetup();
    await prismaCliAsk.ask(ada, null, follow());
    expect(prisma.agentThread.update.mock.calls.filter(c => 'title' in (c[0].data ?? {}))).toEqual([]);
  });

  it('sends the follow-up into the newest working turn and supersedes that message', async () => {
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r).toMatchObject({ status: 202, body: { message: 'msgb00000001', status: 'working', steered: true, supersedes: 'msga00000001' } });
    expect(prisma.agentMessage.findFirst.mock.calls[0][0]).toMatchObject({ where: { threadId: 'thr0000000001' }, orderBy: { createdAt: 'desc' } });
    expect(askRunCalls()[0][2]).toMatchObject({ runId: 'msgb00000001', steerOf: 'msga00000001', live: true, chat: { chatKey: 'p1--ws-ask' } });
    expect(supersedes()).toEqual([[{
      where: { id: 'msga00000001', status: 'working', resultAt: null },
      data: expect.objectContaining({ status: 'superseded', supersededById: 'msgb00000001' }),
    }]]);
  });

  // At most one turn ever runs in a thread's clone: whatever stops a steer, the follow-up waits at the orchestrator.
  const queuedAsNextTurn = (id = 'msgb00000001') => prisma.agentMessage.updateMany.mock.calls.filter(c => c[0].where?.id === id && typeof c[0].data?.queuedPrompt === 'string');
  const markedWorking = (id = 'msgb00000001') => prisma.agentMessage.updateMany.mock.calls.filter(c => c[0].where?.id === id && c[0].data?.status === 'working');

  it('holds a follow-up the box\'s turn refused as the thread\'s next turn; the box starts nothing', async () => {
    answer = { ok: true, started: false, steered: false, reason: 'finished' };
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r).toMatchObject({ status: 202, body: { status: 'submitted', queued: true, queuedFor: 'turn', steered: false, queuedBehind: 'msga00000001', steerRefused: 'its turn had just ended' } });
    expect(supersedes()).toEqual([]);
    expect(markedWorking()).toEqual([]);
    expect(queuedAsNextTurn()).toHaveLength(1);
    expect(queuedAsNextTurn()[0][0].data.queuedPrompt).toBe('what does this do?');
    // The launch decision recorded before the send is put back to what it asked for: its own start decides again.
    const modelWrites = prisma.agentMessage.updateMany.mock.calls.map(c => c[0].data).filter(d => d && 'modelIgnored' in d && !('status' in d));
    expect(modelWrites.at(-1)).toEqual({ model: null, modelIgnored: null });
  });

  it('never steers into a turn that runs headless, even on a box that now announces ask-steer-v1', async () => {
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_box, type) => (type === 'ask-run-status' ? { running: true, known: true } : { ok: true }));
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r).toMatchObject({ status: 202, body: { queuedFor: 'turn', queuedBehind: 'msga00000001', steerRefused: expect.stringContaining('not a live chat turn') } });
    expect(askRunCalls()).toHaveLength(0);
  });

  it('never sends a follow-up headless beside a working turn when the thread\'s chat cannot be set up', async () => {
    prisma.workstream.findUnique.mockRejectedValue(new Error('db down'));
    prisma.workstream.create.mockRejectedValue(new Error('db down'));
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r).toMatchObject({ status: 202, body: { status: 'submitted', queuedFor: 'turn', queuedBehind: 'msga00000001' } });
    expect(askRunCalls()).toHaveLength(0);
    expect(queuedAsNextTurn()).toHaveLength(1);
  });

  it('queues a follow-up whose steer answer was lost when the box does not have it, rather than failing it', async () => {
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_box, type, msg) => {
      if (type === 'ask-run') throw new Error('timed out');
      if (type === 'ask-run-status') return (msg as { runId: string }).runId === 'msga00000001' ? { running: true, known: true, mode: 'chat', live: true } : { running: false, known: false };
      return { ok: true };
    });
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r).toMatchObject({ status: 202, body: { queuedFor: 'turn', queuedBehind: 'msga00000001' } });
    expect(prisma.agentMessage.updateMany.mock.calls.filter(c => c[0].data?.status === 'failed')).toEqual([]);
  });

  it('re-reads the thread under the lock: a second follow-up sent at the same time queues behind the first, at the fresh hop', async () => {
    const thread = (hopCount: number) => ({ id: 'thr0000000001', originUserId: 'u-ada', projectId: 'p1', workstream: 'main', instanceId: 'box1', hopCount, chatWorkstreamId: 'ws-ask', claudeSessionId: null, baseSha: null });
    prisma.agentThread.findUnique.mockReset();
    prisma.agentThread.findUnique.mockResolvedValueOnce(thread(1)).mockResolvedValue(thread(2));
    const first = { id: 'msgc00000001', instanceId: 'box1', status: 'submitted', createdAt: new Date(1), queuedUntil: null, queuedPrompt: null };
    prisma.agentMessage.findFirst.mockReset();
    prisma.agentMessage.findFirst.mockResolvedValueOnce(busyA).mockResolvedValue(first);
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r).toMatchObject({ status: 202, body: { status: 'submitted', queuedFor: 'turn', queuedBehind: 'msgc00000001', hop: 3 } });
    expect(prisma.agentThread.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'thr0000000001', hopCount: 2 } });
    expect(prisma.agentMessage.create.mock.calls[0][0].data).toMatchObject({ hop: 3, queuedPrompt: 'what does this do?' });
    expect(askRunCalls()).toHaveLength(0);
  });


  it('queues a follow-up behind another one that landed on an idle thread at the same time', async () => {
    const first = { id: 'msgc00000001', instanceId: 'box1', status: 'submitted', createdAt: new Date(1), queuedUntil: null, queuedPrompt: null };
    prisma.agentMessage.findFirst.mockReset();
    prisma.agentMessage.findFirst.mockResolvedValueOnce(null).mockResolvedValue(first);
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r).toMatchObject({ status: 202, body: { queuedFor: 'turn', queuedBehind: 'msgc00000001' } });
    expect(askRunCalls()).toHaveLength(0);
  });

  it('learns of a steer whose answer was lost from the status of the message it joined', async () => {
    // The box took the steer; its answer timed out on the way back.
    let steered = false;
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_box, type, msg) => {
      if (type === 'ask-run') { steered = true; throw new Error('timed out'); }
      if (type === 'ask-run-status') {
        const runId = (msg as { runId: string }).runId;
        return runId === 'msga00000001' && steered ? { running: false, known: true, stage: 'superseded', supersededBy: 'msgb00000001' } : { running: true, known: true, mode: 'chat', live: true };
      }
      return { ok: true };
    });
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r).toMatchObject({ status: 202, body: { steered: true, supersedes: 'msga00000001' } });
    expect(supersedes()).toHaveLength(1);
  });


  it('queues the follow-up as the thread\'s next turn, saying why, for a box that cannot take it or a turn not started', async () => {
    steerSetup(['ask-v1', 'ask-cancel-v1', 'ask-chat-v1']);
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r).toMatchObject({
      status: 202,
      body: { status: 'submitted', queued: true, queuedFor: 'turn', steered: false, queuedBehind: 'msga00000001', steerRefused: expect.stringContaining('needs a newer termag agent') },
    });
    const data = prisma.agentMessage.create.mock.calls[0][0].data;
    expect(data.queuedPrompt).toBe('what does this do?');
    expect(data.queuedUntil.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
    expect(askRunCalls()).toHaveLength(0);
    steerSetup(STEER_CAPS, { ...busyA, status: 'submitted', queuedPrompt: 'q', queuedUntil: new Date(Date.now() + 60_000) });
    expect(await prismaCliAsk.ask(ada, null, follow())).toMatchObject({ status: 202, body: { queuedFor: 'turn', steerRefused: expect.stringContaining('is itself waiting') } });
  });

  it('lets a follow-up that joins a running turn in at the cap; one queued as a new turn still counts', async () => {
    prisma.agentMessage.count.mockResolvedValue(MAX_ACTIVE_ASKS);
    expect(await prismaCliAsk.ask(ada, null, follow())).toMatchObject({ status: 202, body: { steered: true } });
    steerSetup(['ask-v1', 'ask-cancel-v1', 'ask-chat-v1']);
    prisma.agentMessage.count.mockResolvedValue(MAX_ACTIVE_ASKS);
    expect(await prismaCliAsk.ask(ada, null, follow())).toMatchObject({ status: 409, body: { code: 'too_many_asks' } });
  });

  it('answers a wait on a superseded message with its follow-up\'s state, together; follow answers the pointer', async () => {
    const thread = { id: 'thr0000000001', hopCount: 2, branch: null, prNumber: null, prUrl: null, prs: [], project: { name: 'api', userId: 'u-ada', instance: { name: 'devbox' } } };
    const base = { threadId: 'thr0000000001', senderUserId: 'u-ada', workstream: 'main', instanceId: 'box1', error: null, numTurns: null, publish: null, publishDetail: null, readAt: null, createdAt: new Date(0), startedAt: new Date(0), queuedPrompt: null, thread };
    const rows: Record<string, Record<string, unknown>> = {
      msga00000001: { ...base, id: 'msga00000001', hop: 1, status: 'superseded', supersededById: 'msgb00000001', replyBytes: null, completedAt: new Date(1) },
      msgb00000001: { ...base, id: 'msgb00000001', hop: 2, status: 'working', supersededById: null, replyBytes: null, completedAt: null },
    };
    prisma.agentMessage.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null);
    const r = await prismaCliAsk.getMessage(ada, 'msga00000001', 0);
    expect(r.body).toMatchObject({ message: 'msga00000001', status: 'working', supersededBy: 'msgb00000001', answeredWith: 'msgb00000001' });
    // No transcript key here, so nothing is stored, and the view says so: a CLI must not promise a stored reply.
    expect(r.body).toMatchObject({ replyStored: false, replyKept: false });
    process.env.ASK_SUPERSEDED_REPLY = 'follow';
    try {
      const f = await prismaCliAsk.getMessage(ada, 'msga00000001', 0);
      expect(f.body).toMatchObject({ message: 'msga00000001', status: 'superseded', supersededBy: 'msgb00000001' });
      expect(f.body).not.toHaveProperty('answeredWith');
    } finally {
      delete process.env.ASK_SUPERSEDED_REPLY;
    }
  });

  it('holds a follow-up queued as the next turn until the turn before it ends, and fails it at its deadline', async () => {
    const queued = { id: 'msgb00000001', instanceId: 'box1', senderUserId: 'u-ada', projectId: 'p1', threadId: 'thr0000000001', createdAt: new Date(2), queuedUntil: new Date(Date.now() + 60_000) };
    prisma.agentMessage.findMany.mockImplementation(async ({ where }: { where: { threadId?: unknown } }) => (where.threadId
      ? [{ id: 'msga00000001', threadId: 'thr0000000001', createdAt: new Date(1) }, { id: 'msgb00000001', threadId: 'thr0000000001', createdAt: new Date(2) }]
      : [queued]));
    prisma.project.findMany.mockResolvedValue([{ id: 'p1', name: 'api', setupStatus: 'ready', setupError: null }]);
    prisma.agentMessage.updateMany.mockClear();
    await tickQueue();
    expect(prisma.agentMessage.updateMany).not.toHaveBeenCalled();
    expect(askRunCalls()).toHaveLength(0);
    queued.queuedUntil = new Date(Date.now() - 1000);
    await tickQueue();
    expect(prisma.agentMessage.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'msgb00000001', status: 'submitted' },
      data: { status: 'failed', error: expect.stringContaining("the thread's previous turn was still running 6 hours after this follow-up") },
    });
  });

  const MODEL_STEER_CAPS = [...STEER_CAPS, 'ask-model-v1'];
  it('queues a follow-up on another --model as the next turn: a running claude -p keeps its model', async () => {
    steerSetup(MODEL_STEER_CAPS, { ...busyA, model: 'sonnet' });
    prisma.workflow.findFirst.mockResolvedValue({ model: 'sonnet' } as never);
    const r = await prismaCliAsk.ask(ada, null, follow());
    expect(r.body).toMatchObject({ steered: true });
    steerSetup(MODEL_STEER_CAPS, { ...busyA, model: 'sonnet' });
    const q = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', messageId: 'msgb00000001', model: 'opus' }));
    expect(q.body).toMatchObject({ queued: true, queuedFor: 'turn', steered: false, queuedBehind: 'msga00000001', steerRefused: "msga00000001's turn runs on sonnet, and --model opus needs a turn of its own" });
    expect(askRunCalls()).toHaveLength(0);
    prisma.workflow.findFirst.mockResolvedValue(null);
  });

  it('a follow-up without --model runs on the thread\'s stored tier, so it waits behind a turn on another one', async () => {
    // A person picked Haiku in the ask chat while the Sonnet turn ran.
    steerSetup(MODEL_STEER_CAPS, { ...busyA, model: 'sonnet' });
    prisma.workflow.findFirst.mockResolvedValue({ model: 'haiku' } as never);
    const q = await prismaCliAsk.ask(ada, null, follow());
    expect(q.body).toMatchObject({ queued: true, queuedBehind: 'msga00000001', steerRefused: "msga00000001's turn runs on sonnet, and --model haiku needs a turn of its own" });
    expect(askRunCalls()).toHaveLength(0);
    // With the flag off, no stored tier applies: it runs on the default, and joins a default turn.
    steerSetup(MODEL_STEER_CAPS, { ...busyA, model: null });
    vi.mocked(boolVariation).mockImplementation(async (key: string) => key !== 'ask-model-choice-enabled');
    expect((await prismaCliAsk.ask(ada, null, follow())).body).toMatchObject({ steered: true });
    vi.mocked(boolVariation).mockImplementation(async () => true);
    prisma.workflow.findFirst.mockResolvedValue(null);
  });

  it('a busy turn whose box is not connected queues the follow-up as not connected, not as a model mismatch', async () => {
    steerSetup(MODEL_STEER_CAPS, { ...busyA, instanceId: 'box-old', model: 'opus' });
    vi.mocked(instanceAgentTransport).mockImplementation(((id: string) => (id === 'box-old' ? undefined
      : { capabilities: MODEL_STEER_CAPS, helloReceived: true, conn: { kind: 'owned-box' } })) as never);
    const q = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', messageId: 'msgb00000001', model: 'opus' }));
    expect(q.body).toMatchObject({ queued: true, queuedBehind: 'msga00000001', steerRefused: 'devbox is not connected' });
    vi.mocked(instanceAgentTransport).mockReset();
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
  });

  it('compares a follow-up\'s --model with what the running turn really runs on: an ignored one ran on the default', async () => {
    steerSetup(MODEL_STEER_CAPS, { ...busyA, model: 'opus', modelIgnored: "devbox's agent predates --model" });
    const q = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', messageId: 'msgb00000001', model: 'opus' }));
    expect(q.body).toMatchObject({ queued: true, queuedFor: 'turn', queuedBehind: 'msga00000001', steerRefused: "msga00000001's turn runs on the box's default model, and --model opus needs a turn of its own" });
    expect(askRunCalls()).toHaveLength(0);
  });

  it('runs a first ask on a steer-capable box as a live turn, with nothing to steer', async () => {
    const r = await prismaCliAsk.ask(ada, null, req());
    expect(r.status).toBe(202);
    expect(askRunCalls()[0][2]).toMatchObject({ live: true });
    expect(askRunCalls()[0][2]).not.toHaveProperty('steerOf');
  });
});

describe('tickQueue: a box being resized', () => {
  it('waits for the resize to finish, then starts the box: it never fails the queued ask', async () => {
    setup(projectRow());
    vi.mocked(instanceAgentTransport).mockReturnValue(undefined as never);
    const queued = { id: 'msgr00000001', instanceId: 'box-rz', senderUserId: 'u-ada', projectId: 'p1', threadId: 'thr0000000009', createdAt: new Date(0), queuedUntil: new Date(Date.now() + 60_000) };
    prisma.agentMessage.findMany.mockImplementation(async ({ where }: { where: { threadId?: unknown } }) => (where.threadId ? [] : [queued]));
    prisma.project.findMany.mockResolvedValue([{ id: 'p1', name: 'api', setupStatus: 'ready', setupError: null }]);
    const box = { id: 'box-rz', name: 'devbox', userId: 'u-ada', kind: 'ec2', status: 'stopped', ec2InstanceId: 'i-1', autoTerminatedAt: null };
    // The box's open resize row (box_events), then none once the resize finished.
    vi.mocked(openBoxEvent).mockResolvedValueOnce({ id: 'ev1', kind: 'resize', startedAt: new Date(), finishedAt: null } as never);
    prisma.instance.findMany.mockResolvedValue([{ id: 'box-rz', status: 'stopped' }]);
    prisma.instance.findUnique.mockResolvedValue(box);
    await tickQueue();
    const failed = prisma.agentMessage.updateMany.mock.calls.filter(c => c[0]?.data?.status === 'failed');
    expect(failed).toEqual([]);
    expect(requestPower).not.toHaveBeenCalled();
    await tickQueue();
    expect(requestPower).toHaveBeenCalledTimes(1);
    expect(prisma.agentMessage.updateMany.mock.calls.filter(c => c[0]?.data?.status === 'failed')).toEqual([]);
  });
});

describe('tickQueue: a box a resize holds is up for a moment', () => {
  it("sends no queued ask while a hibernated box's resize has resumed it, and sends it once the resize is done", async () => {
    setup(projectRow());
    // Resumed to ready and connected, before the resize's plain stop (Bugbot on #877).
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    const queued = { id: 'msgr00000002', instanceId: 'box1', senderUserId: 'u-ada', projectId: 'p1', threadId: 'thr0000000010', createdAt: new Date(0), queuedUntil: new Date(Date.now() + 60_000) };
    prisma.agentMessage.findMany.mockImplementation(async ({ where }: { where: { threadId?: unknown } }) => (where.threadId ? [] : [queued]));
    prisma.project.findMany.mockResolvedValue([{ id: 'p1', name: 'api', setupStatus: 'ready', setupError: null }]);
    prisma.instance.findMany.mockResolvedValue([{ id: 'box1', status: 'ready' }]);
    vi.mocked(boxesWithOpenEvent).mockResolvedValueOnce(new Set(['box1']));
    prisma.agentMessage.updateMany.mockClear();
    // sendQueued's first step is reading the queued message.
    const sends = () => prisma.agentMessage.findUnique.mock.calls.filter(c => c[0]?.where?.id === 'msgr00000002').length;
    await tickQueue();
    expect(sends()).toBe(0);
    expect(prisma.agentMessage.updateMany.mock.calls.filter(c => c[0]?.data?.status === 'failed')).toEqual([]);
    expect(requestPower).not.toHaveBeenCalled();
    expect(vi.mocked(boxesWithOpenEvent).mock.calls.at(-1)?.slice(0, 2)).toEqual([['box1'], 'resize']);
    // The resize finished: the next tick sends it.
    await tickQueue();
    expect(prisma.agentMessage.updateMany.mock.calls.filter(c => c[0]?.data?.status === 'failed')).toEqual([]);
    expect(sends()).toBe(1);
  });
});

describe('prismaCliAsk: a follow-up held as the next turn starts as soon as its thread is free', () => {
  // tickQueue's first read: the queued rows. The 5 s timer is not running in these tests.
  const ticks = () => prisma.agentMessage.findMany.mock.calls.filter(c => c[0]?.where?.queuedPrompt !== undefined && c[0]?.where?.status === 'submitted').length;

  it('kicks the queue right after a hold', async () => {
    setup(projectRow());
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1', 'ask-chat-v1', 'ask-steer-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    prisma.agentThread.findUnique.mockResolvedValue({ id: 'thr0000000001', originUserId: 'u-ada', projectId: 'p1', workstream: 'main', instanceId: 'box1', hopCount: 1, chatWorkstreamId: 'ws-ask', claudeSessionId: null, baseSha: null });
    prisma.agentThread.updateMany.mockResolvedValue({ count: 1 });
    prisma.workstream.findUnique.mockResolvedValue({ id: 'ws-ask', name: 'ask-thr0000000001' });
    prisma.agentMessage.findFirst.mockResolvedValue({ id: 'msga00000001', instanceId: 'box1', status: 'working', createdAt: new Date(0), queuedUntil: null, queuedPrompt: null });
    prisma.agentMessage.findMany.mockResolvedValue([]);
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_box, type) => {
      if (type === 'ask-run-status') return { running: true, known: true, stage: 'sent', mode: 'chat', live: true };
      if (type === 'ask-run') return { ok: true, started: false, steered: false, reason: 'finished' };
      return { ok: true };
    });
    const r = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', messageId: 'msgb00000001' }));
    expect(r).toMatchObject({ status: 202, body: { queuedFor: 'turn' } });
    await vi.waitFor(() => expect(ticks()).toBeGreaterThan(0), { timeout: 1000 });
  });

  it('kicks the queue when a run finishes, and when one is canceled', async () => {
    setup(projectRow());
    prisma.$transaction.mockImplementation(async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: typeof prisma) => unknown)(prisma)));
    prisma.agentMessage.findMany.mockResolvedValue([]);
    const thread = { id: 'thr0000000001', hopCount: 1, branch: null, prNumber: null, prUrl: null, prs: [], project: { name: 'api', userId: 'u-ada', instance: { name: 'devbox' } } };
    const row = { id: 'msga00000001', threadId: 'thr0000000001', instanceId: 'box1', senderUserId: 'u-ada', workstream: 'main', status: 'working', resultAt: null, hop: 1, createdAt: new Date(0), error: null, publish: null, publishDetail: null, readAt: null, startedAt: new Date(0), completedAt: new Date(1), queuedPrompt: null, numTurns: 1, replyBytes: 2, thread: { ...thread, baseSha: null, repo: null } };
    prisma.agentMessage.findUnique.mockResolvedValue(row);
    prisma.agentMessage.update.mockResolvedValue({ ...row, status: 'completed' });
    const res = await prismaCliAsk.recordResult('box1', 'msga00000001', {
      result: 'ok', sessionId: null, isError: false, numTurns: 1, exitReason: null, baseSha: null, repo: null, bundle: false, prDescription: null, prDescriptions: {},
    });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(prisma.agentMessage.update).toHaveBeenCalled(), { timeout: 1000 });
    await vi.waitFor(() => expect(ticks()).toBeGreaterThan(0), { timeout: 1000 });

    const before = ticks();
    prisma.agentMessage.findUnique.mockResolvedValue({ ...row, resultAt: null });
    expect((await prismaCliAsk.cancel(ada, 'msga00000001')).status).toBe(200);
    await vi.waitFor(() => expect(ticks()).toBeGreaterThan(before), { timeout: 1000 });
  });
});

describe('prismaCliAsk: publishing to another PR (--update-pr)', () => {
  const target = { number: 753, url: 'https://github.com/org/api/pull/753', branch: 'termag-ada/oldthread', headSha: 'a'.repeat(40), baseBranch: 'main' };
  beforeEach(() => {
    setup({ ...projectRow(), repoUrl: 'https://github.com/org/api.git' } as ReturnType<typeof projectRow>);
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['ask-v1', 'ask-cancel-v1'], helloReceived: true, conn: { kind: 'owned-box' } } as never);
    vi.mocked(sendToInstanceAgent).mockResolvedValue({ ok: true } as never);
    vi.mocked(githubTokenSource).mockResolvedValue('gho_ada' as never);
    vi.mocked(resolveTargetPr).mockResolvedValue(target);
  });
  afterEach(() => {
    vi.mocked(boolVariation).mockImplementation(async () => true);
    vi.mocked(githubTokenSource).mockResolvedValue(null as never);
  });

  it('checks the PR, remembers it on the new thread and points the run at its branch', async () => {
    const r = await prismaCliAsk.ask(ada, null, req({ targetPr: { number: 753, repo: null } }));
    expect(r).toMatchObject({ status: 202, body: { status: 'working', targetPr: 753, branch: 'termag-ada/oldthread' } });
    expect(vi.mocked(resolveTargetPr).mock.calls[0][1]).toEqual({ repo: 'org/api', token: 'gho_ada', number: 753, askerUnix: 'ada' });
    expect(prisma.agentThread.create.mock.calls[0][0].data).toMatchObject({ targetPr: 753, targetRepo: 'org/api', targetBranch: 'termag-ada/oldthread' });
    const job = askRunCalls()[0][2] as { systemPrompt: string };
    expect(job.systemPrompt).toContain('#753 in org/api');
    expect(job.systemPrompt).toContain("'+refs/heads/termag-ada/oldthread:refs/remotes/termag/target'");
  });

  it("rejects someone else's PR with GitHub's reason, and starts no run", async () => {
    vi.mocked(resolveTargetPr).mockResolvedValue({ refused: 'PR #753 is not yours: it was opened by bob on feature, which is not a termag-ada/… branch' });
    const r = await prismaCliAsk.ask(ada, null, req({ targetPr: { number: 753, repo: null } }));
    expect(r).toMatchObject({ status: 409, body: { status: 'rejected', code: 'target_pr_refused', error: expect.stringContaining('is not yours') } });
    expect(prisma.agentThread.create).not.toHaveBeenCalled();
    expect(askRunCalls()).toHaveLength(0);
  });

  it("rejects a PR in another repository than the project's checkout", async () => {
    const r = await prismaCliAsk.ask(ada, null, req({ targetPr: { number: 753, repo: 'org/web' } }));
    expect(r).toMatchObject({ status: 409, body: { code: 'target_pr_refused', error: expect.stringContaining('checkout of org/api') } });
    expect(resolveTargetPr).not.toHaveBeenCalled();
  });

  it("rejects a PR in another repository than a workspace's checkout, before any run", async () => {
    const ws = projectRow({ repos: ['shop-web', 'shop-api'] });
    setup({ ...ws, repoUrl: null, repos: [{ name: 'shop-web', url: 'https://github.com/org/shop-web.git' }, { name: 'shop-api', url: 'git@github.com:org/shop-api.git' }] } as unknown as ReturnType<typeof projectRow>);
    vi.mocked(githubTokenSource).mockResolvedValue('gho_ada' as never);
    vi.mocked(resolveTargetPr).mockResolvedValue(target);
    const r = await prismaCliAsk.ask(ada, null, req({ repo: 'shop-api', targetPr: { number: 753, repo: 'org/shop-web' } }));
    expect(r).toMatchObject({ status: 409, body: { code: 'target_pr_refused', error: expect.stringContaining('checkout of org/shop-api') } });
    expect(resolveTargetPr).not.toHaveBeenCalled();
    expect(prisma.agentThread.create).not.toHaveBeenCalled();
    expect(askRunCalls()).toHaveLength(0);
    // The workspace repository's own URL is the one a bare number resolves against.
    const ok = await prismaCliAsk.ask(ada, null, req({ repo: 'shop-api', targetPr: { number: 753, repo: null } }));
    expect(ok.status).toBe(202);
    expect(vi.mocked(resolveTargetPr).mock.calls[0][1]).toMatchObject({ repo: 'org/shop-api' });
  });

  it("checks a PR against a still-cloning repository's URL in a new workspace", async () => {
    setup({ ...projectRow({ repos: [] }), repoUrl: null, name: 'shop', layout: 'workspace', setupStatus: 'cloning' });
    prisma.projectRepo.findMany.mockResolvedValue([
      { name: 'shop-web', url: 'https://github.com/org/shop-web.git', setupStatus: 'ready' },
      { name: 'shop-api', url: 'git@github.com:org/shop-api.git', setupStatus: 'cloning' },
    ] as never);
    const wrong = await prismaCliAsk.ask(ada, null, req({ repo: 'shop-api', targetPr: { number: 753, repo: 'org/shop-web' } }));
    expect(wrong).toMatchObject({ status: 409, body: { code: 'target_pr_refused', error: expect.stringContaining('checkout of org/shop-api') } });
    expect(resolveTargetPr).not.toHaveBeenCalled();
    const ok = await prismaCliAsk.ask(ada, null, req({ repo: 'shop-api', targetPr: { number: 753, repo: null } }));
    expect(ok).toMatchObject({ status: 202, body: { queued: true, queuedFor: 'setup' } });
    expect(vi.mocked(resolveTargetPr).mock.calls[0][1]).toMatchObject({ repo: 'org/shop-api' });
  });

  const remembered = { id: 'thr0000000001', originUserId: 'u-ada', projectId: 'p1', workstream: 'main', repoName: null, instanceId: 'box1', hopCount: 1, chatWorkstreamId: null, claudeSessionId: null, baseSha: null, targetPr: 753, targetRepo: 'org/api', targetBranch: 'termag-ada/oldthread' };

  it('a follow-up publishes to the remembered PR without naming it', async () => {
    prisma.agentThread.findUnique.mockResolvedValue(remembered);
    prisma.agentThread.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentMessage.findFirst.mockResolvedValue(null);
    const r = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001' }));
    expect(r).toMatchObject({ status: 202, body: { targetPr: 753, branch: 'termag-ada/oldthread' } });
    expect(resolveTargetPr).not.toHaveBeenCalled();
    expect((askRunCalls()[0][2] as { systemPrompt: string }).systemPrompt).toContain('#753 in org/api');
  });

  it('a follow-up that names another PR is refused: a thread keeps its target', async () => {
    prisma.agentThread.findUnique.mockResolvedValue(remembered);
    prisma.agentMessage.findFirst.mockResolvedValue(null);
    const r = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', targetPr: { number: 760, repo: null } }));
    expect(r).toMatchObject({ status: 409, body: { code: 'thread_mismatch', error: expect.stringContaining('publishes to PR #753') } });
    prisma.agentThread.findUnique.mockResolvedValue({ ...remembered, targetPr: null, targetRepo: null, targetBranch: null, prNumber: 12 });
    const own = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', targetPr: { number: 753, repo: null } }));
    expect(own).toMatchObject({ status: 409, body: { code: 'thread_mismatch', error: expect.stringContaining('its own PR #12') } });
  });

  it("a follow-up that names the thread's own PR is a no-op, not a refusal", async () => {
    prisma.agentThread.findUnique.mockResolvedValue({ ...remembered, targetPr: null, targetRepo: null, targetBranch: null, prNumber: 12, repo: 'org/api' });
    prisma.agentThread.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentMessage.findFirst.mockResolvedValue(null);
    const r = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', targetPr: { number: 12, repo: null } }));
    expect(r).toMatchObject({ status: 202 });
    expect(resolveTargetPr).not.toHaveBeenCalled();
    expect(prisma.agentThread.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ targetPr: 12 }) }));
    prisma.agentMessage.findFirst.mockResolvedValue(null);
    const otherRepo = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', targetPr: { number: 12, repo: 'org/web' } }));
    expect(otherRepo).toMatchObject({ status: 409, body: { code: 'thread_mismatch' } });
  });

  it('a follow-up on a thread that has published nothing may name its PR, as after a refused stack', async () => {
    prisma.agentThread.findUnique.mockResolvedValue({ ...remembered, targetPr: null, targetRepo: null, targetBranch: null, prNumber: null });
    prisma.agentThread.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentMessage.findFirst.mockResolvedValue(null);
    const r = await prismaCliAsk.ask(ada, null, req({ threadId: 'thr0000000001', targetPr: { number: 753, repo: null } }));
    expect(r).toMatchObject({ status: 202, body: { targetPr: 753, branch: 'termag-ada/oldthread' } });
    expect(prisma.agentThread.update).toHaveBeenCalledWith({ where: { id: 'thr0000000001' }, data: { targetPr: 753, targetRepo: 'org/api', targetBranch: 'termag-ada/oldthread' } });
  });

  describe('the publish', () => {
    const thread = {
      id: 'thr0000000001', originUserId: 'u-ada', instanceId: 'box1', workstream: 'main', repoName: null, baseSha: 'b'.repeat(40), repo: 'org/api',
      prNumber: null, targetPr: 753, targetRepo: 'org/api', targetBranch: 'termag-ada/oldthread',
      originUser: { id: 'u-ada', unixUsername: 'ada', googleEmail: 'ada@example.com', displayName: 'Ada' },
      project: { name: 'api', userId: 'u-ada', instance: { name: 'devbox' } },
    };
    const result = { result: 'ok', sessionId: null, isError: false, numTurns: 1, exitReason: null, baseSha: null, repo: null, bundle: true, prDescription: null, prDescriptions: {} };
    const publishOn = async (t: Record<string, unknown>, out?: Awaited<ReturnType<typeof publishBundle>>) => {
      prisma.$transaction.mockImplementation(async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: typeof prisma) => unknown)(prisma)));
      prisma.agentMessage.findUnique.mockImplementation(async ({ select }: { select?: unknown }) => (select
        ? { instanceId: 'box1', status: 'working', threadId: 'thr0000000001', thread: { baseSha: 'b'.repeat(40), repo: 'org/api' } }
        : { id: 'msga00000001', instanceId: 'box1', thread: t }));
      prisma.agentBundle.findUnique.mockResolvedValue({ data: Buffer.from('bundle') });
      prisma.instance.findUnique.mockResolvedValue({ ec2InstanceId: 'i-0abc' });
      prisma.agentMessage.update.mockResolvedValue({ id: 'msga00000001', status: 'completed', thread: { ...t, prs: [], hopCount: 1 } });
      vi.mocked(publishBundle).mockResolvedValue(out ?? { kind: 'done', prs: [{ kind: 'published', key: '', branch: 'termag-ada/oldthread', headSha: 'c'.repeat(40), commits: 3, prNumber: 753, prUrl: 'https://github.com/org/api/pull/753', prCreated: false }] });
      expect((await prismaCliAsk.recordResult('box1', 'msga00000001', result)).status).toBe(202);
    };

    it("pushes to the remembered PR, then records it as the thread's own", async () => {
      await publishOn(thread);
      await vi.waitFor(() => expect(publishBundle).toHaveBeenCalled(), { timeout: 1000 });
      const input = vi.mocked(publishBundle).mock.calls[0][1];
      expect(input).toMatchObject({ repo: 'org/api', prNumbers: { '': 753 }, target: { number: 753, askerUnix: 'ada', firstPublish: true } });
      expect(input.prBody('desc', '', true)).toContain('Updated by `termag ask` for ada');
      expect(input.prBody('desc', '', true)).toContain('--thread thr0000000001');
      await vi.waitFor(() => expect(prisma.agentThreadPr.upsert).toHaveBeenCalled(), { timeout: 1000 });
      expect(prisma.agentThreadPr.upsert.mock.calls[0][0].create).toMatchObject({ key: '', branch: 'termag-ada/oldthread', prNumber: 753 });
      expect(prisma.agentThread.update).toHaveBeenCalledWith(expect.objectContaining({ data: { branch: 'termag-ada/oldthread', prNumber: 753, prUrl: 'https://github.com/org/api/pull/753' } }));
    });

    it('publishes nothing when the checkout is another repository', async () => {
      await publishOn({ ...thread, repo: 'org/web' });
      await vi.waitFor(() => expect(prisma.agentMessage.update).toHaveBeenCalled(), { timeout: 1000 });
      expect(publishBundle).not.toHaveBeenCalled();
      expect(prisma.agentMessage.update.mock.calls[0][0].data).toMatchObject({ publish: 'refused', publishDetail: expect.stringContaining('pushes to org/web') });
    });

    it('a thread with no target lets the publish find the PR the run builds on, and remembers it', async () => {
      const found = { kind: 'published' as const, key: '', branch: 'termag-ada/oldthread', headSha: 'c'.repeat(40), commits: 1, prNumber: 753, prUrl: 'https://github.com/org/api/pull/753', prCreated: false, target: { number: 753, branch: 'termag-ada/oldthread' } };
      await publishOn({ ...thread, targetPr: null, targetRepo: null, targetBranch: null });
      await vi.waitFor(() => expect(publishBundle).toHaveBeenCalled(), { timeout: 1000 });
      expect(vi.mocked(publishBundle).mock.calls[0][1]).toMatchObject({ askerUnix: 'ada', prNumbers: {} });
      expect(vi.mocked(publishBundle).mock.calls[0][1]).not.toHaveProperty('target');

      vi.clearAllMocks();
      await publishOn({ ...thread, targetPr: null, targetRepo: null, targetBranch: null }, { kind: 'done', prs: [found] });
      await vi.waitFor(() => expect(prisma.agentThread.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ prNumber: 753, targetPr: 753, targetRepo: 'org/api', targetBranch: 'termag-ada/oldthread' }),
      })), { timeout: 1000 });
    });
  });
});

describe('prismaCliAsk: telling the asker when the ask finishes', () => {
  const orch = { id: 'p-orch', name: 'orch', userId: 'u-ada', archived: false, instanceId: 'box1', workstreams: [{ name: 'main', archived: false }] };
  beforeEach(() => {
    setup(projectRow());
    const target = projectRow();
    prisma.project.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === 'p-orch' ? orch : target));
  });
  const created = () => prisma.agentMessage.create.mock.calls[0][0].data as Record<string, unknown>;

  it("records a chat turn's session on the message, and says the chat will be told", async () => {
    const r = await prismaCliAsk.ask(ada, 'box1', req({ sender: { projectId: 'p-orch', workstream: 'main' }, notify: true }));
    expect(r).toMatchObject({ status: 202, body: { notify: 'chat' } });
    expect(created()).toMatchObject({ notifyProjectId: 'p-orch', notifyWorkstream: 'main', notifyVia: 'chat' });
    // The same check places the thread under its parent.
    expect(prisma.agentThread.create.mock.calls[0][0].data).toMatchObject({ parentProjectId: 'p-orch', parentWorkstream: 'main' });
  });

  it("records an agent pane as a pane, and a ctrl shell as the sender but not told (a typed line would run there)", async () => {
    await prismaCliAsk.ask(ada, 'box1', req({ sender: { session: 'ada-orch-agent' }, notify: true }));
    expect(created()).toMatchObject({ notifyVia: 'pane', notifyProjectId: 'p-orch' });
    setup(projectRow());
    prisma.project.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === 'p-orch' ? orch : projectRow()));
    const r = await prismaCliAsk.ask(ada, 'box1', req({ sender: { session: 'ada-orch-ctrl' }, notify: true }));
    expect(created()).not.toHaveProperty('notifyVia');
    expect(created()).toMatchObject({ notifyProjectId: 'p-orch', notifyWorkstream: 'main' });
    expect(r.body).not.toHaveProperty('notify');
    expect(prisma.agentThread.create.mock.calls[0][0].data).toMatchObject({ parentProjectId: 'p-orch' });
  });

  it('records the sender but tells nobody for --no-notify, and records nobody for an unchecked sender or one on another box', async () => {
    await prismaCliAsk.ask(ada, 'box1', req({ sender: { projectId: 'p-orch', workstream: 'main' }, notify: false }));
    expect(created()).not.toHaveProperty('notifyVia');
    expect(created()).toMatchObject({ notifyProjectId: 'p-orch', notifyWorkstream: 'main' });
    prisma.agentMessage.create.mockClear();
    await prismaCliAsk.ask(ada, 'box2', req({ sender: { projectId: 'p-orch', workstream: 'main' }, notify: true }));
    expect(created()).not.toHaveProperty('notifyVia');
    expect(created()).not.toHaveProperty('notifyProjectId');
  });

  it("promises no notice to a session the sweep would skip: an automation's run, an ask's own chat", async () => {
    prisma.project.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === 'p-orch' ? { ...orch, kind: 'automation' } : projectRow()));
    const r = await prismaCliAsk.ask(ada, 'box1', req({ sender: { projectId: 'p-orch', workstream: 'main' }, notify: true }));
    expect(created()).not.toHaveProperty('notifyVia');
    expect(created()).toMatchObject({ notifyProjectId: 'p-orch', notifyWorkstream: 'main' });
    expect(r.body).not.toHaveProperty('notify');
    setup(projectRow());
    prisma.project.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === 'p-orch'
      ? { ...orch, workstreams: [{ name: 'main', archived: false, askThread: { id: 'thr0000000009' } }] } : projectRow()));
    const r2 = await prismaCliAsk.ask(ada, 'box1', req({ sender: { projectId: 'p-orch', workstream: 'main' }, notify: true }));
    expect(created()).not.toHaveProperty('notifyVia');
    expect(r2.body).not.toHaveProperty('notify');
  });

  it("records each follow-up's own sender", async () => {
    prisma.agentThread.findUnique.mockResolvedValue({ id: 'thr0000000001', originUserId: 'u-ada', projectId: 'p1', workstream: 'main', repoName: null, hopCount: 1, title: null, targetPr: null, prNumber: null, chatWorkstreamId: null });
    prisma.agentThread.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentMessage.findFirst.mockResolvedValue(null);
    await prismaCliAsk.ask(ada, 'box1', req({ threadId: 'thr0000000001', sender: { projectId: 'p-orch', workstream: 'main' }, notify: true }));
    expect(created()).toMatchObject({ notifyProjectId: 'p-orch', notifyVia: 'chat' });
  });

  it('a poll that sees the finish marks it seen, so nobody is told twice', async () => {
    const thread = { id: 'thr0000000001', hopCount: 1, branch: null, prNumber: null, prUrl: null, prs: [], project: { name: 'api', userId: 'u-ada', instance: { name: 'devbox' } } };
    prisma.agentMessage.findUnique.mockResolvedValue({
      id: 'msg0000000001', threadId: 'thr0000000001', senderUserId: 'u-ada', workstream: 'main', instanceId: 'box1', hop: 1, status: 'failed',
      error: 'boom', numTurns: null, publish: null, publishDetail: null, readAt: null, createdAt: new Date(0), startedAt: new Date(0), completedAt: new Date(1),
      queuedPrompt: null, replyBytes: null, supersededById: null, notifyVia: 'chat', notifyProjectId: 'p-orch', notifyWorkstream: 'main', notifiedAt: null, notice: null, thread,
    });
    await prismaCliAsk.getMessage(ada, 'msg0000000001', 0);
    expect(prisma.agentMessage.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['msg0000000001'] }, notifiedAt: null }, data: { notifiedAt: expect.any(Date), notice: 'waiter' } });
  });
});

describe('prismaCliAsk: the turn\'s model (termag ask --model)', () => {
  const MODEL_CAPS = ['ask-v1', 'ask-cancel-v1', 'ask-chat-v1', 'ask-model-v1'];
  const GATEWAY = {
    CLAUDE_GATEWAY_URL: 'https://bedrock.example.test/bedrock/', CLAUDE_BEDROCK_REGION: 'us-east-2',
    CLAUDE_BEDROCK_MODELS: 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5-20251001-v1:0',
  };
  const caps = (list: string[]) => vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: list, helloReceived: true, conn: { kind: 'owned-box' } } as never);
  const job = () => askRunCalls()[0][2] as Record<string, unknown>;
  const startedWith = () => prisma.agentMessage.updateMany.mock.calls.find(c => c[0].data?.status === 'working')?.[0].data;
  /** A follow-up on thr0000000001, whose chat ws-ask has `stored` as its model. */
  function onThread(stored: string | null) {
    prisma.agentThread.findUnique.mockResolvedValue({
      id: 'thr0000000001', originUserId: 'u-ada', projectId: 'p1', workstream: 'main', instanceId: 'box1',
      hopCount: 1, chatWorkstreamId: 'ws-ask', claudeSessionId: null, baseSha: null,
    });
    prisma.agentThread.updateMany.mockResolvedValue({ count: 1 });
    prisma.workstream.findUnique.mockResolvedValue({ id: 'ws-ask', name: 'ask-thr0000000001' });
    prisma.agentMessage.findFirst.mockResolvedValue(null);
    prisma.workflow.findFirst.mockResolvedValue({ id: 'wf-ask', model: stored } as never);
  }
  const follow = (over: Partial<AskRequest> = {}) => req({ threadId: 'thr0000000001', messageId: 'msgb00000001', ...over });

  beforeEach(() => { setup(projectRow()); caps(MODEL_CAPS); });
  afterEach(() => { vi.unstubAllEnvs(); caps(['ask-v1', 'ask-cancel-v1']); prisma.workflow.findFirst.mockResolvedValue(null); });

  it('launches a new thread\'s turn on it, as the pinned profile on the gateway, and keeps it as the thread chat\'s choice', async () => {
    for (const [k, v] of Object.entries(GATEWAY)) vi.stubEnv(k, v);
    prisma.user.findUnique.mockResolvedValue({ claudeGatewayEnabled: true } as never);
    prisma.workflow.findFirst.mockResolvedValue({ id: 'wf-ask', model: null } as never);
    const r = await prismaCliAsk.ask(ada, null, req({ model: 'opus' }));
    expect(r).toMatchObject({ status: 202, body: { status: 'working', model: 'opus' } });
    expect(r.body).not.toHaveProperty('modelIgnored');
    expect(prisma.agentMessage.create.mock.calls[0][0].data).toMatchObject({ model: 'opus' });
    expect(job()).toMatchObject({ model: 'us.anthropic.claude-opus-5-5', chat: { workstreamId: 'ws-ask' } });
    expect(prisma.workflow.update).toHaveBeenCalledWith({ where: { id: 'wf-ask' }, data: { backend: null, model: 'opus' } });
    expect(startedWith()).toMatchObject({ model: 'opus' });
  });

  it('sends the alias when the owner is off the gateway', async () => {
    for (const [k, v] of Object.entries(GATEWAY)) vi.stubEnv(k, v);
    prisma.user.findUnique.mockResolvedValue({ claudeGatewayEnabled: false } as never);
    await prismaCliAsk.ask(ada, null, req({ model: 'haiku' }));
    expect(job()).toMatchObject({ model: 'haiku' });
  });

  it('a follow-up without --model runs on the tier the thread keeps; one with it switches the thread from that turn on', async () => {
    onThread('opus');
    await prismaCliAsk.ask(ada, null, follow());
    expect(job()).toMatchObject({ model: 'opus' });
    expect(prisma.workflow.update).not.toHaveBeenCalled();
    expect(startedWith()).toMatchObject({ model: 'opus' });
    setup(projectRow()); caps(MODEL_CAPS); onThread('opus');
    await prismaCliAsk.ask(ada, null, follow({ model: 'sonnet' }));
    expect(job()).toMatchObject({ model: 'sonnet' });
    expect(prisma.workflow.update).toHaveBeenCalledWith({ where: { id: 'wf-ask' }, data: { backend: null, model: 'sonnet' } });
  });

  it('without --model on a thread with nothing stored, the turn names no model: the box\'s default, as before', async () => {
    const r = await prismaCliAsk.ask(ada, null, req());
    expect(job()).not.toHaveProperty('model');
    expect(r.body).not.toHaveProperty('model');
    expect(prisma.agentMessage.create.mock.calls[0][0].data).not.toHaveProperty('model');
    expect(prisma.workflow.update).not.toHaveBeenCalled();
    expect(startedWith()).toMatchObject({ model: null });
  });

  it('on an agent from before ask-model-v1 the ask still runs, with no model sent, says --model was ignored, and leaves the thread\'s model as it was', async () => {
    caps(['ask-v1', 'ask-cancel-v1', 'ask-chat-v1']);
    onThread('sonnet');
    const r = await prismaCliAsk.ask(ada, null, follow({ model: 'opus' }));
    expect(r).toMatchObject({ status: 202, body: { status: 'working', model: 'opus', modelIgnored: expect.stringContaining("devbox's agent predates --model") } });
    expect(job()).not.toHaveProperty('model');
    // Nothing stored: the chat's next turn is on what it had (Devin on #1322).
    expect(prisma.workflow.update).not.toHaveBeenCalled();
    expect(prisma.agentMessage.create.mock.calls[0][0].data).toMatchObject({ model: 'opus', modelIgnored: expect.stringContaining('predates') });
    expect(startedWith()).toMatchObject({ model: 'opus', modelIgnored: expect.stringContaining('predates') });
  });

  it('a headless run says --model was ignored', async () => {
    caps(['ask-v1', 'ask-cancel-v1']);
    const r = await prismaCliAsk.ask(ada, null, req({ model: 'opus' }));
    expect(r.body).toMatchObject({ model: 'opus', modelIgnored: expect.stringContaining('the run on devbox is headless') });
    expect(job()).not.toHaveProperty('model');
    expect(job()).not.toHaveProperty('chat');
    expect(startedWith()).toMatchObject({ model: 'opus', modelIgnored: expect.stringContaining('headless') });
  });

  it('with ask-model-choice-enabled off, ignores --model as an older agent would, and applies no stored tier', async () => {
    const flagOff = () => vi.mocked(boolVariation).mockImplementation(async (key: string) => key !== 'ask-model-choice-enabled');
    flagOff();
    onThread('sonnet');
    const r = await prismaCliAsk.ask(ada, null, follow({ model: 'opus' }));
    expect(r).toMatchObject({ status: 202, body: { model: 'opus', modelIgnored: expect.stringContaining('ask-model-choice-enabled') } });
    expect(job()).not.toHaveProperty('model');
    expect(prisma.workflow.update).not.toHaveBeenCalled();
    expect(startedWith()).toMatchObject({ model: 'opus', modelIgnored: expect.stringContaining('ask-model-choice-enabled') });
    // No --model: the thread's stored tier is not applied either, as before the flag.
    setup(projectRow()); caps(MODEL_CAPS); onThread('sonnet'); flagOff();
    const plain = await prismaCliAsk.ask(ada, null, follow());
    expect(job()).not.toHaveProperty('model');
    expect(plain.body).not.toHaveProperty('modelIgnored');
    expect(startedWith()).toMatchObject({ model: null, modelIgnored: null });
    vi.mocked(boolVariation).mockImplementation(async () => true);
  });

  it('a retried POST answers as the first 202 did: the model asked for, and why it was ignored', async () => {
    const existing = (over: Record<string, unknown>) => ({
      id: 'msgb00000001', threadId: 'thr0000000001', senderUserId: 'u-ada', projectId: 'p1', workstream: 'main', instanceId: 'box1',
      hop: 1, promptBytes: Buffer.byteLength('what does this do?'), status: 'working', createdAt: new Date(), queuedPrompt: null, queuedUntil: null,
      notifyVia: null, notice: null, model: null, modelIgnored: null,
      thread: { id: 'thr0000000001', title: null, hopCount: 1, repoName: null, branch: null, prNumber: null, prUrl: null, prs: [], project: { name: 'api', userId: 'u-ada', instance: { name: 'devbox' } } },
      ...over,
    });
    prisma.agentMessage.findUnique.mockResolvedValue(existing({ model: 'opus', modelIgnored: "devbox's agent predates --model" }) as never);
    const ignored = await prismaCliAsk.ask(ada, null, req({ messageId: 'msgb00000001', model: 'opus' }));
    expect(ignored.body).toMatchObject({ replayed: true, model: 'opus', modelIgnored: "devbox's agent predates --model" });
    prisma.agentMessage.findUnique.mockResolvedValue(existing({ model: 'opus' }) as never);
    const taken = await prismaCliAsk.ask(ada, null, req({ messageId: 'msgb00000001', model: 'opus' }));
    expect(taken.body).toMatchObject({ replayed: true, model: 'opus' });
    expect(taken.body).not.toHaveProperty('modelIgnored');
    expect(askRunCalls()).toHaveLength(0);
  });

  it('stores the new tier on the thread only once the box took the turn: a failed start leaves it as it was', async () => {
    onThread('sonnet');
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_box, type) => {
      if (type === 'ask-run') throw new Error('socket closed');
      if (type === 'ask-run-status') return { running: false, known: true };
      return { ok: true };
    });
    const r = await prismaCliAsk.ask(ada, null, follow({ model: 'opus' }));
    expect(r.status).toBe(502);
    expect(prisma.workflow.update).not.toHaveBeenCalled();
    vi.mocked(sendToInstanceAgent).mockImplementation(async () => ({ ok: true }));
    // Taken: stored then.
    setup(projectRow()); caps(MODEL_CAPS); onThread('sonnet');
    await prismaCliAsk.ask(ada, null, follow({ model: 'opus' }));
    expect(prisma.workflow.update).toHaveBeenCalledWith({ where: { id: 'wf-ask' }, data: { backend: null, model: 'opus' } });
  });

  it('answers a run the box took with its 202 even when storing the thread\'s new tier fails', async () => {
    onThread('sonnet');
    prisma.workflow.update.mockRejectedValueOnce(new Error('connection reset'));
    const r = await prismaCliAsk.ask(ada, null, follow({ model: 'opus' }));
    expect(r).toMatchObject({ status: 202, body: { status: 'working', model: 'opus' } });
    expect(job()).toMatchObject({ model: 'opus' });
    expect(startedWith()).toMatchObject({ model: 'opus' });
  });

  it('says a box without ask chats runs headless, not that its agent predates --model, from the first 202', async () => {
    caps(['ask-v1', 'ask-cancel-v1']);
    await prismaCliAsk.ask(ada, null, req({ model: 'opus' }));
    expect(prisma.agentMessage.create.mock.calls[0][0].data).toMatchObject({ modelIgnored: expect.stringContaining('is headless') });
  });

  it('records the launch decision on the message before the send, so a replay never decides it again', async () => {
    onThread('sonnet');
    await prismaCliAsk.ask(ada, null, follow({ model: 'opus' }));
    const writes = prisma.agentMessage.updateMany.mock.calls.map(c => c[0]);
    const recorded = writes.findIndex(w => w.data?.model === 'opus' && w.data?.status === undefined);
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(writes[recorded]).toEqual({ where: { id: 'msgb00000001', status: 'submitted' }, data: { model: 'opus', modelIgnored: null } });
    // Before the RPC: the send comes after it.
    expect(prisma.agentMessage.updateMany.mock.invocationCallOrder[recorded]).toBeLessThan(vi.mocked(sendToInstanceAgent).mock.invocationCallOrder.at(-1)!);
  });

  it('a replay that adopts a run keeps the recorded decision, and stores the thread\'s tier only for one that launched on it', async () => {
    const row = (over: Record<string, unknown>) => ({
      id: 'msgb00000001', threadId: 'thr0000000001', senderUserId: 'u-ada', projectId: 'p1', workstream: 'main', instanceId: 'box1',
      hop: 1, promptBytes: Buffer.byteLength('what does this do?'), status: 'submitted', createdAt: new Date(0), queuedPrompt: null, queuedUntil: null,
      notifyVia: null, notice: null, model: null, modelIgnored: null,
      thread: { id: 'thr0000000001', title: null, hopCount: 1, repoName: null, branch: null, prNumber: null, prUrl: null, prs: [], project: { name: 'api', userId: 'u-ada', instance: { name: 'devbox' } } },
      ...over,
    });
    onThread('sonnet');
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_box, type) => (type === 'ask-run-status' ? { running: true, known: true, mode: 'chat', live: true } : { ok: true }));
    prisma.agentMessage.findUnique.mockResolvedValue(row({ model: 'opus' }) as never);
    const r = await prismaCliAsk.ask(ada, null, req({ messageId: 'msgb00000001', model: 'opus' }));
    expect(r.body).toMatchObject({ replayed: true, status: 'working', model: 'opus' });
    expect(startedWith()).toEqual({ status: 'working', startedAt: expect.any(Date) });
    expect(prisma.workflow.update).toHaveBeenCalledWith({ where: { id: 'wf-ask' }, data: { backend: null, model: 'opus' } });
    // Recorded as ignored (it went headless): nothing stored, whatever the chat or flag say now.
    setup(projectRow()); caps(MODEL_CAPS); onThread('sonnet');
    vi.mocked(sendToInstanceAgent).mockImplementation(async (_box, type) => (type === 'ask-run-status' ? { running: true, known: true } : { ok: true }));
    prisma.agentMessage.findUnique.mockResolvedValue(row({ model: 'opus', modelIgnored: 'the run on devbox is headless' }) as never);
    const h = await prismaCliAsk.ask(ada, null, req({ messageId: 'msgb00000001', model: 'opus' }));
    expect(h.body).toMatchObject({ replayed: true, model: 'opus', modelIgnored: 'the run on devbox is headless' });
    expect(prisma.workflow.update).not.toHaveBeenCalled();
    expect(askRunCalls()).toHaveLength(0);
    vi.mocked(sendToInstanceAgent).mockImplementation(async () => ({ ok: true }));
  });

  it('records --model on the message, which a turn the queue sends later reads (sendQueued passes the row)', async () => {
    caps(MODEL_CAPS);
    await prismaCliAsk.ask(ada, null, req({ model: 'haiku' }));
    expect(prisma.agentMessage.create.mock.calls[0][0].data).toMatchObject({ model: 'haiku' });
  });
});

describe('prismaCliAsk: a run that pushes itself (ask-push-v1, docs/ask-direct-push.md)', () => {
  const pushCaps = (caps: string[]) => vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: caps, helloReceived: true, conn: { kind: 'owned-box' } } as never);
  beforeEach(() => setup(projectRow()));
  afterEach(() => pushCaps(['ask-v1', 'ask-cancel-v1']));

  it("names the thread's branch and tells the run to push on a box with ask-push-v1", async () => {
    pushCaps(['ask-v1', 'ask-cancel-v1', 'ask-push-v1']);
    await prismaCliAsk.ask(ada, null, req());
    const msg = askRunCalls()[0][2] as Record<string, string>;
    expect(msg.pushBranch).toBe('termag-ada/thr0000000001');
    expect(msg.systemPrompt).toContain('git push origin HEAD:termag-ada/thr0000000001');
    expect(msg.systemPrompt).toContain('termag-pr-create');
    expect(msg.systemPrompt).not.toContain('never push or open a pull request yourself');
  });

  it('keeps the bundle and its prompt on a box without it', async () => {
    await prismaCliAsk.ask(ada, null, req());
    const msg = askRunCalls()[0][2] as Record<string, string>;
    expect(msg).not.toHaveProperty('pushBranch');
    expect(msg.systemPrompt).toContain('never push or open a pull request yourself');
  });

  describe('recording what it pushed', () => {
    const result = { result: 'done', sessionId: null, isError: false, numTurns: 1, exitReason: null, baseSha: null, repo: null, bundle: false, prDescription: null, prDescriptions: {}, unpushed: [] };
    const thread = { id: 'thr0000000001', repo: 'org/api', originUserId: 'u-ada', targetBranch: null, prNumber: null, originUser: { unixUsername: 'ada' } };
    const finish = async (pushes: { branch: string; sha: string }[], unpushed: { branch: string; commits: number }[] = []) => {
      prisma.$transaction.mockImplementation(async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: typeof prisma) => unknown)(prisma)));
      prisma.agentMessage.findUnique.mockImplementation(async ({ select }: { select?: { thread?: { select?: Record<string, unknown> } } }) => (select?.thread?.select?.originUserId
        ? { thread }
        : { instanceId: 'box1', status: 'working', threadId: 'thr0000000001', thread: { baseSha: 'b'.repeat(40), repo: 'org/api' } }));
      prisma.agentMessage.update.mockResolvedValue({ id: 'msga00000001', status: 'completed', thread: { ...thread, prs: [], hopCount: 1 } });
      vi.mocked(githubTokenSource).mockResolvedValue('gho_ada' as never);
      expect((await prismaCliAsk.recordResult('box1', 'msga00000001', { ...result, pushes, unpushed })).status).toBe(202);
      await vi.waitFor(() => expect(prisma.agentMessage.update).toHaveBeenCalled(), { timeout: 1000 });
      return prisma.agentMessage.update.mock.calls[0][0].data;
    };

    it("confirms each pushed branch on GitHub and records its PR on the thread, the thread's own as its PR", async () => {
      vi.mocked(confirmPushes).mockResolvedValue([
        { kind: 'recorded', branch: 'termag-ada/thr0000000001', key: '', headSha: 'c'.repeat(40), prNumber: 901, prUrl: 'https://github.com/org/api/pull/901', state: 'open' },
        { kind: 'recorded', branch: 'termag-ada/thr0000000001-docs', key: 'docs', headSha: 'd'.repeat(40), prNumber: 902, prUrl: 'https://github.com/org/api/pull/902', state: 'open' },
      ]);
      const data = await finish([{ branch: 'termag-ada/thr0000000001', sha: 'c'.repeat(40) }, { branch: 'termag-ada/thr0000000001-docs', sha: 'd'.repeat(40) }]);
      expect(vi.mocked(confirmPushes).mock.calls[0][1]).toMatchObject({ repo: 'org/api', token: 'gho_ada', ownBranch: 'termag-ada/thr0000000001', prefix: 'termag-ada/thr0000000001' });
      expect(prisma.agentThreadPr.upsert.mock.calls.map(c => c[0].create)).toEqual([
        expect.objectContaining({ key: '', branch: 'termag-ada/thr0000000001', prNumber: 901 }),
        expect.objectContaining({ key: 'docs', branch: 'termag-ada/thr0000000001-docs', prNumber: 902 }),
      ]);
      expect(prisma.agentThread.update).toHaveBeenCalledWith({ where: { id: 'thr0000000001' }, data: { branch: 'termag-ada/thr0000000001', prNumber: 901, prUrl: 'https://github.com/org/api/pull/901' } });
      expect(data).toMatchObject({ publish: 'published' });
      expect(publishBundle).not.toHaveBeenCalled();
    });

    it("says none when the clone pushed nothing, and never looks for a bundle", async () => {
      const data = await finish([]);
      expect(data).toMatchObject({ publish: 'none', publishDetail: null });
      expect(confirmPushes).not.toHaveBeenCalled();
      expect(prisma.agentBundle.findUnique).not.toHaveBeenCalled();
    });

    // Reports cmvvbgpzk586mbcmx8srqaaen, cmvv15bkb1is114bd6ftao1iw: a follow-up after the conversion committed
    // and did not push, and was recorded `none` with no detail.
    it('is unpushed, naming the branches and the push, when the clone committed without pushing', async () => {
      const data = await finish([], [{ branch: 'ask', commits: 1 }, { branch: 'termag-ada/thr0000000001', commits: 2 }]);
      expect(data.publish).toBe('unpushed');
      expect(data.publishDetail).toBe("ask: 1 commit(s) committed but not pushed (the thread's branch is termag-ada/thr0000000001: git push origin ask:termag-ada/thr0000000001)"
        + ' | termag-ada/thr0000000001: 2 commit(s) committed but not pushed (git push origin termag-ada/thr0000000001)');
      expect(confirmPushes).not.toHaveBeenCalled();
    });

    it('is partial, naming the branch, when a pushed branch has no PR yet', async () => {
      vi.mocked(confirmPushes).mockResolvedValue([{ kind: 'no-pr', branch: 'termag-ada/thr0000000001', headSha: 'c'.repeat(40) }]);
      const data = await finish([{ branch: 'termag-ada/thr0000000001', sha: 'c'.repeat(40) }]);
      expect(data.publish).toBe('partial');
      expect(data.publishDetail).toContain('no pull request yet');
      expect(prisma.agentThreadPr.upsert).not.toHaveBeenCalled();
    });
  });
});
