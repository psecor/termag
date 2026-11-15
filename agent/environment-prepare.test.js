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
/** termag-credentials as the agent runs it (credentials.js): applies and removes recorded in `calls`. */
function fakeCredentials(calls, { fail = false } = {}) {
  return {
    applyCredential: async (provider, payload) => { calls.push(['credentials', 'apply', provider, { broker: payload.broker, login: payload.login }]); if (fail) throw new Error('termag-credentials apply github exited 1: sudo: a password is required'); return { ok: true }; },
    removeCredential: async (provider, _script, reason) => { calls.push(['credentials', 'remove', provider, reason]); return { ok: true }; },
  };
}

/** systemctl on a machine without termag's units: the on-warm run can't start, which never fails a prepare. */
const NO_UNIT = async () => ({ ok: false, error: 'Unit termag-on-warm.service not found.' });

/** systemctl whose on-warm unit writes its status file as termag-hook-run does, ending in `state` after `ms`. */
function warmUnit(home, calls, { state = 'succeeded', ms = 20, script = '10-dotfiles.sh' } = {}) {
  return async (args) => {
    calls.push(['systemctl', ...args]);
    const file = path.join(home, '.termag', 'on-warm.status.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'running', script }));
    setTimeout(() => {
      calls.push(['on-warm', state]);
      fs.writeFileSync(file, JSON.stringify({ schema: 1, state, script: state === 'failed' ? script : null, exitCode: state === 'failed' ? 1 : null,
        reason: state === 'failed' ? 'script-failed' : null, durations: [{ script, seconds: 3, exitCode: state === 'failed' ? 1 : 0 }], logTail: '' }));
    }, ms);
    return { ok: true };
  };
}

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

test('handleEnvironmentPrepare: writes the pool git config for the broker, clones to ~/code/<name>, runs setup only', async () => {
  const home = tmpHome();
  const calls = [];
  let chain = null;
  const r = await prepare.handleEnvironmentPrepare({ ...REQ, githubBroker: 'https://github-broker.example' }, {
    warm: true, home, wait: true, systemctl: NO_UNIT, execFile: fakeGit(calls), credentials: fakeCredentials(calls),
    environmentRun: { stateDir: envRun.stateDir, startChain: async (dir, opts) => { chain = { dir, opts }; return { started: true }; } },
  });
  assert.deepEqual(r, { started: true });
  // The box's git config, written before the clone, so setup's own git goes through the broker too: no -c flags.
  const applied = calls.findIndex(c => c[0] === 'credentials' && c[1] === 'apply');
  assert.ok(applied >= 0 && applied < calls.findIndex(a => a.includes('clone')));
  assert.deepEqual(calls[applied], ['credentials', 'apply', 'github', { broker: 'https://github-broker.example', login: 'environment-pool' }]);
  assert.ok(!calls.find(a => a.includes('clone')).some(a => /insteadOf|credential\./.test(a)));
  assert.equal(prepare.readPool(home).poolGitConfig, true);
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
    warm: true, home, wait: true, systemctl: NO_UNIT, execFile: fakeGit([]),
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
    warm: true, home, wait: true, systemctl: NO_UNIT, execFile: fakeGit([], { failClone: true }),
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
    warm: true, home, wait: true, systemctl: NO_UNIT, execFile: fakeGit(calls), credentials: fakeCredentials(calls),
    environmentRun: { stateDir: envRun.stateDir, startChain: async (d, opts) => { chain = { d, opts }; return { started: true }; } },
  });
  assert.ok(!calls.some(a => a.includes('clone')), 'no second clone');
  const fetch = calls.find(a => a.includes('fetch'));
  // Through the broker: the pool git config is written (again; it is idempotent) before the fetch.
  assert.ok(calls.findIndex(c => c[0] === 'credentials' && c[1] === 'apply') < calls.indexOf(fetch), 'the fetch goes through the broker');
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
    warm: true, home, wait: true, systemctl: NO_UNIT, execFile: git,
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

// The warm pool's on-warm hook (deploy/termag-hook-run warm: the deploy/on-warm.d scripts) runs on a pool
// box too, before its setup: the claimed box then has what a warm box has. It never needs a credential.
test('prepare: starts the on-warm unit, clones alongside it, and runs setup once it has finished', async () => {
  const home = tmpHome();
  const calls = [];
  let started = 0;
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit(calls), systemctl: warmUnit(home, calls), onWarmPollMs: 5,
    onWarmStarted: () => { started++; },
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { calls.push(['chain']); return { started: true }; } },
  });
  const order = calls.map(c => (c[0] === 'systemctl' ? `systemctl ${c.slice(1).join(' ')}` : c[0] === 'on-warm' ? `on-warm ${c[1]}` : c[0] === 'chain' ? 'chain' : c.includes('clone') ? 'clone' : null)).filter(Boolean);
  assert.deepEqual(order, ['systemctl --user start --no-block termag-on-warm.service', 'clone', 'on-warm succeeded', 'chain']);
  assert.equal(started, 1, 'the agent forwards on-warm-status frames for it');
  assert.deepEqual(prepare.readPool(home).onWarm, { state: 'succeeded', seconds: 3 });
});

