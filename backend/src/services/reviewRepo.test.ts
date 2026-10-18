import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: vi.fn(), sendForProject: vi.fn() }));

import { originFromGitConfig, prUrlFor, repoFromPrUrl, reviewTarget, workstreamRepo } from './reviewRepo';
import type { ProjectHost } from './agentRegistry';

const host = { instanceId: 'i-1', userId: 'u1' } as unknown as ProjectHost;

/** A fake agent: `files` answers read-file (missing → null, a value of Error → throws), `branchState` git-branch-state. */
function agent(opts: { branchState?: unknown | Error; files?: Record<string, string | Error> }) {
  return vi.fn(async (_h: ProjectHost, type: string, payload: Record<string, unknown>) => {
    if (type === 'git-branch-state') {
      if (opts.branchState === undefined) throw new Error('Unknown command: git-branch-state');
      if (opts.branchState instanceof Error) throw opts.branchState;
      return opts.branchState;
    }
    if (type === 'read-file') {
      const v = opts.files?.[payload.path as string];
      if (v instanceof Error) throw v;
      return { ok: true, content: v ?? null };
    }
    throw new Error(`unexpected ${type}`);
  });
}

describe('originFromGitConfig', () => {
  it('reads origin\'s url and nothing else', () => {
    const cfg = [
      '[core]', '\trepositoryformatversion = 0', '\turl = nope',
      '[remote "upstream"]', '\turl = git@github.com:other/thing.git',
      '[remote "origin"]', '\turl = https://github.com/example-org/termag.git', '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[branch "main"]', '\tremote = origin',
    ].join('\n');
    expect(originFromGitConfig(cfg)).toEqual({ url: 'https://github.com/example-org/termag.git', includes: false });
  });
  it('is null for a repository without origin (git init)', () => {
    expect(originFromGitConfig('[core]\n\tbare = false\n')).toEqual({ url: null, includes: false });
    expect(originFromGitConfig('')).toEqual({ url: null, includes: false });
  });
  it('reads the deprecated [remote.origin] form; "ORIGIN" is another remote', () => {
    expect(originFromGitConfig('[remote.origin]\n\turl = git@github.com:o/r.git\n').url).toBe('git@github.com:o/r.git');
    expect(originFromGitConfig('[remote "ORIGIN"]\n\turl = git@github.com:o/r.git\n').url).toBeNull();
  });
  it('says when the file includes other config', () => {
    expect(originFromGitConfig('[include]\n\tpath = ~/.gitconfig.local\n')).toEqual({ url: null, includes: true });
    expect(originFromGitConfig('[includeIf "gitdir:~/src/"]\n\tpath = x\n').includes).toBe(true);
  });
});

describe('repoFromPrUrl / prUrlFor', () => {
  it('round-trips', () => {
    expect(repoFromPrUrl(prUrlFor('example-org/termag', 342))).toBe('example-org/termag');
    expect(repoFromPrUrl('https://github.com/o/r/issues/3')).toBeNull();
    expect(repoFromPrUrl(null)).toBeNull();
  });
});

describe('workstreamRepo', () => {
  it('uses git-branch-state\'s origin', async () => {
    const send = agent({ branchState: { origin: 'git@github.com:example-org/termag.git' } });
    expect(await workstreamRepo(send, host, '/home/u/p')).toEqual({ repo: 'example-org/termag', known: true });
  });
  it('a checkout with no remote is known to have no repository', async () => {
    const send = agent({ branchState: { origin: null } });
    expect(await workstreamRepo(send, host, '/home/u/p')).toEqual({ repo: null, known: true });
  });
  it('falls back to .git/config on an agent without the RPC', async () => {
    const send = agent({ files: { '/home/u/p/.git/config': '[remote "origin"]\n\turl = https://github.com/o/r\n' } });
    expect(await workstreamRepo(send, host, '/home/u/p/')).toEqual({ repo: 'o/r', known: true });
  });
  it('the empty-directory case: no .git at all is known, with no repository', async () => {
    const send = agent({ branchState: new Error('fatal: not a git repository') });
    expect(await workstreamRepo(send, host, '/home/u/p')).toEqual({ repo: null, known: true });
  });
  it('an origin that may come from an included file is unknown, not absent', async () => {
    const send = agent({ files: { '/home/u/p/.git/config': '[core]\n\tbare = false\n[include]\n\tpath = ../shared.gitconfig\n' } });
    expect(await workstreamRepo(send, host, '/home/u/p')).toEqual({ repo: null, known: false });
  });
  it('follows a worktree\'s .git file to the main repository\'s config', async () => {
    const send = agent({
      files: {
        '/home/u/p/.worktrees/ws/.git/config': Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' }),
        '/home/u/p/.worktrees/ws/.git': 'gitdir: /home/u/p/.git/worktrees/ws\n',
        '/home/u/p/.git/worktrees/ws/commondir': '../..\n',
        '/home/u/p/.git/config': '[remote "origin"]\n\turl = https://github.com/o/r.git\n',
      },
    });
    expect(await workstreamRepo(send, host, '/home/u/p/.worktrees/ws')).toEqual({ repo: 'o/r', known: true });
  });
  it('is unknown when nothing can be read', async () => {
    const send = agent({ branchState: new Error('timeout'), files: { '/home/u/p/.git/config': new Error('EACCES'), '/home/u/p/.git': new Error('EACCES') } });
    expect(await workstreamRepo(send, host, '/home/u/p')).toEqual({ repo: null, known: false });
  });
});

describe('reviewTarget', () => {
  const url = 'https://github.com/example-org/termag/pull/342';
  it('a bare number takes the workstream\'s repository', () => {
    expect(reviewTarget(342, null, { repo: 'example-org/termag', known: true }))
      .toEqual({ url, repo: 'example-org/termag', mismatch: null });
  });
  it('refuses a bare number in a directory with no GitHub remote', () => {
    const t = reviewTarget(342, null, { repo: null, known: true });
    expect('refuse' in t && t.refuse).toMatch(/no GitHub remote.*Paste the PR's URL/);
  });
  it('a URL wins and says when it is another repository', () => {
    expect(reviewTarget(342, 'https://github.com/example-org/webapp/pull/342', { repo: 'example-org/termag', known: true }))
      .toEqual({ url: 'https://github.com/example-org/webapp/pull/342', repo: 'example-org/webapp', mismatch: 'example-org/termag' });
    expect(reviewTarget(342, url, { repo: null, known: true })).toEqual({ url, repo: 'example-org/termag', mismatch: null });
  });
  it('an unreadable remote starts the review as before', () => {
    expect(reviewTarget(342, null, { repo: null, known: false })).toEqual({ url: null, repo: null, mismatch: null });
  });
});
