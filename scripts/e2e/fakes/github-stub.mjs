// Stand-in for api.github.com and github.com's git smart-HTTP
// (E2E_FAKE_GITHUB=1), plain HTTP on loopback. The backend reaches it through
// github-redirect.cjs: api.github.com at the root, github.com under
// /_github.com/, served by `git http-backend` from bare repositories under
// E2E_GITHUB_ROOT (e2e-org/sample and e2e-org/sample-api, the second repository
// of a multi-repo project, are created with one commit each, as are the
// viewer's own e2e-octocat/shop-web and shop-api, which GET /user/repos lists
// ahead of its made-up rows; e2e-org/dotfiles,
// a dotfiles repo with an install.sh, is public: clones need no token, as is
// example-org/e2e-demo, a public repository; chat trust is the owner's tick,
// not the GitHub owner; e2e-org/big-memory, many-cores, big-disk and typo-box, public, carry
// a .termag/environment.json, served with commits/HEAD and contents/). A token
// containing "_bad" gets 401; one containing "_noscope" lacks admin:public_key.
// Logs each call with a token fingerprint (the first 8 hex of its sha256),
// never the token. GET /_e2e/calls returns the call log. Pull requests (the
// ask publish path) live in memory: list by head, get by number (with its
// author and its head's sha and repository, read from the bare repo), its
// commits and files, create, and PATCH its body; compare answers for any
// served repo.
//
// The PR pipeline gets one open PR, example-org/termag#4242
// by e2e-alice, asking e2e-octocat for a review: the dashboard's review search,
// the overview query and POST .../pulls/4242/reviews answer from it, and a
// submitted review takes the request off the PR, as on GitHub. Two of the
// viewer's own PRs exercise the merge panel: #4243 is approved and clean (PUT
// .../merge merges it into the merged search), #4244 is blocked on a review
// (the auto-merge mutations turn auto-merge on and off). #4245 has a failed
// Actions run (777, which POST .../actions/runs/777/rerun-failed-jobs sets
// running again) and a failed Bugbot suite, which only its app could restart.
// #4244 also has e2e-bob's change request and pending requests to e2e-carol and
// team e2e-team, for POST .../requested_reviewers and .../issues/4244/comments.
// Review groups read their members by number (the ByNumber query): these PRs
// answer it, so a group of them can be made and read on the stack.
// A merge of #4243 compares as not yet in any running commit, and the Publish
// AMI workflow answers its runs (none, until POST .../dispatches starts one).
// gh pr list (with or without a search flag) and gh search prs answer with the
// viewer's open PRs. GET /meta has no installed_version, as on api.github.com,
// and is gzipped for a client that accepts it.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const port = Number(process.env.E2E_GITHUB_PORT);
const gitRoot = process.env.E2E_GITHUB_ROOT;

// A public repo's clones and fetches need no token (pushes still do), as on
// github.com; the marker file inside the bare repo is what makes it public.
const PUBLIC_MARKER = 'termag-e2e-public';
const isPublic = (owner, repo) => !!gitRoot && existsSync(join(gitRoot, owner, `${repo}.git`, PUBLIC_MARKER));
// Seconds a fetch's pack waits before it is sent, from this marker in the bare
// repo (none: at once), so a test can see a clone while it runs.
const SLOW_MARKER = 'termag-e2e-slow';
const slowSeconds = (owner, repo) => {
  try { return Math.min(60, Number(readFileSync(join(gitRoot, owner, `${repo}.git`, SLOW_MARKER), 'utf8').trim()) || 0); } catch { return 0; }
};

function seedRepo(owner, name, { files = {}, isPublicRepo = false } = {}) {
  const bare = join(gitRoot, owner, `${name}.git`);
  if (existsSync(bare)) return;
  mkdirSync(join(gitRoot, owner), { recursive: true });
  const work = join(gitRoot, '.seed', `${owner}-${name}`);
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...a], { cwd, env: { PATH: process.env.PATH, HOME: gitRoot } });
  mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  execFileSync('sh', ['-c', `printf '# ${owner}/${name}\\nserved by the e2e github stub\\n' > README.md`], { cwd: work });
  for (const [path, { content, mode }] of Object.entries(files)) {
    mkdirSync(join(work, path, '..'), { recursive: true });
    writeFileSync(join(work, path), content, { mode: mode ?? 0o644 });
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'initial commit');
  git(join(gitRoot, owner), 'clone', '-q', '--bare', work, bare);
  git(bare, 'config', 'http.receivepack', 'true');
  if (isPublicRepo) writeFileSync(join(bare, PUBLIC_MARKER), '');
}
if (gitRoot) {
  seedRepo('e2e-org', 'sample');
  seedRepo('e2e-org', 'sample-api');
  // The viewer's own repositories, listed first by GET /user/repos, so a
  // repository picker has real rows to pick (a multi-repo project, two).
  // Public, as a stand-in box's git has no GitHub credential.
  seedRepo('e2e-octocat', 'shop-web', { isPublicRepo: true });
  seedRepo('e2e-octocat', 'shop-api', { isPublicRepo: true });
  // A public dotfiles repo for the warm pool's claim-time personalization. Its
  // install.sh takes E2E_DOTFILES_SECONDS (default 3, or set in the box's
  // ~/.termag/e2e-dotfiles.env), so "personalizing" is visible, and leaves a
  // marker saying whose claim ran it.
  seedRepo('e2e-org', 'dotfiles', {
    isPublicRepo: true,
    files: {
      'install.sh': {
        mode: 0o755,
        content: '#!/bin/sh\nset -e\n[ -f "$HOME/.termag/e2e-dotfiles.env" ] && . "$HOME/.termag/e2e-dotfiles.env"\nsleep "${E2E_DOTFILES_SECONDS:-3}"\n'
          + 'printf \'applied for %s <%s>\\n\' "$TERMAG_OWNER_NAME" "$TERMAG_OWNER_EMAIL" > "$HOME/.e2e-dotfiles-applied"\n',
      },
      '.e2e-dotfile': { content: 'from e2e-org/dotfiles\n' },
    },
  });
  // A public repository under a trusted GitHub owner (backend
  // services/chatTrust.ts), so a simple-UI chat on it runs tools at once.
  seedRepo('example-org', 'e2e-demo', { isPublicRepo: true });
  // Repositories that size their own boxes (backend services/repoEnvironment.ts):
  // one asking for 4 vCPU / 32 GiB (r8g.xlarge), one for 8 vCPU / 16 GiB
  // (with it, a multi-repo project's box is 8/32, large), and one whose file
  // has a value termag ignores with a warning. Public.
  seedRepo('e2e-org', 'big-memory', {
    isPublicRepo: true,
    files: { '.termag/environment.json': { content: '{ "resources": { "vcpu": 4, "memoryGiB": 32 } }\n' } },
  });
  seedRepo('e2e-org', 'many-cores', {
    isPublicRepo: true,
    files: { '.termag/environment.json': { content: '{ "resources": { "vcpu": 8, "memoryGiB": 16 } }\n' } },
  });
  // One asking for a 250 GiB disk and nothing else (backend services/boxDiskSize.ts).
  seedRepo('e2e-org', 'big-disk', {
    isPublicRepo: true,
    files: { '.termag/environment.json': { content: '{ "resources": { "diskGiB": 250 } }\n' } },
  });
  seedRepo('e2e-org', 'typo-box', {
    isPublicRepo: true,
    files: { '.termag/environment.json': { content: '{ "resources": "huge" }\n' } },
  });
}

