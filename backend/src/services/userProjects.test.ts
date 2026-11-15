import { describe, it, expect } from 'vitest';
import {
  USER_PROJECT_NAME_MAX,
  baseProjectName,
  checkoutRepoSet,
  checkoutRepoSetKey,
  createRepoUrls,
  findUserProjectForRepoSet,
  groupCheckouts,
  grownRepoSetKeys,
  planAddedUserProjectRepo,
  planNewUserProject,
  planUserProjects,
  projectNameKey,
  qualifiesForUserProject,
  repoDisplayName,
  repoSetEntryKey,
  repoSetKeyForUrls,
  requestedProjectRefusal,
  uniqueProjectName,
  type CheckoutForGrouping,
  type UserProjectForLookup,
} from './userProjects';

const T = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

function checkout(id: string, over: Partial<CheckoutForGrouping> = {}): CheckoutForGrouping {
  return {
    id, kind: 'normal', layout: 'repo', repoUrl: null, repoDefaultBranch: null, repos: [],
    lastActiveAt: T(0), createdAt: T(0), ...over,
  };
}

const repoCheckout = (id: string, url: string, over: Partial<CheckoutForGrouping> = {}) =>
  checkout(id, { repoUrl: url, ...over });

const workspace = (id: string, urls: string[], over: Partial<CheckoutForGrouping> = {}) =>
  checkout(id, {
    layout: 'workspace',
    repos: urls.map((url, position) => ({ url, defaultBranch: null, position })),
    ...over,
  });

function project(id: string, repoSetKey: string, over: Partial<UserProjectForLookup> = {}): UserProjectForLookup {
  return { id, repoSetKey, formerRepoSetKeys: [], archivedAt: null, createdAt: T(0), ...over };
}

describe('repo set keys', () => {
  it('ignores order, case, .git and the https or ssh spelling', () => {
    const a = repoSetKeyForUrls(['https://github.com/example-org/termag-desktop', 'git@github.com:Example-Org/termag.git']);
    const b = repoSetKeyForUrls(['https://github.com/Example-Org/Termag.git', 'https://github.com/example-org/termag-desktop/']);
    expect(a).toBe('example-org/termag,example-org/termag-desktop');
    expect(b).toBe(a);
  });

  it('keys a URL repoKey cannot parse by the URL, lowercased, without .git', () => {
    expect(repoSetEntryKey('https://GitLab.example.com/Team/Thing.git')).toBe('https://gitlab.example.com/team/thing');
    expect(repoSetEntryKey('https://gitlab.example.com/team/thing/')).toBe('https://gitlab.example.com/team/thing');
    expect(repoSetEntryKey('https://example.com/a,b')).toBe('https://example.com/a%2cb');
  });

  it('is "" for no repository, and counts a repository once', () => {
    expect(repoSetKeyForUrls([])).toBe('');
    expect(checkoutRepoSetKey(checkout('p1'))).toBe('');
    expect(checkoutRepoSetKey(workspace('p2', []))).toBe('');
    expect(repoSetKeyForUrls(['https://github.com/o/r', 'git@github.com:o/r.git'])).toBe('o/r');
  });

  it("reads a repo checkout's repoUrl and a workspace's repositories in position order", () => {
    expect(checkoutRepoSetKey(repoCheckout('p1', 'https://github.com/example-org/termag.git'))).toBe('example-org/termag');
    const ws = checkout('p2', {
      layout: 'workspace',
      // A workspace's repoUrl is null; a stray one is not one of its repositories.
      repoUrl: 'https://github.com/o/ignored',
      repos: [
        { url: 'https://github.com/o/second', defaultBranch: 'dev', position: 1 },
        { url: 'https://github.com/o/first', defaultBranch: null, position: 0 },
      ],
    });
    expect(checkoutRepoSet(ws)).toEqual([
      { repoKey: 'o/first', name: 'first', url: 'https://github.com/o/first', defaultBranch: null },
      { repoKey: 'o/second', name: 'second', url: 'https://github.com/o/second', defaultBranch: 'dev' },
    ]);
    expect(checkoutRepoSetKey(ws)).toBe('o/first,o/second');
  });

  it("keeps a repo checkout's default branch", () => {
    expect(checkoutRepoSet(repoCheckout('p1', 'git@github.com:o/Repo.git', { repoDefaultBranch: 'trunk' })))
      .toEqual([{ repoKey: 'o/repo', name: 'Repo', url: 'git@github.com:o/Repo.git', defaultBranch: 'trunk' }]);
  });
});

