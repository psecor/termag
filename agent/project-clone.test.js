'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);

const {
  CAPABILITIES,
  acceptCloneRequest,
  planClone,
  DEFAULT_WAIT_SECONDS,
  cloneWaitDecision,
  waitFailure,
  diskAllows,
  frameFromState,
  sameRepository,
  createCloneForwarder,
  handleProjectClone,
  runClone,
  writeGuides,
  readState,
} = require('./project-clone');

const REQUEST = {
  projectId: 'p1',
  instanceId: 'box1',
  dir: '/home/ada/projects/widget',
  url: 'https://github.com/acme/widget.git',
  branch: 'HEAD',
  attempt: 2,
  sizeKb: null,
  referenceDir: '/home/ada/src/webapp',
};

function pendingOf(request) {
  return {
    projectId: request.projectId,
    instanceId: request.instanceId,
    attempt: request.attempt,
    dir: request.dir,
    url: request.url,
    requestedBranch: request.branch,
    sizeKb: request.sizeKb,
    referenceDir: request.referenceDir,
    status: 'pending',
  };
}

test('the capability is the one the orchestrator selects durable clone with', () => {
  assert.deepEqual(CAPABILITIES, ['project-clone-v1']);
});

test('accepts the orchestrator payload and rejects a shell path or a missing box id', () => {
  assert.deepEqual(acceptCloneRequest(REQUEST), { ok: true, request: REQUEST });
  assert.deepEqual(acceptCloneRequest({ ...REQUEST, referenceDir: undefined }).request.referenceDir, null);
  assert.equal(acceptCloneRequest({ ...REQUEST, instanceId: '' }).ok, false);
  assert.equal(acceptCloneRequest({ ...REQUEST, dir: 'projects/widget' }).ok, false);
  assert.equal(acceptCloneRequest({ ...REQUEST, referenceDir: '$HOME/src/webapp' }).ok, false);
  assert.equal(acceptCloneRequest({ ...REQUEST, sizeKb: 0 }).ok, false);
  assert.equal(acceptCloneRequest({ ...REQUEST, attempt: -1 }).ok, false);
  assert.equal(acceptCloneRequest({ ...REQUEST, url: 'file:///tmp/widget' }).ok, false);
  assert.equal(acceptCloneRequest({ ...REQUEST, projectId: '../p1' }).ok, false);
});

test('a running unit or a finished attempt is left alone, and a dead unit starts again', () => {
  const ready = { ...pendingOf(REQUEST), status: 'ready', branch: 'main' };
  const failed = { ...pendingOf(REQUEST), status: 'failed', error: 'no space' };
  const cloning = { ...pendingOf(REQUEST), status: 'cloning' };
  assert.deepEqual(planClone({ unitState: 'active', existing: cloning, request: REQUEST }), { kind: 'ignore', why: 'running' });
  assert.deepEqual(planClone({ unitState: 'activating', existing: cloning, request: REQUEST }), { kind: 'ignore', why: 'running' });
  assert.deepEqual(planClone({ unitState: 'inactive', existing: ready, request: REQUEST }), { kind: 'ignore', why: 'ready' });
  assert.deepEqual(planClone({ unitState: 'failed', existing: failed, request: REQUEST }), { kind: 'ignore', why: 'failed' });
  assert.deepEqual(
    planClone({ unitState: 'inactive', existing: cloning, request: REQUEST }),
    { kind: 'start', stop: false, state: pendingOf(REQUEST) },
  );
  assert.deepEqual(
    planClone({ unitState: 'active', existing: ready, request: { ...REQUEST, attempt: 3 } }),
    { kind: 'start', stop: true, state: pendingOf({ ...REQUEST, attempt: 3 }) },
  );
});

