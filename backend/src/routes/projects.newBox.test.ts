import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logs } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';

/**
 * A new box and its first project, asked for together: the project waits as
 * `pending` while the box boots and is set up by the box agent's first hello
 * (services/projectClone.ts), so neither the browser tab nor the CLI has to
 * stay around. A box that fails to launch is relaunched by the project's Retry.
 */

type ProjectRow = {
  id: string; name: string; userId: string; instanceId: string | null;
  repoUrl: string | null; setupStatus: string; setupAttempt: number;
};
type BoxRow = {
  id: string; userId: string; kind: string; status: string; hostHome: string; name: string; ec2InstanceId: string | null;
};

const state = {
  project: null as ProjectRow | null,
  workflows: [] as { id: string; type: string; provider: string; workstream: { name: string } }[],
  box: null as BoxRow | null,
  connected: false,
  sent: [] as { type: string; payload: Record<string, unknown> }[],
};

const prisma = {
  instance: {
    findFirst: vi.fn(async () => state.box),
    findUnique: vi.fn(async () => state.box),
    updateMany: vi.fn(async (args: { where: { status: string }; data: { status: string } }) => {
      if (!state.box || state.box.status !== args.where.status) return { count: 0 };
      state.box.status = args.data.status;
      return { count: 1 };
    }),
  },
  agentToken: { updateMany: vi.fn(async () => ({ count: 1 })) },
  project: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(async () => ({ ...state.project, workflows: state.workflows, workstreams: [] })),
    findMany: vi.fn(async () => (state.project ? [{ id: state.project.id }] : [])),
    create: vi.fn(async (args: { data: Omit<ProjectRow, 'id' | 'setupAttempt'> }) => {
      const { name, userId, instanceId, repoUrl, setupStatus } = args.data;
      state.project = { id: 'p1', name, userId, instanceId, repoUrl, setupStatus, setupAttempt: 0 };
      return state.project;
    }),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async (args: { where: { setupStatus?: string }; data: Partial<ProjectRow> }) => {
      if (!state.project) return { count: 0 };
      if (args.where.setupStatus && state.project.setupStatus !== args.where.setupStatus) return { count: 0 };
      Object.assign(state.project, args.data);
      return { count: 1 };
    }),
    delete: vi.fn(async () => ({})),
  },
  workstream: {
    upsert: vi.fn(async () => ({ id: 'ws1', name: 'main' })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  workflow: {
    create: vi.fn(async (args: { data: { provider: string } }) => {
      const row = { id: 'w1', type: 'agent', provider: args.data.provider, workstream: { name: 'main' } };
      state.workflows.push(row);
      return row;
    }),
  },
  user: { findUnique: vi.fn(async () => ({ defaultAgentProvider: 'claude' })) },
  userCredential: { findUnique: vi.fn(async () => ({ provider: 'github' })) },
};

const createBox = vi.fn();
const terminateBox = vi.fn(async () => true);

// The product events the create records (services/productEvents.ts), read
// off a log exporter as the backend sends them.
const logExporter = new InMemoryLogRecordExporter();
logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] }));
const productEvents = () => logExporter.getFinishedLogRecords().map(r => r.attributes);

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn(), requireAuthOrAgentToken: vi.fn() }));
vi.mock('../slack/channels', () => ({ createProjectChannel: vi.fn(async () => null) }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn() }));
vi.mock('../services/status', () => ({ deleteStatus: vi.fn(), setStatus: vi.fn(), notifyStatusChange: vi.fn() }));
vi.mock('./instances', () => ({ createBox }));
vi.mock('../services/chatSpace', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/chatSpace')>()),
  chatSpaceFor: vi.fn(async () => ({ space: null, reachable: false })),
  fixListedChatSpaces: vi.fn(),
  resolveChatSpaceChoice: vi.fn(async (name: string | null | undefined) => (name === null ? { spaceId: null } : name === 'design' ? { spaceId: 's-design' } : null)),
}));
vi.mock('../services/boxProvisioner', () => ({ isBoxProvisioningConfigured: () => true, terminateBox }));
const applyAskBoxPolicy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/boxLifecycle', async importOriginal => ({ ...(await importOriginal<object>()), applyAskBoxPolicy }));
vi.mock('../services/agentRegistry', () => ({
  isAgentConnected: vi.fn(() => state.connected),
  isProjectAgentConnected: vi.fn(() => state.connected),
  instanceAgentTransport: vi.fn(() => (state.connected
    ? { conn: {}, capabilities: ['project-clone-v1'], agentCommit: null, helloReceived: true }
    : null)),
  onBoxAgentHello: vi.fn(() => () => {}),
  onBoxAgentFrame: vi.fn(() => () => {}),
  sendForProject: vi.fn(async (_host: unknown, type: string, payload: Record<string, unknown> = {}) => {
    state.sent.push({ type, payload });
    return type === 'tmux-foreground-cmd' ? { cmd: '' } : {};
  }),
  sendToAgent: vi.fn(),
  sendToInstanceAgent: vi.fn(),
}));

