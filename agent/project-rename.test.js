'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renameProject } = require('./project-rename');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'project-rename-'));
}

function recorder(failFor = new Set()) {
  const calls = [];
  return {
    calls,
    execFile: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (failFor.has(args[2])) throw new Error("can't find session");
    },
  };
}

test('renames each session by exact name and moves the directory', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'projects', 'old'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'old', 'AGENTS.md'), 'x');
  const exec = recorder();
  const result = await renameProject({
    sessions: [{ from: 'u-old-agent', to: 'u-new-agent' }, { from: 'u-old-ctrl', to: 'u-new-ctrl' }],
    fromDir: path.join(root, 'projects', 'old'),
    toDir: path.join(root, 'projects', 'new'),
  }, exec);
  assert.deepEqual(result, { ok: true, renamedSessions: 2, movedDir: true });
  assert.deepEqual(exec.calls, [
    ['tmux', 'rename-session', '-t', '=u-old-agent', '--', 'u-new-agent'],
    ['tmux', 'rename-session', '-t', '=u-old-ctrl', '--', 'u-new-ctrl'],
  ]);
  assert.equal(fs.readFileSync(path.join(root, 'projects', 'new', 'AGENTS.md'), 'utf8'), 'x');
  assert.equal(fs.existsSync(path.join(root, 'projects', 'old')), false);
});

test('skips sessions and a directory that are not there, so a retry converges', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'new'));
  const exec = recorder(new Set(['=gone']));
  const result = await renameProject({
    sessions: [{ from: 'gone', to: 'x' }],
    fromDir: path.join(root, 'old'),
    toDir: path.join(root, 'new'),
  }, exec);
  assert.deepEqual(result, { ok: true, renamedSessions: 0, movedDir: false });
});

test('refuses to move onto an existing directory before renaming anything', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'old'));
  fs.mkdirSync(path.join(root, 'new'));
  const exec = recorder();
  await assert.rejects(renameProject({
    sessions: [{ from: 'a', to: 'b' }],
    fromDir: path.join(root, 'old'),
    toDir: path.join(root, 'new'),
  }, exec), /already exists/);
  assert.deepEqual(exec.calls, []);
  assert.equal(fs.existsSync(path.join(root, 'old')), true);
});

test('repairs worktrees after the move', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'old', '.worktrees', 'feature'), { recursive: true });
  const exec = recorder();
  await renameProject({ sessions: [], fromDir: path.join(root, 'old'), toDir: path.join(root, 'new') }, exec);
  assert.deepEqual(exec.calls, [
    ['git', '-C', path.join(root, 'new'), 'worktree', 'repair', path.join(root, 'new', '.worktrees', 'feature')],
  ]);
});
