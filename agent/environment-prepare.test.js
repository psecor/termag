'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prepare = require('./environment-prepare');
const envRun = require('./environment-run');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'env-prepare-')); }

const REQ = {
  instanceId: 'inst1', environmentId: 'env1', fileText: '{"setup":"true"}', filePath: '.termag/environment.json', fileRepo: 'e2e-org/envdemo',
  repos: [{ repo: 'e2e-org/envdemo', url: 'https://github.com/e2e-org/envdemo', branch: 'main', name: 'envdemo' }],
};

/** git as the prepare runs it: a clone makes the directory, rev-parse says a commit. */
function fakeGit(calls, { failClone = false } = {}) {
  return (cmd, args, opts, cb) => {
    calls.push(args);
    if (args.includes('clone')) {
      if (failClone) return cb(Object.assign(new Error('clone failed'), { code: 128 }), '', 'fatal: Authentication failed\n');
      fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
      return cb(null, '', '');
    }
    if (args.includes('rev-parse')) return cb(null, 'a'.repeat(40) + '\n', '');
    return cb(null, '', '');
  };
}

test('acceptPrepare: checks every field and refuses what could leave the static layout', () => {
  assert.ok(prepare.acceptPrepare(REQ).request);
  assert.match(prepare.acceptPrepare({ ...REQ, repos: [{ ...REQ.repos[0], name: '../etc' }] }).error, /one directory/);
  assert.match(prepare.acceptPrepare({ ...REQ, repos: [{ ...REQ.repos[0], url: 'https://evil.example/x' }] }).error, /github\.com/);
  assert.match(prepare.acceptPrepare({ ...REQ, repos: [{ ...REQ.repos[0], branch: '--upload-pack=x' }] }).error, /branch/);
  assert.match(prepare.acceptPrepare({ ...REQ, repos: [REQ.repos[0], REQ.repos[0]] }).error, /different/);
  assert.match(prepare.acceptPrepare({ ...REQ, filePath: '../x' }).error, /filePath/);
  assert.equal(prepare.acceptPrepare({ ...REQ, githubBroker: 'https://github-broker.example' }).request.broker, 'https://github-broker.example');
  assert.equal(prepare.acceptPrepare({ ...REQ, githubBroker: 'http://x' }).request.broker, null);
});

test('handleEnvironmentPrepare: refused on a box that is not a pool box', async () => {
  assert.match((await prepare.handleEnvironmentPrepare(REQ, { warm: false })).error, /not a pool box/);
});

test('handleEnvironmentPrepare: clones to ~/code/<name> through the broker, writes the marker, runs setup only', async () => {
  const home = tmpHome();
  const calls = [];
  let chain = null;
  const r = await prepare.handleEnvironmentPrepare({ ...REQ, githubBroker: 'https://github-broker.example' }, {
    warm: true, home, wait: true, execFile: fakeGit(calls), configPath: '/cfg.json',
    environmentRun: { stateDir: envRun.stateDir, startChain: async (dir, opts) => { chain = { dir, opts }; return { started: true }; } },
  });
  assert.deepEqual(r, { started: true });
  const clone = calls.find(a => a.includes('clone'));
  assert.ok(clone.includes('url.https://github-broker.example/.insteadOf=https://github.com/'));
  assert.ok(clone.some(a => a.startsWith('credential.https://github-broker.example.helper=') && a.endsWith('termag-git-credential /cfg.json')));
  assert.ok(fs.existsSync(path.join(home, 'code', 'envdemo', '.git')));
  const pool = prepare.readPool(home);
  assert.equal(pool.environmentId, 'env1');
  assert.deepEqual(pool.repos.map(x => [x.repo, x.dir, x.commit]), [['e2e-org/envdemo', path.join(home, 'code', 'envdemo'), 'a'.repeat(40)]]);
  assert.equal(chain.dir, path.join(home, 'code', 'envdemo'));
  assert.equal(chain.opts.only, 'setup');
  assert.equal(chain.opts.projectId, 'pool');
  assert.equal(chain.opts.trigger, 'pool');
  assert.equal(chain.opts.fileText, REQ.fileText);
});

