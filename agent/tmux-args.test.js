'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { sendKeysArgv, enterArgv, captureArgv, parseForeground, newSessionArgv, newSessionOptionArgvs, attachSessionArgv, mouseOptionArgv, tmuxSessionTarget, tmuxPaneTarget } = require('./tmux-args');

test('literal text is passed through untouched — quotes, backslashes, $ and backticks', () => {
  const text = `psql -c "select 1 from users where name='psecor'" \\ $HOME \`x\` don't`;
  assert.deepEqual(sendKeysArgv('u-p-ctrl', text, { literal: true }),
    ['send-keys', '-t', 'u-p-ctrl', '-l', '--', text]);
});

test('text starting with a dash sits after -- so tmux does not parse it as an option', () => {
  assert.deepEqual(sendKeysArgv('s', '-n foo', { literal: true }), ['send-keys', '-t', 's', '-l', '--', '-n foo']);
  assert.deepEqual(sendKeysArgv('s', '-n foo'), ['send-keys', '-t', 's', '--', '-n foo']);
});

test('foreground: a dead pane can still be named claude, and an old line has no dead flag', () => {
  assert.deepEqual(parseForeground('0 claude\n'), { cmd: 'claude', dead: false });
  assert.deepEqual(parseForeground('1 claude'), { cmd: 'claude', dead: true });
  assert.deepEqual(parseForeground('0 zsh'), { cmd: 'zsh', dead: false });
  assert.deepEqual(parseForeground('0 '), { cmd: null, dead: false });
  assert.deepEqual(parseForeground('claude'), { cmd: 'claude', dead: false });
  assert.deepEqual(parseForeground(''), { cmd: null, dead: false });
});

test('literal + Enter needs two invocations; key-name mode rides Enter along', () => {
  assert.deepEqual(sendKeysArgv('s', 'ls', { literal: true, withEnter: true }), ['send-keys', '-t', 's', '-l', '--', 'ls']);
  assert.deepEqual(enterArgv('s'), ['send-keys', '-t', 's', 'Enter']);
  assert.deepEqual(sendKeysArgv('s', 'C-c', { withEnter: true }), ['send-keys', '-t', 's', '--', 'C-c', 'Enter']);
  assert.deepEqual(sendKeysArgv('s', 'C-c'), ['send-keys', '-t', 's', '--', 'C-c']);
});

test('capture: default plain 200 lines; styled adds -e', () => {
  assert.deepEqual(captureArgv('s'), ['capture-pane', '-t', 's', '-p', '-S', '-200']);
  assert.deepEqual(captureArgv('s', { lines: 50, styled: true }), ['capture-pane', '-t', 's', '-p', '-e', '-S', '-50']);
});

test('exact targets get the = prefix so tmux never prefix-matches a longer name', () => {
  assert.equal(tmuxSessionTarget('u-x-1'), 'u-x-1');
  assert.equal(tmuxSessionTarget('u-x-1', true), '=u-x-1');
  // Pane and window commands need the session qualified: `=name:`.
  assert.equal(tmuxPaneTarget('u-x-1', true), '=u-x-1:');
  assert.equal(tmuxPaneTarget('u-x-1'), 'u-x-1');
});

test('new-session: a login shell by default; with a command, that argv after `--`, no shell', () => {
  assert.deepEqual(newSessionArgv('s', '/w'), ['new-session', '-d', '-s', 's', '-c', '/w', '-x', '120', '-y', '30']);
  assert.deepEqual(
    newSessionArgv('s', '/w', ['/home/u/.local/bin/termag-claude-runner', 'ord.1', '2']),
    ['new-session', '-d', '-s', 's', '-c', '/w', '-x', '120', '-y', '30', '--', '/home/u/.local/bin/termag-claude-runner', 'ord.1', '2'],
  );
});

test('new-session carries TERMAG_BOX from the agent environment as -e, before --; absent or empty is omitted', () => {
  assert.deepEqual(
    newSessionArgv('s', '/w', null, { TERMAG_BOX: '1', PATH: '/usr/bin' }),
    ['new-session', '-d', '-s', 's', '-c', '/w', '-x', '120', '-y', '30', '-e', 'TERMAG_BOX=1'],
  );
  assert.deepEqual(
    newSessionArgv('s', '/w', ['/home/u/.local/bin/termag-claude-runner', 'ord.1', '2'], { TERMAG_BOX: '1' }),
    ['new-session', '-d', '-s', 's', '-c', '/w', '-x', '120', '-y', '30', '-e', 'TERMAG_BOX=1', '--', '/home/u/.local/bin/termag-claude-runner', 'ord.1', '2'],
  );
  assert.deepEqual(newSessionArgv('s', '/w', null, { PATH: '/usr/bin' }), newSessionArgv('s', '/w'));
  assert.deepEqual(newSessionArgv('s', '/w', null, { TERMAG_BOX: '' }), newSessionArgv('s', '/w'));
});

