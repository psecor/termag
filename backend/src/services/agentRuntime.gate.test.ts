import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  row: null as { id: string; setupStatus: string } | null,
  foreground: '',
  capabilities: [] as string[],
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
  workflow: { findFirst: vi.fn(async () => null) },
};

const sendForProject = vi.fn(async (_host: unknown, type: string, payload: Record<string, unknown> = {}) => {
  state.sent.push({ type, payload });
  if (type === 'tmux-foreground-cmd') return { cmd: state.foreground };
  return {};
});

vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  instanceAgentTransport: vi.fn(() => ({ conn: {}, capabilities: state.capabilities, agentCommit: null, agentCommitAt: null, helloReceived: true })),
  sendForProject,
}));

const { ensureAgentSessionsAndLaunch, reconstructInstanceSessions, setPaneLaunchSettleForTests } = await import('./agentRuntime');
// Launches here follow one another into the same pane; the post-launch settle would only add waits.
setPaneLaunchSettleForTests(0);
const { SessionGateError } = await import('./sessionGate');
const { PANE_KIND_ENV: K, RESUME_FALLBACK_NOTICE } = await import('./launchCommand');
const { resetClaimUpdateGate, trackClaimUpdate } = await import('./claimUpdateGate');

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
  state.capabilities = [];
  state.sent = [];
  vi.clearAllMocks();
  resetClaimUpdateGate();
});

// A box just claimed from the pool runs current main before its first launch (claimUpdate.ts).
describe('ensureAgentSessionsAndLaunch on a box whose claim update is running', () => {
  it('sends nothing to the box until the update is done, then launches', async () => {
    let done!: () => void;
    trackClaimUpdate('box1', new Promise<void>(r => { done = r; }));

    const launched = ensureAgentSessionsAndLaunch(launch);
    await new Promise(r => setTimeout(r, 20));
    expect(state.sent).toEqual([]);

    done();
    await expect(launched).resolves.toBe('launched');
    expect(state.sent.map(s => s.type)).toContain('tmux-send-keys');
  });

  it('launches when the update fails, as it does after a timeout', async () => {
    trackClaimUpdate('box1', Promise.reject(new Error('box-update failed')));
    await expect(ensureAgentSessionsAndLaunch(launch)).resolves.toBe('launched');
  });

  it('does not wait for another box', async () => {
    trackClaimUpdate('box2', new Promise<void>(() => {}));
    await expect(ensureAgentSessionsAndLaunch(launch)).resolves.toBe('launched');
  });
});

