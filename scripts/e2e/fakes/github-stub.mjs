// Stand-in for api.github.com and github.com's git smart-HTTP
// (E2E_FAKE_GITHUB=1), plain HTTP on loopback. The backend reaches it through
// github-redirect.cjs: api.github.com at the root, github.com under
// /_github.com/, served by `git http-backend` from bare repositories under
// E2E_GITHUB_ROOT (e2e-org/sample is created with one commit; e2e-org/dotfiles,
// a dotfiles repo with an install.sh, is public: clones need no token). A token
// containing "_bad" gets 401; one containing "_noscope" lacks admin:public_key.
// Logs each call with a token fingerprint (the first 8 hex of its sha256),
// never the token. GET /_e2e/calls returns the call log. Pull requests (the
// ask publish path) live in memory: list by head, get by number, create.
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
// A merge of #4243 compares as not yet in any running commit, and the Publish
// AMI workflow answers its runs (none, until POST .../dispatches starts one).
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.E2E_GITHUB_PORT);
const gitRoot = process.env.E2E_GITHUB_ROOT;

// A public repo's clones and fetches need no token (pushes still do), as on
// github.com; the marker file inside the bare repo is what makes it public.
const PUBLIC_MARKER = 'termag-e2e-public';
const isPublic = (owner, repo) => !!gitRoot && existsSync(join(gitRoot, owner, `${repo}.git`, PUBLIC_MARKER));

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
  const cgi = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: gitRoot, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'e2e-octocat',
      REQUEST_METHOD: req.method, PATH_INFO: `/${owner}/${repo}.git/${suffix}`,
      QUERY_STRING: new URL(req.url, 'http://x').search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
    },
  });
  req.pipe(cgi.stdin);
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

function reposFor(owner, page, perPage) {
  const page1 = [{
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
  if (op === 'Authored') return { viewer: { login: VIEWER }, search: search([...own.values()].filter(o => !o.merged).map(ownNode)) };
  if (op === 'Review') return { search: search(requested ? [reviewPrNode()] : []) };
  if (op === 'Merged') return { search: search([...own.values()].filter(o => o.merged).map(mergedNode)) };
  if (op === 'Overview' || op === 'PrId' || op === 'Suites') {
    const o = termag ? own.get(variables?.number) : undefined;
    const node = o ? ownNode(o) : termag && variables?.number === reviewPr.number ? reviewPrNode() : null;
    return { viewer: { login: VIEWER }, repository: { pullRequest: node } };
  }
  // A PR's head, for a new workstream on it (backend services/prReview.ts fetchPrHead).
  // $E2E_GITHUB_ROOT/pr-heads.json ({ "<number>": "<commit>" }) points a PR at a
  // real commit, for a test whose box fetches pull/<n>/head from a local origin.
  if (op === 'PrHead') {
    const o = termag ? own.get(variables?.number) : undefined;
    const pr = o ? o.pr : termag && variables?.number === reviewPr.number ? reviewPr : null;
    const heads = gitRoot && existsSync(join(gitRoot, 'pr-heads.json')) ? JSON.parse(readFileSync(join(gitRoot, 'pr-heads.json'), 'utf8')) : {};
    return { repository: { pullRequest: pr ? {
      state: o?.merged ? 'MERGED' : 'OPEN', headRefName: pr.headRefName, isCrossRepository: false,
      headRefOid: heads[String(variables?.number)] ?? pr.headRefOid ?? String(variables?.number).repeat(10).slice(0, 40).padEnd(40, '0'),
    } : null } };
  }
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
      return send(200, { ssh_keys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'] });
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
    const pullsPath = /^\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?$/.exec(path);
    if (pullsPath) {
      const [, owner, repo, num] = pullsPath;
      const full = `${owner}/${repo}`;
      if (req.method === 'GET' && num) {
        const pr = pulls.find(p => p.repo === full && p.number === Number(num));
        record(`GET ${path} -> ${pr ? 200 : 404} token=${fp(auth)}`);
        return pr ? send(200, pr.view) : send(404, { message: 'Not Found' });
      }
      if (req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const head = q.get('head') ?? '';
        const hits = pulls.filter(p => p.repo === full && (!head || `${owner}:${p.view.head.ref}` === head) && p.view.state === (q.get('state') ?? 'open'));
        record(`GET ${path}?head=${head} -> 200 (${hits.length}) token=${fp(auth)}`);
        return send(200, hits.map(p => p.view));
      }
      if (req.method === 'POST') {
        let b;
        try { b = JSON.parse(body); } catch { return send(400, { message: 'Problems parsing JSON' }); }
        const number = pulls.filter(p => p.repo === full).length + 1;
        const view = {
          number, state: 'open', draft: b.draft === true, title: b.title, body: b.body,
          html_url: `https://github.com/${full}/pull/${number}`, head: { ref: b.head }, base: { ref: b.base },
        };
        pulls.push({ repo: full, number, view });
        record(`POST ${path} -> 201 #${number} head=${b.head} draft=${view.draft} token=${fp(auth)}`);
        return send(201, view);
      }
    }
    const repoPath = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && repoPath) {
      record(`GET ${path} -> 200 token=${fp(auth)}`);
      return send(200, { full_name: `${repoPath[1]}/${repoPath[2]}`, private: true, default_branch: 'main' });
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
