import { beforeEach, describe, expect, it, vi } from 'vitest';

// The legacy path: a project that lives on the orchestrator itself, with no box
// agent connected, launches in the orchestrator's own tmux.
const typed: string[] = [];

const prisma = {
  project: {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => [] as unknown[]),
  },
  user: {
    findUnique: vi.fn(async () => ({ defaultAgentProvider: 'claude' })),
  },
  workflow: { findFirst: vi.fn(async () => null) },
};

vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: vi.fn(() => false),
  instanceAgentTransport: vi.fn(() => null),
  sendForProject: vi.fn(async () => ({})),
}));
vi.mock('./tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tmux')>()),
  ensureProjectDir: vi.fn(async () => undefined),
  ensureSession: vi.fn(async () => true),
  sendKeys: vi.fn(async (_session: string, keys: string) => { typed.push(keys); }),
}));

const { ensureAgentSessionsAndLaunch, setPaneLaunchSettleForTests } = await import('./agentRuntime');
setPaneLaunchSettleForTests(0);

const launch = {
  userId: 'u1',
  unixUsername: 'alice',
  projectName: 'research',
  provider: 'claude',
  instanceId: null,
  workstream: 'main',
};

beforeEach(() => {
  typed.length = 0;
});

describe('ensureAgentSessionsAndLaunch on the orchestrator (no box agent)', () => {
  it('types the agent with its session kind, as a box pane does', async () => {
    expect(await ensureAgentSessionsAndLaunch(launch)).toBe('launched');
    expect(typed).toEqual(['TERMAG_SESSION_KIND=interactive claude']);
  });

  it('keeps the kind on the agent, not on the step before it', async () => {
    expect(await ensureAgentSessionsAndLaunch({ ...launch, preLaunch: 'git clone x' })).toBe('launched');
    expect(typed).toEqual(['git clone x && TERMAG_SESSION_KIND=interactive claude']);
  });
});
