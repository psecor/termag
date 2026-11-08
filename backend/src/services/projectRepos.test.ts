import { describe, expect, it } from 'vitest';
import {
  aggregateSetup,
  decideRepoReport,
  guideRepos,
  hasMainCheckout,
  JOIN_FAILED,
  isCloneRefusal,
  isWorkspace,
  planAddedRepo,
  planWorkspaceRepos,
  repoCheckoutDir,
  settledSetup,
  repoSlug,
  repoNameError,
  suggestRepoName,
  WORKSPACE_CLONE_CAPABILITY,
  workspaceBoxRefusal,
  workspaceGuide,
  workspaceGuideWrites,
  workspaceRenameRefusal,
  workstreamRepos,
  WORKSPACE_RENAME_CAPABILITY,
} from './projectRepos';

const A = 'https://github.com/e2e-org/sample';
const B = 'https://github.com/e2e-org/sample-api';

describe('repository names', () => {
  it('suggests the basename, made safe', () => {
    expect(suggestRepoName('https://github.com/example-org/ld-relay')).toBe('ld-relay');
    expect(suggestRepoName('https://github.com/acme/foo.js')).toBe('foo-js');
    expect(suggestRepoName('git@github.com:acme/.dotfiles.git')).toBe('dotfiles');
  });

  it('refuses dots and leading punctuation, and takes a repository named like a guide file', () => {
    expect(repoNameError('webapp')).toBeNull();
    expect(repoNameError('a.b')).not.toBeNull();
    expect(repoNameError('-x')).not.toBeNull();
    expect(repoNameError('.worktrees')).not.toBeNull();
    expect(repoNameError('')).not.toBeNull();
    expect(repoNameError('claude')).toBeNull();
    expect(repoNameError('agents')).toBeNull();
  });
});

describe('workspaceBoxRefusal', () => {
  it('takes a box whose agent can clone per repository', () => {
    expect(workspaceBoxRefusal({ present: true, booting: false, capabilities: [WORKSPACE_CLONE_CAPABILITY] })).toBeNull();
  });

  it('takes a box still booting: its first hello dispatches the clones', () => {
    expect(workspaceBoxRefusal({ present: false, booting: true, capabilities: [] })).toBeNull();
  });

  it('refuses a box that is up without its agent, and an agent without the capability', () => {
    expect(workspaceBoxRefusal({ present: false, booting: false, capabilities: [] })?.status).toBe(503);
    expect(workspaceBoxRefusal({ present: true, booting: false, capabilities: ['chat-runner-v1'] })?.status).toBe(409);
  });
});

describe('planWorkspaceRepos', () => {
  it('names each repository after its URL and keeps the order', () => {
    expect(planWorkspaceRepos([{ url: A }, { url: B }])).toEqual({
      ok: true,
      repos: [{ name: 'sample', url: A, defaultBranch: null, position: 0 }, { name: 'sample-api', url: B, defaultBranch: null, position: 1 }],
    });
  });

  it('keeps a default branch when one is given', () => {
    const planned = planWorkspaceRepos([{ url: A, defaultBranch: ' develop ' }, { url: B, defaultBranch: '' }]);
    expect(planned.ok && planned.repos.map(r => r.defaultBranch)).toEqual(['develop', null]);
  });

  it('refuses a default branch that is not a branch name, which the box would refuse on every hello', () => {
    expect(planWorkspaceRepos([{ url: A, defaultBranch: 'a..b' }, { url: B }])).toMatchObject({ ok: false, error: expect.stringContaining('not a branch name') });
    expect(planWorkspaceRepos([{ url: A, defaultBranch: '-x' }, { url: B }])).toMatchObject({ ok: false });
    expect(planWorkspaceRepos([{ url: A, defaultBranch: 'feat/one' }, { url: B }])).toMatchObject({ ok: true });
  });

  it('needs two to the cap', () => {
    expect(planWorkspaceRepos([{ url: A }])).toMatchObject({ ok: false });
    const many = Array.from({ length: 3 }, (_, i) => ({ url: `https://github.com/o/r${i}` }));
    expect(planWorkspaceRepos(many, 2)).toMatchObject({ ok: false, error: expect.stringContaining('at most 2') });
  });

  it('refuses the same repository twice, however it is spelled', () => {
    expect(planWorkspaceRepos([{ url: A }, { url: 'git@github.com:E2E-org/sample.git' }])).toMatchObject({ ok: false, error: expect.stringContaining('twice') });
  });

  it('refuses two repositories with one directory name', () => {
    expect(planWorkspaceRepos([{ url: A }, { url: 'https://github.com/other/sample' }])).toMatchObject({ ok: false, error: expect.stringContaining('rename one') });
    expect(planWorkspaceRepos([{ url: A }, { url: 'https://github.com/other/sample', name: 'other-sample' }])).toMatchObject({ ok: true });
  });
});

