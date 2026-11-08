'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseEnvironmentFile,
  resolveSecrets,
  envKey,
  findCheckouts,
  formatDuration,
  frameFromEnvState,
} = require('./environment-file');

const ONE = { fileRepo: 'acme/web', fileDir: '/w/web', checkouts: { 'acme/web': '/w/web' } };
const TWO = { fileRepo: 'acme/web', fileDir: '/w/web', checkouts: { 'acme/web': '/w/web', 'acme/api': '/w/api' } };

test('a string step runs in the file\'s repository', () => {
  const env = parseEnvironmentFile(JSON.stringify({ setup: 'bash .cursor/install.sh', run: 'make dev', seed: 'node seed.js' }), ONE);
  assert.deepEqual(env.setup, [{ repo: 'acme/web', dir: '/w/web', command: 'bash .cursor/install.sh' }]);
  assert.deepEqual(env.run, [{ repo: 'acme/web', dir: '/w/web', command: 'make dev' }]);
  assert.deepEqual(env.seed, [{ repo: 'acme/web', dir: '/w/web', command: 'node seed.js' }]);
  assert.deepEqual(env.warnings, []);
});

test('a map step runs each entry in its repository\'s checkout, in the order written', () => {
  const env = parseEnvironmentFile(JSON.stringify({
    setup: { 'acme/api': 'go mod download', 'https://github.com/Acme/Web': 'pnpm install' },
    run: { 'acme/web': 'pnpm dev', 'acme/api': 'go run .' },
  }), TWO);
  assert.deepEqual(env.setup.map(s => [s.repo, s.dir, s.command]), [
    ['acme/api', '/w/api', 'go mod download'],
    ['acme/web', '/w/web', 'pnpm install'],
  ]);
  assert.deepEqual(env.run.map(s => s.repo), ['acme/web', 'acme/api']);
});

