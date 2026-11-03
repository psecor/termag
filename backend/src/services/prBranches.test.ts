import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: vi.fn(), sendForProject: vi.fn() }));

import { repoFromOrigin, sweepBranches, toBranchState, workstreamTargetsOf, type WorkstreamTarget } from './prBranches';

const target = (over: Partial<WorkstreamTarget> = {}): WorkstreamTarget => ({
  host: { userId: 'u1', instanceId: 'i1' }, cwd: '/home/me/projects/termag/.worktrees/feat',
  projectId: 'p1', projectName: 'termag', workstream: 'feat', branch: 'feat', ...over,
});

describe('repoFromOrigin', () => {
  const hosts = ['github.com', 'github-broker.example.test'];
  it('reads https, broker, ssh and scp-style remotes on GitHub hosts', () => {
    expect(repoFromOrigin('https://github.com/example-org/termag.git', hosts)).toBe('example-org/termag');
    expect(repoFromOrigin('https://github-broker.example.test/example-org/termag.git', hosts)).toBe('example-org/termag');
    expect(repoFromOrigin('git@github.com:example-team/sample-repo.git', hosts)).toBe('example-team/sample-repo');
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

describe('multi-repo workstreams (docs/multi-repo-projects.md)', () => {
  const project = {
    id: 'p1', name: 'acme', userId: 'u1', instanceId: 'i1', user: { unixUsername: 'me' }, instance: { hostHome: '/home/me' },
    layout: 'workspace',
    repos: [
      { name: 'api', url: 'https://github.com/acme/api', position: 1 },
      { name: 'web', url: 'git@github.com:acme/web.git', position: 0 },
    ],
  };

  it('reads each repository\'s worktree, by position, knowing its repository', () => {
    const got = workstreamTargetsOf(project, { name: 'feat', branch: 'feat' });
    expect(got.map(t => [t.cwd.replace(/^.*\/acme\//, ''), t.repo])).toEqual([
      ['.worktrees/feat/web', 'acme/web'],
      ['.worktrees/feat/api', 'acme/api'],
    ]);
    expect(workstreamTargetsOf(project, { name: 'main', branch: 'main' }).map(t => t.cwd.replace(/^.*\/acme\//, ''))).toEqual(['web', 'api']);
  });

  it('a single-repository project is one target at its directory, as before', () => {
    const got = workstreamTargetsOf({ ...project, layout: 'repo' }, { name: 'feat', branch: 'feat' });
    expect(got).toHaveLength(1);
    expect(got[0].cwd).toMatch(/acme\/\.worktrees\/feat$/);
    expect(got[0].repo).toBeUndefined();
  });

  it('links each repository\'s branch on its own, and counts an offline workstream once', async () => {
    const targets = workstreamTargetsOf(project, { name: 'feat', branch: 'feat' });
    const send = vi.fn(async (_h: unknown, _t: string, p: Record<string, unknown>) => ({
      branch: 'feat', upstream: 'origin/feat', ahead: 0, baseBranch: 'main', aheadOfBase: 1, dirty: false,
      origin: String(p.cwd).endsWith('/web') ? 'git@github.com:acme/web.git' : 'https://github.com/acme/api.git',
    }));
    const got = await sweepBranches(targets, { connected: () => true, send });
    expect(got.branches.map(b => b.repo).sort()).toEqual(['acme/api', 'acme/web']);
    expect(got.workstreams.map(w => w.repo).sort()).toEqual(['acme/api', 'acme/web']);

    const offline = await sweepBranches(targets, { connected: () => false, send });
    expect(offline.offline).toBe(1);
    // Still linkable per repository: a null repo on both would match neither (two on one branch).
    expect(offline.workstreams.map(w => w.repo).sort()).toEqual(['acme/api', 'acme/web']);
  });

  it('an unreadable origin keeps the known repository', () => {
    const [t] = workstreamTargetsOf(project, { name: 'feat', branch: 'feat' });
    expect(toBranchState(t, { branch: 'feat', origin: null })?.repo).toBe('acme/web');
  });
});