test('handleEnvironmentPrepare: several repositories run in ~/code itself, marked as a workspace root', async () => {
  const home = tmpHome();
  let chain = null;
  const repos = [REQ.repos[0], { repo: 'e2e-org/lib', url: 'https://github.com/e2e-org/lib', branch: 'main', name: 'lib' }];
  await prepare.handleEnvironmentPrepare({ ...REQ, repos }, {
    warm: true, home, wait: true, execFile: fakeGit([]),
    environmentRun: { stateDir: envRun.stateDir, startChain: async (dir) => { chain = dir; return { started: true }; } },
  });
  // The path a claimed multi-repo project's root links to (workspace.js init-workspace staticRoot): one state key.
  assert.equal(chain, path.join(home, 'code'));
  assert.ok(fs.existsSync(path.join(home, 'code', 'lib', '.git')));
  assert.ok(fs.statSync(path.join(home, 'code', '.termag-workspace')).isFile());
  // init-workspace takes a ~/code holding the marker and no owner yet (staticRootChoice), and refuses one holding
  // anything else; the claimed project then owns it.
  const workspace = require('./workspace');
  const projectRoot = path.join(home, 'termag', 'projects', 'multi');
  assert.equal(workspace.initWorkspace({ dir: projectRoot, guide: null, staticRoot: chain, projectId: 'p1' }).staticLayout, true);
  assert.equal(fs.readlinkSync(projectRoot), chain);
  assert.equal(fs.readFileSync(path.join(chain, '.termag-static-owner'), 'utf8'), 'p1\n');
});

test('handleEnvironmentPrepare: a failed clone is reported as setup failing, through the chain state', async () => {
  const home = tmpHome();
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit([], { failClone: true }),
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { throw new Error('not reached'); } },
  });
  const dir = path.join(home, 'code', 'envdemo');
  const state = JSON.parse(fs.readFileSync(envRun.statePath(home, require('./environment-file').envKey(dir)), 'utf8'));
  assert.equal(state.projectId, 'pool');
  assert.equal(state.state, 'failed');
  assert.match(state.setup.error, /clone e2e-org\/envdemo: fatal: Authentication failed/);
  assert.ok(!fs.existsSync(dir), 'no half checkout is left at the path');
});

test('handleEnvironmentPrepare: refused once the box has been claimed', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
  fs.writeFileSync(prepare.poolFile(home), JSON.stringify({ environmentId: 'env1', repos: [], adopted: true }));
  assert.match((await prepare.handleEnvironmentPrepare(REQ, { warm: true, home })).error, /claimed/);
});

test('preparedCheckout and markAdopted: each prepared checkout is adopted once, by one project', () => {
  const home = tmpHome();
  const dir = path.join(home, 'code', 'envdemo');
  const lib = path.join(home, 'code', 'lib');
  fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
  fs.writeFileSync(prepare.poolFile(home), JSON.stringify({ environmentId: 'env1', repos: [{ repo: 'e2e-org/envdemo', dir }, { repo: 'e2e-org/lib', dir: lib }], adopted: false }));
  assert.equal(prepare.preparedCheckout(home, dir).repo, 'e2e-org/envdemo');
  assert.equal(prepare.preparedCheckout(home, path.join(home, 'code', 'other')), null);
  assert.equal(prepare.markAdopted(home, 'p1', dir), true);
  assert.equal(prepare.preparedCheckout(home, dir), null);
  assert.equal(prepare.markAdopted(home, 'p2', dir), false);
  // The other repository of the same multi-repo project is still to be pulled; the box counts as claimed.
  assert.equal(prepare.preparedCheckout(home, lib).repo, 'e2e-org/lib');
  assert.equal(prepare.readPool(home).adopted, true);
});

test('adoptPoolState: the project takes over the pool chain at the same key, setup and setupCommit kept', async () => {
  const home = tmpHome();
  const root = path.join(home, 'code');
  const { envKey } = require('./environment-file');
  const key = envKey(root);
  fs.mkdirSync(envRun.stateDir(home), { recursive: true });
  fs.writeFileSync(envRun.statePath(home, key), JSON.stringify({
    key, dir: root, projectId: 'pool', state: 'ready', setup: { state: 'succeeded' }, setupCommit: { 'o/a': 'a'.repeat(40) }, pool: true,
  }));
  const killed = [];
  assert.equal(await envRun.adoptPoolState(home, root, 'p1', { tmux: async (args) => { killed.push(args); return { ok: true }; } }), true);
  const adopted = JSON.parse(fs.readFileSync(envRun.statePath(home, key), 'utf8'));
  assert.equal(adopted.projectId, 'p1');
  assert.equal(adopted.setup.state, 'succeeded');
  assert.deepEqual(adopted.setupCommit, { 'o/a': 'a'.repeat(40) });
  assert.equal(adopted.preparedByPool, true);
  assert.equal(adopted.pool, undefined);
  assert.deepEqual(killed, [['kill-session', '-t', `=termag-env-${key}`]]);
  // Once: it is the project's now, and another path has nothing to adopt.
  assert.equal(await envRun.adoptPoolState(home, root, 'p2', { tmux: async () => ({ ok: true }) }), false);
  assert.equal(await envRun.adoptPoolState(home, path.join(home, 'x'), 'p2', { tmux: async () => ({ ok: true }) }), false);
});