// git sends the token as the Basic password, base64-encoded, so the markers
// ("_bad", "_noscope") are only visible after decoding.
const tokenOf = (auth) => {
  const bearer = /^(?:token|bearer)\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1];
  const basic = /^basic\s+(.+)$/i.exec(auth);
  if (!basic) return '';
  return Buffer.from(basic[1], 'base64').toString().split(':').slice(1).join(':');
};
const fp = (auth) => {
  const secret = tokenOf(auth);
  return secret ? createHash('sha256').update(secret).digest('hex').slice(0, 8) : 'none';
};

// github.com smart-HTTP through git http-backend (CGI), streaming both ways.
function serveGit(req, res, path, auth) {
  const rel = path.slice('/_github.com'.length);
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(rel);
  if (!m || !gitRoot) { record(`git ${req.method} ${rel} -> 404`); res.writeHead(404); return res.end(); }
  const [, owner, repo, suffix] = m;
  const service = suffix === 'info/refs' ? new URL(req.url, 'http://x').searchParams.get('service') : suffix;
  const anonymousOk = service === 'git-upload-pack' && isPublic(owner, repo);
  if (!anonymousOk && (!tokenOf(auth) || tokenOf(auth).includes('_bad'))) {
    record(`git ${service} ${owner}/${repo} -> 401 token=${fp(auth)}`);
    res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
    return res.end();
  }
  const delay = service === 'git-upload-pack' && suffix === 'git-upload-pack' ? slowSeconds(owner, repo) : 0;
  if (delay > 0) {
    // Read the request now, hand it to http-backend later.
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => setTimeout(() => runBackend(req, res, owner, repo, suffix, service, auth, Buffer.concat(chunks)), delay * 1000));
    return;
  }
  runBackend(req, res, owner, repo, suffix, service, auth, null);
}

function runBackend(req, res, owner, repo, suffix, service, auth, body) {
  const cgi = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: gitRoot, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'e2e-octocat',
      REQUEST_METHOD: req.method, PATH_INFO: `/${owner}/${repo}.git/${suffix}`,
      QUERY_STRING: new URL(req.url, 'http://x').search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
    },
  });
  if (body) cgi.stdin.end(body); else req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let headerDone = false;
  let status = 200;
  cgi.stdout.on('data', chunk => {
    if (headerDone) return res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    headerDone = true;
    const headers = {};
    for (const line of head.slice(0, end).toString().split('\r\n')) {
      const i = line.indexOf(':');
      const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = parseInt(v, 10); else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.write(head.slice(end + 4));
  });
  cgi.on('close', () => { record(`git ${service} ${owner}/${repo} -> ${status} token=${fp(auth)}`); res.end(); });
}

// Never matches GET /user, so connect still gets a user.
// A bare _ratelimited fails example-team, not the user route, so the user group stays ok.
function listingFailure(token, path) {
  const org = /^\/orgs\/([^/]+)\/repos$/.exec(path);
  const userRepos = path === '/user/repos';
  if (!org && !userRepos) return null;
  const nosso = /_nosso(?:_([A-Za-z0-9][A-Za-z0-9_.-]*))?/.exec(token);
  if (nosso) {
    const slug = nosso[1] || 'example-org';
    return org && org[1] === slug ? 'sso' : null;
  }
  const rate = /_ratelimited(?:_([A-Za-z0-9][A-Za-z0-9_.-]*))?/.exec(token);
  if (rate) {
    const slug = rate[1] || 'example-team';
    if (slug === 'user') return userRepos ? 'rate' : null;
    return org && org[1] === slug ? 'rate' : null;
  }
  return null;
}

