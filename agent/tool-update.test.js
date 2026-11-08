'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { AT_START, CAPABILITIES, COMPONENT_CAPABILITIES, COMPONENT_CHECKS, COMPONENT_REQUIRES, TOOL_UNITS, ROOT_HELPERS, instanceUnit, loadedComponents, capabilities, pythonLayout, pythonRecipeEnv, startToolUpdate } = require('./tool-update');

const RUN = 'cmvtqfadd05j1afsfd7mb5zz2';

// A fake execFile that records calls and answers from a function.
function fakeExec(answer) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answer(cmd, args, opts);
  };
  return { exec, calls };
}

test('the capability is tool-update-v1, and claude and codex map to their template units', () => {
  assert.deepEqual(CAPABILITIES, ['tool-update-v1']);
  assert.deepEqual(TOOL_UNITS, { claude: 'termag-claude-update@.service', codex: 'termag-codex-update@.service', cursor: 'termag-cursor-update@.service', devin: 'termag-devin-update@.service', pi: 'termag-pi-update@.service', gh: 'termag-gh-update@.service', aws: 'termag-aws-update@.service', node: 'termag-node-update@.service', python: 'termag-python-update@.service', docker: 'termag-docker-update.service' });
  assert.deepEqual(COMPONENT_CAPABILITIES, { claude: 'tool-update-v1', codex: 'tool-update-codex-v1', cursor: 'tool-update-cursor-v1', devin: 'tool-update-devin-v1', pi: 'tool-update-pi-v1', gh: 'tool-update-gh-v1', aws: 'tool-update-aws-v1', node: 'tool-update-node-v1', python: 'tool-update-python-v1', docker: 'tool-update-docker-v1' });
  assert.equal(instanceUnit('pi', RUN), `termag-pi-update@${RUN}.service`);
  assert.equal(instanceUnit('devin', RUN), `termag-devin-update@${RUN}.service`);
  assert.deepEqual(capabilities(['devin']), ['tool-update-devin-v1']);
  assert.equal(instanceUnit('cursor', RUN), `termag-cursor-update@${RUN}.service`);
  assert.deepEqual(capabilities(['cursor', 'claude']), ['tool-update-v1', 'tool-update-cursor-v1']);
  assert.equal(instanceUnit('claude', RUN), `termag-claude-update@${RUN}.service`);
  assert.equal(instanceUnit('codex', RUN), `termag-codex-update@${RUN}.service`);
});

test('each component\'s capability is announced only when its unit is loaded', async () => {
  const codexOnly = fakeExec(async (_cmd, args) => ({ stdout: args[5].startsWith('termag-codex-update@') ? 'loaded\n' : 'not-found\n' }));
  assert.deepEqual(await loadedComponents(codexOnly.exec, { exists: () => true }), ['codex']);
  assert.deepEqual(codexOnly.calls.map((c) => c.args[5]), ['termag-claude-update@probe.service', 'termag-codex-update@probe.service', 'termag-cursor-update@probe.service', 'termag-devin-update@probe.service', 'termag-pi-update@probe.service', 'termag-gh-update@probe.service', 'termag-aws-update@probe.service', 'termag-node-update@probe.service', 'termag-python-update@probe.service', 'termag-docker-update.service']);
  assert.deepEqual(capabilities(['codex']), ['tool-update-codex-v1']);
  assert.deepEqual(capabilities(['codex', 'claude']), ['tool-update-v1', 'tool-update-codex-v1']);
});

test('tool-update starts a Codex run\'s instance of the Codex unit', async () => {
  const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
  assert.deepEqual(await startToolUpdate({ component: 'codex', run: RUN }, exec), { started: true, unit: `termag-codex-update@${RUN}.service` });
  assert.deepEqual(calls[0].args, ['--user', 'start', '--no-block', `termag-codex-update@${RUN}.service`]);
  const missing = fakeExec(async () => { const err = new Error('Command failed'); err.stderr = `Unit termag-codex-update@${RUN}.service not found.\n`; throw err; });
  await assert.rejects(startToolUpdate({ component: 'codex', run: RUN }, missing.exec), /termag-codex-update@\.service is not installed on this box/);
});

