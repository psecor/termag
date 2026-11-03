/**
 * A stale pool box, claimed and launched on, end to end in one process: the
 * claim's update (claimUpdate.ts, on a box simulated in memory) and the real
 * pane launch (agentRuntime.ts). On 2026-10-30 a box like this one launched
 * Claude Code on Fireworks without the /model menu, because its agent ran the
 * image's commit; here the launch waits for the update and its hello, and
 * types the menu.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OLD = 'ac81b246'.padEnd(40, '0');
const MAIN = '64688acd'.padEnd(40, '0');
const BASE = ['credentials-v1', 'fireworks-v1', 'box-update-v1', 'tmux-create-command-v1'];

/** The box: its agent, and what the RPCs it got did. */
const box = {
  conn: {} as object,
  commit: OLD,
  capabilities: [...BASE] as string[],
  rpcs: [] as string[],
};

vi.mock('../db', () => ({
  prisma: {
    project: { findFirst: vi.fn(async () => ({ id: 'p1', setupStatus: 'none', repoUrl: null, chatTrustedAt: null })) },
    workflow: { findFirst: vi.fn(async () => ({ backend: 'fireworks', model: null })) },
  },
}));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: () => true,
  instanceAgentTransport: () => ({ conn: box.conn, capabilities: box.capabilities, agentCommit: box.commit, agentCommitAt: null, helloReceived: true }),
  instanceAgentSettled: () => true,
  dropInstanceAgent: () => true,
  sendToInstanceAgent: async () => ({ ok: true }),
  sendForProject: vi.fn(async (_host: unknown, type: string, payload: Record<string, unknown> = {}) => {
    box.rpcs.push(type === 'tmux-send-keys' ? `${type} ${String(payload.keys)}` : type);
    return type === 'tmux-foreground-cmd' ? { cmd: 'zsh' } : {};
  }),
}));
vi.mock('./fireworksFlag', () => ({
  fireworksModelsForBox: async () => ({
    models: [{ id: 'accounts/fireworks/models/kimi-k2', label: 'Kimi K2' }, { id: 'accounts/fireworks/models/glm-4p6', label: 'GLM 4.6' }],
    defaultModel: 'accounts/fireworks/models/kimi-k2',
    fastModel: 'accounts/fireworks/models/kimi-k2',
  }),
}));
vi.mock('./boxUpdate', () => ({ BOX_UPDATE_CAPABILITY: 'box-update-v1', noteClaimUpdated: () => {} }));
vi.mock('./termagVersion', () => ({ termagVersion: async () => ({ sha: MAIN, source: 'git' }) }));

const { startClaimUpdate } = await import('./claimUpdate');
const { resetClaimUpdateGate } = await import('./claimUpdateGate');
const { ensureAgentSessionsAndLaunch, setPaneLaunchSettleForTests } = await import('./agentRuntime');
setPaneLaunchSettleForTests(0);

const claimed = { id: 'box1', name: 'ada-pool-box', kind: 'ec2', userId: 'u_ada' };
const launch = {
  userId: 'u_ada', unixUsername: 'ada', projectName: 'web', provider: 'claude',
  instanceId: 'box1', workstream: 'main', hostHome: '/home/ada',
};

/**
 * The box side of `box-update` on a short real clock: termag-box-update pulls
 * main, reconciles (installing the termag-credentials that carries the menu
 * marker) and restarts the agent, whose hello brings the new capability.
 */
function updatingBox(opts: { reports: boolean }) {
  let reportAt: number | null = null;
  return {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 5))),
    targetCommit: async () => MAIN,
    agent: () => ({ conn: box.conn, capabilities: box.capabilities, agentCommit: box.commit, helloReceived: true }),
    settled: () => true,
    begin: async () => {},
    sendUpdate: async () => {
      box.rpcs.push('box-update');
      if (!opts.reports) return;
      reportAt = Date.now() + 30;
      setTimeout(() => {
        box.conn = {}; box.commit = MAIN; box.capabilities = [...BASE, 'fireworks-menu-v1'];
        box.rpcs.push('(agent restarted, hello)');
      }, 40);
    },
    report: async () => (reportAt !== null && Date.now() >= reportAt
      ? { outcome: 'updated', detail: 'pull=pulled:14 reconcile=reconciled deps=unchanged agent=restarted hooks=current', commit: MAIN }
      : null),
    redial: () => {},
    finish: async () => {},
  };
}

beforeEach(() => {
  box.conn = {}; box.commit = OLD; box.capabilities = [...BASE]; box.rpcs = [];
  resetClaimUpdateGate();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a new project on a stale pool box', () => {
  it('updates the box before the first launch, which then has the Fireworks /model menu', async () => {
    const started = await startClaimUpdate(claimed, { unixUsername: 'ada' }, Promise.resolve(), updatingBox({ reports: true }));
    expect(started.updating).toBe(true);
    // The project's launch is asked for at once, as project create does.
    await expect(ensureAgentSessionsAndLaunch(launch)).resolves.toBe('launched');
    await expect(started.done).resolves.toMatchObject({ status: 'updated', detail: `${OLD.slice(0, 12)} → ${MAIN.slice(0, 12)}` });

    const typed = box.rpcs.findIndex(r => r.startsWith('tmux-send-keys'));
    expect(box.rpcs.slice(0, 3)).toEqual(['box-update', '(agent restarted, hello)', 'tmux-create']);
    expect(box.rpcs[typed]).toMatch(/termag-credentials launch-settings --backend fireworks .*--models \S+ -\) && (\S+=\S+ )*claude --settings/);
  });

  it('launches on the old commit when the update never reports, without the menu', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fx = updatingBox({ reports: false });
    // The bound passes in no time: each sleep moves the clock 10 s.
    fx.sleep = async () => { vi.setSystemTime(Date.now() + 10_000); };
    try {
      const started = await startClaimUpdate(claimed, { unixUsername: 'ada' }, Promise.resolve(), fx);
      await expect(ensureAgentSessionsAndLaunch(launch)).resolves.toBe('launched');
      await expect(started.done).resolves.toMatchObject({ status: 'timed-out' });
      const keys = box.rpcs.find(r => r.startsWith('tmux-send-keys'))!;
      expect(keys).toContain('termag-credentials launch-settings --backend fireworks');
      expect(keys).not.toContain('--models');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('timed-out after 150s: no report from termag-box-update within 150 s; launching on the commit it has'));
    } finally {
      vi.useRealTimers();
    }
  });
});