test('prepare: an on-warm run that fails, or cannot start, does not fail the prepare', async () => {
  for (const systemctlFor of [(home, calls) => warmUnit(home, calls, { state: 'failed' }), () => NO_UNIT]) {
    const home = tmpHome();
    const calls = [];
    await prepare.handleEnvironmentPrepare(REQ, {
      warm: true, home, wait: true, execFile: fakeGit(calls), systemctl: systemctlFor(home, calls), onWarmPollMs: 5,
      environmentRun: { stateDir: envRun.stateDir, startChain: async () => { calls.push(['chain']); return { started: true }; } },
    });
    assert.ok(calls.some(c => c[0] === 'chain'), 'setup runs anyway');
    assert.equal(prepare.readPool(home).onWarm.state, 'failed');
    // Either way the status file says failed, for the agent to forward to the pool page.
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.termag', 'on-warm.status.json'), 'utf8')).state, 'failed');
  }
});

test('prepare: a refresh does not run on-warm again once it has succeeded on the box, and does after a failure', async () => {
  for (const [prior, runs] of [['succeeded', false], ['failed', true]]) {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
    fs.writeFileSync(path.join(home, '.termag', 'on-warm.status.json'), JSON.stringify({ schema: 1, state: prior }));
    const calls = [];
    await prepare.handleEnvironmentPrepare({ ...REQ, prepareId: 'refresh-1' }, {
      warm: true, home, wait: true, execFile: fakeGit(calls), systemctl: warmUnit(home, calls), onWarmPollMs: 5,
      environmentRun: { stateDir: envRun.stateDir, startChain: async () => { calls.push(['chain']); return { started: true }; } },
    });
    assert.equal(calls.some(c => c[0] === 'systemctl'), runs, `after ${prior}`);
    assert.ok(calls.some(c => c[0] === 'chain'));
  }
});

test('prepare: a stale status file from an earlier run is not taken for this run\'s result', async () => {
  const home = tmpHome();
  const file = path.join(home, '.termag', 'on-warm.status.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'failed' }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  const calls = [];
  // A unit that takes a while to write its first status.
  const slow = async (args) => { calls.push(['systemctl', ...args]); setTimeout(() => fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'succeeded', durations: [] })), 40); return { ok: true }; };
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit(calls), systemctl: slow, onWarmPollMs: 5,
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => ({ started: true }) },
  });
  assert.equal(prepare.readPool(home).onWarm.state, 'succeeded');
});

