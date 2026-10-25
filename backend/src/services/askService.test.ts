import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => {
  const p = {
    project: { findUnique: vi.fn(), findMany: vi.fn() },
    projectShare: { findUnique: vi.fn() },
    agentMessage: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    agentThread: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    workstream: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() },
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
vi.mock('./boxPower', () => ({ PowerRequestConflict: class extends Error {}, requestPower: vi.fn() }));
vi.mock('./boxProvisioner', () => ({ isBoxProvisioningConfigured: vi.fn(() => true) }));
vi.mock('./credentialStore', () => ({ githubTokenSource: vi.fn(async () => null) }));
vi.mock('./askPublish', () => ({ publishBundle: vi.fn(), publishConfigFromEnv: vi.fn(() => ({})) }));
vi.mock('./askReplyListener', () => ({ startReplyListener: vi.fn(), stopReplyListener: vi.fn() }));
// Sharing on for everyone: an ask must stay owner-only whatever a flag says.
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => true), stringVariation: vi.fn(async () => ''), isLdEnabled: vi.fn(() => true) }));
vi.mock('./boxSharingFlag', () => ({ boxSharingEnabled: vi.fn(async () => true), BOX_SHARING_FLAG: 'box-sharing-enabled', SHARING_DISABLED_CODE: 'sharing_disabled' }));

import { prismaCliAsk } from './askService';
import { instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import { MAX_ACTIVE_ASKS, type AskRequest } from './agentMessages';
import type { CliUser } from './cliStore';

const ada = { id: 'u-ada', unixUsername: 'ada', displayName: 'Ada', googleEmail: 'ada@example.com' } as CliUser;

function projectRow(over: { userId?: string; boxOwner?: string | null; instance?: null } = {}) {
  const userId = over.userId ?? 'u-ada';
  return {
    id: 'p1', name: 'api', userId, archived: false, instanceId: over.instance === null ? null : 'box1',
    setupStatus: 'ready', setupError: null,
    user: { id: userId, unixUsername: userId === 'u-ada' ? 'ada' : 'bob' },
    workstreams: [{ name: 'main' }],
    instance: over.instance === null ? null : {
      id: 'box1', name: 'devbox', hostHome: '/home/ada', status: 'ready', kind: 'ec2',
      userId: over.boxOwner === undefined ? userId : over.boxOwner,
    },
  };
}

const req = (over: Partial<AskRequest> = {}): AskRequest => ({
  ref: null, projectId: 'p1', workstream: 'main', prompt: 'what does this do?', threadId: null, messageId: null, ...over,
});

function setup(project: ReturnType<typeof projectRow>, active = 0) {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  prisma.project.findUnique.mockResolvedValue(project);
  prisma.projectShare.findUnique.mockResolvedValue(project.userId === 'u-ada' ? null : { id: 's1', projectId: 'p1', userId: 'u-ada' });
  prisma.agentMessage.findUnique.mockResolvedValue(null);
  prisma.agentMessage.count.mockResolvedValue(active);
  prisma.agentThread.create.mockResolvedValue({ id: 'thr0000000001', projectId: 'p1', chatWorkstreamId: null, hopCount: 1, claudeSessionId: null, baseSha: null });
  prisma.workstream.findFirst.mockResolvedValue(null);
  prisma.workstream.create.mockResolvedValue({ id: 'ws-ask', name: 'ask-thr0000000001' });
  prisma.agentMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'msg0000000001', ...data }));
  prisma.agentMessage.updateMany.mockResolvedValue({ count: 1 });
}

const askRunCalls = () => vi.mocked(sendToInstanceAgent).mock.calls.filter(c => c[1] === 'ask-run');

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
