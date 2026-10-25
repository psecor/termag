import { beforeEach, describe, expect, it, vi } from 'vitest';

// The handoff launch claim's wiring in both launch paths:
// consulted after the spawn claim, skipped when a spawn claims first, released
// when typing the launch fails.
const state = {
  sent: [] as { type: string; payload: Record<string, unknown> }[],
  failSend: false,
  // What the pane's foreground process is; a typed launch starts the agent.
  foreground: 'zsh',
};

const prisma = {
  project: {
    findFirst: vi.fn(async () => ({ id: 'p1', setupStatus: 'ready' })),
    findMany: vi.fn(async () => [{
      id: 'p1', name: 'research', setupStatus: 'ready', instance: { hostHome: '/home/alice' },
      workflows: [{ type: 'agent', provider: 'claude', workstream: { name: 'main' } }],
    }]),
  },
  user: { findUnique: vi.fn(async () => ({ defaultAgentProvider: 'claude' })) },
  // The workstream's agent row, for its model backend.
  workflow: { findFirst: vi.fn(async (): Promise<{ backend: string | null; model?: string | null } | null> => null) },
};

const sendForProject = vi.fn(async (_host: unknown, type: string, payload: Record<string, unknown> = {}) => {
  state.sent.push({ type, payload });
  if (type === 'tmux-foreground-cmd') return { cmd: state.foreground };
  if (type === 'tmux-send-keys' && state.failSend) throw new Error('tmux gone');
  if (type === 'tmux-send-keys') state.foreground = 'claude';
  return {};
});

vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => true),
  instanceAgentTransport: vi.fn(() => ({ conn: {}, capabilities: [], agentCommit: null, agentCommitAt: null, helloReceived: true })),
  sendForProject,
}));
vi.mock('./agentSpawnStore', () => ({ claimSpawnLaunch: vi.fn(async () => null), releaseSpawnLaunch: vi.fn(async () => {}), isParkedSpawn: vi.fn(async () => false), unparkOnLaunch: vi.fn(async () => {}) }));
vi.mock('./agentHandoffStore', () => ({ claimHandoffLaunch: vi.fn(async () => null), releaseHandoffLaunch: vi.fn(async () => {}) }));
// The fireworks-models flag for the owner and box (null = Fireworks off).
const fireworksFlag = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./fireworksFlag', async () => {
  const { parseFireworksModels } = await import('./fireworksGateway');
  return { fireworksModelsForBox: vi.fn(async () => parseFireworksModels(fireworksFlag.value)) };
});

const { ensureAgentSessionsAndLaunch, reconstructInstanceSessions, withPaneLock, setPaneLaunchSettleForTests } = await import('./agentRuntime');
// Launches here follow one another into the same pane; the post-launch settle would only add waits.
setPaneLaunchSettleForTests(0);
const { claimSpawnLaunch } = await import('./agentSpawnStore');
const { claimHandoffLaunch, releaseHandoffLaunch } = await import('./agentHandoffStore');

const launch = { userId: 'u1', unixUsername: 'alice', projectName: 'research', provider: 'claude', instanceId: 'box1', workstream: 'main', hostHome: '/home/alice' };
const typed = () => state.sent.filter(s => s.type === 'tmux-send-keys').map(s => s.payload.keys);
const handoff = { id: 'ck1', command: 'claude "$(cat "$HOME/.termag/handoffs/ck1.md")"' };

beforeEach(() => {
  state.sent = [];
  state.failSend = false;
  state.foreground = 'zsh';
  vi.clearAllMocks();
});