test('handleEnvironmentPrepare: a refresh fetches and checks out each existing checkout at its head, and its chain carries the prepareId', async () => {
  const home = tmpHome();
  const dir = path.join(home, 'code', 'envdemo');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
  fs.writeFileSync(prepare.poolFile(home), JSON.stringify({ environmentId: 'env1', repos: [{ repo: 'e2e-org/envdemo', dir }], adopted: false }));
  const calls = [];
  let chain = null;
  await prepare.handleEnvironmentPrepare({ ...REQ, prepareId: 'refresh-1762430400000', githubBroker: 'https://github-broker.example' }, {
    warm: true, home, wait: true, execFile: fakeGit(calls),
    environmentRun: { stateDir: envRun.stateDir, startChain: async (d, opts) => { chain = { d, opts }; return { started: true }; } },
  });
  assert.ok(!calls.some(a => a.includes('clone')), 'no second clone');
  const fetch = calls.find(a => a.includes('fetch'));
  assert.ok(fetch.includes('url.https://github-broker.example/.insteadOf=https://github.com/'), 'the fetch goes through the broker');
  assert.deepEqual(fetch.slice(fetch.indexOf('-C')), ['-C', dir, 'fetch', '--quiet', 'origin', 'main']);
  assert.deepEqual(calls.find(a => a.includes('checkout')), ['-C', dir, 'checkout', '--quiet', '--force', '-B', 'main', 'origin/main']);
  assert.equal(chain.opts.prepareId, 'refresh-1762430400000');
  assert.equal(chain.opts.only, 'setup');
});

test('handleEnvironmentPrepare: a refresh whose fetch fails says so in a failed state carrying its prepareId', async () => {
  const home = tmpHome();
  const dir = path.join(home, 'code', 'envdemo');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const git = (cmd, args, opts, cb) => (args.includes('fetch') ? cb(Object.assign(new Error('x'), { code: 128 }), '', 'fatal: 403\n') : cb(null, '', ''));
  await prepare.handleEnvironmentPrepare({ ...REQ, prepareId: 'refresh-1' }, {
    warm: true, home, wait: true, execFile: git,
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { throw new Error('not reached'); } },
  });
  const state = JSON.parse(fs.readFileSync(envRun.statePath(home, require('./environment-file').envKey(dir)), 'utf8'));
  assert.equal(state.prepareId, 'refresh-1');
  assert.match(state.setup.error, /fetch e2e-org\/envdemo: fatal: 403/);
  assert.equal(require('./environment-file').frameFromEnvState(state).status.prepareId, 'refresh-1');
});

test('acceptPrepare: a prepareId must be an id', () => {
  assert.equal(prepare.acceptPrepare({ ...REQ, prepareId: 'refresh-1' }).request.prepareId, 'refresh-1');
  assert.equal(prepare.acceptPrepare(REQ).request.prepareId, null);
  assert.match(prepare.acceptPrepare({ ...REQ, prepareId: '$(x)' }).error, /prepareId/);
});

test('startChain: the pending state carries the prepareId, and adoptPoolState drops it', async () => {
  const home = tmpHome();
  const dir = path.join(home, 'code', 'envdemo');
  fs.mkdirSync(dir, { recursive: true });
  const { envKey } = require('./environment-file');
  await envRun.startChain(dir, { projectId: 'pool', prepareId: 'refresh-2', only: 'setup' }, { home, tmux: async () => ({ ok: true, stdout: '' }) });
  const state = JSON.parse(fs.readFileSync(envRun.statePath(home, envKey(dir)), 'utf8'));
  assert.equal(state.prepareId, 'refresh-2');
  assert.equal(await envRun.adoptPoolState(home, dir, 'p1', { tmux: async () => ({ ok: true }) }), true);
  assert.equal(JSON.parse(fs.readFileSync(envRun.statePath(home, envKey(dir)), 'utf8')).prepareId, undefined);
});

test("startChain: a refresh's pending frame carries the last setup's success with state pending, which the orchestrator must not take as done", async () => {
  const home = tmpHome();
  const dir = path.join(home, 'code', 'envdemo');
  fs.mkdirSync(dir, { recursive: true });
  const { envKey, frameFromEnvState } = require('./environment-file');
  fs.mkdirSync(envRun.stateDir(home), { recursive: true });
  fs.writeFileSync(envRun.statePath(home, envKey(dir)), JSON.stringify({
    key: envKey(dir), dir, projectId: 'pool', state: 'ready', setup: { state: 'succeeded' }, setupCommit: { 'e2e-org/envdemo': 'a'.repeat(40) },
  }));
  await envRun.startChain(dir, { projectId: 'pool', prepareId: 'refresh-3', only: 'setup', again: true }, { home, tmux: async () => ({ ok: true, stdout: '' }) });
  const frame = frameFromEnvState(JSON.parse(fs.readFileSync(envRun.statePath(home, envKey(dir)), 'utf8')));
  assert.equal(frame.status.prepareId, 'refresh-3');
  assert.equal(frame.status.state, 'pending');
  assert.equal(frame.status.setup.state, 'succeeded', 'the earlier result is still in the state: backend poolStatusOutcome needs state ready');
});

