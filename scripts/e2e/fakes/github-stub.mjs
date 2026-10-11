// Stand-in for api.github.com and github.com's git smart-HTTP
// (E2E_FAKE_GITHUB=1), plain HTTP on loopback. The backend reaches it through
// github-redirect.cjs: api.github.com at the root, github.com under
// /_github.com/, served by `git http-backend` from bare repositories under
// E2E_GITHUB_ROOT (e2e-org/sample is created with one commit; e2e-org/dotfiles,
// a dotfiles repo with an install.sh, is public: clones need no token). A token
// containing "_bad" gets 401; one containing "_noscope" lacks admin:public_key.
// Logs each call with a token fingerprint (the first 8 hex of its sha256),
// never the token. GET /_e2e/calls returns the call log.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
// A bare _ratelimited fails example-labs, not the user route, so the user group stays ok.
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
    const slug = rate[1] || 'example-labs';
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
      record(`POST /graphql -> 200 token=${fp(auth)}`);
      return send(200, { data: { viewer: { login: 'e2e-octocat' } } });
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
