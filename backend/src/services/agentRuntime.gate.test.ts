import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  row: null as { id: string; setupStatus: string } | null,
  foreground: '',
  sent: [] as { type: string; payload: Record<string, unknown> }[],
};

const prisma = {
  project: {
    findFirst: vi.fn(async () => state.row),
    findMany: vi.fn(async () => [] as unknown[]),
  },
  user: {
    findUnique: vi.fn(async () => ({ defaultAgentProvider: 'claude' })),
  },
};

const sendForProject = vi.fn(async (_host: unknown, type: string, payload: Record<string, unknown> = {}) => {
  state.sent.push({ type, payload });
  if (type === 'tmux-foreground-cmd') return { cmd: state.foreground };
  return {};
});

vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  sendForProject,
}));

const { ensureAgentSessionsAndLaunch, reconstructInstanceSessions } = await import('./agentRuntime');
const { SessionGateError } = await import('./sessionGate');

const launch = {
  userId: 'u1',
  unixUsername: 'alice',
  projectName: 'research',
  provider: 'claude',
  instanceId: 'box1',
  workstream: 'main',
  hostHome: '/home/alice',
};

const dir = '/home/alice/termag/projects/research';

beforeEach(() => {
  state.row = null;
  state.foreground = '';
  state.sent = [];
  vi.clearAllMocks();
});

describe('ensureAgentSessionsAndLaunch session gate', () => {
  it('refuses a project still waiting for its clone before sending anything', async () => {
    state.row = { id: 'p1', setupStatus: 'pending' };

    const err = await ensureAgentSessionsAndLaunch(launch).catch(e => e);

    expect(err).toBeInstanceOf(SessionGateError);
    expect(err.refusal).toEqual({
      setupStatus: 'pending',
      message: 'This project is waiting for its box to clone the repository.',
    });
    expect(state.sent).toEqual([]);
    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', instanceId: 'box1', name: 'research', archived: false },
      select: { id: true, setupStatus: true },
    });
  });

  it('refuses a cloning or failed project the same way', async () => {
    for (const setupStatus of ['cloning', 'failed']) {
      state.row = { id: 'p1', setupStatus };
      await expect(ensureAgentSessionsAndLaunch(launch)).rejects.toBeInstanceOf(SessionGateError);
    }
    expect(state.sent).toEqual([]);
  });

  it('lets the setup owner launch the project it is moving', async () => {
    state.row = { id: 'p1', setupStatus: 'pending' };

    const outcome = await ensureAgentSessionsAndLaunch({ ...launch, admission: { projectId: 'p1', from: 'pending' } });

    expect(outcome).toBe('launched');
    expect(state.sent).toEqual([
      { type: 'tmux-create', payload: { sessionName: 'alice-research-agent', cwd: dir } },
      { type: 'tmux-create', payload: { sessionName: 'alice-research-ctrl', cwd: dir } },
      { type: 'tmux-foreground-cmd', payload: { sessionName: 'alice-research-agent' } },
      { type: 'tmux-send-keys', payload: { sessionName: 'alice-research-agent', keys: 'claude', withEnter: true } },
    ]);
  });

  it('holds an admission for another project or another status to the gate', async () => {
    state.row = { id: 'p1', setupStatus: 'cloning' };
    await expect(ensureAgentSessionsAndLaunch({ ...launch, admission: { projectId: 'p2', from: 'cloning' } }))
      .rejects.toBeInstanceOf(SessionGateError);
    await expect(ensureAgentSessionsAndLaunch({ ...launch, admission: { projectId: 'p1', from: 'pending' } }))
      .rejects.toBeInstanceOf(SessionGateError);
    expect(state.sent).toEqual([]);
  });

  it('launches a project with no live row, or a settled one, as it always has', async () => {
    expect(await ensureAgentSessionsAndLaunch(launch)).toBe('launched');
    state.sent = [];
    state.row = { id: 'p1', setupStatus: 'ready' };
    expect(await ensureAgentSessionsAndLaunch(launch)).toBe('launched');
    expect(state.sent.map(s => s.type)).toEqual(['tmux-create', 'tmux-create', 'tmux-foreground-cmd', 'tmux-send-keys']);
  });

  it('reports a pane that already has git or an agent in it, and types nothing', async () => {
    state.row = { id: 'p1', setupStatus: 'none' };
    state.foreground = 'git';
    expect(await ensureAgentSessionsAndLaunch(launch)).toBe('busy');
    state.foreground = 'claude';
    expect(await ensureAgentSessionsAndLaunch(launch)).toBe('running');
    expect(state.sent.filter(s => s.type === 'tmux-send-keys')).toEqual([]);
  });
});

describe('reconstruction and setup status', () => {
  function projectRow(id: string, name: string, setupStatus: string) {
    return {
      id, name, setupStatus, userId: 'u1', instanceId: 'box1',
      instance: { hostHome: '/home/alice' },
      workflows: [{ type: 'agent', provider: 'claude', workstream: { name: 'main' } }],
    };
  }

  it('skips a project that is still cloning and resumes a settled one', async () => {
    prisma.project.findMany.mockResolvedValue([
      projectRow('p1', 'research', 'cloning'),
      projectRow('p2', 'notes', 'none'),
    ]);

    await reconstructInstanceSessions('box1', 'u1', 'alice');

    const sessions = state.sent.map(s => String(s.payload.sessionName));
    expect(sessions.filter(s => s.startsWith('alice-research-'))).toEqual([]);
    expect(state.sent.filter(s => s.type !== 'tmux-foreground-cmd')).toEqual([
      { type: 'tmux-create', payload: { sessionName: 'alice-notes-agent', cwd: '/home/alice/termag/projects/notes' } },
      { type: 'tmux-create', payload: { sessionName: 'alice-notes-ctrl', cwd: '/home/alice/termag/projects/notes' } },
      { type: 'tmux-send-keys', payload: { sessionName: 'alice-notes-agent', keys: 'claude --continue', withEnter: true } },
    ]);
  });

  it('skips a pending or failed project without probing it', async () => {
    prisma.project.findMany.mockResolvedValue([
      projectRow('p1', 'research', 'pending'),
      projectRow('p2', 'notes', 'failed'),
    ]);

    await reconstructInstanceSessions('box1', 'u1', 'alice');

    expect(state.sent).toEqual([]);
  });
});
