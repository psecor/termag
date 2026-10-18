'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES, BOX_UPDATE_UNIT, readCheckoutCommit, readCheckoutCommitDate, boxUpdateUnitLoaded, startBoxUpdate } = require('./box-update');

const SHA = 'a3f1c2d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c0';

// A fake execFile that records calls and answers from a table.
function fakeExec(answer) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answer(cmd, args);
  };
  return { exec, calls };
}

test('the agent announces the box-update capability', () => {
  assert.deepEqual(CAPABILITIES, ['box-update-v1']);
});

const CHECKOUT = '/home/ada/src/termag';
const same = (p) => p;

test('readCheckoutCommit asks git for the top level and HEAD of the checkout and returns the full sha', async () => {
  const { exec, calls } = fakeExec(async () => ({ stdout: `${CHECKOUT}\n${SHA}\n` }));
  assert.equal(await readCheckoutCommit(exec, CHECKOUT, same), SHA);
  assert.deepEqual(calls[0].args, ['-C', CHECKOUT, 'rev-parse', '--show-toplevel', 'HEAD']);
  assert.equal(calls[0].cmd, 'git');
  assert.ok(calls[0].opts.timeout > 0, 'bounded');
});

test('readCheckoutCommit compares the top level after resolving symlinks in the checkout path', async () => {
  const { exec } = fakeExec(async () => ({ stdout: `/data/home/ada/src/termag\n${SHA}\n` }));
  assert.equal(await readCheckoutCommit(exec, CHECKOUT, () => '/data/home/ada/src/termag'), SHA);
  // A realpath that fails (the directory is gone) falls back to the path as given.
  assert.equal(await readCheckoutCommit(exec, '/data/home/ada/src/termag', () => { throw new Error('ENOENT'); }), SHA);
});

test('readCheckoutCommit is null for an enclosing, unrelated repository', async () => {
  // An agent copied to /home/ada/project/vendor/termag/agent inside /home/ada/project's repository.
  const { exec } = fakeExec(async () => ({ stdout: `/home/ada/project\n${SHA}\n` }));
  assert.equal(await readCheckoutCommit(exec, '/home/ada/project/vendor/termag', same), null);
});

test('readCheckoutCommit is null outside a checkout, for garbage, and when git is missing', async () => {
  assert.equal(await readCheckoutCommit(fakeExec(async () => { throw new Error('not a git repository'); }).exec, '/x', same), null);
  assert.equal(await readCheckoutCommit(fakeExec(async () => ({ stdout: '/x\nHEAD\n' })).exec, '/x', same), null);
  assert.equal(await readCheckoutCommit(fakeExec(async () => ({ stdout: `/x\n${SHA.slice(0, 12)}\n` })).exec, '/x', same), null);
  assert.equal(await readCheckoutCommit(fakeExec(async () => ({ stdout: '/x\n' })).exec, '/x', same), null);
  assert.equal(await readCheckoutCommit(fakeExec(async () => { const e = new Error('spawn git ENOENT'); e.code = 'ENOENT'; throw e; }).exec, '/x', same), null);
});

test('boxUpdateUnitLoaded is true only when systemd has the unit', async () => {
  const loaded = fakeExec(async () => ({ stdout: 'loaded\n' }));
  assert.equal(await boxUpdateUnitLoaded(loaded.exec), true);
  assert.deepEqual(loaded.calls[0].args, ['--user', 'show', '-p', 'LoadState', '--value', 'termag-box-update.service']);
  assert.equal(loaded.calls[0].cmd, 'systemctl');
  assert.ok(loaded.calls[0].opts.timeout > 0, 'bounded');
  assert.equal(await boxUpdateUnitLoaded(fakeExec(async () => ({ stdout: 'not-found\n' })).exec), false);
  assert.equal(await boxUpdateUnitLoaded(fakeExec(async () => ({ stdout: '' })).exec), false);
  assert.equal(await boxUpdateUnitLoaded(fakeExec(async () => { throw new Error('Failed to connect to bus'); }).exec), false);
});

test('startBoxUpdate starts the unit without blocking and says so', async () => {
  const { exec, calls } = fakeExec(async () => ({ stdout: '' }));
  assert.deepEqual(await startBoxUpdate(exec), { ok: true, started: true, unit: BOX_UPDATE_UNIT });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'systemctl');
  assert.deepEqual(calls[0].args, ['--user', 'start', '--no-block', 'termag-box-update.service']);
  assert.ok(calls[0].opts.timeout > 0, 'bounded');
});

test('a box without the unit yet gets a clear error, other failures the last systemctl line', async () => {
  const missing = fakeExec(async () => {
    const e = new Error('Command failed: systemctl');
    e.stderr = 'Failed to start termag-box-update.service: Unit termag-box-update.service not found.\n';
    throw e;
  });
  await assert.rejects(startBoxUpdate(missing.exec), /termag-box-update\.service is not installed on this box; run termag-reconcile/);

  const other = fakeExec(async () => {
    const e = new Error('Command failed: systemctl');
    e.stderr = 'Failed to connect to bus: No medium found\n';
    throw e;
  });
  await assert.rejects(startBoxUpdate(other.exec), /could not start termag-box-update\.service: Failed to connect to bus: No medium found/);

  const bare = fakeExec(async () => { throw new Error('spawn systemctl ENOENT'); });
  await assert.rejects(startBoxUpdate(bare.exec), /could not start termag-box-update\.service: spawn systemctl ENOENT/);
});

test('readCheckoutCommitDate asks git for the committer date of HEAD and returns it as ISO 8601, null otherwise', async () => {
  const { exec, calls } = fakeExec(async () => ({ stdout: '2026-10-09T22:04:03-07:00\n' }));
  assert.equal(await readCheckoutCommitDate(exec, CHECKOUT), '2026-10-09T22:04:03-07:00');
  assert.deepEqual(calls[0].args, ['-C', CHECKOUT, 'show', '-s', '--format=%cI', 'HEAD']);
  const bad = fakeExec(async () => ({ stdout: 'fatal: not a git repository\n' }));
  assert.equal(await readCheckoutCommitDate(bad.exec, CHECKOUT), null);
  const thrown = fakeExec(async () => { throw new Error('ENOENT'); });
  assert.equal(await readCheckoutCommitDate(thrown.exec, CHECKOUT), null);
});