test('the wait proceeds once GitHub and on-claim have settled, and names which one did not', () => {
  const waiting = { brokerPresent: false, skipPresent: false, claimState: null, elapsedSec: 10, waitSeconds: 300 };
  assert.equal(cloneWaitDecision(waiting), 'wait');
  assert.equal(cloneWaitDecision({ ...waiting, elapsedSec: 300 }), 'timeout');
  assert.equal(cloneWaitDecision({ ...waiting, brokerPresent: true }), 'go');
  assert.equal(cloneWaitDecision({ ...waiting, skipPresent: true, claimState: 'succeeded' }), 'go');
  assert.equal(cloneWaitDecision({ ...waiting, brokerPresent: true, claimState: 'running' }), 'wait');
  assert.equal(cloneWaitDecision({ ...waiting, brokerPresent: true, claimState: 'running', elapsedSec: 300 }), 'timeout');
  assert.equal(cloneWaitDecision({ ...waiting, brokerPresent: true, claimState: 'failed' }), 'go');
  assert.equal(waitFailure({ brokerPresent: false, skipPresent: false }), 'GitHub delivery did not settle before the clone wait elapsed');
  assert.equal(waitFailure({ brokerPresent: true, skipPresent: false }), 'on-claim did not settle before the clone wait elapsed');
});

test('the default wait covers the on-claim unit runtime', () => {
  const unit = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'termag-on-claim.service'), 'utf8');
  const match = unit.match(/^TimeoutStartSec=(\d+)min$/m);
  assert.ok(match);
  const unitSeconds = Number(match[1]) * 60;
  assert.ok(DEFAULT_WAIT_SECONDS >= unitSeconds);
  const stillRunning = {
    brokerPresent: true,
    skipPresent: false,
    claimState: 'running',
    elapsedSec: unitSeconds - 1,
    waitSeconds: DEFAULT_WAIT_SECONDS,
  };
  assert.equal(cloneWaitDecision(stillRunning), 'wait');
  assert.equal(cloneWaitDecision({ ...stillRunning, claimState: 'pending' }), 'wait');
  assert.equal(cloneWaitDecision({ ...stillRunning, elapsedSec: 10 * 60 }), 'wait');
});

test('a missing size leaves disk alone, and a size needs twice that many free KiB', () => {
  assert.equal(diskAllows(null, 10), true);
  assert.equal(diskAllows(null, null), true);
  assert.equal(diskAllows(1000, null), true);
  assert.equal(diskAllows(1000, 2000), true);
  assert.equal(diskAllows(1000, 1999), false);
});

test('a reference counts only when it is a checkout of the same repository', () => {
  assert.equal(sameRepository('https://github.com/acme/widget.git', 'git@github.com:acme/widget.git'), true);
  assert.equal(sameRepository('https://github.com/acme/widget.git', 'https://broker.example/acme/widget.git'), true);
  assert.equal(sameRepository('https://github.com/acme/widget.git', 'https://github.com/acme/other.git'), false);
});

test('every status frame echoes the box id and the attempt from the request', () => {
  const base = { projectId: 'p1', instanceId: 'box1', attempt: 2 };
  assert.deepEqual(frameFromState({ ...pendingOf(REQUEST) }), { ...base, status: 'pending' });
  assert.deepEqual(frameFromState({ ...pendingOf(REQUEST), status: 'cloning' }), { ...base, status: 'cloning' });
  assert.deepEqual(frameFromState({ ...pendingOf(REQUEST), status: 'ready', branch: 'develop' }), { ...base, status: 'ready', branch: 'develop' });
  assert.deepEqual(frameFromState({ ...pendingOf(REQUEST), status: 'failed', error: 'fatal: denied' }), { ...base, status: 'failed', error: 'fatal: denied' });
  assert.equal(frameFromState({ ...pendingOf(REQUEST), attempt: '2' }), null);
});

test('the forwarder sends each clone file once per socket and again when it changes', () => {
  const files = new Map([
    ['p1.json', JSON.stringify(pendingOf(REQUEST))],
  ]);
  const sent = [];
  const forwarder = createCloneForwarder({
    readNames: () => [...files.keys()],
    readFile: (name) => files.get(name),
    send: (frame) => sent.push(frame),
    isOpen: () => true,
  });
  assert.equal(forwarder.tick(), true);
  assert.equal(forwarder.tick(), false);
  files.set('p1.json', JSON.stringify({ ...pendingOf(REQUEST), status: 'ready', branch: 'main' }));
  assert.equal(forwarder.tick(), true);
  assert.deepEqual(sent, [
    { projectId: 'p1', instanceId: 'box1', attempt: 2, status: 'pending', type: 'project-clone-status' },
    { projectId: 'p1', instanceId: 'box1', attempt: 2, status: 'ready', branch: 'main', type: 'project-clone-status' },
  ]);
});