test('a map entry for a repository the environment has no checkout of is skipped with a warning', () => {
  const env = parseEnvironmentFile(JSON.stringify({ setup: { 'acme/other': 'make', 'acme/web': 'make' } }), ONE);
  assert.deepEqual(env.setup.map(s => s.repo), ['acme/web']);
  assert.match(env.warnings[0], /acme\/other.*not one of this environment's checkouts/);
});

test('a step that is not a string or a map of strings is left out with a warning, never thrown', () => {
  const env = parseEnvironmentFile(JSON.stringify({ setup: 42, run: { 'acme/web': ['make'] }, seed: '' }), ONE);
  assert.deepEqual([env.setup, env.run, env.seed], [[], [], []]);
  assert.equal(env.warnings.length, 3);
  assert.match(env.warnings[0], /"setup" is 42/);
});

test('ports keep their order, name, health and path; the first is what a preview opens', () => {
  const env = parseEnvironmentFile(JSON.stringify({
    ports: [
      { name: 'frontend', port: 5174, health: '/termag/', path: '/termag/' },
      { name: 'backend', port: 3040, health: '/termag/health' },
      { port: 9000 },
    ],
  }), ONE);
  assert.deepEqual(env.ports, [
    { name: 'frontend', port: 5174, health: '/termag/', path: '/termag/' },
    { name: 'backend', port: 3040, health: '/termag/health', path: '/' },
    { name: 'port 9000', port: 9000, health: null, path: '/' },
  ]);
});

test('a port that is not a whole number in range, or a slot-shaped port, is left out with a warning', () => {
  const env = parseEnvironmentFile(JSON.stringify({
    ports: [{ port: 0 }, { port: '80' }, { port: { base: 3002, step: 10 } }, { port: 80, health: 'health' }, 'x', { port: 80 }],
  }), ONE);
  assert.deepEqual(env.ports.map(p => p.port), [80]);
  assert.equal(env.warnings.length, 5);
  assert.ok(env.warnings.some(w => /slots/.test(w)));
  assert.ok(env.warnings.some(w => /health.*start with \//.test(w)));
});

test('secrets are names only: a value-shaped entry is left out with a warning', () => {
  const env = parseEnvironmentFile(JSON.stringify({ secrets: ['APP_API_KEY', 'not a name', 7, 'APP_SDK_KEY'] }), ONE);
  assert.deepEqual(env.secrets, ['APP_API_KEY', 'APP_SDK_KEY']);
  assert.equal(env.warnings.length, 2);
});

test('phase 5 keys are named as not used yet; resources, base and unknown keys pass without a word', () => {
  const env = parseEnvironmentFile(JSON.stringify({
    resources: 'large', base: 'empty', name: 'termag', slots: { max: 8 }, env: { A: '1' }, envFile: 'x', host: '127.0.0.${slot}',
  }), ONE);
  // env applies to every step (decision #58): only slots, envFile and host are still to come.
  assert.equal(env.warnings.length, 3);
  for (const key of ['slots', 'envFile', 'host']) assert.ok(env.warnings.some(w => w.includes(`"${key}"`)), key);
  assert.deepEqual(env.env, { A: '1' });
});

test('a file that is not JSON, or not an object, is ignored with a warning', () => {
  assert.match(parseEnvironmentFile('{', ONE).warnings[0], /not valid JSON/);
  assert.match(parseEnvironmentFile('[]', ONE).warnings[0], /not a JSON object/);
  assert.deepEqual(parseEnvironmentFile('[]', ONE).run, []);
});

test('a name already in the environment resolves; the rest are warnings, not failures', () => {
  const r = resolveSecrets(['GITHUB_TOKEN', 'APP_SDK_KEY'], { env: { GITHUB_TOKEN: 'mine' } });
  assert.deepEqual(r.env, {});
  assert.deepEqual(r.resolved, [{ name: 'GITHUB_TOKEN', via: 'your environment' }]);
  assert.deepEqual(r.missing, ['APP_SDK_KEY']);
  assert.match(r.warnings[0], /APP_SDK_KEY.*runs? without it/);
});

test('envKey is stable for a directory and safe as a tmux session and file name', () => {
  const a = envKey('/home/ada/termag/projects/My Proj.x');
  assert.equal(a, envKey('/home/ada/termag/projects/My Proj.x'));
  assert.match(a, /^my-proj-x-[0-9a-f]{8}$/);
  assert.notEqual(a, envKey('/home/bob/termag/projects/My Proj.x'));
});

test('findCheckouts maps a checkout, or each checkout under a multi-repo root, to its repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
  const mk = (dir, url) => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  };
  mk(path.join(root, 'single'), 'https://github.com/Acme/Web.git');
  assert.deepEqual(findCheckouts(path.join(root, 'single')), { 'acme/web': path.join(root, 'single') });
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, '.termag-workspace'), 'marker\n');
  mk(path.join(ws, 'frontend'), 'git@github.com:acme/web.git');
  mk(path.join(ws, 'api'), 'https://github.com/acme/api');
  fs.mkdirSync(path.join(ws, '.worktrees'));
  assert.deepEqual(findCheckouts(ws), { 'acme/api': path.join(ws, 'api'), 'acme/web': path.join(ws, 'frontend') });
  fs.rmSync(root, { recursive: true, force: true });
});

