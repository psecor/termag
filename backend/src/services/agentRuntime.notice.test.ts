import { beforeEach, describe, expect, it, vi } from 'vitest';

// A tool update's restart notice (services/toolUpdate/notice.ts) in both launch
// paths: echoed ahead of a typed launch, handed to the agent for a bridge pane
// (Codex), and dropped when it is not safe to type.
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
vi.mock('./agentSpawnStore', () => ({ claimSpawnLaunch: vi.fn(async () => null), releaseSpawnLaunch: vi.fn(async () => {}), isParkedSpawn: vi.fn(async () => false), unparkOnLaunch: vi.fn(async () => {}), spawnTelemetryFor: vi.fn(async () => null) }));
vi.mock('./agentHandoffStore', () => ({ claimHandoffLaunch: vi.fn(async () => null), releaseHandoffLaunch: vi.fn(async () => {}) }));
// The fireworks-models flag for the owner and box (null = Fireworks off).
const fireworksFlag = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./fireworksFlag', async () => {
  const { parseFireworksModels } = await import('./fireworksGateway');
  return { fireworksModelsForBox: vi.fn(async () => parseFireworksModels(fireworksFlag.value)) };
});

const { ensureAgentSessionsAndLaunch, setPaneLaunchSettleForTests } = await import('./agentRuntime');
// Launches here follow one another into the same pane; the post-launch settle would only add waits.
setPaneLaunchSettleForTests(0);

const launch = { userId: 'u1', unixUsername: 'alice', projectName: 'research', provider: 'claude', instanceId: 'box1', workstream: 'main', hostHome: '/home/alice' };
const typed = () => state.sent.filter(s => s.type === 'tmux-send-keys').map(s => s.payload.keys);
// What a pane types ahead of every agent's command (services/launchCommand.ts PANE_KIND_ENV).
const K = 'TERMAG_SESSION_KIND=interactive ';

const NOTICE = '[termag] Claude Code was updated to 2.1.320 (automatic nightly run); resuming your session.';

beforeEach(() => {
  state.sent = [];
  state.failSend = false;
  state.foreground = 'zsh';
  vi.clearAllMocks();
});

describe('ensureAgentSessionsAndLaunch with a restart notice', () => {
  it('echoes the notice once, then the resume', async () => {
    await ensureAgentSessionsAndLaunch({ ...launch, resume: true, notice: NOTICE });
    expect(typed()).toEqual([`echo '${NOTICE}'; ${K}claude --continue`]);
  });

  it('types the launch alone without one', async () => {
    await ensureAgentSessionsAndLaunch({ ...launch, resume: true });
    expect(typed()).toEqual([`${K}claude --continue`]);
  });

  it('drops a notice that is not safe to type, and still launches', async () => {
    for (const notice of [`[termag] x'; touch /tmp/pwned; echo '`, '[termag] $(id)', '[termag] `id`', '[termag] a\nb', '[termag] a\\b', 'x'.repeat(201)]) {
      state.sent = [];
      state.foreground = 'zsh';
      await ensureAgentSessionsAndLaunch({ ...launch, resume: true, notice });
      expect(typed()).toEqual([`${K}claude --continue`]);
    }
  });

  it('hands a bridge pane\'s notice to the agent, which types it after its clear', async () => {
    await ensureAgentSessionsAndLaunch({ ...launch, provider: 'codex', resume: true, resumeSessionId: '0198c1b2-0000-7000-8000-000000000001', notice: NOTICE });
    expect(state.sent.find(s => s.type === 'codex-session-start')?.payload).toMatchObject({ resumeSessionId: '0198c1b2-0000-7000-8000-000000000001', notice: NOTICE });
    state.sent = [];
    state.foreground = 'zsh';
    await ensureAgentSessionsAndLaunch({ ...launch, provider: 'codex', notice: "it's" });
    expect(state.sent.find(s => s.type === 'codex-session-start')?.payload).not.toHaveProperty('notice');
  });
});