test('the capability is announced only when the claude unit is loaded', async () => {
  const loaded = fakeExec(async (_cmd, args) => ({ stdout: args[5].startsWith('termag-claude-update@') ? 'loaded\n' : 'not-found\n' }));
  assert.deepEqual(await loadedComponents(loaded.exec), ['claude']);
  // An instance, not the template: systemd 255 refuses `show` on a template name.
  assert.deepEqual(loaded.calls[0].args, ['--user', 'show', '-p', 'LoadState', '--value', 'termag-claude-update@probe.service']);
  assert.equal(loaded.calls[0].cmd, 'systemctl');
  assert.ok(loaded.calls[0].opts.timeout > 0, 'bounded');
  assert.deepEqual(capabilities(['claude']), ['tool-update-v1']);

  assert.deepEqual(await loadedComponents(fakeExec(async () => ({ stdout: 'not-found\n' })).exec), []);
  assert.deepEqual(await loadedComponents(fakeExec(async () => { throw new Error('Failed to connect to bus'); }).exec), []);
  assert.deepEqual(capabilities([]), []);
});

test('tool-update starts the run\'s instance without waiting for it', async () => {
  const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
  const result = await startToolUpdate({ component: 'claude', run: RUN }, exec);
  assert.deepEqual(result, { started: true, unit: `termag-claude-update@${RUN}.service` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'systemctl');
  assert.deepEqual(calls[0].args, ['--user', 'start', '--no-block', `termag-claude-update@${RUN}.service`]);
  assert.ok(calls[0].opts.timeout > 0, 'bounded');
});

test('tool-update refuses a component outside the table, and starts nothing', async () => {
  for (const component of ['cursor-agent', 'Codex', 'Claude', '', undefined, null, 7, 'constructor', '__proto__', 'claude;id']) {
    const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
    await assert.rejects(startToolUpdate({ component, run: RUN }, exec), /unknown component/);
    assert.equal(calls.length, 0, `nothing run for ${String(component)}`);
  }
  await assert.rejects(startToolUpdate(null, fakeExec(async () => ({})).exec), /unknown component/);
});

test('tool-update refuses a run that is not a run id, and starts nothing', async () => {
  const bad = [
    'short', 'a'.repeat(19), 'a'.repeat(41), RUN.toUpperCase(), `${RUN}.service`, `${RUN} x`,
    '../../etc/passwd0000000000', `-${'a'.repeat(24)}`, `${'a'.repeat(24)}\n`, `${'a'.repeat(12)}_${'a'.repeat(12)}`,
    undefined, null, 12345678901234567890,
  ];
  for (const run of bad) {
    const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
    await assert.rejects(startToolUpdate({ component: 'claude', run }, exec), /not a run id/);
    assert.equal(calls.length, 0, `nothing run for ${JSON.stringify(run)}`);
  }
  // Both ends of the length range are accepted.
  for (const run of ['a'.repeat(20), '0'.repeat(40)]) {
    const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
    assert.equal((await startToolUpdate({ component: 'claude', run }, exec)).started, true);
    assert.equal(calls.length, 1);
  }
});

test('a box without the unit says how to get it; any other failure says what systemctl said', async () => {
  const missing = fakeExec(async () => {
    const err = new Error('Command failed');
    err.stderr = `Failed to start termag-claude-update@${RUN}.service: Unit termag-claude-update@${RUN}.service not found.\n`;
    throw err;
  });
  await assert.rejects(startToolUpdate({ component: 'claude', run: RUN }, missing.exec), /termag-claude-update@\.service is not installed on this box; run termag-reconcile/);

  const bus = fakeExec(async () => { const err = new Error('Command failed'); err.stderr = 'Failed to connect to bus: No medium found\n'; throw err; });
  await assert.rejects(startToolUpdate({ component: 'claude', run: RUN }, bus.exec), new RegExp(`could not start termag-claude-update@${RUN}\\.service: Failed to connect to bus`));
});

test('the GitHub CLI runs as root: its system unit, announced only while sudo lets this user run its helper', async () => {
  assert.deepEqual(ROOT_HELPERS, { gh: '/usr/local/libexec/termag/termag-gh-update-start', aws: '/usr/local/libexec/termag/termag-aws-update-start' });
  const helper = ROOT_HELPERS.gh;
  // Loaded in the system manager, and sudo -n -l allows the helper: announced.
  const ok = fakeExec(async (cmd, args) => (cmd === 'sudo' ? { stdout: helper } : { stdout: args[5] === 'termag-gh-update@probe.service' ? 'loaded\n' : 'not-found\n' }));
  assert.deepEqual(await loadedComponents(ok.exec), ['gh']);
  const gh = ok.calls.filter((c) => c.cmd === 'sudo' || c.args[5] === 'termag-gh-update@probe.service');
  assert.deepEqual(gh.map((c) => [c.cmd, ...c.args]), [
    ['systemctl', '--system', 'show', '-p', 'LoadState', '--value', 'termag-gh-update@probe.service'],
    ['sudo', '-n', '-l', helper, 'probe'],
  ]);
  assert.deepEqual(capabilities(['gh']), ['tool-update-gh-v1']);
  // Loaded, but sudo says no: not announced.
  const noSudo = fakeExec(async (cmd, args) => {
    if (cmd === 'sudo') { const err = new Error('Command failed'); err.stderr = 'sudo: a password is required\n'; throw err; }
    return { stdout: args[5] === 'termag-gh-update@probe.service' ? 'loaded\n' : 'not-found\n' };
  });
  assert.deepEqual(await loadedComponents(noSudo.exec), []);
  // Not loaded: sudo is never asked.
  const none = fakeExec(async () => ({ stdout: 'not-found\n' }));
  assert.deepEqual(await loadedComponents(none.exec), []);
  assert.equal(none.calls.filter((c) => c.cmd === 'sudo').length, 0);
});

test('a gh run starts through sudo -n and the helper, with the run id alone', async () => {
  const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
  assert.deepEqual(await startToolUpdate({ component: 'gh', run: RUN }, exec), { started: true, unit: `termag-gh-update@${RUN}.service` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'sudo');
  assert.deepEqual(calls[0].args, ['-n', '/usr/local/libexec/termag/termag-gh-update-start', RUN]);
  assert.ok(calls[0].opts.timeout > 0, 'bounded');
  for (const run of ['short', `${RUN};id`, `${RUN} x`, '-l', '']) {
    const r = fakeExec(async () => ({ stdout: '' }));
    await assert.rejects(startToolUpdate({ component: 'gh', run }, r.exec), /not a run id/);
    assert.equal(r.calls.length, 0);
  }
  const denied = fakeExec(async () => { const err = new Error('Command failed'); err.stderr = 'sudo: a password is required\n'; throw err; });
  await assert.rejects(startToolUpdate({ component: 'gh', run: RUN }, denied.exec), /sudo does not let this user start termag-gh-update@\.service/);
});

test('the AWS CLI runs as root on the same seam: its system unit, its helper, the run id alone', async () => {
  const helper = ROOT_HELPERS.aws;
  const ok = fakeExec(async (cmd, args) => (cmd === 'sudo' ? { stdout: helper } : { stdout: args[5] === 'termag-aws-update@probe.service' ? 'loaded\n' : 'not-found\n' }));
  assert.deepEqual(await loadedComponents(ok.exec), ['aws']);
  assert.deepEqual(ok.calls.filter((c) => c.cmd === 'sudo').map((c) => c.args), [['-n', '-l', helper, 'probe']]);
  assert.deepEqual(capabilities(['aws']), ['tool-update-aws-v1']);
  const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
  assert.deepEqual(await startToolUpdate({ component: 'aws', run: RUN }, exec), { started: true, unit: `termag-aws-update@${RUN}.service` });
  assert.deepEqual([calls[0].cmd, ...calls[0].args], ['sudo', '-n', '/usr/local/libexec/termag/termag-aws-update-start', RUN]);
  // A refusal names the AWS CLI's own setup, not the GitHub CLI's.
  const denied = fakeExec(async () => { const err = new Error('Command failed'); err.stderr = 'sudo: a password is required\n'; throw err; });
  await assert.rejects(startToolUpdate({ component: 'aws', run: RUN }, denied.exec), /termag-aws-update-setup/);
});

test('Node runs in the user\'s systemd, as the npm tools do: no root helper', async () => {
  assert.equal(ROOT_HELPERS.node, undefined);
  const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
  assert.deepEqual(await startToolUpdate({ component: 'node', run: RUN }, exec), { started: true, unit: `termag-node-update@${RUN}.service` });
  assert.deepEqual([calls[0].cmd, ...calls[0].args], ['systemctl', '--user', 'start', '--no-block', `termag-node-update@${RUN}.service`]);
  assert.deepEqual(capabilities(['node']), ['tool-update-node-v1']);
});

test('Python runs in the user\'s systemd, and is offered only where pyenv and uv are', async () => {
  assert.equal(ROOT_HELPERS.python, undefined);
  const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
  assert.deepEqual(await startToolUpdate({ component: 'python', run: RUN }, exec), { started: true, unit: `termag-python-update@${RUN}.service` });
  assert.deepEqual([calls[0].cmd, ...calls[0].args], ['systemctl', '--user', 'start', '--no-block', `termag-python-update@${RUN}.service`]);
  assert.deepEqual(capabilities(['python']), ['tool-update-python-v1']);
  assert.deepEqual(COMPONENT_REQUIRES.python, ['.pyenv/bin/pyenv', '.local/bin/uv']);
  // The unit loaded, as termag-reconcile installs it on every box.
  const loaded = () => fakeExec(async (_cmd, args) => ({ stdout: args[5].startsWith('termag-python-update@') ? 'loaded\n' : 'not-found\n' }));
  const seen = [];
  const both = loaded();
  assert.deepEqual(await loadedComponents(both.exec, { home: '/home/ada', checks: {}, exists: (p) => { seen.push(p); return true; } }), ['python']);
  assert.deepEqual(seen, ['/home/ada/.pyenv/bin/pyenv', '/home/ada/.local/bin/uv']);
  // A minimal box: no pyenv (its python3 is the system's), so no capability, and its unit is not even asked.
  const noPyenv = loaded();
  assert.deepEqual(await loadedComponents(noPyenv.exec, { home: '/home/ada', exists: (p) => !p.endsWith('/pyenv') }), []);
  assert.equal(noPyenv.calls.some((c) => c.args[5].startsWith('termag-python-update@')), false);
  const noUv = loaded();
  assert.deepEqual(await loadedComponents(noUv.exec, { home: '/home/ada', exists: (p) => !p.endsWith('/uv') }), []);
  assert.deepEqual(await loadedComponents(loaded().exec, { home: '/home/ada', exists: () => { throw new Error('EACCES'); } }), []);
});

test('Docker is updated only at the box\'s start: announced while its system unit is enabled, and the RPC starts nothing', async () => {
  assert.deepEqual(AT_START, { docker: true });
  assert.equal(instanceUnit('docker', RUN), 'termag-docker-update.service');
  const enabled = fakeExec(async (_cmd, args) => ({ stdout: args[5] === 'termag-docker-update.service' ? 'enabled\n' : 'not-found\n' }));
  assert.deepEqual(await loadedComponents(enabled.exec, { exists: () => true }), ['docker']);
  const probe = enabled.calls.find((c) => c.args[5] === 'termag-docker-update.service');
  assert.deepEqual([probe.cmd, ...probe.args], ['systemctl', '--system', 'show', '-p', 'UnitFileState', '--value', 'termag-docker-update.service']);
  assert.deepEqual(capabilities(['docker']), ['tool-update-docker-v1']);
  // Installed but not enabled (or masked): boot would not run it, so no capability.
  assert.deepEqual(await loadedComponents(fakeExec(async (_c, args) => ({ stdout: args[5] === 'termag-docker-update.service' ? 'disabled\n' : 'not-found\n' })).exec, { exists: () => true }), []);
  const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
  await assert.rejects(startToolUpdate({ component: 'docker', run: RUN }, exec), /updated only when the box starts/);
  assert.equal(calls.length, 0);
});

// A box's home, as each image lays Python out. new: uv's CPython in uv's
// directory, ~/.pyenv/versions/<x.y.z> a link to it, `pyenv global <x.y.z>`
// (packer/scripts/setup.sh since c7527b495). old: `pyenv install 3.13`, a
// CPython pyenv built into ~/.pyenv/versions/3.13.15, `pyenv global 3.13`.
// Its pyenv answers `global` as pyenv-global does (version, then global,
// then default under PYENV_ROOT, the first word that is not a comment, else
// system), and its uv `python dir` as uv does (UV_PYTHON_INSTALL_DIR, else
// XDG_DATA_HOME's, else ~/.local/share's uv/python), both from the
// environment they are run in.
const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmp.push(d); return d; };
const PYENV_STUB = `#!/bin/sh
[ "$1" = global ] || exit 1
echo "$PYENV_VERSION" > "$PYENV_ROOT/.seen-pyenv-version"
for f in "$PYENV_ROOT/version" "$PYENV_ROOT/global" "$PYENV_ROOT/default"; do
  [ -f "$f" ] || continue
  v=$(grep -v '^ *#' "$f" | awk 'NF { print $1; exit }')
  [ -n "$v" ] && { echo "$v"; exit 0; }
done
echo system
`;
const UV_STUB = `#!/bin/sh
[ "$1 $2 $3" = "python dir --no-config" ] || exit 2
env | grep '^UV_' > "$HOME/.seen-uv-env"
echo "\${UV_PYTHON_INSTALL_DIR:-\${XDG_DATA_HOME:-$HOME/.local/share}/uv/python}"
`;
function pythonHome(layout, { global, file = 'version', uvDir } = {}) {
  const home = mkTmp('tu-python-');
  const versions = path.join(home, '.pyenv/versions');
  const uv = uvDir || path.join(home, '.local/share/uv/python');
  fs.mkdirSync(versions, { recursive: true });
  fs.mkdirSync(path.join(home, '.pyenv/bin'), { recursive: true });
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.mkdirSync(uv, { recursive: true });
  fs.writeFileSync(path.join(home, '.pyenv/bin/pyenv'), PYENV_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.local/bin/uv'), UV_STUB, { mode: 0o755 });
  if (layout === 'new') {
    fs.mkdirSync(path.join(uv, 'cpython-3.13.18-x86_64-linux-gnu/bin'), { recursive: true });
    fs.symlinkSync(path.join(uv, 'cpython-3.13.18-x86_64-linux-gnu'), path.join(versions, '3.13.18'));
  } else {
    fs.mkdirSync(path.join(versions, '3.13.15/bin'), { recursive: true });
  }
  if (global !== null) fs.writeFileSync(path.join(home, '.pyenv', file), `${global || (layout === 'new' ? '3.13.18' : '3.13')}\n`);
  return { home, uv };
}
// systemctl says the Python unit is loaded; pyenv and uv are the home's stubs, run for real.
const realExec = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })));
});
const pythonBox = () => fakeExec(async (cmd, args, opts) => {
  if (cmd !== 'systemctl') return realExec(cmd, args, opts);
  return { stdout: args[5] && args[5].startsWith('termag-python-update@') ? 'loaded\n' : 'not-found\n' };
});
// The agent's own environment for the probe, as the user manager gives it.
const agentEnv = (home, extra = {}) => ({ PATH: '/usr/bin:/bin', HOME: home, ...extra });
const offered = async ({ home }, env = {}) => {
  const logs = [];
  const box = pythonBox();
  const checks = { python: (exec, o) => pythonLayout(exec, { ...o, env: agentEnv(home, env) }) };
  const got = await loadedComponents(box.exec, { home, exists: () => true, checks, log: (l) => logs.push(l) });
  return { caps: capabilities(got), logs, calls: box.calls };
};