describe('naming', () => {
  it('names a project after its repositories', () => {
    expect(baseProjectName(['termag'])).toBe('termag');
    expect(baseProjectName(['termag', 'termag-desktop'])).toBe('termag + termag-desktop');
    expect(baseProjectName(['dev', 'webapp', 'ld-relay', 'docs'])).toBe('dev + 3 more');
    expect(baseProjectName(['a', 'b', 'c'])).toBe('a + 2 more');
    expect(baseProjectName([])).toBe('Scratch');
  });

  it("takes a repository's name from GitHub's URL, else the URL's last segment", () => {
    expect(repoDisplayName('https://github.com/example-org/termag.git')).toBe('termag');
    expect(repoDisplayName('git@github.com:example-org/termag-desktop.git')).toBe('termag-desktop');
    expect(repoDisplayName('https://gitlab.example.com/team/Thing.git/')).toBe('Thing');
  });

  it('gives a name the person already has " 2", " 3", ignoring case', () => {
    expect(uniqueProjectName('termag', new Set())).toBe('termag');
    expect(uniqueProjectName('termag', new Set(['termag']))).toBe('termag 2');
    expect(uniqueProjectName('Termag', new Set(['termag', 'termag 2']))).toBe('Termag 3');
    expect(projectNameKey('  Termag 2 ')).toBe('termag 2');
  });

  it('keeps a name, suffix included, within 60 characters', () => {
    const long = 'x'.repeat(70);
    const first = uniqueProjectName(long, new Set());
    expect(first).toHaveLength(USER_PROJECT_NAME_MAX);
    const second = uniqueProjectName(long, new Set([projectNameKey(first)]));
    expect(second).toHaveLength(USER_PROJECT_NAME_MAX);
    expect(second.endsWith(' 2')).toBe(true);
    // A cut never leaves a space before the suffix.
    expect(uniqueProjectName(`${'y'.repeat(57)} zzz`, new Set([`${'y'.repeat(57)} zz`]))).toBe(`${'y'.repeat(57)} 2`);
  });
});