// The pool git config (the broker's URL rewrite and credential helper, credential-free: the broker swaps the pool
// credential in) is the pool's, before claim only.
test('prepare: a pool git config that cannot be written fails the prepare before anything is cloned', async () => {
  const home = tmpHome();
  const calls = [];
  await prepare.handleEnvironmentPrepare({ ...REQ, githubBroker: 'https://github-broker.example' }, {
    warm: true, home, wait: true, systemctl: NO_UNIT, execFile: fakeGit(calls), credentials: fakeCredentials(calls, { fail: true }),
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { throw new Error('not reached'); } },
  });
  assert.ok(!calls.some(a => Array.isArray(a) && a.includes('clone')));
  const state = JSON.parse(fs.readFileSync(envRun.statePath(home, require('./environment-file').envKey(path.join(home, 'code', 'envdemo'))), 'utf8'));
  assert.match(state.setup.error, /pool git config: termag-credentials apply github exited 1/);
});

test('prepare: with a broker but no credentials module, the pool git config is refused, never written with a default', async () => {
  const home = tmpHome();
  const calls = [];
  await prepare.handleEnvironmentPrepare({ ...REQ, githubBroker: 'https://github-broker.example' }, {
    warm: true, home, wait: true, systemctl: NO_UNIT, execFile: fakeGit(calls),
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { throw new Error('not reached'); } },
  });
  assert.ok(!calls.some(a => Array.isArray(a) && a.includes('clone')));
  await assert.rejects(prepare.dropPoolGitConfig((() => { const h = tmpHome(); fs.mkdirSync(path.join(h, '.termag'), { recursive: true }); fs.writeFileSync(prepare.poolFile(h), JSON.stringify({ repos: [], poolGitConfig: true })); return h; })()), /no credentials module/);
});

test('prepare: no broker (a box without one), no pool git config', async () => {
  const home = tmpHome();
  const calls = [];
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, systemctl: NO_UNIT, execFile: fakeGit(calls), credentials: fakeCredentials(calls),
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => ({ started: true }) },
  });
  assert.ok(!calls.some(c => c[0] === 'credentials'));
  assert.equal(prepare.readPool(home).poolGitConfig, undefined);
});

test('dropPoolGitConfig: at claim, removes the pool git config once, before the owner\'s delivery writes theirs', async () => {
  const home = tmpHome();
  const calls = [];
  fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
  fs.writeFileSync(prepare.poolFile(home), JSON.stringify({ environmentId: 'env1', repos: [], poolGitConfig: true }));
  assert.equal(await prepare.dropPoolGitConfig(home, { credentials: fakeCredentials(calls) }), true);
  assert.deepEqual(calls, [['credentials', 'remove', 'github', 'the pool box was claimed: its owner\'s delivery comes next']]);
  assert.equal(prepare.readPool(home).poolGitConfig, false);
  assert.equal(await prepare.dropPoolGitConfig(home, { credentials: fakeCredentials(calls) }), false);
  assert.equal(calls.length, 1);
  // Not a pool box: nothing.
  assert.equal(await prepare.dropPoolGitConfig(tmpHome(), { credentials: fakeCredentials(calls) }), false);
});

test('prepare: a first prepare re-sent at a reconnect, after on-warm succeeded, does not wait for a run that will not come (Bugbot on #1461)', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag', 'on-warm.status.json'), JSON.stringify({ schema: 1, state: 'succeeded', durations: [{ script: 's', seconds: 4 }] }));
  const calls = [];
  const started = Date.now();
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit(calls), onWarmPollMs: 5, onWarmWaitMs: 2000,
    // systemctl start of a succeeded RemainAfterExit unit is a no-op: the file never changes.
    systemctl: async (args) => { calls.push(['systemctl', ...args]); return { ok: true }; },
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { calls.push(['chain']); return { started: true }; } },
  });
  assert.ok(Date.now() - started < 1000, 'no wait');
  assert.ok(!calls.some(c => c[0] === 'systemctl'), 'not started again');
  assert.ok(calls.some(c => c[0] === 'chain'));
  // It reports the run this box already had.
  assert.deepEqual(prepare.readPool(home).onWarm, { state: 'succeeded', seconds: 4 });
});