function hasTmux() {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('new-session options apply on a real tmux server (a bare `=name` target fails set-option)', { skip: !hasTmux() && 'tmux not installed' }, () => {
  const socket = ['-L', `termag-test-${process.pid}`];
  const tmux = (...argv) => execFileSync('tmux', [...socket, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    tmux(...newSessionArgv('u-p-agent', process.cwd()));
    for (const argv of newSessionOptionArgvs('u-p-agent')) tmux(...argv);
    assert.equal(tmux('show-options', '-t', '=u-p-agent:', '-v', 'history-limit').trim(), '10000');
  } finally {
    try { tmux('kill-server'); } catch { /* already gone */ }
  }
});

test('-e reaches a session on a server that already exists without the variable', { skip: !hasTmux() && 'tmux not installed' }, () => {
  const socket = ['-L', `termag-test-env-${process.pid}`];
  const env = { ...process.env };
  delete env.TERMAG_BOX;
  const tmux = (...argv) => execFileSync('tmux', [...socket, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
  try {
    // The server comes up with the first session, from an environment without
    // the variable: show-environment then knows nothing of it (exit 1).
    tmux(...newSessionArgv('u-old-agent', process.cwd()));
    assert.throws(() => tmux('show-environment', '-t', '=u-old-agent', 'TERMAG_BOX'), /unknown variable/);
    // A later session on that surviving server gets it from -e.
    tmux(...newSessionArgv('u-new-agent', process.cwd(), null, { TERMAG_BOX: '1' }));
    assert.equal(tmux('show-environment', '-t', '=u-new-agent', 'TERMAG_BOX').trim(), 'TERMAG_BOX=1');
  } finally {
    try { tmux('kill-server'); } catch { /* already gone */ }
  }
});

test('terminal attach and its mouse toggle name the session exactly', () => {
  assert.deepEqual(attachSessionArgv('u-p-agent'), ['attach-session', '-t', '=u-p-agent']);
  assert.deepEqual(mouseOptionArgv('u-p-agent', true), ['set-option', '-t', '=u-p-agent:', 'mouse', 'on']);
  assert.deepEqual(mouseOptionArgv('u-p-agent', false), ['set-option', '-t', '=u-p-agent:', 'mouse', 'off']);
});

test('the attach target is no pattern or prefix on a real tmux server', { skip: !hasTmux() && 'tmux not installed' }, () => {
  const socket = ['-L', `termag-test-attach-${process.pid}`];
  const tmux = (...argv) => execFileSync('tmux', [...socket, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // has-session takes a session target like attach-session's, without needing a terminal.
  const reaches = (name) => { try { tmux('has-session', '-t', attachSessionArgv(name)[2]); return true; } catch { return false; } };
  try {
    for (const s of ['u-p-agent', 'u-p-secret-ctrl']) tmux(...newSessionArgv(s, process.cwd()));
    // What a bare -t does with these, and what the attach no longer does.
    tmux('has-session', '-t', 'u-p-secret?ctrl');
    tmux('has-session', '-t', 'u-p-a');
    assert.equal(reaches('u-p-secret?ctrl'), false);
    assert.equal(reaches('u-p-a'), false);
    assert.equal(reaches('u-p-secret-ctrl'), true);
    tmux(...mouseOptionArgv('u-p-agent', true));
    tmux(...mouseOptionArgv('u-p-secret-ctrl', false));
    assert.equal(tmux('show-options', '-t', '=u-p-agent:', '-v', 'mouse').trim(), 'on');
    assert.equal(tmux('show-options', '-t', '=u-p-secret-ctrl:', '-v', 'mouse').trim(), 'off');
  } finally {
    try { tmux('kill-server'); } catch { /* already gone */ }
  }
});

test('tailLines returns the last n non-blank lines, not scrollback + the whole pane', () => {
  const { tailLines } = require('./tmux-args');
  const pane = ['old quote: usage limit reached', '', 'a', 'b', '', 'c', 'd', '', ''].join('\n');
  assert.equal(tailLines(pane, 3), 'b\nc\nd');
  assert.equal(tailLines(pane, 10), 'old quote: usage limit reached\na\nb\nc\nd');
  assert.equal(tailLines('', 5), '');
});
