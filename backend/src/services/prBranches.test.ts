import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: vi.fn(), sendForProject: vi.fn() }));

import { repoFromOrigin, sweepBranches, toBranchState, type WorkstreamTarget } from './prBranches';

const target = (over: Partial<WorkstreamTarget> = {}): WorkstreamTarget => ({
  host: { userId: 'u1', instanceId: 'i1' }, cwd: '/home/me/projects/termag/.worktrees/feat',
  projectId: 'p1', projectName: 'termag', workstream: 'feat', branch: 'feat', ...over,
});

describe('repoFromOrigin', () => {
  const hosts = ['github.com', 'github-broker.example.test'];
  it('reads https, broker, ssh and scp-style remotes on GitHub hosts', () => {
    expect(repoFromOrigin('https://github.com/example-org/termag.git', hosts)).toBe('example-org/termag');
    expect(repoFromOrigin('https://github-broker.example.test/example-org/termag.git', hosts)).toBe('example-org/termag');
    expect(repoFromOrigin('git@github.com:example-labs/org-explorer.git', hosts)).toBe('example-labs/org-explorer');
    expect(repoFromOrigin('ssh://git@github.com/example-org/webapp', hosts)).toBe('example-org/webapp');
  });
  it('is null for path remotes, other forges and junk', () => {
    expect(repoFromOrigin(null, hosts)).toBeNull();
    expect(repoFromOrigin('/srv/git/local', hosts)).toBeNull();
    expect(repoFromOrigin('file:///srv/git/local.git', hosts)).toBeNull();
    expect(repoFromOrigin('https://gitlab.com/example-org/termag.git', hosts)).toBeNull();
    expect(repoFromOrigin('git@gitlab.com:example-org/termag.git', hosts)).toBeNull();
    expect(repoFromOrigin('https://github.com/example-org/termag/extra', hosts)).toBeNull();
    expect(repoFromOrigin('nothing', hosts)).toBeNull();
  });
  it('trusts github.com by default and the broker only when configured', () => {
    expect(repoFromOrigin('https://github.com/example-org/termag.git')).toBe('example-org/termag');
  });
});

describe('toBranchState', () => {
  it('pushed means an upstream with nothing unpushed', () => {
    const base = { branch: 'feat', baseBranch: 'main', aheadOfBase: 2, origin: 'https://github.com/example-org/termag.git' };
    expect(toBranchState(target(), { ...base, upstream: 'origin/feat', ahead: 0 })?.pushed).toBe(true);
    expect(toBranchState(target(), { ...base, upstream: 'origin/feat', ahead: 1 })?.pushed).toBe(false);
    expect(toBranchState(target(), { ...base, upstream: null, ahead: 0 })?.pushed).toBe(false);
  });
  it('a detached HEAD has no branch state', () => {
    expect(toBranchState(target(), { branch: null })).toBeNull();
  });
  it('re-validates numbers and defaults the base', () => {
    const got = toBranchState(target(), { branch: 'feat', aheadOfBase: '3', dirty: 'yes' });
    expect(got).toMatchObject({ aheadOfBase: null, dirty: false, baseBranch: 'main', repo: null });
    expect(toBranchState(target(), { branch: 'feat', aheadOfBase: null })?.aheadOfBase).toBeNull();
    expect(toBranchState(target(), { branch: 'feat', aheadOfBase: 0 })?.aheadOfBase).toBe(0);
  });
});

describe('sweepBranches', () => {
  const ok = { branch: 'feat', upstream: 'origin/feat', ahead: 0, baseBranch: 'main', aheadOfBase: 1, dirty: false, origin: 'git@github.com:example-org/termag.git' };

  it('reads connected hosts and links by the checkout\'s repo', async () => {
    const send = vi.fn(async () => ok);
    const got = await sweepBranches([target()], { connected: () => true, send });
    expect(send).toHaveBeenCalledWith({ userId: 'u1', instanceId: 'i1' }, 'git-branch-state', { cwd: target().cwd }, expect.any(Number));
    expect(got.branches).toHaveLength(1);
    expect(got.workstreams).toEqual([expect.objectContaining({ branch: 'feat', repo: 'example-org/termag' })]);
  });
  it('skips offline hosts but keeps their workstreams linkable by branch', async () => {
    const send = vi.fn();
    const got = await sweepBranches([target()], { connected: () => false, send });
    expect(send).not.toHaveBeenCalled();
    expect(got).toMatchObject({ offline: 1, branches: [], workstreams: [expect.objectContaining({ repo: null, branch: 'feat' })] });
  });
  it('counts every workstream on an outdated agent', async () => {
    const send = vi.fn(async () => { throw new Error('Unknown command: git-branch-state'); });
    const targets = [target({ workstream: 'a' }), target({ workstream: 'b' }), target({ workstream: 'c' })];
    // One worker at a time would make this exact; with several, at most one call per in-flight worker.
    const got = await sweepBranches(targets, { connected: () => true, send });
    expect(got.outdatedAgent).toBe(3);
    expect(got.workstreams).toHaveLength(3);
    expect(send.mock.calls.length).toBeLessThanOrEqual(3);
  });
  it('a failing workstream does not sink the others, and is counted', async () => {
    const send = vi.fn(async (_h: unknown, _t: string, p: Record<string, unknown>) => {
      if (String(p.cwd).endsWith('gone')) throw new Error('not a git repository');
      return ok;
    });
    const got = await sweepBranches([target({ cwd: '/x/gone' }), target()], { connected: () => true, send });
    expect(got.branches).toHaveLength(1);
    expect(got.workstreams).toHaveLength(2);
    expect(got).toMatchObject({ failed: 1, offline: 0, outdatedAgent: 0 });
  });
});