test('prepare: skipping a succeeded on-warm run still forwards its status file, so a new socket hears it (Bugbot on #1461)', async () => {
  for (const prepareId of [undefined, 'refresh-1']) {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
    fs.writeFileSync(path.join(home, '.termag', 'on-warm.status.json'), JSON.stringify({ schema: 1, state: 'succeeded', durations: [] }));
    let forwarded = 0;
    await prepare.handleEnvironmentPrepare({ ...REQ, ...(prepareId ? { prepareId } : {}) }, {
      warm: true, home, wait: true, execFile: fakeGit([]), systemctl: async () => { throw new Error('not started again'); },
      onWarmStarted: () => { forwarded++; },
      environmentRun: { stateDir: envRun.stateDir, startChain: async () => ({ started: true }) },
    });
    assert.equal(forwarded, 1, `forwarded once (${prepareId ? 'refresh' : 'first prepare'})`);
  }
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

test("prepare: with no systemctl passed, the on-warm run is not started, never this machine's real unit, and the prepare goes on", async () => {
  const home = tmpHome();
  const calls = [];
  const started = Date.now();
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: (cmd, args, opts, cb) => { calls.push([cmd, ...args]); return fakeGit(calls)(cmd, args, opts, cb); },
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { calls.push(['chain']); return { started: true }; } },
  });
  assert.ok(!calls.some(c => c[0] === 'systemctl'), 'no real systemctl');
  assert.ok(Date.now() - started < 1000, 'no wait');
  assert.equal(prepare.readPool(home).onWarm.state, 'failed');
  assert.ok(calls.some(c => c[0] === 'chain'));
});

test('handleEnvironmentPrepare: a prepare re-sent on a new socket while one is in flight forwards on-warm over the new socket (Bugbot on #1461)', async () => {
  const home = tmpHome();
  const calls = [];
  const sockets = [];
  const chain = { stateDir: envRun.stateDir, startChain: async () => ({ started: true }) };
  // Its on-warm run is slow: still running when the box reconnects.
  const first = await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, execFile: fakeGit(calls), systemctl: warmUnit(home, calls, { ms: 200 }), onWarmPollMs: 5,
    onWarmStarted: () => sockets.push('old'), environmentRun: chain,
  });
  assert.deepEqual(first, { started: true });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sockets, ['old']);
  // The agent stops the on-warm poller when a socket closes; the re-sent prepare is the new socket's only chance to start it.
  const again = await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, execFile: fakeGit(calls), systemctl: NO_UNIT, onWarmPollMs: 5, onWarmStarted: () => sockets.push('new'), environmentRun: chain,
  });
  assert.deepEqual(again, { running: true });
  assert.deepEqual(sockets, ['old', 'new']);
  await new Promise(r => setTimeout(r, 300));
});

test('handleEnvironmentPrepare: a prepare re-sent before the in-flight one has started on-warm hands its socket to that start', async () => {
  const home = tmpHome();
  const sockets = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const chain = { stateDir: envRun.stateDir, startChain: async () => ({ started: true }) };
  const slowStart = async (args) => { await gate; return warmUnit(home, [], { ms: 5 })(args); };
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, execFile: fakeGit([]), systemctl: slowStart, onWarmPollMs: 5, onWarmStarted: () => sockets.push('old'), environmentRun: chain,
  });
  const again = await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, execFile: fakeGit([]), systemctl: NO_UNIT, onWarmPollMs: 5, onWarmStarted: () => sockets.push('new'), environmentRun: chain,
  });
  assert.deepEqual(again, { running: true });
  assert.deepEqual(sockets, [], 'nothing to forward before the run starts');
  release();
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(sockets, ['new']);
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