describe('aggregateSetup', () => {
  const row = (name: string, setupStatus: string, setupError: string | null = null) => ({ name, setupStatus, setupError });
  it('is failed if any repository failed, naming them', () => {
    expect(aggregateSetup([row('a', 'ready'), row('b', 'failed', 'boom'), row('c', 'cloning')]))
      .toEqual({ status: 'failed', error: 'b: boom' });
  });
  it('is cloning, then pending, then ready', () => {
    expect(aggregateSetup([row('a', 'ready'), row('b', 'cloning'), row('c', 'pending')]).status).toBe('cloning');
    expect(aggregateSetup([row('a', 'ready'), row('c', 'pending')]).status).toBe('pending');
    expect(aggregateSetup([row('a', 'ready'), row('b', 'ready')]).status).toBe('ready');
  });
});

describe('decideRepoReport', () => {
  it('drops a stale attempt', () => {
    expect(decideRepoReport({ setupStatus: 'cloning', setupAttempt: 2 }, { attempt: 1, status: 'ready' }).kind).toBe('ignore');
  });
  it('moves pending to cloning to ready', () => {
    expect(decideRepoReport({ setupStatus: 'pending', setupAttempt: 0 }, { attempt: 0, status: 'cloning' })).toMatchObject({ kind: 'write', status: 'cloning' });
    expect(decideRepoReport({ setupStatus: 'cloning', setupAttempt: 0 }, { attempt: 0, status: 'ready', branch: 'main' })).toEqual({ kind: 'write', status: 'ready', error: null, branch: 'main' });
  });
  it('never moves a settled repository', () => {
    expect(decideRepoReport({ setupStatus: 'ready', setupAttempt: 0 }, { attempt: 0, status: 'failed' }).kind).toBe('ignore');
  });
});

describe('workspaceGuide', () => {
  const repos = [{ name: 'api', url: B, position: 1 }, { name: 'web', url: A, position: 0 }];
  it('says the root is not a repository and lists every one by position', () => {
    const guide = workspaceGuide({ project: 'p', workstream: 'main', branch: 'main', repos });
    expect(guide).toContain('# p\n');
    expect(guide).toContain('not a git repository');
    expect(guide).toContain('its main checkout');
    expect(guide.indexOf('`web/`')).toBeLessThan(guide.indexOf('`api/`'));
    expect(guide).toContain('only in the repositories you change');
    expect(guide).not.toContain('main\'s checkout');
  });
  it('names a workstream\'s branch and points at main\'s checkouts for running', () => {
    const guide = workspaceGuide({ project: 'p', workstream: 'fix', branch: 'ccs/fix', repos });
    expect(guide).toContain('# p / fix');
    expect(guide).toContain('a worktree on branch `ccs/fix`');
    expect(guide).toContain('`../../<repo>`');
  });
});

describe('workspaceRenameRefusal', () => {
  const ready = [{ name: 'web', setupStatus: 'ready' }, { name: 'api', setupStatus: 'ready' }];
  it('allows a box whose agent can repair every repository\'s worktrees', () => {
    expect(workspaceRenameRefusal({ capabilities: [WORKSPACE_CLONE_CAPABILITY, WORKSPACE_RENAME_CAPABILITY], repos: ready })).toBeNull();
  });
  it('refuses an older agent, which would move the folder and leave every worktree at the old paths', () => {
    expect(workspaceRenameRefusal({ capabilities: [WORKSPACE_CLONE_CAPABILITY], repos: ready }))
      .toMatchObject({ status: 409, code: 'agent_outdated', error: expect.stringMatching(/update the box/) });
  });
  it('refuses while a repository is still cloning into the folder, and not after a failed clone', () => {
    const caps = [WORKSPACE_RENAME_CAPABILITY];
    expect(workspaceRenameRefusal({ capabilities: caps, repos: [ready[0], { name: 'api', setupStatus: 'cloning' }] }))
      .toEqual({ status: 409, error: 'api is still being cloned; rename once it is done' });
    expect(workspaceRenameRefusal({ capabilities: caps, repos: [{ name: 'web', setupStatus: 'pending' }] })?.error).toMatch(/^web /);
    expect(workspaceRenameRefusal({ capabilities: caps, repos: [ready[0], { name: 'api', setupStatus: 'failed' }] })).toBeNull();
  });
});