describe('ensureAgentSessionsAndLaunch', () => {
  it('starts a pane a handoff restart killed on the handoff', async () => {
    vi.mocked(claimHandoffLaunch).mockResolvedValueOnce(handoff);
    await ensureAgentSessionsAndLaunch(launch);
    expect(claimHandoffLaunch).toHaveBeenCalledWith({ userId: 'u1', projectId: 'p1', workstream: 'main', provider: 'claude' });
    expect(typed()).toEqual([handoff.command]);
  });

  it('leaves the handoff alone when a spawn brief claims the launch first', async () => {
    vi.mocked(claimSpawnLaunch).mockResolvedValueOnce({ id: 'sp1', command: 'claude "$(cat brief)"' });
    await ensureAgentSessionsAndLaunch(launch);
    expect(claimHandoffLaunch).not.toHaveBeenCalled();
    expect(typed()).toEqual(['claude "$(cat brief)"']);
  });

  it('starts on the user\'s first prompt from its file, after a spawn brief or a handoff', async () => {
    await ensureAgentSessionsAndLaunch({ ...launch, workstream: 'termag-pr1', firstPrompt: 'Describe termag#1.' });
    expect(state.sent.find(s => s.type === 'write-file')?.payload).toEqual({
      path: '/home/alice/.termag/first-prompts/alice-research-termag-pr1-agent.md', content: 'Describe termag#1.\n', mode: 0o600,
    });
    expect(typed()).toEqual(['claude "$(cat "$HOME/.termag/first-prompts/alice-research-termag-pr1-agent.md")"']);
    state.sent = [];
    state.foreground = 'zsh';
    vi.mocked(claimHandoffLaunch).mockResolvedValueOnce(handoff);
    await ensureAgentSessionsAndLaunch({ ...launch, firstPrompt: 'Describe termag#1.' });
    expect(state.sent.some(s => s.type === 'write-file')).toBe(false);
    expect(typed()).toEqual([handoff.command]);
  });

  it('types nothing when another launch is starting the handoff in this pane', async () => {
    vi.mocked(claimHandoffLaunch).mockResolvedValueOnce('held');
    await expect(ensureAgentSessionsAndLaunch(launch)).resolves.toBe('running');
    expect(typed()).toEqual([]);
  });

  it('hands the claim back when typing the launch fails', async () => {
    vi.mocked(claimHandoffLaunch).mockResolvedValueOnce(handoff);
    state.failSend = true;
    await expect(ensureAgentSessionsAndLaunch(launch)).rejects.toThrow('tmux gone');
    expect(releaseHandoffLaunch).toHaveBeenCalledWith('ck1');
  });

  it('unparks a parked spawn only once its launch was typed, not when typing fails', async () => {
    const { unparkOnLaunch } = await import('./agentSpawnStore');
    state.failSend = true;
    await expect(ensureAgentSessionsAndLaunch(launch)).rejects.toThrow('tmux gone');
    expect(unparkOnLaunch).not.toHaveBeenCalled();
    state.failSend = false;
    state.sent = [];
    await ensureAgentSessionsAndLaunch(launch);
    expect(unparkOnLaunch).toHaveBeenCalledWith('u1', 'p1', 'main');
  });
});

describe('ensureAgentSessionsAndLaunch: the workstream\'s model backend', () => {
  it('starts on the backend its agent row names, on a box that can run it', async () => {
    const { instanceAgentTransport } = await import('./agentRegistry');
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {}, capabilities: ['fireworks-v1'], agentCommit: null, agentCommitAt: null, helloReceived: true } as never);
    const KIMI = 'accounts/fireworks/models/kimi-k3';
    const DS = 'accounts/fireworks/models/deepseek-v4p1-flash';
    fireworksFlag.value = { default: KIMI, fast: DS, models: [{ id: KIMI, context: 1048576 }, { id: DS, context: 512000 }] };
    prisma.workflow.findFirst.mockResolvedValueOnce({ backend: 'fireworks' });
    await ensureAgentSessionsAndLaunch(launch);
    expect(prisma.workflow.findFirst).toHaveBeenCalledWith({ where: { projectId: 'p1', type: 'agent', workstream: { name: 'main' } }, select: { backend: true, model: true } });
    // No model picked: the flag's default, and Claude Code's window is the smaller of it and the fast model.
    expect(typed()).toEqual([`termag_settings=$(TERMAG_PROJECT=research TERMAG_WORKSTREAM=main termag-credentials launch-settings --backend fireworks --model ${KIMI} --fast ${DS} --context 512000 -) && claude --settings "$termag_settings"`]);

    state.sent = [];
    state.foreground = 'zsh';
    fireworksFlag.value = null;
    prisma.workflow.findFirst.mockResolvedValueOnce({ backend: 'fireworks', model: KIMI });
    await ensureAgentSessionsAndLaunch(launch);
    expect(typed()[0]).toMatch(/^echo 'termag: Fireworks models are not on for you/);
  });

  it('takes the caller\'s backend over the row, and the default for a backend the provider cannot run on', async () => {
    const { instanceAgentTransport } = await import('./agentRegistry');
    vi.mocked(instanceAgentTransport).mockReturnValue({ conn: {}, capabilities: ['fireworks-v1'], agentCommit: null, agentCommitAt: null, helloReceived: true } as never);
    await ensureAgentSessionsAndLaunch({ ...launch, backend: null });
    expect(prisma.workflow.findFirst).not.toHaveBeenCalled();
    expect(typed()).toEqual(['claude']);
    state.sent = [];
    state.foreground = 'zsh';
    prisma.workflow.findFirst.mockResolvedValueOnce({ backend: 'fireworks' });
    await ensureAgentSessionsAndLaunch({ ...launch, provider: 'cursor' });
    expect(typed()).toEqual(['cursor-agent']);
  });
});

