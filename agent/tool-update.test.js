'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES, COMPONENT_CAPABILITIES, TOOL_UNITS, ROOT_HELPERS, instanceUnit, loadedComponents, capabilities, startToolUpdate } = require('./tool-update');

const RUN = 'cmvtqfadd05j1afsfd7mb5zz2';

// A fake execFile that records calls and answers from a function.
function fakeExec(answer) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answer(cmd, args);
  };
  return { exec, calls };
}

test('the capability is tool-update-v1, and claude and codex map to their template units', () => {
  assert.deepEqual(CAPABILITIES, ['tool-update-v1']);
  assert.deepEqual(TOOL_UNITS, { claude: 'termag-claude-update@.service', codex: 'termag-codex-update@.service', cursor: 'termag-cursor-update@.service', devin: 'termag-devin-update@.service', pi: 'termag-pi-update@.service', gh: 'termag-gh-update@.service', aws: 'termag-aws-update@.service', node: 'termag-node-update@.service' });
  assert.deepEqual(COMPONENT_CAPABILITIES, { claude: 'tool-update-v1', codex: 'tool-update-codex-v1', cursor: 'tool-update-cursor-v1', devin: 'tool-update-devin-v1', pi: 'tool-update-pi-v1', gh: 'tool-update-gh-v1', aws: 'tool-update-aws-v1', node: 'tool-update-node-v1' });
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
  assert.deepEqual(await loadedComponents(codexOnly.exec), ['codex']);
  assert.deepEqual(codexOnly.calls.map((c) => c.args[5]), ['termag-claude-update@probe.service', 'termag-codex-update@probe.service', 'termag-cursor-update@probe.service', 'termag-devin-update@probe.service', 'termag-pi-update@probe.service', 'termag-gh-update@probe.service', 'termag-aws-update@probe.service', 'termag-node-update@probe.service']);
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