describe('workspaceGuideWrites', () => {
  it('gives the root and each workstream its guide under the new names', () => {
    const repos = [{ name: 'web', url: A, position: 0 }];
    const writes = workspaceGuideWrites({
      project: 'store',
      repos,
      workstreams: [{ name: 'main', branch: 'main' }, { name: 'fix', branch: 'ccs/fix' }],
      dirFor: ws => (ws === 'main' ? '/h/store' : `/h/store/.worktrees/${ws}`),
    });
    expect(writes).toEqual([
      { dir: '/h/store', content: workspaceGuide({ project: 'store', workstream: 'main', branch: 'main', repos }) },
      { dir: '/h/store/.worktrees/fix', content: workspaceGuide({ project: 'store', workstream: 'fix', branch: 'ccs/fix', repos }) },
    ]);
    expect(writes[1].content).toContain('# store / fix');
  });
});

it('tells the box refusing a clone apart from a lost request', () => {
  expect(isCloneRefusal('project-clone: branch must be HEAD or a branch name')).toBe(true);
  expect(isCloneRefusal('Agent request timed out: project-clone')).toBe(false);
  expect(isCloneRefusal('Instance agent not connected')).toBe(false);
});

it('reads the layout, defaulting to a single repository', () => {
  expect(isWorkspace({ layout: 'workspace' })).toBe(true);
  expect(isWorkspace({ layout: 'repo' })).toBe(false);
  expect(isWorkspace({})).toBe(false);
});

describe('repoSlug / repoCheckoutDir', () => {
  const repos = [{ name: 'web', url: 'https://github.com/Acme/Web' }, { name: 'api', url: 'git@github.com:acme/api.git' }];
  it('owner/name of a GitHub URL, case kept', () => {
    expect(repoSlug('https://github.com/Acme/Web')).toBe('Acme/Web');
    expect(repoSlug('git@github.com:acme/api.git')).toBe('acme/api');
    expect(repoSlug('/srv/git/local')).toBeNull();
  });
  it('the checkout of a repository in a workspace root, matched in any case', () => {
    expect(repoCheckoutDir('/p/acme/.worktrees/feat/', repos, 'acme/web')).toBe('/p/acme/.worktrees/feat/web');
    expect(repoCheckoutDir('/p/acme', repos, 'ACME/API')).toBe('/p/acme/api');
    expect(repoCheckoutDir('/p/acme', repos, 'acme/other')).toBeNull();
    expect(repoCheckoutDir('/p/acme', repos, null)).toBeNull();
  });
});

describe('planAddedRepo', () => {
  const have = [
    { name: 'web', url: 'https://github.com/acme/web', position: 0 },
    { name: 'api', url: 'https://github.com/acme/api.git', position: 3 },
  ];

  it('takes a new repository after the last one, named after it', () => {
    expect(planAddedRepo(have, { url: 'https://github.com/acme/docs-site.git' })).toEqual({
      ok: true, repo: { name: 'docs-site', url: 'https://github.com/acme/docs-site.git', defaultBranch: null, position: 4 },
    });
    expect(planAddedRepo(have, { url: 'git@github.com:acme/docs.git', name: 'manual', defaultBranch: ' trunk ' })).toMatchObject({
      ok: true, repo: { name: 'manual', defaultBranch: 'trunk' },
    });
  });

  it('refuses one the project holds already, in any case or URL form', () => {
    expect(planAddedRepo(have, { url: 'git@github.com:Acme/API.git' })).toEqual({ ok: false, error: 'acme/api is already in this project' });
  });

  it('refuses a directory name another repository has, in any case', () => {
    expect(planAddedRepo(have, { url: 'https://github.com/other/web' })).toMatchObject({ ok: false, error: expect.stringContaining('already checked out as web') });
    expect(planAddedRepo(have, { url: 'https://github.com/other/x', name: 'API' })).toMatchObject({ ok: false });
  });

  it('refuses a bad URL, name or branch, and a ninth repository', () => {
    expect(planAddedRepo(have, { url: 'https://gitlab.com/a/b' })).toMatchObject({ ok: false });
    expect(planAddedRepo(have, null)).toMatchObject({ ok: false });
    expect(planAddedRepo(have, { url: 'https://github.com/a/b', name: '.worktrees' })).toMatchObject({ ok: false, error: expect.stringContaining('letters, digits') });
    expect(planAddedRepo(have, { url: 'https://github.com/a/b', defaultBranch: 'a..b' })).toMatchObject({ ok: false, error: expect.stringContaining('not a branch name') });
    const eight = Array.from({ length: 8 }, (_, i) => ({ name: `r${i}`, url: `https://github.com/a/r${i}`, position: i }));
    expect(planAddedRepo(eight, { url: 'https://github.com/a/b' })).toEqual({ ok: false, error: 'a project holds at most 8 repositories' });
  });
});