// The CLI's create re-reads the project for its answer; the shape is cliStorePrisma's concern.
vi.mock('../services/cliStorePrisma', () => ({
  prismaCliStore: { listProjects: vi.fn(async () => [{ id: 'p1', name: 'notes' }]), listBoxes: vi.fn(async () => []) },
}));

const { createProjectFor, retryCloneFor } = await import('./projects');
const { prismaCliLifecycle } = await import('./cliLifecyclePrisma');
const { setWorkspaceChangeCallback } = await import('../services/workspaceEvents');
const { applySetupEvent } = await import('../services/projectClone');
const { setPaneLaunchSettleForTests } = await import('../services/agentRuntime');
// Launches here follow one another into the same pane; the post-launch settle would only add waits.
setPaneLaunchSettleForTests(0);

const user = {
  id: 'u1', unixUsername: 'alice', defaultAgentProvider: 'claude',
  role: 'user', googleEmail: 'alice@example.com',
} as unknown as Express.User;

function box(status: string): BoxRow {
  return { id: 'box1', userId: 'u1', kind: 'ec2', status, hostHome: '/home/alice', name: 'alice-box', ec2InstanceId: null };
}

beforeEach(() => {
  state.project = null;
  state.workflows = [];
  state.box = null;
  state.connected = false;
  state.sent = [];
  logExporter.reset();
  vi.clearAllMocks();
  prisma.project.findFirst.mockImplementation(async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
    const p = state.project;
    if (!p || args.where.archived === true) return null;
    if (args.where.id !== undefined && args.where.id !== p.id) return null;
    if (args.where.name !== undefined && args.where.name !== p.name) return null;
    if (args.where.instanceId !== undefined && args.where.instanceId !== p.instanceId) return null;
    return {
      ...p,
      workflows: state.workflows,
      workstreams: [{ branch: 'main' }],
      instance: state.box,
      user: { unixUsername: 'alice', defaultAgentProvider: 'claude' },
    };
  });
  prisma.project.findUnique.mockImplementation(async () => state.project && {
    ...state.project, name: state.project.name, user: { unixUsername: 'alice' },
  });
});

const empty = { name: 'notes', instanceId: 'box1', initialAgent: { enabled: true, provider: 'claude' } };
const types = () => state.sent.map(s => s.type);

