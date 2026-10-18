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
vi.mock('./agentSpawnStore', () => ({ claimSpawnLaunch: vi.fn(async () => null), releaseSpawnLaunch: vi.fn(async () => {}) }));
vi.mock('./agentHandoffStore', () => ({ claimHandoffLaunch: vi.fn(async () => null), releaseHandoffLaunch: vi.fn(async () => {}) }));

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
});