test('handleEnvironmentPrepare: a refresh brings a checkout whose setup changed a tracked file to the new head (real git)', async () => {
  const { execFileSync } = require('child_process');
  const home = tmpHome();
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString().trim();
  const bare = path.join(home, 'up.git');
  const work = path.join(home, 'work');
  g(home, 'init', '-q', '--bare', bare);
  g(home, 'clone', '-q', bare, work);
  fs.writeFileSync(path.join(work, 'config.json'), '{"v":1}\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'A'); g(work, 'push', '-q', 'origin', 'HEAD:main');
  const dir = path.join(home, 'code', 'envdemo');
  g(home, 'clone', '-q', bare, dir);
  // setup wrote into a tracked file, and left an ignored build cache beside it
  fs.writeFileSync(path.join(dir, 'config.json'), '{"v":1,"built":true}\n');
  fs.writeFileSync(path.join(dir, '.cache-untracked'), 'keep');
  // upstream changes the same file
  fs.writeFileSync(path.join(work, 'config.json'), '{"v":2}\n');
  g(work, 'commit', '-qam', 'B'); g(work, 'push', '-q', 'origin', 'HEAD:main');
  const head = g(work, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
  fs.writeFileSync(prepare.poolFile(home), JSON.stringify({ environmentId: 'env1', repos: [{ repo: 'e2e-org/envdemo', dir }], adopted: false }));
  let chain = null;
  await prepare.handleEnvironmentPrepare({ ...REQ, prepareId: 'refresh-4' }, {
    warm: true, home, wait: true,
    environmentRun: { stateDir: envRun.stateDir, startChain: async (d, opts) => { chain = { d, opts }; return { started: true }; } },
  });
  assert.ok(chain, 'the refresh reached setup');
  assert.equal(g(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{"v":2}\n');
  assert.equal(fs.readFileSync(path.join(dir, '.cache-untracked'), 'utf8'), 'keep', 'untracked output (caches) is kept');
});

test('handleEnvironmentPrepare: a refresh whose new head tracks a file setup left untracked on the disk still reaches the head (real git)', async () => {
  const { execFileSync } = require('child_process');
  const home = tmpHome();
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString().trim();
  const bare = path.join(home, 'up.git');
  const work = path.join(home, 'work');
  g(home, 'init', '-q', '--bare', bare);
  g(home, 'clone', '-q', bare, work);
  fs.writeFileSync(path.join(work, 'README.md'), 'A\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'A'); g(work, 'push', '-q', 'origin', 'HEAD:main');
  const dir = path.join(home, 'code', 'envdemo');
  g(home, 'clone', '-q', bare, dir);
  // setup generated these, untracked; upstream then starts tracking the same paths (a file and one inside a directory)
  fs.writeFileSync(path.join(dir, 'generated.json'), '{"local":true}\n');
  fs.mkdirSync(path.join(dir, 'gen'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen', 'types.ts'), 'local\n');
  fs.writeFileSync(path.join(dir, 'cache.bin'), 'keep');
  fs.writeFileSync(path.join(work, 'generated.json'), '{"tracked":true}\n');
  fs.mkdirSync(path.join(work, 'gen'), { recursive: true });
  fs.writeFileSync(path.join(work, 'gen', 'types.ts'), 'tracked\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'B'); g(work, 'push', '-q', 'origin', 'HEAD:main');
  const head = g(work, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
  fs.writeFileSync(prepare.poolFile(home), JSON.stringify({ environmentId: 'env1', repos: [{ repo: 'e2e-org/envdemo', dir }], adopted: false }));
  let chain = null;
  await prepare.handleEnvironmentPrepare({ ...REQ, prepareId: 'refresh-5' }, {
    warm: true, home, wait: true,
    environmentRun: { stateDir: envRun.stateDir, startChain: async (d, opts) => { chain = { d, opts }; return { started: true }; } },
  });
  const stateFile = envRun.statePath(home, require('./environment-file').envKey(dir));
  assert.ok(chain, `the refresh reached setup${fs.existsSync(stateFile) ? `: ${JSON.parse(fs.readFileSync(stateFile, 'utf8')).setup.error}` : ''}`);
  assert.equal(g(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(dir, 'generated.json'), 'utf8'), '{"tracked":true}\n');
  assert.equal(fs.readFileSync(path.join(dir, 'gen', 'types.ts'), 'utf8'), 'tracked\n');
  assert.equal(fs.readFileSync(path.join(dir, 'cache.bin'), 'utf8'), 'keep', 'other untracked output is kept');
});