function systemd(calls, active = 'inactive') {
  return async (cmd, args) => {
    calls.push([cmd, [...args]]);
    if (cmd === 'systemctl' && args[1] === 'is-active') {
      if (active === 'active' || active === 'activating') return { stdout: `${active}\n` };
      const err = new Error('inactive');
      err.stdout = `${active}\n`;
      throw err;
    }
    return { stdout: '' };
  };
}

test('the RPC stores the box id and the attempt, then starts that project unit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-rpc-'));
  const calls = [];
  const result = await handleProjectClone(REQUEST, { execFile: systemd(calls), home, remapPath: (p) => p });
  assert.deepEqual(result, { ok: true, started: true });
  assert.deepEqual(readState(home, 'p1'), pendingOf(REQUEST));
  assert.deepEqual(calls.filter(([cmd, args]) => cmd === 'systemctl' && args.includes('start')), [
    ['systemctl', ['--user', 'start', '--no-block', 'termag-project-clone@p1.service']],
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a second RPC for a clone that is already ready does not start the unit again', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-rpc-'));
  const calls = [];
  await handleProjectClone(REQUEST, { execFile: systemd(calls), home, remapPath: (p) => p });
  const file = path.join(home, '.termag', 'clones', 'p1.json');
  const ready = { ...pendingOf(REQUEST), status: 'ready', branch: 'main' };
  fs.writeFileSync(file, JSON.stringify(ready));
  const again = await handleProjectClone(REQUEST, { execFile: systemd(calls, 'inactive'), home, remapPath: (p) => p });
  assert.deepEqual(again, { ok: true, started: false, ignored: 'ready' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ready);
  assert.equal(calls.filter(([, args]) => args.includes('start')).length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a failed stop or reset is returned and the unit is not started', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-rpc-'));
  const refuse = async (which) => {
    const calls = [];
    const execFile = async (cmd, args) => {
      calls.push([cmd, [...args]]);
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        return { stdout: which === 'stop' ? 'active\n' : 'inactive\n' };
      }
      if (cmd === 'systemctl' && args.includes(which)) {
        throw Object.assign(new Error(`${which} refused`), { stderr: `${which} refused\n` });
      }
      return { stdout: '' };
    };
    await assert.rejects(
      handleProjectClone({ ...REQUEST, attempt: 3 }, { execFile, home, remapPath: (p) => p }),
      which === 'stop' ? /stop refused/ : /could not reset/,
    );
    assert.equal(calls.some(([, args]) => args.includes('start')), false);
  };
  await refuse('stop');
  await refuse('reset-failed');
  fs.rmSync(home, { recursive: true, force: true });
});

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
}

function seedRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README'), 'hello\n');
  git(dir, ['add', 'README']);
  git(dir, ['commit', '-m', 'init']);
}

function cloneState(home, dir, extra = {}) {
  const state = {
    ...pendingOf({ ...REQUEST, dir, referenceDir: null }),
    url: extra.url,
    ...extra,
  };
  fs.mkdirSync(path.join(home, '.termag', 'clones'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'termag'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'termag', 'github.skip'), '');
  fs.writeFileSync(path.join(home, '.termag', 'clones', 'p1.json'), JSON.stringify(state));
  return state;
}