// The owner's bare repositories under E2E_GITHUB_ROOT, which clone: page 1
// lists them ahead of the made-up rows, most recently pushed.
function seededRepos(owner) {
  if (!gitRoot || !existsSync(join(gitRoot, owner))) return [];
  return readdirSync(join(gitRoot, owner))
    .filter(entry => entry.endsWith('.git'))
    .sort()
    .map((entry, i) => {
      const name = entry.slice(0, -'.git'.length);
      return {
        id: 20000 + i, name, full_name: `${owner}/${name}`, private: !isPublic(owner, name),
        default_branch: 'main', archived: false, pushed_at: new Date().toISOString(), size: 10,
      };
    });
}

function reposFor(owner, page, perPage) {
  const page1 = [...seededRepos(owner), {
    id: 1, name: 'archived-one', full_name: `${owner}/archived-one`, private: true,
    default_branch: 'main', archived: true, pushed_at: '2019-01-01T00:00:00Z', size: 8,
  }];
  for (let i = 1; i < perPage; i++) {
    page1.push({
      id: i + 1, name: `repo-${i}`, full_name: `${owner}/repo-${i}`, private: true,
      default_branch: 'main', archived: false, pushed_at: '2024-01-01T00:00:00Z', size: 100 + i,
    });
  }
  if (page <= 1) return page1;
  if (page === 2) {
    return [{
      id: 10000, name: 'repo-last', full_name: `${owner}/repo-last`, private: false,
      default_branch: 'main', archived: false, pushed_at: '2025-01-01T00:00:00Z', size: 50,
    }];
  }
  return [];
}

function serveRepoList(req, res, auth, path, url, send) {
  const token = tokenOf(auth);
  const orgMatch = /^\/orgs\/([^/]+)\/repos$/.exec(path);
  const owner = orgMatch ? orgMatch[1] : 'e2e-octocat';
  const fail = listingFailure(token, path);
  if (fail === 'sso') {
    record(`GET ${path} -> 403 sso token=${fp(auth)}`);
    return send(403, { message: 'Resource protected by organization SAML enforcement' }, {
      'x-github-sso': `required; url=https://github.com/orgs/${owner}/sso?authorization_request=e2e`,
    });
  }
  if (fail === 'rate') {
    record(`GET ${path} -> 403 rate token=${fp(auth)}`);
    return send(403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-remaining': '0',
      'retry-after': '60',
    });
  }
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const perPage = Math.max(1, parseInt(url.searchParams.get('per_page') || '30', 10) || 1);
  const etag = `"${owner}-p${page}"`;
  if (req.headers['if-none-match'] === etag) {
    record(`GET ${path}?page=${page} -> 304 token=${fp(auth)}`);
    res.writeHead(304, { etag });
    return res.end();
  }
  const link = `<https://api.github.com${path}?page=2&per_page=${perPage}>; rel="last"`;
  record(`GET ${path}?page=${page} -> 200 token=${fp(auth)}`);
  return send(200, reposFor(owner, page, perPage), { etag, link });
}

const calls = [];
const keys = new Map();
const pulls = [];

// The bare repository the stub serves for owner/name, or null.
const servedBare = (owner, name) => {
  const bare = gitRoot ? join(gitRoot, owner, `${name}.git`) : null;
  return bare && existsSync(bare) ? bare : null;
};
const bareLines = (bare, args) => {
  try { return execFileSync('git', ['-C', bare, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return []; }
};
const bareRev = (bare, ref) => bareLines(bare, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])[0] ?? null;
const bareAncestor = (bare, a, b) => {
  try { execFileSync('git', ['-C', bare, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; }
};
// A PR as GET /pulls/:n answers: its author, and its head's sha and repository read from the bare repo now.
const pullView = (p) => {
  const [owner, name] = p.headRepo.split('/');
  const bare = servedBare(owner, name);
  const defaultBranch = (() => { try { return /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(servedBare(...p.repo.split('/')) ?? '', 'HEAD'), 'utf8'))?.[1] ?? 'main'; } catch { return 'main'; } })();
  return {
    ...p.view, user: { login: p.user },
    head: { ...p.view.head, sha: (bare && bareRev(bare, `refs/heads/${p.view.head.ref}`)) ?? null, repo: { full_name: p.headRepo } },
    base: { ...p.view.base, repo: { full_name: p.repo, default_branch: defaultBranch } },
  };
};

const VIEWER = 'e2e-octocat';
const reviewPr = {
  number: 4242, title: 'Add a stub PR for the review dialog', url: 'https://github.com/example-org/termag/pull/4242',
  isDraft: false, updatedAt: new Date().toISOString(), headRefName: 'e2e/review-me', baseRefName: 'main',
  reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  author: { login: 'e2e-alice' }, repository: { nameWithOwner: 'example-org/termag' }, autoMergeRequest: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [
    { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ] } } } }] },
  state: 'OPEN', createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  body: 'Why: the dashboard needs a PR to review.\n\nHow: the e2e GitHub stub serves this one.\n\n- [ ] reviewed',
  additions: 12, deletions: 2, changedFiles: 2,
  files: { pageInfo: { hasNextPage: false }, nodes: [
    { path: 'scripts/e2e/fakes/github-stub.mjs', additions: 10, deletions: 2, changeType: 'MODIFIED' },
    { path: 'docs/e2e-stack.md', additions: 2, deletions: 0, changeType: 'MODIFIED' },
  ] },
};
const reviews = []; // { author, state, submittedAt, body }
let requested = true;

