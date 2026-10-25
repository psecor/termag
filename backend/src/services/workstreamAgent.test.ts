import { describe, it, expect, vi } from 'vitest';
import { adoptWorkstreamAgent, isUsableCheckout, startWorkstreamAgent, type WorkstreamAgentDeps } from './workstreamAgent';

const target = {
  projectId: 'p1',
  workstreamId: 'ws1',
  userId: 'u1',
  unixUsername: 'alice',
  projectName: 'termag',
  instanceId: 'box-1',
  hostHome: '/home/alice',
  workstream: 'feature-x',
  provider: 'claude',
};

function deps(state: unknown): WorkstreamAgentDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    branchState: vi.fn(async (_host, cwd) => { calls.push(`state ${cwd}`); if (state instanceof Error) throw state; return state; }),
    recordAgent: vi.fn(async (p, ws, provider) => { calls.push(`record ${p} ${ws} ${provider}`); }),
    launch: vi.fn(async ctx => { calls.push(`launch ${ctx.workstream} resume=${ctx.resume}`); return 'launched' as const; }),
  };
}

describe('isUsableCheckout', () => {
  it('wants a checkout with a commit', () => {
    expect(isUsableCheckout({ branch: 'feature-x', lastCommitAt: '2026-10-19T00:00:00.000Z' })).toBe(true);
    // An empty git-init (the folder tmux-create makes for a missing worktree).
    expect(isUsableCheckout({ branch: 'main', lastCommitAt: null })).toBe(false);
    expect(isUsableCheckout(null)).toBe(false);
  });
});

describe('startWorkstreamAgent', () => {
  it('checks the worktree, records the agent, then resumes it', async () => {
    const d = deps({ branch: 'feature-x', lastCommitAt: '2026-10-19T00:00:00.000Z' });
    expect(await startWorkstreamAgent(target, d)).toBe('launched');
    expect(d.calls).toEqual([
      'state /home/alice/termag/projects/termag/.worktrees/feature-x',
      'record p1 ws1 claude',
      'launch feature-x resume=true',
    ]);
  });

  it('records the model backend with the agent and starts on it', async () => {
    const d = deps({ branch: 'feature-x', lastCommitAt: '2026-10-19T00:00:00.000Z' });
    await startWorkstreamAgent({ ...target, backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' }, d);
    expect(d.recordAgent).toHaveBeenCalledWith('p1', 'ws1', 'claude', 'fireworks', 'accounts/fireworks/models/kimi-k3');
    expect(vi.mocked(d.launch).mock.calls[0][0]).toMatchObject({ provider: 'claude', backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3', resume: true });
    const plain = deps({ branch: 'feature-x', lastCommitAt: '2026-10-19T00:00:00.000Z' });
    await startWorkstreamAgent(target, plain);
    expect(plain.recordAgent).toHaveBeenCalledWith('p1', 'ws1', 'claude', null, null);
  });

  it('records and launches nothing when the checkout is missing', async () => {
    const d = deps(new Error('git: not a git repository'));
    expect(await startWorkstreamAgent(target, d)).toBe('no-checkout');
    expect(d.recordAgent).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('records and launches nothing in an empty repo', async () => {
    const d = deps({ branch: 'main', lastCommitAt: null });
    expect(await startWorkstreamAgent(target, d)).toBe('no-checkout');
    expect(d.launch).not.toHaveBeenCalled();
  });
});

describe('adoptWorkstreamAgent', () => {
  it('returns the launch without running it', async () => {
    const d = deps({ branch: 'feature-x', lastCommitAt: '2026-10-19T00:00:00.000Z' });
    const ctx = await adoptWorkstreamAgent(target, d);
    expect(ctx).toMatchObject({ workstream: 'feature-x', provider: 'claude', instanceId: 'box-1', resume: true });
    expect(d.launch).not.toHaveBeenCalled();
  });
});
