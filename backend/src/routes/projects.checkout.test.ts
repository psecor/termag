import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A reconnect during the pane checkout's delivery wait used to type the bare
 * resume command, because reconstruction launches from the agent workflow
 * row. The launch then probed "running" and never typed the clone. The row is
 * now committed up front and the session gate keeps reconstruction off the
 * project until the clone is typed. These tests drive that reconnect through
 * the real runtime.
 */

type WorkflowRow = { id: string; type: string; provider: string; workstream: { name: string } };
type ProjectRow = {
  id: string; name: string; userId: string; instanceId: string | null;
  repoUrl: string | null; setupStatus: string; setupAttempt: number;
};
type Box = ReturnType<typeof box>;

const state = {
  workflows: [] as WorkflowRow[],
  project: null as ProjectRow | null,
  box: null as Box | null,
  deliveryReads: 0,
  foreground: '' as string,
  sent: [] as { type: string; payload: Record<string, unknown> }[],
  order: [] as string[],
};

const prisma = {
  instance: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  project: {
    findFirst: vi.fn(async (_args: { where: Record<string, unknown> }): Promise<unknown> => null),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(),
    delete: vi.fn(async () => ({})),
  },
  workstream: {
    upsert: vi.fn(async () => ({ id: 'ws1', name: 'main' })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  workflow: {
    create: vi.fn(),
  },
  user: {
    findUnique: vi.fn(async () => ({ defaultAgentProvider: 'claude' })),
  },
  userCredential: {
    findUnique: vi.fn(async () => ({ provider: 'github' })),
  },
};

const sendForProject = vi.fn(async (_host: unknown, type: string, payload: Record<string, unknown> = {}) => {
  state.sent.push({ type, payload });
  if (type === 'tmux-send-keys') {
    const keys = String(payload.keys ?? '');
    // A bare resume is what reconstruction types. Once that is in the pane the
    // next probe reports the agent, and the clone is no longer typed.
    if (!keys.includes('git fetch')) state.foreground = 'claude';
  }
  if (type === 'tmux-foreground-cmd') return { cmd: state.foreground };
  return {};
});

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn(), requireAuthOrAgentToken: vi.fn() }));
vi.mock('../slack/channels', () => ({ createProjectChannel: vi.fn(async () => null) }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn() }));
vi.mock('../services/status', () => ({ deleteStatus: vi.fn(), setStatus: vi.fn(), notifyStatusChange: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({
  isAgentConnected: vi.fn(() => true),
  isProjectAgentConnected: vi.fn(() => true),
  instanceAgentTransport: vi.fn(() => ({ conn: {}, capabilities: [], agentCommit: null, helloReceived: true })),
  onBoxAgentHello: vi.fn(() => () => {}),
  onBoxAgentFrame: vi.fn(() => () => {}),
  sendForProject,
  sendToAgent: vi.fn(),
  sendToInstanceAgent: vi.fn(),
}));

const { createProjectFor } = await import('./projects');
const { reconstructInstanceSessions } = await import('../services/agentRuntime');

const user = {
  id: 'u1', unixUsername: 'alice', defaultAgentProvider: 'claude',
  role: 'admin', adminSource: 'grant', googleEmail: 'alice@example.com',
} as unknown as Express.User;

function box(kind: 'ec2' | 'external') {
  return {
    id: 'box1', userId: 'u1', kind, status: 'ready', hostHome: '/home/alice', name: 'alice-box',
  };
}

async function findProject(args: { where: Record<string, unknown> }) {
  const { where } = args;
  const p = state.project;
  if (!p || where.archived === true) return null;
  if (where.id !== undefined && where.id !== p.id) return null;
  if (where.name !== undefined && where.name !== p.name) return null;
  return {
    ...p,
    workflows: state.workflows,
    workstreams: [{ branch: 'HEAD' }],
    instance: state.box && { hostHome: state.box.hostHome, kind: state.box.kind, userId: state.box.userId },
    user: { unixUsername: 'alice', defaultAgentProvider: 'claude' },
  };
}

beforeEach(() => {
  state.workflows = [];
  state.project = null;
  state.box = null;
  state.deliveryReads = 0;
  state.foreground = '';
  state.sent = [];
  state.order = [];
  vi.clearAllMocks();

  prisma.instance.findFirst.mockImplementation(async () => state.box);
  prisma.project.findFirst.mockImplementation(findProject);
  prisma.project.updateMany.mockImplementation(async (args: { where: { setupStatus: string }; data: { setupStatus: string } }) => {
    if (!state.project || state.project.setupStatus !== args.where.setupStatus) return { count: 0 };
    state.project.setupStatus = args.data.setupStatus;
    return { count: 1 };
  });
  prisma.workstream.upsert.mockResolvedValue({ id: 'ws1', name: 'main' });
  prisma.user.findUnique.mockResolvedValue({ defaultAgentProvider: 'claude' });
  prisma.userCredential.findUnique.mockResolvedValue({ provider: 'github' });
  prisma.project.create.mockImplementation(async (args: { data: Omit<ProjectRow, 'id' | 'setupAttempt'> }) => {
    state.order.push('project');
    const { name, userId, instanceId, repoUrl, setupStatus } = args.data;
    state.project = { id: 'p1', name, userId, instanceId, repoUrl, setupStatus, setupAttempt: 0 };
    return state.project;
  });
  prisma.project.findUnique.mockImplementation(async (args: { select?: unknown }) => {
    if (args?.select) {
      return { name: state.project?.name ?? 'research', instanceId: state.project?.instanceId ?? null, user: { unixUsername: 'alice' } };
    }
    return { ...state.project, workflows: state.workflows, workstreams: [{ id: 'ws1', name: 'main' }] };
  });
  prisma.project.findUniqueOrThrow.mockImplementation(async () => ({
    ...state.project, workflows: state.workflows, workstreams: [{ id: 'ws1', name: 'main' }],
  }));
  prisma.project.findMany.mockImplementation(async () => (state.project ? [{
    ...state.project,
    workflows: state.workflows.map(w => ({ ...w, workstream: { name: 'main' } })),
    instance: { hostHome: '/home/alice' },
  }] : []));
  prisma.workflow.create.mockImplementation(async (args: { data: { provider: string } }) => {
    state.order.push('workflow');
    const row = { id: 'w1', type: 'agent', provider: args.data.provider, workstream: { name: 'main' } };
    state.workflows.push(row);
    return row;
  });
});

function keysSent(): string[] {
  return state.sent.filter(s => s.type === 'tmux-send-keys').map(s => String(s.payload.keys));
}

describe('repo create checkout', () => {
  it('a reconnect during the delivery wait still runs the clone', async () => {
    state.box = box('ec2');
    let reconstructed = false;
    let sentDuringReconnect: typeof state.sent | null = null;
    prisma.instance.findUnique.mockImplementation(async () => {
      state.order.push('delivery-read');
      state.deliveryReads += 1;
      if (!reconstructed) {
        reconstructed = true;
        const before = state.sent.length;
        await reconstructInstanceSessions('box1', 'u1', 'alice');
        sentDuringReconnect = state.sent.slice(before);
        return { githubDeliveredAt: null, onClaimStatus: 'pending' };
      }
      return { githubDeliveredAt: new Date('2026-10-09T00:00:00Z'), onClaimStatus: 'succeeded' };
    });

    const result = await createProjectFor(user, {
      name: 'research',
      instanceId: 'box1',
      initialAgent: { enabled: true, provider: 'claude' },
      repoUrl: 'https://github.com/example-org/research.git',
    });

    expect(result.status).toBe(201);
    expect(state.deliveryReads).toBe(2);
    expect(sentDuringReconnect).toEqual([]);
    const keys = keysSent();
    expect(keys).toEqual([
      expect.stringContaining('git fetch --progress origin'),
    ]);
    expect(keys[0]).toContain('GIT_CONFIG_GLOBAL=/dev/null git fetch --progress origin');
    expect(keys[0]).toContain('&& claude');
    expect(keys.some(k => k === 'claude' || k === 'claude --continue')).toBe(false);
  });

  it('keeps the user gitconfig for an external box and a host create', async () => {
    state.box = box('external');
    const external = await createProjectFor(user, {
      name: 'research',
      instanceId: 'box1',
      initialAgent: { enabled: true, provider: 'claude' },
      repoUrl: 'https://github.com/example-org/research.git',
    });
    expect(external.status).toBe(201);
    expect(state.deliveryReads).toBe(0);
    expect(keysSent()).toHaveLength(1);
    expect(keysSent()[0]).toContain('git fetch --progress origin');
    expect(keysSent()[0]).not.toContain('GIT_CONFIG_GLOBAL');

    state.workflows = [];
    state.project = null;
    state.box = null;
    state.foreground = '';
    state.sent = [];
    const host = await createProjectFor(user, {
      name: 'notes',
      initialAgent: { enabled: true, provider: 'claude' },
      repoUrl: 'https://github.com/example-org/research.git',
    });
    expect(host.status).toBe(201);
    expect(state.deliveryReads).toBe(0);
    expect(keysSent()).toHaveLength(1);
    expect(keysSent()[0]).toContain("{ git remote add origin 'https://github.com/example-org/research.git'");
    expect(keysSent()[0]).not.toContain('GIT_CONFIG_GLOBAL');
  });

  it('records a listed default branch on the main workstream', async () => {
    state.box = box('ec2');
    const result = await createProjectFor(user, {
      name: 'widget',
      instanceId: 'box1',
      initialAgent: { enabled: true, provider: 'claude' },
      repoUrl: 'https://github.com/acme/widget.git',
      defaultBranch: 'develop',
    });
    expect(result.status).toBe(201);
    expect(prisma.project.create.mock.calls[0][0].data.repoUrl).toBe('https://github.com/acme/widget.git');
    expect(prisma.workstream.upsert.mock.calls[0][0].create.branch).toBe('develop');
  });

  it('records HEAD when a repo create names no branch', async () => {
    state.box = box('ec2');
    const result = await createProjectFor(user, {
      name: 'widget',
      instanceId: 'box1',
      initialAgent: { enabled: true, provider: 'claude' },
      repoUrl: 'https://github.com/acme/widget.git',
    });
    expect(result.status).toBe(201);
    expect(prisma.workstream.upsert.mock.calls[0][0].create.branch).toBe('HEAD');
  });

  it('records main for an empty boxed project', async () => {
    state.box = box('ec2');
    const result = await createProjectFor(user, {
      name: 'notes',
      instanceId: 'box1',
      initialAgent: { enabled: true, provider: 'claude' },
    });
    expect(result.status).toBe(201);
    expect(prisma.project.create.mock.calls[0][0].data.repoUrl).toBe(null);
    expect(prisma.workstream.upsert.mock.calls[0][0].create.branch).toBe('main');
    expect(prisma.project.findFirst.mock.calls[0][0].where).toEqual({
      userId: 'u1', name: 'notes', archived: true,
    });
  });

  it('refuses a repo create when that name is archived on this box', async () => {
    state.box = box('ec2');
    prisma.project.findFirst.mockResolvedValue({
      id: 'old', name: 'widget', archived: true, instanceId: 'box1', workflows: [],
    });
    const result = await createProjectFor(user, {
      name: 'widget',
      instanceId: 'box1',
      initialAgent: { enabled: true, provider: 'claude' },
      repoUrl: 'https://github.com/acme/widget.git',
      defaultBranch: 'develop',
    });
    expect(result).toEqual({
      status: 409,
      body: { error: 'An archived project with this name exists on this box' },
    });
    expect(prisma.project.findFirst.mock.calls[0][0].where).toEqual({
      userId: 'u1', name: 'widget', archived: true, instanceId: 'box1',
    });
    expect(state.sent).toEqual([]);
  });
});