test('prepare: a failed clone fails the prepare at once, without waiting for the on-warm run (Bugbot on #1461)', async () => {
  const home = tmpHome();
  const calls = [];
  // An on-warm run that is still running: it would hold the prepare for ON_WARM_WAIT_MS.
  const running = async (args) => {
    calls.push(['systemctl', ...args]);
    fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
    fs.writeFileSync(path.join(home, '.termag', 'on-warm.status.json'), JSON.stringify({ schema: 1, state: 'running', script: '10-dotfiles.sh' }));
    return { ok: true };
  };
  let chained = false;
  const at = Date.now();
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit(calls, { failClone: true }), systemctl: running, onWarmPollMs: 5, onWarmWaitMs: 2000,
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { chained = true; return { started: true }; } },
  });
  assert.ok(Date.now() - at < 1000, `failed after ${Date.now() - at} ms, not at once`);
  assert.equal(chained, false);
  const state = JSON.parse(fs.readFileSync(path.join(envRun.stateDir(home), fs.readdirSync(envRun.stateDir(home))[0]), 'utf8'));
  assert.equal(state.setup.state, 'failed');
});

test('prepare: the settled on-warm status is forwarded before setup starts, so the orchestrator has it when the prepare finishes (Bugbot on #1461)', async () => {
  const home = tmpHome();
  const calls = [];
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit(calls), systemctl: warmUnit(home, calls), onWarmPollMs: 5,
    onWarmSettled: () => calls.push(['settled']),
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { calls.push(['chain']); return { started: true }; } },
  });
  const order = calls.map(c => c[0]).filter(c => c === 'settled' || c === 'chain' || c === 'on-warm');
  assert.deepEqual(order, ['on-warm', 'settled', 'chain']);
});

test("prepare: a new on-warm run over an earlier run's failed status file never lets the agent forward that failure as this run's (Bugbot on #1461)", async () => {
  const home = tmpHome();
  const file = path.join(home, '.termag', 'on-warm.status.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'failed', script: '20-image-pulls.sh', exitCode: 1, reason: 'script-failed', durations: [], logTail: 'old' }));
  const past = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(file, past, past);
  const calls = [];
  const seenAtStart = [];
  // The unit is slow to write its first status: `--no-block` returns before it has.
  const slowUnit = async (args) => { calls.push(['systemctl', ...args]); setTimeout(() => warmUnit(home, calls, { ms: 10 })(args), 30); return { ok: true }; };
  await prepare.handleEnvironmentPrepare({ ...REQ, prepareId: 'refresh-1' }, {
    warm: true, home, wait: true, execFile: fakeGit(calls), systemctl: slowUnit, onWarmPollMs: 5,
    onWarmStarted: () => seenAtStart.push(JSON.parse(fs.readFileSync(file, 'utf8')).state),
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => ({ started: true }) },
  });
  assert.deepEqual(seenAtStart, ['running'], 'what the poller reads first is this run, not the old failure');
  assert.equal(prepare.readPool(home).onWarm.state, 'succeeded');
});

test('prepare: an on-warm run past its wait is stopped, and its status file says it timed out (Bugbot on #1461)', async () => {
  const home = tmpHome();
  const file = path.join(home, '.termag', 'on-warm.status.json');
  const calls = [];
  const hung = async (args) => {
    calls.push(['systemctl', ...args]);
    if (args.includes('start')) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'running', script: '10-dotfiles.sh' })); }
    return { ok: true };
  };
  let settled = null;
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit(calls), systemctl: hung, onWarmPollMs: 5, onWarmWaitMs: 50,
    onWarmSettled: () => { settled = JSON.parse(fs.readFileSync(file, 'utf8')); },
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => ({ started: true }) },
  });
  assert.ok(calls.some(c => c[0] === 'systemctl' && c.includes('stop') && c.includes(prepare.ON_WARM_UNIT)), 'the unit is stopped');
  assert.equal(settled && settled.state, 'failed');
  assert.equal(settled.reason, 'timeout');
  assert.equal(prepare.readPool(home).onWarm.state, 'failed');
});