describe('ensureAgentSessionsAndLaunch: the workstream\'s model', () => {
  it('starts on the model its agent row names, and drops one the provider and backend do not offer', async () => {
    prisma.workflow.findFirst.mockResolvedValueOnce({ backend: null, model: 'sonnet' });
    await ensureAgentSessionsAndLaunch(launch);
    expect(typed()).toEqual(['claude --model sonnet']);
    state.sent = [];
    state.foreground = 'zsh';
    prisma.workflow.findFirst.mockResolvedValueOnce({ backend: null, model: 'accounts/fireworks/models/kimi-k3' });
    await ensureAgentSessionsAndLaunch(launch);
    expect(typed()).toEqual(['claude']);
  });
});

describe('one launch at a time per pane', () => {
  it('a reconnect racing a handoff relaunch types once: the second sees the agent the first started', async () => {
    vi.mocked(claimHandoffLaunch).mockResolvedValueOnce(handoff);
    await Promise.all([ensureAgentSessionsAndLaunch(launch), reconstructInstanceSessions('box1', 'u1', 'alice')]);
    expect(typed()).toEqual([handoff.command]);
  });

  it('runs one holder at a time per key, others in parallel, and survives a throwing holder', async () => {
    const order: string[] = [];
    const hold = (key: string, tag: string, ms: number, fail = false) => withPaneLock(key, async () => {
      order.push(`${tag}+`);
      await new Promise(r => setTimeout(r, ms));
      order.push(`${tag}-`);
      if (fail) throw new Error('boom');
    });
    await Promise.allSettled([hold('a', 'a1', 20, true), hold('a', 'a2', 1), hold('b', 'b1', 1)]);
    expect(order.indexOf('a1-')).toBeLessThan(order.indexOf('a2+'));
    expect(order.indexOf('b1+')).toBeLessThan(order.indexOf('a1-'));
  });
});

describe('reconnect reconstruction', () => {
  it('starts on the handoff instead of resuming the conversation it handed off', async () => {
    vi.mocked(claimHandoffLaunch).mockResolvedValueOnce(handoff);
    await reconstructInstanceSessions('box1', 'u1', 'alice');
    expect(claimHandoffLaunch).toHaveBeenCalledWith({ userId: 'u1', projectId: 'p1', workstream: 'main', provider: 'claude' });
    expect(typed()).toEqual([handoff.command]);
  });

  it('never types the resume command over a handoff launch another path just made', async () => {
    vi.mocked(claimHandoffLaunch).mockResolvedValueOnce('held');
    await reconstructInstanceSessions('box1', 'u1', 'alice');
    expect(typed()).toEqual([]);
  });

  it('resumes as before when there is no handoff, and releases one whose launch fails', async () => {
    await reconstructInstanceSessions('box1', 'u1', 'alice');
    expect(typed()).toEqual(['claude --continue']);
    state.sent = [];
    state.foreground = 'zsh'; // the resumed agent exited again
    vi.mocked(claimHandoffLaunch).mockResolvedValueOnce(handoff);
    state.failSend = true;
    await reconstructInstanceSessions('box1', 'u1', 'alice');
    expect(releaseHandoffLaunch).toHaveBeenCalledWith('ck1');
  });

  it('leaves a parked spawn\'s pane stopped across a reconnect', async () => {
    const { isParkedSpawn } = await import('./agentSpawnStore');
    vi.mocked(isParkedSpawn).mockResolvedValueOnce(true);
    await reconstructInstanceSessions('box1', 'u1', 'alice');
    expect(typed()).toEqual([]);
  });
});
