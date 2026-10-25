'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { codexResourceEnv, withoutResourceEnv } = require('./codex-resource-env');

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