test("prepare: the pool chain carries this prepare's own on-warm outcome, a skip on a refresh included, and its frame says it (Devin on #1461)", async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag', 'on-warm.status.json'), JSON.stringify({ schema: 1, state: 'succeeded', durations: [{ script: 'a', seconds: 41, exitCode: 0 }], logTail: '' }));
  let opts = null;
  await prepare.handleEnvironmentPrepare({ ...REQ, prepareId: 'refresh-2' }, {
    warm: true, home, wait: true, execFile: fakeGit([]), systemctl: NO_UNIT, onWarmPollMs: 5,
    environmentRun: { stateDir: envRun.stateDir, startChain: async (_d, o) => { opts = o; return { started: true }; } },
  });
  assert.deepEqual(opts.poolOnWarm, { state: 'skipped', seconds: 0 });
  const { frameFromEnvState } = require('./environment-file');
  assert.deepEqual(frameFromEnvState({ projectId: 'pool', state: 'ready', poolOnWarm: { state: 'skipped', seconds: 0 } }).status.onWarm, { state: 'skipped', seconds: 0 });
  assert.equal(frameFromEnvState({ projectId: 'p1', state: 'ready' }).status.onWarm, undefined);
});

test('prepare: a run that settles while the timed-out unit is being stopped keeps its own result (Bugbot on #1461)', async () => {
  const home = tmpHome();
  const file = path.join(home, '.termag', 'on-warm.status.json');
  const unit = async (args) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (args.includes('start')) fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'running', script: '10-dotfiles.sh' }));
    // It finishes just as the stop arrives.
    if (args.includes('stop')) fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'succeeded', durations: [{ script: 'a', seconds: 7, exitCode: 0 }], logTail: '' }));
    return { ok: true };
  };
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit([]), systemctl: unit, onWarmPollMs: 5, onWarmWaitMs: 30,
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => ({ started: true }) },
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'succeeded');
  assert.deepEqual(prepare.readPool(home).onWarm, { state: 'succeeded', seconds: 7 });
});

test('prepare: a timed-out on-warm unit that cannot be stopped fails the prepare, never running setup beside it (Devin on #1461)', async () => {
  const home = tmpHome();
  const file = path.join(home, '.termag', 'on-warm.status.json');
  const stopArgs = [];
  const unit = async (args, opts) => {
    if (args.includes('start')) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'running', script: 'x' })); }
    if (args.includes('stop')) { stopArgs.push(opts); return { ok: false, error: 'Job for termag-on-warm.service timed out' }; }
    return { ok: true };
  };
  let chained = false;
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit([]), systemctl: unit, onWarmPollMs: 5, onWarmWaitMs: 30,
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => { chained = true; return { started: true }; } },
  });
  assert.equal(chained, false, 'setup never starts');
  assert.ok(stopArgs[0] && stopArgs[0].timeoutMs >= 60_000, 'the stop gets longer than a start to finish');
  const state = JSON.parse(fs.readFileSync(path.join(envRun.stateDir(home), fs.readdirSync(envRun.stateDir(home))[0]), 'utf8'));
  assert.equal(state.setup.state, 'failed');
  assert.match(state.setup.error, /could not be stopped/);
});

test("prepare: a fatal on-warm timeout forwards its status first, and the failed chain state carries this prepare's on-warm outcome (Bugbot, Devin on #1461)", async () => {
  const home = tmpHome();
  const file = path.join(home, '.termag', 'on-warm.status.json');
  const unit = async (args) => {
    if (args.includes('start')) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ schema: 1, state: 'running', script: 'x' })); }
    return args.includes('stop') ? { ok: false, error: 'timed out' } : { ok: true };
  };
  const order = [];
  await prepare.handleEnvironmentPrepare(REQ, {
    warm: true, home, wait: true, execFile: fakeGit([]), systemctl: unit, onWarmPollMs: 5, onWarmWaitMs: 30,
    onWarmSettled: () => order.push(`settled:${fs.existsSync(envRun.stateDir(home)) ? fs.readdirSync(envRun.stateDir(home)).length : 0}`),
    environmentRun: { stateDir: envRun.stateDir, startChain: async () => ({ started: true }) },
  });
  assert.deepEqual(order, ['settled:0'], 'forwarded before the failed state is written');
  const state = JSON.parse(fs.readFileSync(path.join(envRun.stateDir(home), fs.readdirSync(envRun.stateDir(home))[0]), 'utf8'));
  assert.equal(state.poolOnWarm.state, 'failed');
});
