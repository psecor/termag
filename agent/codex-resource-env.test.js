'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { codexResourceEnv, spawnEnv, withoutResourceEnv, codexBridgeEnv } = require('./codex-resource-env');

test('names the pair when the RPC carries both as ids', () => {
  assert.deepEqual(
    codexResourceEnv({ sessionName: 'ada-research-agent', cwd: '/x', project: 'research', workstream: 'main' }),
    { TERMAG_PROJECT: 'research', TERMAG_WORKSTREAM: 'main' },
  );
  assert.deepEqual(
    codexResourceEnv({ project: 'webapp', workstream: 'feature_x-2' }),
    { TERMAG_PROJECT: 'webapp', TERMAG_WORKSTREAM: 'feature_x-2' },
  );
});

test('is empty for an older orchestrator that sends neither, and for one of the two', () => {
  assert.deepEqual(codexResourceEnv({ sessionName: 'ada-research-agent', cwd: '/x' }), {});
  assert.deepEqual(codexResourceEnv({ project: 'research' }), {});
  assert.deepEqual(codexResourceEnv({ workstream: 'main' }), {});
  assert.deepEqual(codexResourceEnv(undefined), {});
});

test('drops the pair, not the launch, on anything that is not an id', () => {
  for (const bad of ['a b', 'x;rm', 'é', '', 'a'.repeat(65), 'a,b=c', 42, null]) {
    assert.deepEqual(codexResourceEnv({ project: bad, workstream: 'main' }), {}, String(bad));
    assert.deepEqual(codexResourceEnv({ project: 'research', workstream: bad }), {}, String(bad));
  }
});

test('withoutResourceEnv takes only the pair out of a copy', () => {
  const env = { PATH: '/bin', TERMAG_PROJECT: 'old', TERMAG_WORKSTREAM: 'old', TERMAG_STATUS_BEARER_TOKEN: 't' };
  assert.deepEqual(withoutResourceEnv(env), { PATH: '/bin', TERMAG_STATUS_BEARER_TOKEN: 't' });
  assert.equal(env.TERMAG_PROJECT, 'old');
});

test('codexBridgeEnv: the session pair and kind interactive, over whatever the agent inherited', () => {
  const env = { PATH: '/bin', TERMAG_PROJECT: 'old', TERMAG_WORKSTREAM: 'old', TERMAG_SESSION_KIND: 'ask' };
  assert.deepEqual(codexBridgeEnv(env, { TERMAG_PROJECT: 'research', TERMAG_WORKSTREAM: 'main' }),
    { PATH: '/bin', TERMAG_PROJECT: 'research', TERMAG_WORKSTREAM: 'main', TERMAG_SESSION_KIND: 'interactive' });
  assert.deepEqual(codexBridgeEnv(env), { PATH: '/bin', TERMAG_SESSION_KIND: 'interactive' });
});

test("names a spawned workstream's spawn as TERMAG_SPAWN_*, beside the pair or without it", () => {
  const spawn = { id: 'ckspawn0001', root: 'ckroot00001', depth: 2, parentProject: 'termag', parentWorkstream: 'main', parentBox: 'box00001' };
  const env = {
    TERMAG_SPAWN_ID: 'ckspawn0001', TERMAG_SPAWN_ROOT: 'ckroot00001', TERMAG_SPAWN_DEPTH: '2',
    TERMAG_SPAWN_PARENT_PROJECT: 'termag', TERMAG_SPAWN_PARENT_WORKSTREAM: 'main', TERMAG_SPAWN_PARENT_BOX: 'box00001',
  };
  assert.deepEqual(codexResourceEnv({ project: 'research', workstream: 'main', spawn }),
    { TERMAG_PROJECT: 'research', TERMAG_WORKSTREAM: 'main', ...env });
  assert.deepEqual(codexResourceEnv({ spawn }), env);
});

test('spawnEnv drops each bad value on its own, and everything without a good id', () => {
  assert.deepEqual(spawnEnv(undefined), {});
  assert.deepEqual(spawnEnv({ id: 'short' }), {});
  assert.deepEqual(spawnEnv({ id: 'x;rm -rf /', root: 'ckroot00001' }), {});
  assert.deepEqual(spawnEnv({ id: 'ckspawn0001', root: 'BAD ROOT', depth: 0, parentProject: 'a b', parentWorkstream: 'main', parentBox: 'x' }),
    { TERMAG_SPAWN_ID: 'ckspawn0001' });
  assert.deepEqual(spawnEnv({ id: 'ckspawn0001', depth: '2', parentProject: 'termag' }), { TERMAG_SPAWN_ID: 'ckspawn0001' });
});

test('withoutResourceEnv takes an inherited spawn out too', () => {
  assert.deepEqual(withoutResourceEnv({ PATH: '/bin', TERMAG_SPAWN_ID: 'old', TERMAG_SPAWN_PARENT_BOX: 'old' }), { PATH: '/bin' });
});