describe('grouping', () => {
  it('includes normal checkouts, ask checkouts and archived ones; leaves automations, MetaTerm and space orchestrators out', () => {
    expect(qualifiesForUserProject({ kind: 'normal' })).toBe(true);
    expect(qualifiesForUserProject({ kind: 'automation' })).toBe(false);
    expect(qualifiesForUserProject({ kind: 'metaterm' })).toBe(false);
    expect(qualifiesForUserProject({ kind: 'space-orchestrator' })).toBe(false);
    const url = 'https://github.com/example-org/termag';
    const groups = groupCheckouts([
      repoCheckout('box1', url),
      repoCheckout('box2', `${url}.git`),
      // termag ask --new-box makes a normal checkout with createdFor 'ask'.
      repoCheckout('ask', url),
      repoCheckout('auto', url, { kind: 'automation' }),
      checkout('meta', { kind: 'metaterm' }),
      checkout('orch', { kind: 'space-orchestrator' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].repoSetKey).toBe('example-org/termag');
    expect([...groups[0].checkoutIds].sort()).toEqual(['ask', 'box1', 'box2']);
  });

  it('groups by the exact set: one repository and a workspace with it are two groups', () => {
    const groups = groupCheckouts([
      repoCheckout('a', 'https://github.com/example-org/termag', { createdAt: T(1) }),
      workspace('b', ['https://github.com/example-org/termag', 'https://github.com/example-org/termag-desktop'], { createdAt: T(2) }),
      workspace('c', ['git@github.com:example-org/termag-desktop.git', 'git@github.com:example-org/termag.git'], { createdAt: T(3) }),
      checkout('d', { createdAt: T(4) }),
      workspace('e', [], { createdAt: T(5) }),
    ]);
    expect(groups.map(g => [g.repoSetKey, [...g.checkoutIds].sort()])).toEqual([
      ['example-org/termag', ['a']],
      ['example-org/termag,example-org/termag-desktop', ['b', 'c']],
      ['', ['d', 'e']],
    ]);
  });

  it("takes a group's repositories from its most recent checkout, and lists the checkouts most recent first", () => {
    const [g] = groupCheckouts([
      workspace('old', ['https://github.com/o/a', 'https://github.com/o/b'], { createdAt: T(0), lastActiveAt: T(5) }),
      workspace('recent', ['https://github.com/o/b', 'https://github.com/o/a'], { createdAt: T(1), lastActiveAt: T(9) }),
    ]);
    expect(g.checkoutIds).toEqual(['recent', 'old']);
    expect(g.repos.map(r => r.name)).toEqual(['b', 'a']);
    expect(baseProjectName(g.repos.map(r => r.name))).toBe('b + a');
  });

  it('orders groups oldest first, so the older work keeps a shared name', () => {
    const groups = groupCheckouts([
      repoCheckout('fork', 'https://github.com/someone/termag', { createdAt: T(9) }),
      repoCheckout('mine', 'https://github.com/example-org/termag', { createdAt: T(1) }),
    ]);
    expect(groups.map(g => g.checkoutIds[0])).toEqual(['mine', 'fork']);
  });
});

describe('the project for a repo set', () => {
  it('finds an exact set first, then a former set, then none', () => {
    const exact = project('exact', 'o/a,o/b');
    const grown = project('grown', 'o/a,o/b,o/c', { formerRepoSetKeys: ['o/a'] });
    expect(findUserProjectForRepoSet([grown, exact], 'o/a,o/b')).toBe(exact);
    expect(findUserProjectForRepoSet([grown, exact], 'o/a')).toBe(grown);
    expect(findUserProjectForRepoSet([grown, exact], 'o/z')).toBeNull();
  });

  it('prefers an exact match over an older project that once had the set', () => {
    const older = project('older', 'o/a,o/b', { formerRepoSetKeys: ['o/a'], createdAt: T(0) });
    const newer = project('newer', 'o/a', { createdAt: T(5) });
    expect(findUserProjectForRepoSet([older, newer], 'o/a')).toBe(newer);
  });

  it('never matches a project that merely contains the set', () => {
    const both = project('both', 'example-org/termag,example-org/termag-desktop');
    expect(findUserProjectForRepoSet([both], 'example-org/termag')).toBeNull();
  });

  it('matches the empty set only to a no-repo project, never through a former set', () => {
    const repo = project('repo', 'o/a', { formerRepoSetKeys: [''] });
    expect(findUserProjectForRepoSet([repo], '')).toBeNull();
    const scratch = project('scratch', '');
    expect(findUserProjectForRepoSet([repo, scratch], '')).toBe(scratch);
  });

  it('lets the oldest of several matches win, and never matches an archived project', () => {
    const a = project('a', 'o/a', { createdAt: T(3) });
    const b = project('b', 'o/a', { createdAt: T(1) });
    const archived = project('archived', 'o/a', { createdAt: T(0), archivedAt: T(2) });
    expect(findUserProjectForRepoSet([a, b, archived], 'o/a')).toBe(b);
    expect(findUserProjectForRepoSet([archived], 'o/a')).toBeNull();
    // Unarchived, the original is the older again and takes the set back.
    expect(findUserProjectForRepoSet([a, b, { ...archived, archivedAt: null }], 'o/a')?.id).toBe('archived');
  });

  it('lets the oldest win among former-set matches too', () => {
    const later = project('later', 'o/a,o/c', { formerRepoSetKeys: ['o/a'], createdAt: T(4) });
    const earlier = project('earlier', 'o/a,o/b', { formerRepoSetKeys: ['o/a'], createdAt: T(2) });
    expect(findUserProjectForRepoSet([later, earlier], 'o/a')).toBe(earlier);
  });
});

describe('the backfill plan', () => {
  const named = (id: string, name: string, repoSetKey: string, over: Partial<UserProjectForLookup> = {}) =>
    ({ ...project(id, repoSetKey, over), name, nameKey: projectNameKey(name) });

  it('joins a project the person has, and names a new one around every name they have, archived included', () => {
    const plan = planUserProjects([
      repoCheckout('a', 'https://github.com/example-org/termag', { createdAt: T(1) }),
      repoCheckout('b', 'https://github.com/someone/termag', { createdAt: T(2) }),
      repoCheckout('c', 'https://github.com/other/termag', { createdAt: T(3) }),
      checkout('d', { createdAt: T(4) }),
    ], [
      named('mine', 'termag', 'example-org/termag'),
      named('old', 'Termag 2', 'gone/termag', { archivedAt: T(0) }),
    ]);
    expect(plan.map(e => [e.existing?.id ?? null, e.name, e.checkoutIds])).toEqual([
      ['mine', 'termag', ['a']],
      [null, 'termag 3', ['b']],
      [null, 'termag 4', ['c']],
      [null, 'Scratch', ['d']],
    ]);
  });

  it('never joins an archived project: its set gets a new one', () => {
    const [entry] = planUserProjects([repoCheckout('a', 'https://github.com/o/r')], [named('arch', 'r', 'o/r', { archivedAt: T(1) })]);
    expect([entry.existing, entry.name]).toEqual([null, 'r 2']);
  });
});

describe('a create that names a project', () => {
  it('is refused for a missing, archived or other-set project', () => {
    expect(requestedProjectRefusal(null, 'o/r')).toMatchObject({ status: 404, code: 'user_project_not_found' });
    expect(requestedProjectRefusal({ archivedAt: T(1), repoSetKey: 'o/r' }, 'o/r')).toMatchObject({ status: 409, code: 'user_project_archived' });
    expect(requestedProjectRefusal({ archivedAt: null, repoSetKey: 'o/r,o/s' }, 'o/r')).toMatchObject({ status: 409, code: 'user_project_repos_mismatch' });
    expect(requestedProjectRefusal({ archivedAt: null, repoSetKey: '' }, '')).toBeNull();
  });

  it("reads the create's repositories from repos, else repoUrl", () => {
    expect(createRepoUrls({ repos: [{ url: 'https://github.com/o/a' }, { url: 7 }] })).toEqual(['https://github.com/o/a', '']);
    expect(createRepoUrls({ repoUrl: 'https://github.com/o/a' })).toEqual(['https://github.com/o/a']);
    expect(createRepoUrls({ repoUrl: '  ' })).toEqual([]);
    expect(createRepoUrls({})).toEqual([]);
    expect(createRepoUrls({ repos: [null, 'x'] })).toEqual(['', '']);
    // Not a list: the create refuses it rather than reading it.
    expect(createRepoUrls({ repos: 'https://github.com/o/a' })).toBeNull();
    expect(createRepoUrls({ repos: { url: 'https://github.com/o/a' } })).toBeNull();
  });
});

describe('planNewUserProject (POST /api/user-projects)', () => {
  const TERMAG = 'https://github.com/example-org/termag.git';
  const DESKTOP = 'git@github.com:example-org/termag-desktop.git';

  it('takes a trimmed name and its repositories in the order given, keyed as a checkout of them would be', () => {
    const plan = planNewUserProject({ name: '  termag + desktop ', repos: [{ url: DESKTOP }, { url: TERMAG, defaultBranch: ' main ' }] });
    expect(plan).toEqual({
      ok: true,
      project: {
        name: 'termag + desktop',
        repoSetKey: repoSetKeyForUrls([TERMAG, DESKTOP]),
        repos: [
          { repoKey: 'example-org/termag-desktop', name: 'termag-desktop', url: DESKTOP, defaultBranch: null },
          { repoKey: 'example-org/termag', name: 'termag', url: TERMAG, defaultBranch: 'main' },
        ],
      },
    });
  });

  it('takes no repositories, as [] or left out', () => {
    for (const body of [{ name: 'scratch', repos: [] }, { name: 'scratch' }]) {
      expect(planNewUserProject(body)).toEqual({ ok: true, project: { name: 'scratch', repoSetKey: '', repos: [] } });
    }
  });

  it('refuses a name that is empty or over 60 characters', () => {
    for (const name of [undefined, '', '   ', 7]) {
      expect(planNewUserProject({ name, repos: [] })).toMatchObject({ ok: false, field: 'name' });
    }
    expect(planNewUserProject({ name: 'x'.repeat(USER_PROJECT_NAME_MAX), repos: [] }).ok).toBe(true);
    expect(planNewUserProject({ name: 'x'.repeat(USER_PROJECT_NAME_MAX + 1), repos: [] })).toMatchObject({ ok: false, field: 'name' });
    expect(planNewUserProject(null)).toMatchObject({ ok: false, field: 'name' });
  });

  it('names the repository at fault', () => {
    expect(planNewUserProject({ name: 'p', repos: [{ url: TERMAG }, { url: 'https://gitlab.com/a/b' }] }))
      .toEqual({ ok: false, field: 'repos', repo: 'https://gitlab.com/a/b', error: "https://gitlab.com/a/b isn't a GitHub repository URL" });
    expect(planNewUserProject({ name: 'p', repos: [{ url: TERMAG }, { url: 'https://github.com/Example-Org/termag' }] }))
      .toMatchObject({ ok: false, field: 'repos', repo: 'https://github.com/Example-Org/termag', error: 'example-org/termag is listed twice' });
    expect(planNewUserProject({ name: 'p', repos: [{ url: TERMAG, defaultBranch: 'a..b' }] }))
      .toMatchObject({ ok: false, field: 'repos', repo: TERMAG });
    expect(planNewUserProject({ name: 'p', repos: [null] })).toMatchObject({ ok: false, field: 'repos', repo: '' });
  });

  it('refuses two repositories that would be checked out under one folder name', () => {
    expect(planNewUserProject({ name: 'p', repos: [{ url: 'https://github.com/acme/api' }, { url: 'https://github.com/octo/API.git' }] }))
      .toEqual({ ok: false, field: 'repos', repo: 'https://github.com/octo/API.git', error: 'octo/api and acme/api would both be checked out as api: pick one' });
  });

  it('takes one repository at most when told so (multi-repo projects off)', () => {
    expect(planNewUserProject({ name: 'p', repos: [{ url: TERMAG }, { url: DESKTOP }] }, 1))
      .toMatchObject({ ok: false, field: 'repos', error: 'Projects with more than one repository are not on for you' });
    expect(planNewUserProject({ name: 'p', repos: [{ url: TERMAG }] }, 1).ok).toBe(true);
  });

  it('refuses repos that is not a list, and a ninth repository', () => {
    expect(planNewUserProject({ name: 'p', repos: TERMAG })).toMatchObject({ ok: false, field: 'repos' });
    const nine = Array.from({ length: 9 }, (_, i) => ({ url: `https://github.com/o/r${i}` }));
    expect(planNewUserProject({ name: 'p', repos: nine })).toMatchObject({ ok: false, field: 'repos', error: 'A project holds at most 8 repositories' });
    expect(planNewUserProject({ name: 'p', repos: nine.slice(0, 8) }).ok).toBe(true);
  });
});

describe('planAddedUserProjectRepo (POST /api/user-projects/:id/repos)', () => {
  const termag = { repoKey: 'example-org/termag', url: 'https://github.com/example-org/termag.git' };

  it('takes a GitHub repository the project lacks, with its default branch', () => {
    expect(planAddedUserProjectRepo([termag], { url: 'git@github.com:Example-Org/termag-desktop.git', defaultBranch: 'main' })).toEqual({
      ok: true, repo: { repoKey: 'example-org/termag-desktop', name: 'termag-desktop', url: 'git@github.com:Example-Org/termag-desktop.git', defaultBranch: 'main' },
    });
    expect(planAddedUserProjectRepo([], { url: 'https://github.com/a/b' })).toMatchObject({ ok: true, repo: { repoKey: 'a/b', defaultBranch: null } });
  });

  it('refuses one it already has, in any spelling', () => {
    expect(planAddedUserProjectRepo([termag], { url: 'https://github.com/Example-Org/termag' }))
      .toEqual({ ok: false, status: 409, code: 'user_project_repo_exists', error: 'The project already has example-org/termag' });
  });

  it('refuses a ninth, and a second while multi-repo projects are off', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ repoKey: `o/r${i}`, url: `https://github.com/o/r${i}` }));
    expect(planAddedUserProjectRepo(eight, { url: 'https://github.com/o/r9' }))
      .toEqual({ ok: false, status: 409, code: 'user_project_repo_limit', error: 'A project holds at most 8 repositories' });
    expect(planAddedUserProjectRepo([termag], { url: 'https://github.com/o/x' }, 1))
      .toMatchObject({ ok: false, status: 409, code: 'user_project_repo_limit' });
    expect(planAddedUserProjectRepo([], { url: 'https://github.com/o/x' }, 1).ok).toBe(true);
  });

  it('refuses a URL that is not GitHub\'s, a bad branch, and a folder another repository takes', () => {
    expect(planAddedUserProjectRepo([], { url: 'https://gitlab.com/a/b' })).toMatchObject({ ok: false, status: 400, code: 'user_project_invalid' });
    expect(planAddedUserProjectRepo([], { url: 'https://github.com/a/b', defaultBranch: 'a..b' })).toMatchObject({ ok: false, status: 400 });
    expect(planAddedUserProjectRepo([termag], { url: 'https://github.com/octo/termag' }))
      .toEqual({ ok: false, status: 400, code: 'user_project_invalid', error: 'octo/termag and example-org/termag would both be checked out as termag' });
  });
});

describe('grownRepoSetKeys', () => {
  it('adds the repository to the set and keeps the old set among the former ones', () => {
    expect(grownRepoSetKeys({ repoSetKey: 'example-org/termag', formerRepoSetKeys: [] }, 'example-org/desktop'))
      .toEqual({ repoSetKey: 'example-org/desktop,example-org/termag', formerRepoSetKeys: ['example-org/termag'] });
  });

  it('never keeps the empty set, nor a set twice', () => {
    expect(grownRepoSetKeys({ repoSetKey: '', formerRepoSetKeys: [] }, 'a/b')).toEqual({ repoSetKey: 'a/b', formerRepoSetKeys: [] });
    expect(grownRepoSetKeys({ repoSetKey: 'a/b', formerRepoSetKeys: ['a/b'] }, 'a/c')).toEqual({ repoSetKey: 'a/b,a/c', formerRepoSetKeys: ['a/b'] });
  });
});