describe('a project asked for with a new box', () => {
  it('waits for a provisioning box, then is set up by its first hello', async () => {
    state.box = box('provisioning');
    const result = await createProjectFor(user, empty);
    expect(result.status).toBe(201);
    expect(state.project?.setupStatus).toBe('pending');
    expect(state.workflows).toHaveLength(1);
    expect(state.sent).toEqual([]);

    state.box.status = 'ready';
    state.connected = true;
    const outcome = await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, {
      kind: 'agent-connected', capabilities: ['project-clone-v1'],
    });
    expect(outcome).toEqual({ kind: 'applied', from: 'pending', to: 'none' });
    expect(state.project?.setupStatus).toBe('none');
    expect(types()).toContain('mkdir');
    expect(types()).toContain('init-wiki');
    expect(types()).toContain('tmux-create');
    expect(types()).not.toContain('project-clone');
  });

  it('still launches when the hello lands before the project has its workflow', async () => {
    state.box = box('provisioning');
    prisma.workflow.create.mockImplementationOnce(async (args: { data: { provider: string } }) => {
      state.box!.status = 'ready';
      state.connected = true;
      await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, {
        kind: 'agent-connected', capabilities: ['project-clone-v1'],
      });
      expect(types()).not.toContain('tmux-create');
      const row = { id: 'w1', type: 'agent', provider: args.data.provider, workstream: { name: 'main' } };
      state.workflows.push(row);
      return row;
    });
    const result = await createProjectFor(user, empty);
    expect(result.status).toBe(201);
    expect(state.project?.setupStatus).toBe('none');
    expect(types()).toContain('mkdir');
    expect(types()).toContain('tmux-create');
  });

  it('is set up at once on a box that is already up, as before', async () => {
    state.box = box('ready');
    state.connected = true;
    const result = await createProjectFor(user, empty);
    expect(result.status).toBe(201);
    expect(state.project?.setupStatus).toBe('none');
    expect(types()).toContain('mkdir');
  });

  it('records New session\'s space, or its "No space", on the chat; says nothing for a create that names none (plan-outbox #38)', async () => {
    const { chatSpaceFor } = await import('../services/chatSpace');
    state.box = box('ready');
    state.connected = true;
    prisma.workstream.upsert.mockClear();
    // Fixed in the insert of the main workstream itself, so a listing during the create can't fix it first (Bugbot, #769).
    // The insert is the first upsert of a create (createProjectFor's own check after it updates nothing).
    const created = () => {
      const calls = prisma.workstream.upsert.mock.calls as unknown as Array<[{ create: Record<string, unknown> }]>;
      const c = calls.map(x => x[0].create);
      prisma.workstream.upsert.mockClear();
      return c[0];
    };
    expect((await createProjectFor(user, { ...empty, chatSpace: 'design' })).status).toBe(201);
    expect(created()).toMatchObject({ spaceId: 's-design', spaceFixedAt: expect.any(Date) });
    expect(vi.mocked(chatSpaceFor)).toHaveBeenLastCalledWith('ws1', { requested: { name: 'design', userId: 'u1' } });
    state.project = null;
    await createProjectFor(user, { ...empty, chatSpace: null });
    expect(created()).toMatchObject({ spaceId: null, spaceFixedAt: expect.any(Date) });
    expect(vi.mocked(chatSpaceFor)).toHaveBeenLastCalledWith('ws1', { requested: { name: null, userId: 'u1' } });
    vi.mocked(chatSpaceFor).mockClear();
    state.project = null;
    await createProjectFor(user, empty);
    expect(vi.mocked(chatSpaceFor)).not.toHaveBeenCalled();
    expect(created()).not.toHaveProperty('spaceFixedAt');
  });

  it('keeps "Act as an orchestrator" only for a trusted chat', async () => {
    state.box = box('provisioning');
    const chat = { ...empty, initialAgent: { enabled: true, provider: 'claude-chat' } };
    const stored = () => (prisma.project.create.mock.calls.at(-1)![0] as { data: { chatOrchestrator: boolean } }).data.chatOrchestrator;
    await createProjectFor(user, { ...chat, chatTrusted: true, chatOrchestrator: true });
    expect(stored()).toBe(true);
    for (const input of [
      { ...chat, chatTrusted: false, chatOrchestrator: true },
      { ...chat, chatTrusted: true },
      { ...empty, chatTrusted: true, chatOrchestrator: true },
    ]) {
      state.project = null;
      await createProjectFor(user, input);
      expect(stored()).toBe(false);
    }
  });

  it('creates a claude-chat project, and refuses pi-chat until the runner has a pi engine', async () => {
    state.box = box('ready');
    state.connected = true;
    const chat = (provider: string) => ({ ...empty, initialAgent: { enabled: true, provider } });
    expect(await createProjectFor(user, chat('pi-chat'))).toEqual({
      status: 400, body: { error: 'pi-chat cannot run yet: the chat runner has no pi engine' },
    });
    expect(prisma.project.create).not.toHaveBeenCalled();
    expect((await createProjectFor(user, chat('claude-chat'))).status).toBe(201);
    expect(state.workflows.map(w => w.provider)).toEqual(['claude-chat']);
  });

  it('records the create and the agent launch as product events, keyed by the user and the box', async () => {
    state.box = box('ready');
    state.connected = true;
    expect((await createProjectFor(user, { ...empty, warmClaimed: true })).status).toBe(201);
    expect(productEvents()).toEqual([
      {
        'event.name': 'project.created', 'termag.user.id': 'u1', 'termag.box.id': 'box1',
        'termag.provider': 'claude', 'termag.repoSource': 'empty', 'termag.boxKind': 'box', 'termag.warmClaimed': true, 'termag.spawned': false,
      },
      {
        'event.name': 'agent.session.started', 'termag.user.id': 'u1', 'termag.box.id': 'box1',
        'termag.provider': 'claude', 'termag.kind': 'interactive', 'termag.resume': false, 'termag.spawned': false, 'termag.clone': false,
      },
    ]);
  });

  it('records no launch event for a project still waiting for its box', async () => {
    state.box = box('provisioning');
    expect((await createProjectFor(user, empty)).status).toBe(201);
    expect(productEvents().map(a => a['event.name'])).toEqual(['project.created']);
  });

  it('says the box failed, not that its agent is away, when the launch failed first', async () => {
    state.box = { ...box('failed'), provisioningError: 'No box AMI found' } as BoxRow;
    expect(await createProjectFor(user, empty)).toEqual({
      status: 409, body: { error: 'The box failed to launch: No box AMI found', code: 'box-failed' },
    });
    expect(prisma.project.create).not.toHaveBeenCalled();
  });

  it('still refuses a ready box whose agent is away', async () => {
    state.box = box('ready');
    expect(await createProjectFor(user, empty)).toEqual({ status: 503, body: { error: 'Box agent is not connected' } });
    expect(prisma.project.create).not.toHaveBeenCalled();
  });
});