const REPO_SETTINGS = { nameWithOwner: 'example-org/termag', mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH' };
const ownPr = (number, title, over) => ({
  ...reviewPr, number, title, url: `https://github.com/example-org/termag/pull/${number}`, headRefName: `e2e/own-${number}`,
  author: { login: VIEWER }, id: `PR_e2e${number}`, headRefOid: String(number).repeat(10), ...over,
});
const own = new Map([
  [4243, { pr: ownPr(4243, 'A PR of mine that is ready to merge', { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }), merged: null, autoMethod: null }],
  [4244, { pr: ownPr(4244, 'A PR of mine still waiting on a review', { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }), merged: null, autoMethod: null }],
]);
let ciRerun = false;
own.set(4245, { pr: ownPr(4245, 'A PR of mine with a failed CI run', { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }), merged: null, autoMethod: null, failing: true });
const failingChecks = () => ({
  commits: { nodes: [{ commit: { statusCheckRollup: { state: ciRerun ? 'PENDING' : 'FAILURE', contexts: { nodes: [
    { __typename: 'CheckRun', name: 'ci', status: ciRerun ? 'IN_PROGRESS' : 'COMPLETED', conclusion: ciRerun ? null : 'FAILURE' },
    { __typename: 'CheckRun', name: 'Cursor Bugbot', status: 'COMPLETED', conclusion: 'FAILURE' },
  ] } } } }] },
  head: { nodes: [{ commit: { checkSuites: { nodes: [
    { status: ciRerun ? 'IN_PROGRESS' : 'COMPLETED', conclusion: ciRerun ? null : 'FAILURE', app: { name: 'GitHub Actions' }, workflowRun: { databaseId: 777, workflow: { name: 'CI' } } },
    { status: 'COMPLETED', conclusion: 'FAILURE', app: { name: 'Cursor Bugbot' }, workflowRun: null },
  ] } } }] },
});
const review4244 = { reviews: [{ author: 'e2e-bob', state: 'CHANGES_REQUESTED' }], users: ['e2e-carol'], teams: ['e2e-team'] };
const comments = [];
let bakeDispatchedAt = null;
const reviewState = o => o.pr.number !== 4244 ? null : {
  reviewRequests: { nodes: [
    ...review4244.users.map(login => ({ requestedReviewer: { __typename: 'User', login } })),
    ...review4244.teams.map(slug => ({ requestedReviewer: { __typename: 'Team', slug } })),
  ] },
  latestReviews: { nodes: review4244.reviews.map(r => ({ author: { login: r.author }, state: r.state, submittedAt: o.pr.createdAt })) },
};
const ownNode = o => ({
  ...o.pr,
  ...(o.failing ? failingChecks() : {}),
  repository: REPO_SETTINGS,
  state: o.merged ? 'MERGED' : 'OPEN',
  autoMergeRequest: o.autoMethod ? { enabledAt: new Date().toISOString(), mergeMethod: o.autoMethod } : null,
  reviewRequests: { nodes: [] }, timelineItems: { nodes: [] },
  latestReviews: { nodes: o.pr.reviewDecision === 'APPROVED' ? [{ author: { login: 'e2e-alice' }, state: 'APPROVED', submittedAt: o.pr.createdAt }] : [] },
  viewerLatestReview: null,
  ...reviewState(o),
});
// More of the viewer's open PRs, in any repository, from
// $E2E_GITHUB_ROOT/own-prs.json ([{ "repo": "owner/name", "number": N,
// "title": "...", "headRefName": "..." }]), read on every search and
// overview: a multi-repo workstream's second PR, on the same branch as #4244.
const extraOwn = () => {
  const file = gitRoot && join(gitRoot, 'own-prs.json');
  if (!file || !existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).map(x => ({
    ...ownNode({ pr: ownPr(x.number, x.title, { headRefName: x.headRefName, url: `https://github.com/${x.repo}/pull/${x.number}` }), merged: null, autoMethod: null }),
    repository: { ...REPO_SETTINGS, nameWithOwner: x.repo },
  }));
};
const mergedNode = o => ({
  number: o.pr.number, title: o.pr.title, url: o.pr.url, headRefName: o.pr.headRefName, baseRefName: 'main', mergedAt: o.merged.at,
  author: { login: VIEWER }, mergedBy: { login: VIEWER }, repository: { nameWithOwner: 'example-org/termag' },
  mergeCommit: { oid: o.merged.sha }, files: { pageInfo: { hasNextPage: false }, nodes: o.pr.files.nodes.map(f => ({ path: f.path })) },
});

function reviewPrNode() {
  return {
    ...reviewPr,
    reviewRequests: { nodes: requested ? [{ requestedReviewer: { __typename: 'User', login: VIEWER } }] : [] },
    timelineItems: { nodes: [{ createdAt: reviewPr.createdAt, requestedReviewer: { __typename: 'User', login: VIEWER } }] },
    latestReviews: { nodes: reviews.map(({ author, state, submittedAt }) => ({ author: { login: author }, state, submittedAt })) },
    viewerLatestReview: reviews.length ? { author: { login: VIEWER }, ...reviews.at(-1), body: undefined } : null,
  };
}

/** The GraphQL documents the backend sends, told apart by operation name. */
function graphqlData(query, variables) {
  const op = /(?:query|mutation)\s+(\w+)/.exec(query ?? '')?.[1];
  const search = nodes => ({ issueCount: nodes.length, nodes });
  const termag = variables?.owner === 'example-org' && variables?.name === 'termag';
  const byId = id => [...own.values()].find(o => o.pr.id === id);
  if (op === 'Authored') return { viewer: { login: VIEWER }, search: search([...[...own.values()].filter(o => !o.merged).map(ownNode), ...extraOwn()]) };
  if (op === 'Review') return { search: search(requested ? [reviewPrNode()] : []) };
  if (op === 'Merged') return { search: search([...own.values()].filter(o => o.merged).map(mergedNode)) };
  if (op === 'Overview' || op === 'PrId' || op === 'Suites') {
    const o = termag ? own.get(variables?.number) : undefined;
    const full = `${variables?.owner}/${variables?.name}`;
    const extra = termag ? undefined : extraOwn().find(x => x.repository.nameWithOwner === full && x.number === variables?.number);
    const node = o ? ownNode(o) : extra ?? (termag && variables?.number === reviewPr.number ? reviewPrNode() : null);
    return { viewer: { login: VIEWER }, repository: { pullRequest: node } };
  }
  // Review group members, by number (backend services/prPipelineGithub.ts fetchPrsByNumber):
  // aliases m<i> over the variables o<i>/n<i>/p<i>. The stub's own PRs and its review
  // request answer, so a group of them can be made and read; any other PR is null, as
  // GitHub answers one the token can't see.
  if (op === 'ByNumber') {
    const out = {};
    for (let i = 0; variables && `p${i}` in variables; i++) {
      const inTermag = variables[`o${i}`] === 'example-org' && variables[`n${i}`] === 'termag';
      const number = variables[`p${i}`];
      const o = inTermag ? own.get(number) : undefined;
      const node = o
        ? { ...(o.merged ? mergedNode(o) : ownNode(o)), state: o.merged ? 'MERGED' : 'OPEN' }
        : inTermag && number === reviewPr.number ? reviewPrNode() : null;
      out[`m${i}`] = { pullRequest: node };
    }
    return out;
  }
  // A PR's head, for a new workstream on it (backend services/prReview.ts fetchPrHead).
  // $E2E_GITHUB_ROOT/pr-heads.json ({ "<number>": "<commit>" }) points a PR at a
  // real commit, for a test whose box fetches pull/<n>/head from a local origin;
  // a PR of own-prs.json in another repository is keyed "<owner>/<name>#<number>".
  if (op === 'PrHead') {
    const o = termag ? own.get(variables?.number) : undefined;
    const full = `${variables?.owner}/${variables?.name}`;
    const extra = termag ? undefined : extraOwn().find(x => x.repository.nameWithOwner === full && x.number === variables?.number);
    const pr = o ? o.pr : extra ?? (termag && variables?.number === reviewPr.number ? reviewPr : null);
    const heads = gitRoot && existsSync(join(gitRoot, 'pr-heads.json')) ? JSON.parse(readFileSync(join(gitRoot, 'pr-heads.json'), 'utf8')) : {};
    return { repository: { pullRequest: pr ? {
      state: o?.merged ? 'MERGED' : 'OPEN', headRefName: pr.headRefName, isCrossRepository: false,
      headRefOid: heads[termag ? String(variables?.number) : `${full}#${variables?.number}`] ?? pr.headRefOid ?? String(variables?.number).repeat(10).slice(0, 40).padEnd(40, '0'),
    } : null } };
  }
  // gh's feature detection introspects types (`SearchType: __type(...)`); none
  // has the fields or values it looks for.
  const types = [...(query ?? '').matchAll(/(\w+)\s*:\s*__type\b/g)].map(m => m[1]);
  const empty = /\benumValues\b/.test(query) ? { enumValues: [] } : { fields: [] };
  if (types.length) return Object.fromEntries(types.map(t => [t, empty]));
  // gh pr list on its own (PullRequestList) and with a search flag such as
  // --author (PullRequestSearch): the viewer's open PRs, in any repository.
  const openPrs = () => [...own.values()].filter(o => !o.merged).map(ownNode);
  const page = { pageInfo: { hasNextPage: false, endCursor: null } };
  if (op === 'PullRequestSearch') return { search: { ...search(openPrs()), ...page } };
  if (op === 'PullRequestList') return { repository: { pullRequests: { totalCount: openPrs().length, nodes: openPrs(), ...page } } };
  if (op === 'EnableAutoMerge' || op === 'DisableAutoMerge') {
    const o = byId(variables?.id);
    if (!o) return { errors: [{ message: `Could not resolve to a node with the global id of '${variables?.id}'` }] };
    if (op === 'EnableAutoMerge' && o.pr.mergeStateStatus === 'CLEAN') return { errors: [{ message: 'Pull request is in clean status' }] };
    o.autoMethod = op === 'EnableAutoMerge' ? variables.method : null;
    const field = op === 'EnableAutoMerge' ? 'enablePullRequestAutoMerge' : 'disablePullRequestAutoMerge';
    return { [field]: { pullRequest: { autoMergeRequest: o.autoMethod ? { enabledAt: new Date().toISOString() } : null } } };
  }
  return { viewer: { login: VIEWER } };
}

const REVIEW_STATE = { APPROVE: 'APPROVED', COMMENT: 'COMMENTED', REQUEST_CHANGES: 'CHANGES_REQUESTED' };
let nextId = 9000;

function record(line) {
  calls.push(line);
  console.log(new Date().toISOString(), line);
}

createServer((req, res) => {
  const earlyPath = req.url.split('?')[0];
  if (earlyPath.startsWith('/_github.com/')) return serveGit(req, res, earlyPath, req.headers.authorization ?? '');
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const auth = req.headers.authorization ?? '';
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (req.method === 'GET' && path === '/_e2e/calls') return send(200, calls);
    if (req.method === 'GET' && path === '/meta') {
      record('GET /meta');
      const meta = JSON.stringify({ ssh_keys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'] });
      // Compressed when the client accepts it, as api.github.com does.
      if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        return res.end(gzipSync(meta));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(meta);
    }
    // A served repository's default branch head (`commits/HEAD`, the sha
    // alone, as `Accept: application/vnd.github.sha` asks) and a file at a
    // commit (`contents/<path>?ref=`, raw), read from its bare repo: what the
    // backend's repoEnvironment.ts reads `.termag/environment.json` with. A private one
    // needs a token, as on GitHub, and a public one none; anything else
    // answers 404.
    const headPath = /^\/repos\/([^/]+)\/([^/]+)\/commits\/HEAD$/.exec(path);
    const contentsPath = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path);
    if (req.method === 'GET' && (headPath || contentsPath)) {
      const [, owner, name] = headPath ?? contentsPath;
      const bare = servedBare(owner, name);
      const allowed = bare && (isPublic(owner, name) || (tokenOf(auth) && !tokenOf(auth).includes('_bad')));
      if (!allowed) { record(`GET ${path} -> 404 token=${fp(auth)}`); return send(404, { message: 'Not Found' }); }
      if (headPath) {
        const sha = bareRev(bare, 'HEAD');
        record(`GET ${path} -> 200 ${sha} token=${fp(auth)}`);
        res.writeHead(200, { 'content-type': 'application/vnd.github.sha' });
        return res.end(sha);
      }
      const ref = url.searchParams.get('ref') ?? 'HEAD';
      let text = null;
      try { text = execFileSync('git', ['-C', bare, 'show', `${ref}:${decodeURIComponent(contentsPath[3])}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { text = null; }
      record(`GET ${path}?ref=${ref} -> ${text === null ? 404 : 200} token=${fp(auth)}`);
      if (text === null) return send(404, { message: 'Not Found' });
      res.writeHead(200, { 'content-type': 'application/vnd.github.raw' });
      return res.end(text);
    }
    if (!auth) { record(`${req.method} ${path} -> 401 (no token)`); return send(401, { message: 'Requires authentication' }); }
    if (tokenOf(auth).includes('_bad')) { record(`${req.method} ${path} -> 401 token=${fp(auth)}`); return send(401, { message: 'Bad credentials' }); }
    const scopeHeader = { 'x-oauth-scopes': tokenOf(auth).includes('_noscope') ? 'repo, read:org' : 'repo, read:org, admin:public_key' };
    if (req.method === 'GET' && path === '/') {
      record(`GET / -> 200 token=${fp(auth)}`);
      return send(200, { current_user_url: 'https://api.github.com/user' }, scopeHeader);
    }
    if (req.method === 'POST' && path === '/graphql') {
      let q = {};
      try { q = JSON.parse(body); } catch { /* gh's own probes */ }
      const op = /(?:query|mutation)\s+(\w+)/.exec(q.query ?? '')?.[1] ?? '-';
      record(`POST /graphql ${op} -> 200 token=${fp(auth)}`);
      const data = graphqlData(q.query, q.variables);
      // A refused mutation answers 200 with `errors`, as GitHub does.
      return send(200, data.errors ? { data: null, errors: data.errors } : { data });
    }
    // gh search prs and gh search issues: the viewer's open PRs.
    if (req.method === 'GET' && path === '/search/issues') {
      record(`GET /search/issues -> 200 token=${fp(auth)}`);
      const items = [...own.values()].filter(o => !o.merged).map(({ pr }) => ({
        number: pr.number, title: pr.title, state: 'open', html_url: pr.url, user: { login: pr.author.login },
        repository_url: 'https://api.github.com/repos/example-org/termag', labels: [], created_at: pr.createdAt, updated_at: pr.updatedAt,
        pull_request: { url: `https://api.github.com/repos/example-org/termag/pulls/${pr.number}` },
      }));
      return send(200, { total_count: items.length, incomplete_results: false, items });
    }
    const compare = /^\/repos\/example-org\/termag\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(path);
    if (req.method === 'GET' && compare) {
      const merged = [...own.values()].some(o => o.merged?.sha === compare[2]);
      record(`GET ${path} -> ${merged ? 200 : 404}`);
      return merged ? send(200, { status: 'ahead' }) : send(404, { message: 'Not Found' });
    }
    const workflow = '/repos/example-org/termag/actions/workflows/publish-ami.yml';
    if (req.method === 'GET' && path === `${workflow}/runs`) {
      record(`GET ${path} -> 200`);
      return send(200, { workflow_runs: bakeDispatchedAt ? [{ status: 'in_progress', event: 'workflow_dispatch', html_url: 'https://github.com/example-org/termag/actions/runs/1', created_at: bakeDispatchedAt }] : [] });
    }
    if (req.method === 'POST' && path === `${workflow}/dispatches`) {
      let r = {};
      try { r = JSON.parse(body); } catch { return send(400, { message: 'Problems parsing JSON' }); }
      if (r.ref !== 'main' || r.inputs?.target !== 'orchestrator') { record(`POST ${path} -> 422`); return send(422, { message: 'Unexpected inputs' }); }
      bakeDispatchedAt = new Date().toISOString();
      record(`POST ${path} -> 204 ref=${r.ref} target=${r.inputs.target} token=${fp(auth)}`);
      return send(204);
    }
    if (req.method === 'POST' && path === '/repos/example-org/termag/pulls/4244/requested_reviewers') {
      let r = {};
      try { r = JSON.parse(body); } catch { return send(400, { message: 'Problems parsing JSON' }); }
      const users = r.reviewers ?? [];
      if (users.includes(VIEWER)) { record(`POST ${path} -> 422`); return send(422, { message: 'Review cannot be requested from pull request author.' }); }
      // A re-request turns an answered reviewer back into a pending one, as on GitHub.
      for (const u of users) {
        review4244.reviews = review4244.reviews.filter(x => x.author !== u);
        if (!review4244.users.includes(u)) review4244.users.push(u);
      }
      for (const t of r.team_reviewers ?? []) if (!review4244.teams.includes(t)) review4244.teams.push(t);
      record(`POST ${path} -> 201 reviewers=${users.join(',')} token=${fp(auth)}`);
      return send(201, { requested_reviewers: review4244.users.map(login => ({ login })), requested_teams: review4244.teams.map(slug => ({ slug })) });
    }
    if (req.method === 'POST' && path === '/repos/example-org/termag/issues/4244/comments') {
      let r = {};
      try { r = JSON.parse(body); } catch { return send(400, { message: 'Problems parsing JSON' }); }
      comments.push(r.body);
      record(`POST ${path} -> 201 body=${JSON.stringify(r.body)} token=${fp(auth)}`);
      return send(201, { id: nextId++, html_url: `${own.get(4244).pr.url}#issuecomment-${nextId}` });
    }
    if (req.method === 'POST' && path === '/repos/example-org/termag/actions/runs/777/rerun-failed-jobs') {
      if (ciRerun) { record(`POST ${path} -> 403 (running)`); return send(403, { message: 'This workflow is already running' }); }
      ciRerun = true;
      record(`POST ${path} -> 201 token=${fp(auth)}`);
      return send(201, {});
    }
    const mergePath = /^\/repos\/example-org\/termag\/pulls\/(\d+)\/merge$/.exec(path);
    if (req.method === 'PUT' && mergePath) {
      const o = own.get(Number(mergePath[1]));
      let r = {};
      try { r = JSON.parse(body); } catch { return send(400, { message: 'Problems parsing JSON' }); }
      if (!o || o.merged) { record(`PUT ${path} -> 405`); return send(405, { message: 'Pull Request is not mergeable' }); }
      if (r.sha !== o.pr.headRefOid) { record(`PUT ${path} -> 409`); return send(409, { message: 'Head branch was modified. Review and try the merge again.' }); }
      if (o.pr.mergeStateStatus !== 'CLEAN') { record(`PUT ${path} -> 405 (blocked)`); return send(405, { message: 'At least 1 approving review is required by reviewers with write access.' }); }
      o.merged = { at: new Date().toISOString(), sha: 'e2e0'.repeat(10) };
      record(`PUT ${path} -> 200 method=${r.merge_method} token=${fp(auth)}`);
      return send(200, { merged: true, sha: o.merged.sha, message: 'Pull Request successfully merged' });
    }
    if (req.method === 'POST' && path === `/repos/example-org/termag/pulls/${reviewPr.number}/reviews`) {
      let r = {};
      try { r = JSON.parse(body); } catch { return send(400, { message: 'Problems parsing JSON' }); }
      const state = REVIEW_STATE[r.event];
      if (!state) { record(`POST ${path} -> 422`); return send(422, { message: 'Unprocessable Entity', errors: ['event is not valid'] }); }
      if (state !== 'APPROVED' && !r.body) { record(`POST ${path} -> 422 (no body)`); return send(422, { message: 'Unprocessable Entity', errors: ['Body is required'] }); }
      const review = { author: VIEWER, state, submittedAt: new Date().toISOString(), body: r.body ?? '' };
      reviews.push(review);
      requested = false;
      record(`POST ${path} -> 200 event=${r.event} token=${fp(auth)}`);
      return send(200, { id: nextId++, state, html_url: `${reviewPr.url}#pullrequestreview-${nextId}` });
    }
    // compare <base>...<sha> on a served repository other than example-org/termag, from its bare repo,
    // as GitHub answers it: `ahead` when sha descends from base, `behind` when base descends from sha.
    const anyCompare = /^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)\.\.\.([0-9a-f]{40})$/.exec(path);
    if (req.method === 'GET' && anyCompare && servedBare(anyCompare[1], anyCompare[2])) {
      const bare = servedBare(anyCompare[1], anyCompare[2]);
      const base = bareRev(bare, decodeURIComponent(anyCompare[3]));
      const sha = anyCompare[4];
      const status = !base || !bareRev(bare, sha) ? null
        : base === sha ? 'identical' : bareAncestor(bare, base, sha) ? 'ahead' : bareAncestor(bare, sha, base) ? 'behind' : 'diverged';
      record(`GET ${path} -> ${status ? `200 ${status}` : 404}`);
      return status ? send(200, { status }) : send(404, { message: 'Not Found' });
    }
    const pullsPath = /^\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?(\/commits|\/files)?$/.exec(path);
    if (pullsPath) {
      const [, owner, repo, num, sub] = pullsPath;
      const commitsOf = sub === '/commits';
      const full = `${owner}/${repo}`;
      const pr = num ? pulls.find(p => p.repo === full && p.number === Number(num)) : null;
      if (req.method === 'GET' && num && commitsOf) {
        record(`GET ${path} -> ${pr ? 200 : 404} token=${fp(auth)}`);
        if (!pr) return send(404, { message: 'Not Found' });
        const bare = servedBare(...pr.headRepo.split('/'));
        const shas = bare ? bareLines(bare, ['rev-list', '--reverse', pr.view.head.ref, `^${pr.view.base.ref}`]) : [];
        return send(200, shas.map(sha => {
          const [ae, ce] = bareLines(bare, ['log', '-1', '--format=%ae%n%ce', sha]);
          return { sha, commit: { author: { email: ae }, committer: { email: ce } } };
        }));
      }
      if (req.method === 'GET' && num && sub === '/files') {
        record(`GET ${path} -> ${pr ? 200 : 404} token=${fp(auth)}`);
        if (!pr) return send(404, { message: 'Not Found' });
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page') ?? '1');
        const bare = servedBare(...pr.headRepo.split('/'));
        const names = bare && page === 1 ? bareLines(bare, ['diff', '--name-only', `${pr.view.base.ref}...${pr.view.head.ref}`]) : [];
        return send(200, names.map(filename => ({ filename })));
      }
      if (req.method === 'GET' && num) {
        record(`GET ${path} -> ${pr ? 200 : 404} token=${fp(auth)}`);
        return pr ? send(200, pullView(pr)) : send(404, { message: 'Not Found' });
      }
      if (req.method === 'PATCH' && num) {
        let b;
        try { b = JSON.parse(body); } catch { return send(400, { message: 'Problems parsing JSON' }); }
        if (!pr) return send(404, { message: 'Not Found' });
        if (typeof b.body === 'string') pr.view.body = b.body;
        if (typeof b.state === 'string') pr.view.state = b.state;
        record(`PATCH ${path} -> 200 token=${fp(auth)}`);
        return send(200, pullView(pr));
      }
      if (req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const head = q.get('head') ?? '';
        const hits = pulls.filter(p => p.repo === full && (!head || `${owner}:${p.view.head.ref}` === head) && p.view.state === (q.get('state') ?? 'open'));
        record(`GET ${path}?head=${head} -> 200 (${hits.length}) token=${fp(auth)}`);
        return send(200, hits.map(pullView));
      }
      if (req.method === 'POST') {
        let b;
        try { b = JSON.parse(body); } catch { return send(400, { message: 'Problems parsing JSON' }); }
        const number = pulls.filter(p => p.repo === full).length + 1;
        const view = {
          number, state: 'open', draft: b.draft === true, title: b.title, body: b.body,
          html_url: `https://github.com/${full}/pull/${number}`, head: { ref: b.head }, base: { ref: b.base },
        };
        // A test or demo may open someone else's PR (`e2e_user`) or a fork's (`e2e_head_repo`); termag never sends these.
        const user = typeof b.e2e_user === 'string' ? b.e2e_user : VIEWER;
        const headRepo = typeof b.e2e_head_repo === 'string' ? b.e2e_head_repo : full;
        pulls.push({ repo: full, number, view, user, headRepo });
        record(`POST ${path} -> 201 #${number} head=${b.head} draft=${view.draft} user=${user} token=${fp(auth)}`);
        return send(201, pullView(pulls[pulls.length - 1]));
      }
    }
    // Any repository: one the stub serves as it is (its visibility, its
    // default branch), any other as a private one on main, so a lookup never
    // reaches GitHub.
    const repoPath = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && repoPath) {
      const [, owner, name] = repoPath;
      const bare = gitRoot ? join(gitRoot, owner, `${name}.git`) : null;
      const served = !!bare && existsSync(bare);
      let defaultBranch = 'main';
      if (served) {
        try { defaultBranch = /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(bare, 'HEAD'), 'utf8'))?.[1] ?? 'main'; } catch { /* main */ }
      }
      const priv = !(served && isPublic(owner, name));
      record(`GET ${path} -> 200 (${served ? 'served' : 'generic'}) token=${fp(auth)}`);
      return send(200, {
        name, full_name: `${owner}/${name}`, owner: { login: owner }, private: priv, visibility: priv ? 'private' : 'public',
        default_branch: defaultBranch, archived: false, html_url: `https://github.com/${owner}/${name}`,
        clone_url: `https://github.com/${owner}/${name}.git`,
      });
    }
    if (req.method === 'GET' && (path === '/user/repos' || /^\/orgs\/[^/]+\/repos$/.test(path))) {
      return serveRepoList(req, res, auth, path, url, send);
    }
    if (req.method === 'GET' && path === '/user') {
      if (tokenOf(auth).includes('_bad')) { record('GET /user -> 401'); return send(401, { message: 'Bad credentials' }); }
      const scopes = tokenOf(auth).includes('_noscope') ? 'repo, read:org' : 'repo, read:org, admin:public_key';
      record(`GET /user -> 200 scopes=${scopes} token=${fp(auth)}`);
      return send(200, { login: 'e2e-octocat', id: 424242 }, { 'x-oauth-scopes': scopes });
    }
    if (req.method === 'GET' && path === '/user/keys') {
      record('GET /user/keys');
      return send(200, [...keys].map(([id, k]) => ({ id, title: k.title, key: k.key })));
    }
    if (req.method === 'POST' && path === '/user/keys') {
      let k;
      try { k = JSON.parse(body); } catch { return send(400, { message: 'Problems parsing JSON' }); }
      const id = nextId++;
      keys.set(id, k);
      record(`POST /user/keys -> 201 id=${id} title="${k.title}"`);
      return send(201, { id, title: k.title, key: k.key });
    }
    const m = /^\/user\/keys\/(\d+)$/.exec(path);
    if (req.method === 'DELETE' && m) {
      const existed = keys.delete(Number(m[1]));
      record(`DELETE /user/keys/${m[1]} -> ${existed ? 204 : 404}`);
      return existed ? send(204) : send(404, { message: 'Not Found' });
    }
    record(`${req.method} ${path} -> 404`);
    send(404, { message: 'Not Found' });
  });
}).listen(port, '127.0.0.1', () => console.log(`github stub on 127.0.0.1:${port}`));