describe('ensureAgentSessionsAndLaunch session gate', () => {
  it('refuses a project still waiting for its clone before sending anything', async () => {
    state.row = { id: 'p1', setupStatus: 'pending' };

    const err = await ensureAgentSessionsAndLaunch(launch).catch(e => e);

    expect(err).toBeInstanceOf(SessionGateError);
    expect(err.refusal).toEqual({
      setupStatus: 'pending',
      message: 'This project is waiting for its box.',
    });
    expect(state.sent).toEqual([]);
    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', instanceId: 'box1', name: 'research', archived: false },
      select: { id: true, setupStatus: true, repoUrl: true, chatTrustedAt: true },
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
      { type: 'tmux-send-keys', payload: { sessionName: 'alice-research-agent', keys: 'TERMAG_SESSION_KIND=interactive claude', withEnter: true } },
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

  it('types the replay settings into a Claude launch from a browser when the box can print them', async () => {
    const replaySessionId = 'huuhcqcev124emZ9urmRjjPSNXLl';
    state.capabilities = ['credentials-v1', 'telemetry-v1', 'telemetry-replay-v1'];
    expect(await ensureAgentSessionsAndLaunch({ ...launch, replaySessionId, preLaunch: 'git clone x' })).toBe('launched');
    expect(state.sent.filter(s => s.type === 'tmux-send-keys')).toEqual([{
      type: 'tmux-send-keys',
      payload: {
        sessionName: 'alice-research-agent',
        // The pane's project and workstream ride ahead of the box script (services/launchCommand.ts).
        keys: `git clone x && TERMAG_SESSION_KIND=interactive claude --settings "$(TERMAG_SESSION_KIND=interactive TERMAG_PROJECT=research TERMAG_WORKSTREAM=main termag-credentials telemetry-launch ${replaySessionId})"`,
        withEnter: true,
      },
    }]);
  });

  it('types the bare command on a box without the subcommand', async () => {
    state.capabilities = ['credentials-v1', 'telemetry-v1'];
    expect(await ensureAgentSessionsAndLaunch({ ...launch, replaySessionId: 'huuhcqcev124emZ9urmRjjPSNXLl' })).toBe('launched');
    expect(state.sent.filter(s => s.type === 'tmux-send-keys').map(s => s.payload.keys)).toEqual(['TERMAG_SESSION_KIND=interactive claude']);
  });

  it('types the project and workstream without a replay when the box can print them, else the bare command', async () => {
    state.capabilities = ['telemetry-replay-v1'];
    expect(await ensureAgentSessionsAndLaunch(launch)).toBe('launched');
    expect(state.sent.filter(s => s.type === 'tmux-send-keys').map(s => s.payload.keys))
      .toEqual(['TERMAG_SESSION_KIND=interactive claude --settings "$(TERMAG_SESSION_KIND=interactive TERMAG_PROJECT=research TERMAG_WORKSTREAM=main termag-credentials telemetry-launch -)"']);
    state.sent = [];
    state.capabilities = ['credentials-v1'];
    expect(await ensureAgentSessionsAndLaunch(launch)).toBe('launched');
    expect(state.sent.filter(s => s.type === 'tmux-send-keys').map(s => s.payload.keys)).toEqual(['TERMAG_SESSION_KIND=interactive claude']);
  });

  it("starts a Codex pane through the bridge, naming the pane's project and workstream for its resource", async () => {
    expect(await ensureAgentSessionsAndLaunch({ ...launch, provider: 'codex' })).toBe('launched');
    expect(state.sent.filter(s => s.type === 'tmux-send-keys')).toEqual([]);
    expect(state.sent.filter(s => s.type === 'codex-session-start')).toEqual([{
      type: 'codex-session-start',
      payload: { sessionName: 'alice-research-agent', cwd: dir, project: 'research', workstream: 'main' },
    }]);
  });

  it('resumes a Codex pane by id only when a tool update names the conversation; a bare resume starts fresh as before', async () => {
    const id = '01a18c85-d963-7800-93d4-991c84da09d5';
    expect(await ensureAgentSessionsAndLaunch({ ...launch, provider: 'codex', resume: true, resumeSessionId: id })).toBe('launched');
    expect(await ensureAgentSessionsAndLaunch({ ...launch, provider: 'codex', resume: true })).toBe('launched');
    expect(await ensureAgentSessionsAndLaunch({ ...launch, provider: 'codex', resumeSessionId: id })).toBe('launched');
    expect(state.sent.filter(s => s.type === 'codex-session-start').map(s => s.payload)).toEqual([
      { sessionName: 'alice-research-agent', cwd: dir, project: 'research', workstream: 'main', resumeSessionId: id },
      { sessionName: 'alice-research-agent', cwd: dir, project: 'research', workstream: 'main' },
      { sessionName: 'alice-research-agent', cwd: dir, project: 'research', workstream: 'main' },
    ]);
  });

  it('resumes a Cursor pane by chat id only on a tool update\'s relaunch; anything else launches as before', async () => {
    const chat = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    expect(await ensureAgentSessionsAndLaunch({ ...launch, provider: 'cursor', resume: true, resumeSessionId: chat })).toBe('launched');
    expect(await ensureAgentSessionsAndLaunch({ ...launch, provider: 'cursor', resume: true })).toBe('launched');
    expect(await ensureAgentSessionsAndLaunch({ ...launch, provider: 'cursor', resume: true, resumeSessionId: 'x; rm -rf ~' })).toBe('launched');
    const keys = state.sent.filter(s => s.type === 'tmux-send-keys').map(s => String(s.payload.keys));
    expect(keys).toHaveLength(3);
    expect(keys[0]).toContain(`cursor-agent --resume ${chat}`);
    for (const k of keys.slice(1)) { expect(k).toContain('cursor-agent'); expect(k).not.toContain('--resume'); expect(k).not.toContain('rm -rf'); }
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
      { type: 'tmux-send-keys', payload: { sessionName: 'alice-notes-agent', keys: `{ ${K}claude --continue; } || { [ $? -eq 1 ] && echo '${RESUME_FALLBACK_NOTICE}' && ${K}claude; }`, withEnter: true } },
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
