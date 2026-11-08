'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codexPaneCommand, isCodexSessionId } = require('./codex-launch');

const ID = '01a18c85-d963-7800-93d4-991c84da09d5';

test('a fresh pane gets the --remote client, as it always has', () => {
  assert.equal(codexPaneCommand({ remoteUrl: 'ws://127.0.0.1:4100', cwd: '/home/ada/web' }),
    "codex --remote ws://127.0.0.1:4100 --no-alt-screen -C '/home/ada/web' -a on-request");
  assert.equal(codexPaneCommand({ remoteUrl: 'ws://127.0.0.1:4100', cwd: "/home/ada/it's" }),
    "codex --remote ws://127.0.0.1:4100 --no-alt-screen -C '/home/ada/it'\\''s' -a on-request");
});

test('a tool update\'s relaunch resumes the conversation by its id, with the same flags', () => {
  assert.equal(codexPaneCommand({ remoteUrl: 'ws://127.0.0.1:4100', cwd: '/home/ada/web', resumeSessionId: ID }),
    `codex resume ${ID} --remote ws://127.0.0.1:4100 --no-alt-screen -C '/home/ada/web' -a on-request`);
});

test('anything but a Codex thread id starts fresh, never reaches the line', () => {
  for (const bad of ['', 'last', '--last', `${ID}; rm -rf ~`, `${ID} x`, ID.slice(1), 7, null, undefined, { id: ID }]) {
    assert.equal(isCodexSessionId(bad), false, String(bad));
    assert.equal(codexPaneCommand({ remoteUrl: 'ws://127.0.0.1:1', cwd: '/w', resumeSessionId: bad }), "codex --remote ws://127.0.0.1:1 --no-alt-screen -C '/w' -a on-request");
  }
  assert.equal(isCodexSessionId(ID.toUpperCase()), true);
});

test('a tool update\'s notice prints once, before the client', () => {
  const notice = '[termag] Codex was updated to 0.130.0 (automatic nightly run); resuming your session.';
  assert.equal(codexPaneCommand({ remoteUrl: 'ws://127.0.0.1:1', cwd: '/w', resumeSessionId: ID, notice }),
    `printf '%s\\n' '${notice}'; codex resume ${ID} --remote ws://127.0.0.1:1 --no-alt-screen -C '/w' -a on-request`);
});

test('a notice that is not safe to type is dropped, and the client starts all the same', () => {
  for (const notice of ["[termag] x'; touch /tmp/pwned; echo '", '[termag] $(id)', '[termag] `id`', '[termag] a\nb', '[termag] a\\b', 'x'.repeat(201), '', 42, {}, null]) {
    assert.equal(codexPaneCommand({ remoteUrl: 'ws://127.0.0.1:1', cwd: '/w', notice }), "codex --remote ws://127.0.0.1:1 --no-alt-screen -C '/w' -a on-request", String(notice));
  }
});
