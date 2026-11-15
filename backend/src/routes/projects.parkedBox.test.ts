import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logs } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';

/**
 * Runs on: Auto's Send on a parked box ("Send never
 * waits on a box"): with box-placement-enabled, POST /api/projects takes the
 * caller's own stopped, hibernated, starting, stopping or hibernating box, the
 * project waits `pending` for its agent, and the box is woken once
 * (services/sessionBoxWake.ts). Off, a parked box is refused as before.
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
    findMany: vi.fn(async () => (state.box ? [{ name: state.box.name }] : [])),
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
    count: vi.fn(async () => 0),
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
const powerOwnedBox = vi.hoisted(() => vi.fn(async (): Promise<{ status: number; body: unknown }> => ({ status: 202, body: { ok: true, status: 'starting' } })));
const flags = vi.hoisted(() => ({ placement: true }));
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
const terminateOwnedBox = vi.hoisted(() => vi.fn(async () => ({ status: 200, body: {} })));
vi.mock('./instances', () => ({ createBox, powerOwnedBox, terminateOwnedBox }));
vi.mock('../services/featureFlags', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/featureFlags')>()),
  boolVariation: vi.fn(async (key: string, _u: unknown, fallback: boolean) => (key === 'box-placement-enabled' ? flags.placement : fallback)),
}));
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

// An environment named in a create (services/environments.ts): its repositories, and what of its definition was left out.
const environmentWarnings = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('../services/environments', async importOriginal => {
  const real = await importOriginal<typeof import('../services/environments')>();
  return {
    ...real,
    withEnvironmentRepos: vi.fn(async (store: unknown, userId: string, input: { environment?: string | null }) => {
      if (!input.environment) return { input, warnings: [] };
      const { environment: _e, ...rest } = input;
      return { input: rest, warnings: environmentWarnings.list, environmentId: 'e-shop' };
    }),
  };
});
const { createProjectFor, moveToNewBoxFor } = await import('./projects');
const { sessionWakes } = await import('../services/sessionBoxWake');
const { applySetupEvent, redispatchClones } = await import('../services/projectClone');
const { setPaneLaunchSettleForTests } = await import('../services/agentRuntime');
// Launches here follow one another into the same pane; the post-launch settle would only add waits.
setPaneLaunchSettleForTests(0);

const user = {
  id: 'u1', unixUsername: 'alice', defaultAgentProvider: 'claude',
  role: 'user', googleEmail: 'alice@example.com',
} as unknown as Express.User;

function box(status: string): BoxRow {
  return { id: 'box1', userId: 'u1', kind: 'ec2', status, hostHome: '/home/alice', name: 'alice-box', ec2InstanceId: 'i-1' };
}

beforeEach(() => {
  state.project = null;
  state.workflows = [];
  state.box = null;
  state.connected = false;
  state.sent = [];
  logExporter.reset();
  vi.clearAllMocks();
  flags.placement = true;
  sessionWakes.reset();
  powerOwnedBox.mockImplementation(async () => { if (state.box) state.box.status = 'starting'; return { status: 202, body: { ok: true, status: 'starting' } }; });
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

const repo = { name: 'web', instanceId: 'box1', initialAgent: { enabled: true, provider: 'claude' }, repoUrl: 'https://github.com/acme/web' };
const empty = { name: 'notes', instanceId: 'box1', initialAgent: { enabled: true, provider: 'claude' } };

describe('a session on a parked box', () => {
  it('is refused as before while box-placement-enabled is off', async () => {
    flags.placement = false;
    state.box = box('stopped');
    const result = await createProjectFor(user, repo);
    expect(result).toEqual({ status: 409, body: { error: 'This box is stopped. Start it from the Boxes list first.' } });
    expect(state.project).toBeNull();
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });

  for (const asleep of ['stopped', 'hibernated']) {
    it(`opens at once on a ${asleep} box, waits pending for its agent, and wakes it once`, async () => {
      state.box = box(asleep);
      const result = await createProjectFor(user, repo);
      expect(result.status).toBe(201);
      expect(state.project?.setupStatus).toBe('pending');
      expect((result.body as { wake?: unknown }).wake).toEqual({ state: 'waking' });
      expect(powerOwnedBox).toHaveBeenCalledTimes(1);
      expect(powerOwnedBox).toHaveBeenCalledWith(expect.anything(), 'box1', 'start');
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
      expect(state.sent).toEqual([]);
    });
  }

  it('waits on a starting box without starting it again', async () => {
    state.box = box('starting');
    const result = await createProjectFor(user, empty);
    expect(result.status).toBe(201);
    expect(state.project?.setupStatus).toBe('pending');
    expect((result.body as { wake?: unknown }).wake).toBeUndefined();
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });

  for (const down of ['stopping', 'hibernating']) {
    it(`sends nothing to a ${down} box whose agent is still connected, and starts it once it is down`, async () => {
      state.box = box(down);
      state.connected = true;
      const result = await createProjectFor(user, repo);
      expect(result.status).toBe(201);
      expect(state.project?.setupStatus).toBe('pending');
      expect((result.body as { wake?: unknown }).wake).toEqual({ state: 'held' });
      expect(state.sent.map(s => s.type)).not.toContain('project-clone');
      expect(state.sent.map(s => s.type)).not.toContain('mkdir');
      expect(powerOwnedBox).not.toHaveBeenCalled();
      state.connected = false;
      state.box.status = down === 'stopping' ? 'stopped' : 'hibernated';
      await sessionWakes.sweep();
      expect(powerOwnedBox).toHaveBeenCalledTimes(1);
    });
  }

  it('says why when the wake is refused, and still opens the session', async () => {
    state.box = box('stopped');
    powerOwnedBox.mockImplementation(async () => ({ status: 502, body: { error: 'EC2 refused the start: InsufficientInstanceCapacity' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await createProjectFor(user, repo);
    warn.mockRestore();
    expect(result.status).toBe(201);
    expect((result.body as { wake?: unknown }).wake).toEqual({ state: 'failed', error: "Couldn't wake alice-box: EC2 refused the start: InsufficientInstanceCapacity" });
    expect(sessionWakes.errorFor('box1')).toBe("Couldn't wake alice-box: EC2 refused the start: InsufficientInstanceCapacity");
  });

  it("refuses someone else's box as before", async () => {
    state.box = null;
    const result = await createProjectFor(user, repo);
    expect(result).toEqual({ status: 400, body: { error: 'instanceId not found or not owned by you' } });
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });

  it('never takes a quarantined box', async () => {
    state.box = box('quarantined');
    const result = await createProjectFor(user, repo);
    expect(result.status).toBe(409);
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });

  it("keeps refusing an automation's project on a parked box", async () => {
    state.box = box('stopped');
    const result = await createProjectFor(user, { ...repo, kind: 'automation' });
    expect(result.status).toBe(409);
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });

  it('leaves an up box as it was', async () => {
    state.box = box('ready');
    state.connected = true;
    const result = await createProjectFor(user, repo);
    expect(result.status).toBe(201);
    expect((result.body as { wake?: unknown }).wake).toBeUndefined();
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });
});

describe('a box on its way down whose agent reconnects', () => {
  it('runs no waiting checkout until the box is started again', async () => {
    state.box = box('stopping');
    state.connected = true;
    await createProjectFor(user, repo);
    expect(state.project?.setupStatus).toBe('pending');
    const hello = { instance: { id: 'box1' }, user: { id: 'u1' }, settled: Promise.resolve() } as unknown as Parameters<typeof redispatchClones>[0];
    prisma.project.findMany.mockClear();
    await redispatchClones(hello);
    // Not even looked for: the box's waiting checkouts wait for the hello after it's started again.
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    expect(state.sent.map(s => s.type)).not.toContain('project-clone');
    state.box.status = 'ready';
    await redispatchClones(hello);
    expect(prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instanceId: 'box1', setupStatus: { in: ['pending', 'cloning'] } }) }));
  });
});

describe('renaming an archived project aside on a parked box', () => {
  it('is refused as before, and nothing is renamed or woken', async () => {
    state.box = box('hibernated');
    state.project = { id: 'p1', name: 'web', userId: 'u1', instanceId: 'box1', repoUrl: null, setupStatus: 'none', setupAttempt: 0 };
    prisma.project.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => (args.where.archived === true
      ? { ...state.project, archived: true, updatedAt: new Date(0), workflows: [], workstreams: [{ name: 'main' }] }
      : null));
    const result = await createProjectFor(user, { ...repo, archivedName: 'rename-aside' });
    expect(result).toEqual({ status: 409, body: { error: 'This box is hibernated. Resume it from the Boxes list first.' } });
    expect(state.project?.name).toBe('web');
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });
});

describe('un-archiving onto a parked box', () => {
  it('is refused as before, and nothing is woken', async () => {
    state.box = box('stopped');
    state.project = { id: 'p1', name: 'web', userId: 'u1', instanceId: 'box1', repoUrl: null, setupStatus: 'none', setupAttempt: 0 };
    prisma.project.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => (args.where.archived === true
      ? { ...state.project, archived: true, updatedAt: new Date(0), workflows: [], workstreams: [{ name: 'main' }] }
      : null));
    const result = await createProjectFor(user, { ...repo, archivedName: 'unarchive' });
    expect(result).toEqual({ status: 409, body: { error: 'This box is stopped. Start it from the Boxes list first.' } });
    expect(powerOwnedBox).not.toHaveBeenCalled();
  });
});

describe("a multi-repo session's hello on a box going down", () => {
  it('dispatches nothing until the box is started again', async () => {
    const { onHello } = await import('../services/workspaceSetup');
    state.box = box('hibernating');
    const hello = { instance: { id: 'box1' }, user: { id: 'u1' }, settled: Promise.resolve() } as unknown as Parameters<typeof onHello>[0];
    prisma.project.findMany.mockClear();
    await onHello(hello);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    state.box.status = 'ready';
    await onHello(hello);
    expect(prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ layout: 'workspace' }) }));
  });
});

describe('Start on a new box, for a session whose box would not wake', () => {
  beforeEach(() => {
    prisma.project.findFirst.mockImplementation(async () => state.project && {
      id: state.project.id, layout: 'repo', setupStatus: state.project.setupStatus, instanceId: state.project.instanceId,
      repoUrl: state.project.repoUrl, repos: [],
      instance: state.box ? { name: state.box.name, status: state.box.status } : null,
    });
    createBox.mockResolvedValue({ status: 201, body: { instance: { id: 'box2', name: 'alice-box-2' } } });
  });

  async function waitingOnStoppedBox() {
    state.box = box('stopped');
    powerOwnedBox.mockImplementation(async () => ({ status: 502, body: { error: 'EC2 refused the start: InsufficientInstanceCapacity' } }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createProjectFor(user, repo);
    expect(state.project?.setupStatus).toBe('pending');
  }

  it('makes a new box with its own name and moves only this session onto it', async () => {
    await waitingOnStoppedBox();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await moveToNewBoxFor(user, 'p1');
    expect(r).toEqual({ status: 202, body: { instanceId: 'box2', name: 'alice-box-2' } });
    expect(createBox).toHaveBeenCalledWith(user, { name: 'alice-box-2', kind: 'ec2', repo: 'https://github.com/acme/web' });
    expect(state.project?.instanceId).toBe('box2');
    expect(state.box?.status).toBe('stopped');
  });

  it('takes the new box back when the session moved on while it was being made', async () => {
    await waitingOnStoppedBox();
    createBox.mockImplementation(async () => { state.project!.setupStatus = 'cloning'; return { status: 201, body: { instance: { id: 'box2', name: 'alice-box-2' } } }; });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await moveToNewBoxFor(user, 'p1');
    expect(r.status).toBe(409);
    expect(terminateOwnedBox).toHaveBeenCalledWith(user, 'box2', true);
    expect(state.project?.instanceId).toBe('box1');
  });

  it('leaves the new box be when another session landed on it meanwhile', async () => {
    await waitingOnStoppedBox();
    createBox.mockImplementation(async () => { state.project!.setupStatus = 'cloning'; return { status: 201, body: { instance: { id: 'box2', name: 'alice-box-2' } } }; });
    prisma.project.count.mockResolvedValueOnce(1);
    expect((await moveToNewBoxFor(user, 'p1')).status).toBe(409);
    expect(terminateOwnedBox).not.toHaveBeenCalled();
  });

  it('is off with the flag, and only for a session still waiting on a box that is not up', async () => {
    await waitingOnStoppedBox();
    flags.placement = false;
    expect((await moveToNewBoxFor(user, 'p1')).status).toBe(404);
    flags.placement = true;
    state.box!.status = 'ready';
    expect((await moveToNewBoxFor(user, 'p1')).status).toBe(409);
    state.box!.status = 'stopped';
    state.project!.setupStatus = 'ready';
    expect((await moveToNewBoxFor(user, 'p1')).status).toBe(409);
    expect(createBox).not.toHaveBeenCalled();
  });
});