test('Python is offered on the new image\'s layout: an x.y.z global linked into uv\'s directory', async () => {
  assert.equal(COMPONENT_CHECKS.python, pythonLayout);
  const box = pythonHome('new');
  const { caps, logs, calls } = await offered(box);
  assert.deepEqual(caps, ['tool-update-python-v1']);
  assert.deepEqual(logs, []);
  // pyenv and uv asked as the recipe asks them: pyenv global, then ~/.local/bin/uv python dir --no-config.
  const asked = calls.filter((c) => c.cmd !== 'systemctl');
  assert.deepEqual(asked.map((c) => [c.cmd, ...c.args]), [
    [path.join(box.home, '.pyenv/bin/pyenv'), 'global'],
    [path.join(box.home, '.local/bin/uv'), 'python', 'dir', '--no-config'],
  ]);
  for (const c of asked) assert.ok(c.opts.timeout > 0, 'bounded');
  // XDG_DATA_HOME moves uv's directory for the recipe too: kept.
  const xdg = mkTmp('tu-xdg-');
  const moved = pythonHome('new', { uvDir: path.join(xdg, 'uv/python') });
  assert.deepEqual((await offered(moved, { XDG_DATA_HOME: xdg })).caps, ['tool-update-python-v1']);
  // A comment and blank lines before the version, as pyenv's version file allows.
  fs.writeFileSync(path.join(box.home, '.pyenv/version'), '# set by the bake\n\n3.13.18\n');
  assert.deepEqual((await offered(box)).caps, ['tool-update-python-v1']);
});