test('formatDuration reads as people say it', () => {
  assert.equal(formatDuration(900), '1s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(151_000), '2m 31s');
  assert.equal(formatDuration(3_720_000), '1h 2m');
});

test('frameFromEnvState carries what the orchestrator shows, never a command or a secret', () => {
  const frame = frameFromEnvState({
    projectId: 'p1', instanceId: 'b1', key: 'web-1234abcd', dir: '/w/web', session: 'termag-env-web-1234abcd', state: 'up',
    setup: { state: 'succeeded', startedAt: 't0', finishedAt: 't1', durationMs: 151000, exitCode: 0, commands: ['bash x'] },
    run: { state: 'running', startedAt: 't1', windows: [{ name: 'run', repo: 'acme/web', command: 'make dev' }] },
    ports: [{ name: 'frontend', port: 5174, path: '/termag/', healthy: true, checkedAt: 't2' }],
    seed: { state: 'none' },
    secrets: { resolved: [{ name: 'APP_API_KEY', via: 'your environment' }], missing: ['X'] },
    warnings: ['w'],
    env: { APP_API_KEY: 'box-token' },
  });
  assert.equal(frame.type, 'environment-status');
  assert.equal(frame.projectId, 'p1');
  assert.equal(frame.status.setup.durationMs, 151000);
  assert.deepEqual(frame.status.ports, [{ name: 'frontend', port: 5174, path: '/termag/', healthy: true, checkedAt: 't2' }]);
  const text = JSON.stringify(frame);
  assert.ok(!text.includes('box-token'));
  assert.ok(!text.includes('make dev'));
  assert.equal(frameFromEnvState({ key: 'x' }), null, 'no project: a CLI run in some checkout, nothing to forward');
});

test("the file's repos name what a map step may: one the file lists runs in its checkout, any other is skipped", () => {
  const env = parseEnvironmentFile(JSON.stringify({
    repos: [{ repo: 'acme/web' }, { repo: 'Acme/API', path: 'api' }],
    setup: { 'acme/api': 'go mod download', 'acme/other': 'make' },
  }), { ...TWO, checkouts: { ...TWO.checkouts, 'acme/other': '/w/other' } });
  assert.deepEqual(env.repos, [{ repo: 'acme/web' }, { repo: 'acme/api', path: 'api' }]);
  assert.deepEqual(env.setup.map(s => [s.repo, s.dir]), [['acme/api', '/w/api']]);
  assert.match(env.warnings[0], /acme\/other.*not one of this environment's repositories/);
});

test("an inline file's string step runs in the first of its repos; a pointer's own repository may be named in a map", () => {
  const inline = parseEnvironmentFile(JSON.stringify({ repos: [{ repo: 'acme/api' }, { repo: 'acme/web' }], run: 'make dev' }),
    { fileRepo: null, fileDir: null, checkouts: TWO.checkouts });
  assert.deepEqual(inline.run, [{ repo: 'acme/api', dir: '/w/api', command: 'make dev' }]);
  const pointer = parseEnvironmentFile(JSON.stringify({ repos: [{ repo: 'acme/api' }], setup: { 'acme/web': 'pnpm install' } }), TWO);
  assert.deepEqual(pointer.setup.map(s => s.repo), ['acme/web']);
});

test("a repository the file lists is found at its path under a multi-repo root when its origin can't say", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-path-'));
  fs.mkdirSync(path.join(root, 'api'));
  try {
    const env = parseEnvironmentFile(JSON.stringify({ repos: [{ repo: 'acme/api', path: 'api' }], setup: { 'acme/api': 'make' } }),
      { fileRepo: null, fileDir: null, checkouts: {}, root, multi: true });
    assert.deepEqual(env.setup.map(s => s.dir), [path.join(root, 'api')]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The person's decision (#998, plan-outbox #45): no hold. A turn while setup runs is told so; the next turn after it settles gets one line.
test('turnNotice: every turn while the steps run says so, with the step, how to check, and that the ports are not up', () => {
  const { turnNotice } = require('./environment-file');
  const state = { state: 'setup', setup: { state: 'running', startedAt: '2026-10-30T10:00:00Z' }, ports: [{ name: 'frontend', port: 5174, path: '/termag/' }, { name: 'backend', port: 3040, path: '/' }] };
  const first = turnNotice(state, {}, { now: Date.parse('2026-10-30T10:01:05Z') });
  assert.match(first.text, /still setting up: setup has run 1m 5s/);
  assert.match(first.text, /frontend :5174, backend :3040/);
  assert.match(first.text, /termag-env status/);
  assert.match(first.text, /work that doesn't need/);
  assert.deepEqual(first.seen, { told: true });
  const again = turnNotice({ ...state, state: 'waiting', setup: { state: 'succeeded', durationMs: 41000 }, run: { state: 'running' } }, first.seen, { now: Date.now() });
  assert.match(again.text, /setup took 41s; the app is starting, waiting for its ports/);
});

test('turnNotice: once it settles, one line on the next turn only, and nothing for a session never told it was setting up', () => {
  const { turnNotice } = require('./environment-file');
  const up = { state: 'up', updatedAt: 't9', setup: { state: 'succeeded', durationMs: 41000, finishedAt: 't5' }, run: { state: 'succeeded' }, ports: [{ name: 'frontend', port: 5174, path: '/termag/' }] };
  const done = turnNotice(up, { told: true });
  assert.equal(done.text, 'The environment is ready: setup took 41s and the app is up (frontend http://localhost:5174/termag/).');
  assert.equal(turnNotice(up, done.seen).text, null, 'told once');
  assert.equal(turnNotice(up, {}).text, null, 'a session that started after it was ready');
  assert.equal(turnNotice({ state: 'none' }, {}).text, null);
});

test('turnNotice: a failure says which step, with its log tail', () => {
  const { turnNotice } = require('./environment-file');
  const failed = { state: 'failed', updatedAt: 't3', setup: { state: 'failed', durationMs: 12000, exitCode: 3, error: 'bash .cursor/install.sh exited 3' } };
  const n = turnNotice(failed, { told: true }, { logTail: () => 'npm ERR! missing script\nnpm ERR! exit 3' });
  assert.match(n.text, /^The environment's setup failed after 12s: bash \.cursor\/install\.sh exited 3\./);
  assert.match(n.text, /npm ERR! exit 3/);
  assert.match(n.text, /termag-env status/);
});

// The person's decision (plan-outbox #47): an optional `stop`, run by termag-env down before it closes the session.
test('stop is a step like the others: a string in the file\'s repository, a map in the order written', () => {
  const one = parseEnvironmentFile(JSON.stringify({ stop: 'make e2e-down' }), ONE);
  assert.deepEqual(one.stop, [{ repo: 'acme/web', dir: '/w/web', command: 'make e2e-down' }]);
  const map = parseEnvironmentFile(JSON.stringify({ stop: { 'acme/api': 'docker compose down', 'acme/web': 'pkill -f vite' } }), TWO);
  assert.deepEqual(map.stop.map(s => [s.repo, s.command]), [['acme/api', 'docker compose down'], ['acme/web', 'pkill -f vite']]);
  assert.deepEqual(parseEnvironmentFile('{}', ONE).stop, []);
  assert.match(parseEnvironmentFile(JSON.stringify({ stop: 7 }), ONE).warnings[0], /"stop" is 7/);
});

// Bugbot on #998 (6f51c94c): while seeding the app is up; the notice must not also say its ports aren't.
test('turnNotice: seeding says the app is up, and waiting names only the ports not up yet', () => {
  const { turnNotice } = require('./environment-file');
  const ports = [{ name: 'frontend', port: 5174, path: '/', healthy: true }, { name: 'backend', port: 3040, path: '/', healthy: true }];
  const seeding = turnNotice({ state: 'seeding', setup: { state: 'succeeded', durationMs: 1000 }, ports }, {}).text;
  assert.match(seeding, /the app is up and seeding/);
  assert.doesNotMatch(seeding, /aren't up yet/);
  const waiting = turnNotice({ state: 'waiting', setup: { state: 'succeeded', durationMs: 1000 }, ports: [ports[0], { ...ports[1], healthy: false }] }, {}).text;
  assert.match(waiting, /backend :3040 isn't up yet/);
  assert.doesNotMatch(waiting, /frontend :5174/);
});

// Security Agent on #998: a failure notice goes into the model's prompt, so a secret a step was given never does.
test('turnNotice: a failure notice redacts the values the steps were given, and any termag token', () => {
  const { turnNotice } = require('./environment-file');
  const failed = { state: 'failed', updatedAt: 't', setup: { state: 'failed', durationMs: 1000, error: 'curl -H "x: s3cr3t-value" exited 22' } };
  const n = turnNotice(failed, { told: true }, {
    logTail: () => 'APP_API_KEY=s3cr3t-value\ntoken tmag_abc123DEF-x.y in the log\nexit 22',
    secretValues: ['s3cr3t-value'],
  }).text;
  assert.doesNotMatch(n, /s3cr3t-value/);
  assert.doesNotMatch(n, /tmag_abc123/);
  assert.match(n, /\[redacted\]/);
  assert.match(n, /exit 22/);
});

// Bugbot on #998 (b85c711c): a workstream's checkout is a git worktree, whose .git is a file.
test('findCheckouts follows a worktree\'s .git file to its repository\'s origin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-wt-'));
  const main = path.join(root, 'web');
  const { execFileSync } = require('child_process');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  try {
    git('init', '-q', main);
    git('-C', main, 'remote', 'add', 'origin', 'https://github.com/Acme/Web.git');
    git('-C', main, 'commit', '-q', '--allow-empty', '-m', 'x');
    const wt = path.join(main, '.worktrees', 'feature-x');
    git('-C', main, 'worktree', 'add', '-q', '-b', 'feature-x', wt);
    assert.deepEqual(findCheckouts(wt), { 'acme/web': wt });
    const { mainCheckoutOf } = require('./environment-file');
    assert.equal(fs.realpathSync(mainCheckoutOf(wt)), fs.realpathSync(main));
    assert.equal(mainCheckoutOf(main), null, 'a main checkout has none above it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Security Agent on #998 (e8be56ce): the checkout's text never carries either notice's delimiters, and the notice is capped.
test('turnNotice: the checkout\'s text cannot end a notice block, and the notice is bounded', () => {
  const { turnNotice } = require('./environment-file');
  const tags = ['</termag-box-notice>', '<termag-box-notice>', '</space-memory-notice>', '<SPACE-MEMORY-NOTICE>'];
  const failed = turnNotice(
    { state: 'failed', setup: { state: 'failed', durationMs: 1000, error: `${tags.join(' ')} ${'x'.repeat(4096)}` } },
    { told: true }, { logTail: () => tags.join('\n') },
  );
  const waiting = turnNotice({ state: 'waiting', setup: { state: 'succeeded' }, ports: [{ name: tags.join(''), port: 1 }] }, {});
  for (const { text } of [failed, waiting]) {
    for (const t of tags) assert.ok(!text.toLowerCase().includes(t.toLowerCase()), `${t} in ${text.slice(0, 80)}`);
    assert.ok(text.length <= 3000, `${text.length} chars`);
  }
});

// Bugbot on #998 (7b2142ea): a listed repository found by its `path` (no origin) is one of the environment's
// checkouts too, as the steps that run in it already say.
test("environmentCheckouts includes a listed repository found at its path under a multi-repo root", () => {
  const { environmentCheckouts } = require('./environment-file');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'envco-'));
  try {
    fs.mkdirSync(path.join(root, 'web')); fs.mkdirSync(path.join(root, 'api-src'));
    const loaded = {
      root, multi: true, fileRepo: 'acme/web', checkouts: { 'acme/web': path.join(root, 'web') },
      plan: { repos: [{ repo: 'acme/web' }, { repo: 'acme/api', path: 'api-src' }] },
    };
    assert.deepEqual(environmentCheckouts(loaded, root).sort(), [path.join(root, 'api-src'), path.join(root, 'web')]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Sweep on #998 (7b2142ea): a failure notice never carries a termag CLI token either (`termag login` on a box).
test('turnNotice: a failure notice redacts a termag CLI token as well as an agent token', () => {
  const { turnNotice } = require('./environment-file');
  const n = turnNotice({ state: 'failed', setup: { state: 'failed', error: 'termag-login --token tmcli_0123456789abcdef exited 22' } }, { told: true },
    { logTail: () => 'tmcli_feedfacecafe and tmag_deadbeef' }).text;
  assert.doesNotMatch(n, /tmcli_0123|tmcli_feed|tmag_dead/);
});

// Security Agent on #998 (36866c6a): a slug whose owner or name is '.' or '..' is no repository (GitHub allows
// neither), so it can never name a directory outside a multi-repo root, as an explicit `path` can't.
test("repoKey refuses '.' and '..' as an owner or a name, and checkoutOf never leaves the root", () => {
  const { repoKey, checkoutOf, parseEnvironmentFile } = require('./environment-file');
  for (const s of ['evil/..', 'evil/.', '../web', './web', 'https://github.com/evil/..', 'git@github.com:evil/...git']) {
    assert.equal(repoKey(s), null, s);
  }
  assert.equal(repoKey('acme/web.js'), 'acme/web.js');
  assert.equal(repoKey('acme/.github'), 'acme/.github');
  const ctx = { root: '/w/ws', multi: true, existsSync: () => true, repos: [{ repo: 'evil/..' }, { repo: 'evil/.' }] };
  assert.equal(checkoutOf('evil/..', ctx), undefined);
  assert.equal(checkoutOf('evil/.', ctx), undefined);
  const parsed = parseEnvironmentFile(JSON.stringify({ repos: [{ repo: 'evil/..' }], setup: { 'evil/..': 'echo x' } }), { root: '/w/ws', multi: true, checkouts: {} });
  assert.deepEqual(parsed.repos, []);
  assert.ok(parsed.setup.every(e => !e.dir || !e.dir.startsWith('/w/') || e.dir.startsWith('/w/ws')));
});

// Bugbot on #998 (35c6d2f5): a repository inside a multi-repo workstream (<project>/.worktrees/<ws>/<repo>, where
// an ask's chat runs) belongs to the project, whose state the claim's chain writes.
test('projectRootOf maps a repository in a multi-repo workstream to the project root', () => {
  const { projectRootOf } = require('./environment-file');
  const exists = (p) => p === '/w/proj/.termag-workspace';
  assert.equal(projectRootOf('/w/proj/.worktrees/fix/web', { existsSync: exists, readFileSync: () => { throw new Error('no .git'); } }), '/w/proj');
  assert.equal(projectRootOf('/w/proj/.worktrees/fix', { existsSync: exists, readFileSync: () => { throw new Error('no .git'); } }), '/w/proj');
  // A single repository's workstream has no such nesting: its repo is the worktree itself.
  assert.equal(projectRootOf('/w/other/.worktrees/fix/web', { existsSync: () => false, readFileSync: () => { throw new Error('no .git'); } }), null);
});

// Bugbot on #998 (804b7062): a file that names its repos, none of which are here, owns no checkout. Only a file
// that names none falls back to every checkout.
test('environmentCheckouts owns nothing when none of the named repos is found', () => {
  const { environmentCheckouts } = require('./environment-file');
  const loaded = { root: '/w/ws', multi: true, fileRepo: null, checkouts: { 'acme/tools': '/w/ws/tools' },
    plan: { repos: [{ repo: 'acme/web' }, { repo: 'acme/api' }] } };
  assert.deepEqual(environmentCheckouts(loaded, '/w/ws'), []);
  assert.deepEqual(environmentCheckouts({ ...loaded, plan: { repos: null } }, '/w/ws').sort(), ['/w/ws', '/w/ws/tools']);
  assert.deepEqual(environmentCheckouts({ ...loaded, plan: { repos: [] } }, '/w/ws').sort(), ['/w/ws', '/w/ws/tools'], 'an empty list names none');
});