describe('settledSetup', () => {
  const r = (name: string, setupStatus: string, setupError: string | null = null) => ({ name, setupStatus, setupError });

  it('moves a project in setup to the aggregate', () => {
    expect(settledSetup('cloning', null, [r('a', 'ready'), r('b', 'ready')])).toEqual({ status: 'ready', error: null });
    expect(settledSetup('cloning', null, [r('a', 'ready'), r('b', 'failed', 'boom')])).toEqual({ status: 'failed', error: 'b: boom' });
    expect(settledSetup('cloning', null, [r('a', 'ready'), r('b', 'cloning')])).toBeNull();
  });

  it('keeps a ready project ready while a repository added later clones or fails', () => {
    expect(settledSetup('ready', null, [r('a', 'ready'), r('b', 'pending')])).toBeNull();
    expect(settledSetup('ready', null, [r('a', 'ready'), r('b', 'failed', 'boom')])).toBeNull();
  });

  it('lets a failed project become ready once every repository is', () => {
    expect(settledSetup('failed', 'b: boom', [r('a', 'ready'), r('b', 'ready')])).toEqual({ status: 'ready', error: null });
  });
});

describe('guideRepos', () => {
  const r = (name: string, setupStatus: string, setupError: string | null = null) => ({ name, setupStatus, setupError });
  const rows = [r('web', 'ready'), r('docs', 'cloning'), r('wiki', 'failed', 'Repository not found'), r('blog', 'failed', `${JOIN_FAILED} fix: fatal: boom`)];

  it('lists in the project folder the ones with a checkout there, and the one whose clone just landed', () => {
    expect(guideRepos(rows).map(x => x.name)).toEqual(['web', 'blog']);
    expect(guideRepos(rows, { joined: 'docs' }).map(x => x.name)).toEqual(['web', 'docs', 'blog']);
  });

  it("lists in a workstream root the worktrees the box finds there, whatever the rows' status", () => {
    expect(guideRepos(rows, { present: ['blog', 'web'] }).map(x => x.name)).toEqual(['web', 'blog']);
    expect(guideRepos(rows, { present: ['web'] }).map(x => x.name)).toEqual(['web']);
  });

  it('counts a checkout only for a failure after the clone', () => {
    expect([hasMainCheckout(rows[0]), hasMainCheckout(rows[1]), hasMainCheckout(rows[2]), hasMainCheckout(rows[3])]).toEqual([true, false, false, true]);
  });
});

describe('workstreamRepos', () => {
  const r = (name: string, setupStatus: string) => ({ name, setupStatus });

  it('holds Branch off back while one still clones', () => {
    expect(workstreamRepos([r('web', 'ready'), r('docs', 'pending')])).toEqual({ ok: false, error: 'docs is not cloned yet' });
    expect(workstreamRepos([r('web', 'ready'), r('docs', 'cloning')])).toEqual({ ok: false, error: 'docs is not cloned yet' });
  });

  it('leaves out one that failed to clone, so the project can still branch', () => {
    expect(workstreamRepos([r('web', 'ready'), r('wiki', 'failed'), r('api', 'ready')])).toEqual({ ok: true, repos: [r('web', 'ready'), r('api', 'ready')] });
  });

  it('refuses a pull request in one that failed to clone', () => {
    expect(workstreamRepos([r('web', 'ready'), r('wiki', 'failed')], 'wiki')).toEqual({ ok: false, error: 'wiki did not clone; Retry it first' });
    expect(workstreamRepos([r('web', 'ready'), r('wiki', 'failed')], 'web')).toMatchObject({ ok: true });
  });
});