test('Python\'s probe runs uv in the recipe\'s environment: an inherited UV_PYTHON_INSTALL_DIR does not move uv\'s directory', async () => {
  // The recipe unsets every UV_ variable, so it updates the default directory's Python.
  const box = pythonHome('new');
  const elsewhere = mkTmp('tu-uvdir-');
  const r = await offered(box, { UV_PYTHON_INSTALL_DIR: elsewhere, UV_PYTHON_INSTALL_MIRROR: 'https://mirror.example.test', PYENV_VERSION: '3.12.0' });
  assert.deepEqual(r.caps, ['tool-update-python-v1']);
  assert.equal(fs.readFileSync(path.join(box.home, '.seen-uv-env'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(box.home, '.pyenv/.seen-pyenv-version'), 'utf8'), '\n');
  const env = pythonRecipeEnv({ PATH: '/usr/bin', UV_CACHE_DIR: '/c', PYTHONPATH: '/p', XDG_DATA_HOME: '/x', LANG: 'C.UTF-8' }, '/home/ada');
  assert.deepEqual(env, { PATH: '/home/ada/.local/bin:/usr/bin:/usr/local/bin:/usr/bin:/bin', XDG_DATA_HOME: '/x', LANG: 'C.UTF-8', HOME: '/home/ada', PYENV_ROOT: '/home/ada/.pyenv' });
  assert.equal(pythonRecipeEnv({ PYENV_ROOT: '/opt/pyenv' }, '/home/ada').PYENV_ROOT, '/opt/pyenv');
});

test('Python\'s probe reads pyenv\'s global as pyenv does: version, then global, then default', async () => {
  assert.deepEqual((await offered(pythonHome('new', { file: 'global' }))).caps, ['tool-update-python-v1']);
  assert.deepEqual((await offered(pythonHome('new', { file: 'default' }))).caps, ['tool-update-python-v1']);
  // version wins over the fallbacks.
  const box = pythonHome('new');
  fs.writeFileSync(path.join(box.home, '.pyenv/global'), '3.13\n');
  assert.deepEqual((await offered(box)).caps, ['tool-update-python-v1']);
  // None of the three: system, not offered.
  const none = await offered(pythonHome('new', { global: null }));
  assert.deepEqual(none.caps, []);
  assert.match(none.logs.join('\n'), /python not offered: pyenv global "system" is not an x\.y\.z/);
});

test('Python is not offered on the old image\'s layout, nor on system', async () => {
  // pyenv global 3.13: the bare minor the old bake set.
  let r = await offered(pythonHome('old'));
  assert.deepEqual(r.caps, []);
  assert.match(r.logs.join('\n'), /python not offered: pyenv global "3\.13" is not an x\.y\.z/);
  assert.equal(r.calls.some((c) => c.cmd.endsWith('/uv')), false, 'uv is not even asked');
  // An x.y.z, but a real directory pyenv built, not uv's.
  r = await offered(pythonHome('old', { global: '3.13.15' }));
  assert.deepEqual(r.caps, []);
  assert.match(r.logs.join('\n'), /pyenv's 3\.13\.15 is .*versions\/3\.13\.15, not in uv's .* \(pyenv-built\)/);
  r = await offered(pythonHome('new', { global: 'system' }));
  assert.deepEqual(r.caps, []);
  // An x.y.z that names no version at all: not offered, never thrown.
  r = await offered(pythonHome('new', { global: '3.13.99' }));
  assert.deepEqual(r.caps, []);
  assert.match(r.logs.join('\n'), /could not read the layout: ENOENT/);
  // pyenv or uv that will not answer: not offered, never thrown.
  const box = pythonHome('new');
  fs.writeFileSync(path.join(box.home, '.local/bin/uv'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  assert.deepEqual((await offered(box)).caps, []);
  const noPyenv = pythonHome('new');
  fs.rmSync(path.join(noPyenv.home, '.pyenv/bin/pyenv'));
  r = await offered(noPyenv);
  assert.deepEqual(r.caps, []);
  assert.match(r.logs.join('\n'), /pyenv global did not answer: ENOENT/);
  assert.equal(typeof await pythonLayout(async () => { throw new Error('boom'); }, { home: box.home }), 'string');
  // A link out of uv's directory, to a cpython-looking directory elsewhere.
  const elsewhere = pythonHome('new');
  const other = mkTmp('tu-other-');
  fs.mkdirSync(path.join(other, 'cpython-3.13.18-x86_64-linux-gnu'));
  fs.rmSync(path.join(elsewhere.home, '.pyenv/versions/3.13.18'));
  fs.symlinkSync(path.join(other, 'cpython-3.13.18-x86_64-linux-gnu'), path.join(elsewhere.home, '.pyenv/versions/3.13.18'));
  assert.deepEqual((await offered(elsewhere)).caps, []);
  // Only Python's capability goes: the other units still announce theirs.
  const old = pythonHome('old');
  const all = fakeExec(async (cmd, args, opts) => (cmd === 'systemctl' ? { stdout: 'loaded\n' } : realExec(cmd, args, opts)));
  const checks = { python: (exec, o) => pythonLayout(exec, { ...o, env: agentEnv(old.home) }) };
  const got = await loadedComponents(all.exec, { home: old.home, exists: () => true, checks, log: () => {} });
  assert.equal(got.includes('python'), false);
  assert.ok(got.includes('claude') && got.includes('node'));
});