describe('Retry on a project whose box failed to launch', () => {
  beforeEach(async () => {
    state.box = box('provisioning');
    await createProjectFor(user, empty);
    state.box.status = 'failed';
  });

  it('retires the failed box, launches one of the same name and moves the project onto it', async () => {
    createBox.mockResolvedValue({ status: 201, body: { instance: { id: 'box2' }, claimed: false } });
    const result = await retryCloneFor(user, 'p1');
    expect(result).toEqual({ status: 202, body: { setupStatus: 'pending', instanceId: 'box2' } });
    expect(state.box?.status).toBe('terminated');
    expect(terminateBox).toHaveBeenCalledOnce();
    expect(createBox).toHaveBeenCalledWith(user, { name: 'alice-box', kind: 'ec2', flavor: 'full' }, { relaunchSize: undefined, relaunchDiskGiB: null });
    expect(state.project).toMatchObject({ instanceId: 'box2', setupStatus: 'pending' });
  });

  it("launches the replacement at the failed box's size", async () => {
    (state.box as unknown as { size: string }).size = 'medium';
    createBox.mockResolvedValue({ status: 201, body: { instance: { id: 'box2' }, claimed: false } });
    await retryCloneFor(user, 'p1');
    expect(createBox).toHaveBeenCalledWith(user, { name: 'alice-box', kind: 'ec2', flavor: 'full' }, { relaunchSize: 'medium', relaunchDiskGiB: null });
  });

  it("keeps an ask box's ask-box policy on the replacement (termag ask --new-box rerun after a failed launch)", async () => {
    (state.box as unknown as { createdFor: string }).createdFor = 'ask';
    createBox.mockResolvedValue({ status: 201, body: { instance: { id: 'box2' }, claimed: false } });
    expect((await retryCloneFor(user, 'p1')).status).toBe(202);
    expect(applyAskBoxPolicy).toHaveBeenCalledWith('box2');
  });

  it('gives any other box no ask-box policy', async () => {
    createBox.mockResolvedValue({ status: 201, body: { instance: { id: 'box2' }, claimed: false } });
    await retryCloneFor(user, 'p1');
    expect(applyAskBoxPolicy).not.toHaveBeenCalled();
  });

  it('relaunches a failed minimal box as minimal, not as the full bake', async () => {
    state.box = { ...box('provisioning'), flavor: 'minimal' };
    await createProjectFor(user, empty);
    state.box.status = 'failed';
    createBox.mockResolvedValue({ status: 201, body: { instance: { id: 'box2' }, claimed: false } });
    await retryCloneFor(user, 'p1');
    expect(createBox).toHaveBeenCalledWith(user, { name: 'alice-box', kind: 'ec2', flavor: 'minimal' }, { relaunchSize: undefined, relaunchDiskGiB: null });
  });

  it('leaves the project on the retired box when no new box can be made, so Retry can try again', async () => {
    createBox.mockResolvedValue({ status: 409, body: { error: 'Connect GitHub first', code: 'github-required' } });
    expect(await retryCloneFor(user, 'p1')).toEqual({ status: 409, body: { error: 'Connect GitHub first', code: 'github-required' } });
    expect(state.box?.status).toBe('terminated');
    expect(state.project?.instanceId).toBe('box1');

    createBox.mockResolvedValue({ status: 201, body: { instance: { id: 'box3' }, claimed: true } });
    expect((await retryCloneFor(user, 'p1')).status).toBe(202);
    expect(terminateBox).toHaveBeenCalledOnce();
    expect(state.project?.instanceId).toBe('box3');
  });
});

describe('termag project create <box>/<project> --new-box', () => {
  afterEach(() => setWorkspaceChangeCallback(null));

  it("tells the owner's tabs the project list changed, so /chat and the full UI show it without a reload", async () => {
    const changed = vi.fn();
    setWorkspaceChangeCallback(changed);
    state.box = box('provisioning');
    prisma.user.findUnique.mockResolvedValueOnce(user as never);
    const result = await prismaCliLifecycle.createProject({ id: 'u1' } as never, { boxId: 'box1', name: 'notes', agent: 'claude' });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ project: { id: 'p1' }, restored: false });
    expect(changed.mock.calls).toEqual([['u1', 'projects']]);
  });

  it('says nothing when the create is refused', async () => {
    const changed = vi.fn();
    setWorkspaceChangeCallback(changed);
    prisma.user.findUnique.mockResolvedValueOnce(user as never);
    const result = await prismaCliLifecycle.createProject({ id: 'u1' } as never, { boxId: 'box1', name: '', agent: 'claude' });
    expect(result.status).toBe(400);
    expect(changed).not.toHaveBeenCalled();
  });
});
