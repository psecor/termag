'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isRunnerSessionName, orderFromRunnerSession, runnerBaseDir, runnerProjectDirs, tmuxSafe, tmuxUnsafe } = require('./runner-sessions');

test('runner session names: this user\'s, with the backend\'s escaping; not a project pane, not another user', () => {
  assert.equal(isRunnerSessionName('termag-claude-runner-s2-6389d265-4c81-53f0-8bd0-2fa7e1a303dc-r', 'termag'), true);
  assert.equal(isRunnerSessionName('a_db-claude-runner-s3-ord_d1-r', 'a.b'), true);
  assert.equal(isRunnerSessionName('termag-webapp-agent', 'termag'), false);
  assert.equal(isRunnerSessionName('other-claude-runner-s2-x-r', 'termag'), false);
  assert.equal(isRunnerSessionName('termag-claude-runner-sx-x-r', 'termag'), false);
  assert.equal(isRunnerSessionName('', 'termag'), false);
});

test('the order id comes back out of the name, with the backend\'s escaping undone', () => {
  for (const order of ['6389d265-4c81-53f0-8bd0-2fa7e1a303dc', 'a.b', 'a_b', 'a_d', 'x__y.z']) {
    assert.equal(tmuxUnsafe(tmuxSafe(order)), order);
    assert.equal(orderFromRunnerSession(`termag-claude-runner-s2-${tmuxSafe(order)}-r`, 'termag'), order);
  }
  assert.equal(orderFromRunnerSession('termag-webapp-agent', 'termag'), null);
});

test('the base dir is <root>/sessions/<order>, ~/ccr by default: the pane cwd is the state dir, never the checkout', () => {
  assert.equal(runnerBaseDir('/home/t', 'ord-1'), '/home/t/ccr/sessions/ord-1');
  assert.equal(runnerBaseDir('/home/t', 'ord-1', '/data/ccr'), '/data/ccr/sessions/ord-1');
  assert.equal(runnerBaseDir('/home/t', null), null);
});

test('project dirs: one per session config under _sessions, named by the checkout\'s encoded path', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const checkout = path.join(base, 'example-org', 'webapp');
  assert.deepEqual(await runnerProjectDirs(base), []);
  assert.deepEqual(await runnerProjectDirs(null), []);
  fs.mkdirSync(path.join(base, '_sessions', 'cse_01A.claude-config', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(base, '_sessions', 'cse_01A'), { recursive: true });
  const dirs = await runnerProjectDirs(base);
  assert.deepEqual(dirs, [path.join(base, '_sessions', 'cse_01A.claude-config', 'projects', checkout.replace(/[/.]/g, '-'))]);
  fs.rmSync(base, { recursive: true, force: true });
});