test('the runner clones into a sibling directory, then renames it into place with the branch and the exclude', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-run-'));
  const src = path.join(home, 'src');
  const dest = path.join(home, 'projects', 'widget');
  seedRepo(src);
  cloneState(home, dest, { url: src, requestedBranch: 'HEAD', referenceDir: null });
  fs.unlinkSync(path.join(home, '.config', 'termag', 'github.skip'));
  fs.writeFileSync(path.join(home, '.config', 'termag', 'github-broker'), '');
  const seen = [];
  const execFile = async (cmd, args, opts = {}) => {
    // The template lookup reads the real global config on purpose; every git
    // command that touches the repository must not.
    if (cmd === 'git' && !args.includes('init.templateDir')) seen.push(opts.env && opts.env.GIT_CONFIG_GLOBAL);
    return execFileAsync(cmd, args, opts);
  };
  assert.equal(await runClone('p1', { home, execFile, waitSeconds: 300 }), 0);
  assert.ok(seen.length > 0);
  assert.deepEqual(seen, seen.map(() => '/dev/null'));
  assert.equal(fs.existsSync(path.join(home, 'projects', '.clone-p1')), false);
  assert.equal(fs.readFileSync(path.join(dest, 'README'), 'utf8'), 'hello\n');
  assert.match(fs.readFileSync(path.join(dest, 'AGENTS.md'), 'utf8'), /`termag ask[\s\S]*`agent-ask` skill/);
  assert.equal(fs.readFileSync(path.join(dest, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.match(fs.readFileSync(path.join(dest, '.git', 'info', 'exclude'), 'utf8'), /^\/\.worktrees\/$/m);
  const state = readState(home, 'p1');
  assert.equal(state.status, 'ready');
  assert.equal(state.branch, 'main');
  assert.equal(state.instanceId, 'box1');
  assert.equal(state.attempt, 2);
  assert.deepEqual(frameFromState(state), {
    projectId: 'p1', instanceId: 'box1', attempt: 2, status: 'ready', branch: 'main',
  });
  assert.equal(await runClone('p1', { home, execFile: execFileAsync, waitSeconds: 300 }), 0);
  assert.equal(fs.readFileSync(path.join(dest, 'README'), 'utf8'), 'hello\n');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the clone takes the box git template, so it gets the commit trailer hook', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-template-'));
  const src = path.join(home, 'src');
  const dest = path.join(home, 'projects', 'widget');
  const template = path.join(home, 'git-template');
  fs.mkdirSync(path.join(template, 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'deploy', 'termag-commit-msg'), path.join(template, 'hooks', 'commit-msg'));
  fs.chmodSync(path.join(template, 'hooks', 'commit-msg'), 0o755);
  seedRepo(src);
  cloneState(home, dest, { url: src, requestedBranch: 'HEAD', referenceDir: null });
  const clones = [];
  const execFile = async (cmd, args, opts = {}) => {
    if (cmd === 'git' && args.includes('init.templateDir')) {
      assert.notEqual(opts.env && opts.env.GIT_CONFIG_GLOBAL, '/dev/null');
      return { stdout: `${template}\n`, stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'clone') clones.push([...args]);
    return execFileAsync(cmd, args, opts);
  };
  assert.equal(await runClone('p1', { home, execFile, waitSeconds: 300 }), 0);
  assert.ok(clones[0].includes(`--template=${template}`));
  const hook = path.join(dest, '.git', 'hooks', 'commit-msg');
  assert.equal(fs.readFileSync(hook, 'utf8'), fs.readFileSync(path.join(template, 'hooks', 'commit-msg'), 'utf8'));
  assert.ok(fs.statSync(hook).mode & 0o100);
  fs.rmSync(home, { recursive: true, force: true });
});

test('no git template (or one that is not there) clones as before', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-notemplate-'));
  const src = path.join(home, 'src');
  const dest = path.join(home, 'projects', 'widget');
  seedRepo(src);
  cloneState(home, dest, { url: src, requestedBranch: 'HEAD', referenceDir: null });
  const clones = [];
  const execFile = async (cmd, args, opts = {}) => {
    if (cmd === 'git' && args.includes('init.templateDir')) return { stdout: `${path.join(home, 'absent')}\n`, stderr: '' };
    if (cmd === 'git' && args[0] === 'clone') clones.push([...args]);
    return execFileAsync(cmd, args, opts);
  };
  assert.equal(await runClone('p1', { home, execFile, waitSeconds: 300 }), 0);
  assert.equal(clones[0].some(a => a.startsWith('--template')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('github.skip keeps the owner gitconfig on every git command', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-skip-'));
  const src = path.join(home, 'src');
  const dest = path.join(home, 'projects', 'widget');
  const owner = path.join(os.tmpdir(), 'termag-project-clone-owner.gitconfig');
  seedRepo(src);
  cloneState(home, dest, { url: src, requestedBranch: 'HEAD', referenceDir: null });
  fs.writeFileSync(owner, '[user]\n\tname = Owner\n');
  const seen = [];
  const execFile = async (cmd, args, opts = {}) => {
    if (cmd === 'git') seen.push(opts.env && opts.env.GIT_CONFIG_GLOBAL);
    return execFileAsync(cmd, args, opts);
  };
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = owner;
  try {
    assert.equal(await runClone('p1', { home, execFile, waitSeconds: 300 }), 0);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
  assert.ok(seen.length > 0);
  assert.deepEqual(seen, seen.map(() => owner));
  fs.rmSync(home, { recursive: true, force: true });
});

test('a baked checkout of the same repository is used as a reference', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-ref-'));
  const src = path.join(home, 'origin');
  const baked = path.join(home, 'baked');
  const dest = path.join(home, 'projects', 'widget');
  seedRepo(src);
  git(home, ['clone', src, baked]);
  cloneState(home, dest, { url: src, referenceDir: baked, requestedBranch: 'HEAD' });
  assert.equal(await runClone('p1', { home, execFile: execFileAsync }), 0);
  const alternates = fs.readFileSync(path.join(dest, '.git', 'objects', 'info', 'alternates'), 'utf8');
  assert.match(alternates, /baked\/\.git\/objects/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an occupied target fails and is left in place', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-busy-'));
  const src = path.join(home, 'src');
  const dest = path.join(home, 'projects', 'widget');
  seedRepo(src);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'keep'), 'mine\n');
  cloneState(home, dest, { url: src });
  assert.equal(await runClone('p1', { home, execFile: execFileAsync }), 1);
  assert.equal(fs.readFileSync(path.join(dest, 'keep'), 'utf8'), 'mine\n');
  const state = readState(home, 'p1');
  assert.equal(state.status, 'failed');
  assert.match(state.error, /already exists/);
  assert.deepEqual(frameFromState(state), {
    projectId: 'p1', instanceId: 'box1', attempt: 2, status: 'failed', error: state.error,
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('the wait records a failure when GitHub never arrives', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-wait-'));
  const dest = path.join(home, 'projects', 'widget');
  const state = pendingOf({ ...REQUEST, dir: dest, referenceDir: null });
  fs.mkdirSync(path.join(home, '.termag', 'clones'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag', 'clones', 'p1.json'), JSON.stringify({ ...state, url: '/no/such' }));
  let slept = false;
  const code = await runClone('p1', {
    home,
    execFile: execFileAsync,
    waitSeconds: 0,
    sleep: () => { slept = true; },
  });
  assert.equal(code, 1);
  assert.equal(slept, false);
  assert.equal(readState(home, 'p1').error, 'GitHub delivery did not settle before the clone wait elapsed');
  assert.equal(fs.existsSync(dest), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an on-claim file that cannot be read is not treated as settled', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-claim-'));
  const dest = path.join(home, 'projects', 'widget');
  cloneState(home, dest, { url: '/no/such' });
  fs.writeFileSync(path.join(home, '.termag', 'on-claim.status.json'), '{');
  const code = await runClone('p1', { home, execFile: execFileAsync, waitSeconds: 0, sleep: () => {} });
  assert.equal(code, 1);
  assert.equal(readState(home, 'p1').error, 'on-claim did not settle before the clone wait elapsed');
  assert.equal(fs.existsSync(dest), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the clone wrapper resolves Node, and a missing runtime fails the pending clone', () => {
  const root = path.join(__dirname, '..', 'deploy');
  const unit = fs.readFileSync(path.join(root, 'termag-project-clone@.service'), 'utf8');
  // Agent/clone runtime parity is exercised through both shipped units in
  // node-runtime.test.js, rather than comparing their shell source text.
  assert.match(unit, /termag-project-clone" "%i"/);
  const timeout = unit.match(/^TimeoutStartSec=(\d+)min$/m);
  assert.ok(timeout);
  const timeoutSec = Number(timeout[1]) * 60;
  assert.equal(timeoutSec, 30 * 60);
  assert.ok(timeoutSec >= DEFAULT_WAIT_SECONDS + 15 * 60);

  const script = path.join(root, 'termag-project-clone');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-node-'));
  const clones = path.join(home, '.termag', 'clones');
  fs.mkdirSync(clones, { recursive: true });
  const file = path.join(clones, 'p1.json');
  const pending = { ...pendingOf(REQUEST), status: 'pending' };
  fs.writeFileSync(file, `${JSON.stringify(pending)}\n`);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/node-argv"\nexit 0\n');
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  fs.mkdirSync(path.join(home, '.nvm'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nvm', 'nvm.sh'), `export PATH="${bin}:$PATH"\n`);

  let status = 0;
  try {
    execFileSync(script, ['p1'], {
      env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', NVM_DIR: path.join(home, '.nvm'), TERMAG_CHECKOUT: path.join(root, '..') },
      stdio: 'pipe',
    });
  } catch (err) {
    status = err.status;
  }
  assert.equal(status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'pending');
  assert.match(fs.readFileSync(path.join(home, 'node-argv'), 'utf8'), /project-clone\.js\nrun\np1\n/);

  fs.writeFileSync(file, `${JSON.stringify(pending)}\n`);
  status = 0;
  try {
    execFileSync(script, ['p1'], {
      env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', NVM_DIR: path.join(home, 'missing-nvm'), TERMAG_CHECKOUT: path.join(root, '..') },
      stdio: 'pipe',
    });
  } catch (err) {
    status = err.status;
  }
  assert.equal(status, 1);
  const failed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /no usable Node.js/);
  assert.equal(failed.instanceId, 'box1');
  assert.equal(failed.attempt, 2);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a killed clone unit marks a pending or cloning state failed', async () => {
  const script = path.join(__dirname, '..', 'deploy', 'termag-project-clone');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-kill-'));
  const clones = path.join(home, '.termag', 'clones');
  fs.mkdirSync(clones, { recursive: true });
  const file = path.join(clones, 'p1.json');
  fs.writeFileSync(file, `${JSON.stringify({ ...pendingOf(REQUEST), status: 'cloning' })}\n`);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\n[ "$1" = --version ] && exit 0\ntouch "$HOME/node-started"\nsleep 30\n');
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  fs.mkdirSync(path.join(home, '.nvm'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nvm', 'nvm.sh'), `export PATH="${bin}:$PATH"\n`);

  const child = spawn(script, ['p1'], {
    env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', NVM_DIR: path.join(home, '.nvm'), TERMAG_CHECKOUT: path.join(__dirname, '..') },
    stdio: 'ignore',
  });
  try {
    const started = path.join(home, 'node-started');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(started)) {
      if (Date.now() > deadline) throw new Error('node did not start');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('clone unit did not exit')), 5000)),
    ]);
    assert.notEqual(code, 0);
    const failed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /killed before it finished/);
    assert.equal(failed.instanceId, 'box1');
    assert.equal(failed.attempt, 2);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a dangling guide symlink is not followed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-symlink-'));
  const dir = path.join(home, 'projects', '.clone-p1');
  const outside = path.join(home, '.config', 'termag');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const agentsTarget = path.join(outside, 'github.skip');
  const claudeTarget = path.join(outside, 'claude-escaped');
  fs.symlinkSync('../../.config/termag/github.skip', path.join(dir, 'AGENTS.md'));
  fs.symlinkSync('../../.config/termag/claude-escaped', path.join(dir, 'CLAUDE.md'));
  writeGuides(dir, 'widget', 'owner', path.join(__dirname, 'initial-AGENTS.md'));
  assert.equal(fs.existsSync(agentsTarget), false);
  assert.equal(fs.existsSync(claudeTarget), false);
  assert.equal(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(dir, 'AGENTS.md')), '../../.config/termag/github.skip');
  assert.equal(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink(), true);

  fs.unlinkSync(path.join(dir, 'AGENTS.md'));
  writeGuides(dir, 'widget', 'owner', path.join(__dirname, 'initial-AGENTS.md'));
  assert.equal(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(claudeTarget), false);
  assert.equal(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(dir, 'CLAUDE.md')), '../../.config/termag/claude-escaped');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a clone that needs more disk than the machine has fails before creating the project', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-disk-'));
  const src = path.join(home, 'src');
  const dest = path.join(home, 'projects', 'widget');
  seedRepo(src);
  cloneState(home, dest, { url: src, sizeKb: 2 ** 40 });
  assert.equal(await runClone('p1', { home, execFile: execFileAsync }), 1);
  assert.equal(fs.existsSync(dest), false);
  assert.match(readState(home, 'p1').error, /not enough free disk/);
  fs.rmSync(home, { recursive: true, force: true });
});
