'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES, createSpaceSync } = require('./space-sync');

const ANSWER = { root: '/home/u/termag/spaces', default: 'team', spaces: [{ kind: 'synced', space: 'team', files: 3 }], removed: [] };

/** A stand-in box CLI: records each argv, then answers as `world` says. */
function box(world) {
  const calls = [];
  const execFile = async (bin, argv, opts) => {
    calls.push({ bin, argv, timeout: opts.timeout });
    if (world.fail) throw world.fail;
    return { stdout: `${JSON.stringify(world.answer ?? ANSWER, null, 2)}\n` };
  };
  const fsImpl = { existsSync: p => world.installed !== false && p === '/home/u/.local/bin/termag' };
  return { calls, sync: createSpaceSync({ home: '/home/u', execFile, fsImpl, env: {} }).sync };
}

function exitError(code, { stdout = '', stderr = '' } = {}) {
  return Object.assign(new Error(`Command failed with exit code ${code}`), { code, stdout, stderr });
}

test('announces space-sync-v1', () => {
  assert.deepEqual(CAPABILITIES, ['space-sync-v1']);
});

test('runs the box CLI for every space, or the one named, and answers its JSON', async () => {
  const { calls, sync } = box({});
  assert.deepEqual(await sync({}), ANSWER);
  assert.deepEqual(await sync({ space: 'team' }), ANSWER);
  assert.deepEqual(calls.map(c => [c.bin, c.argv]), [
    ['/home/u/.local/bin/termag', ['space', 'sync', '--json']],
    ['/home/u/.local/bin/termag', ['space', 'sync', 'team', '--json']],
  ]);
  assert.ok(calls[0].timeout < 180_000, 'the CLI gives up before the orchestrator does');
});

test('passes on the answer when one space failed and the CLI exited 1', async () => {
  const partial = { ...ANSWER, spaces: [{ kind: 'failed', space: 'team', error: 'storage answered HTTP 403' }] };
  const { sync } = box({ fail: exitError(1, { stdout: JSON.stringify(partial) }) });
  assert.deepEqual(await sync({}), partial);
});

test('says why when the CLI printed no answer, and when it is too old to copy spaces', async () => {
  const unreachable = box({ fail: exitError(1, { stderr: "termag: Can't reach the orchestrator\nmore" }) });
  await assert.rejects(unreachable.sync({}), { message: "termag: Can't reach the orchestrator" });
  // With --json the CLI writes its failure as JSON.
  const unreached = box({ fail: exitError(3, { stderr: JSON.stringify({ error: { code: 'not_found', message: "You don't reach nope" } }) }) });
  await assert.rejects(unreached.sync({ space: 'nope' }), { message: "You don't reach nope" });
  const old = box({ fail: exitError(2, { stderr: 'termag: Unknown command space sync' }) });
  await assert.rejects(old.sync({}), /can't copy spaces yet \(termag: Unknown command space sync\)/);
  await assert.rejects(box({ installed: false }).sync({}), /no \/home\/u\/\.local\/bin\/termag/);
});

test('refuses a space that is not a space name, without running anything', async () => {
  const { calls, sync } = box({});
  for (const space of ['../x', 'A', '--json', 7]) {
    await assert.rejects(sync({ space }), /space must be a space name/);
  }
  assert.equal(calls.length, 0);
});
