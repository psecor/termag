'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planOnClaim, renderOnClaimEnv, createStatusForwarder } = require('./on-claim');

test('renderOnClaimEnv quotes the owner and the repo and carries no token', () => {
  const env = renderOnClaimEnv({
    dotfilesRepoUrl: 'https://github.com/ada/dotfiles',
    ownerName: "Ada O'Neil",
    ownerEmail: 'ada@example.com',
  });
  assert.equal(env.includes('TERMAG_GITHUB_TOKEN'), false);
  assert.equal(env.includes('githubToken'), false);
  assert.match(env, /TERMAG_DOTFILES_REPO_URL='https:\/\/github.com\/ada\/dotfiles'/);
  assert.match(env, /TERMAG_OWNER_NAME='Ada O'\\''Neil'/);
});

test('renderOnClaimEnv omits the repo line when there is none', () => {
  const env = renderOnClaimEnv({
    dotfilesRepoUrl: null,
    ownerName: 'Ada',
    ownerEmail: 'ada@example.com',
  });
  assert.equal(env.includes('TERMAG_DOTFILES_REPO_URL'), false);
});

test('planOnClaim starts only when there is work and nothing has finished', () => {
  assert.deepEqual(planOnClaim({ unitState: 'inactive', hasWork: false }), { write: false, start: false });
  assert.deepEqual(planOnClaim({ unitState: 'inactive', hasWork: true }), { write: true, start: true });
  assert.deepEqual(
    planOnClaim({ unitState: 'inactive', hasWork: true, existingState: 'skipped' }),
    { write: false, start: false },
  );
  assert.deepEqual(
    planOnClaim({ unitState: 'active', hasWork: true }),
    { write: false, start: false },
  );
});

// A socket and a status file the test controls.
function harness(initial) {
  const state = { file: initial, open: true, sent: [] };
  const forwarder = () => createStatusForwarder({
    read: () => { if (state.file === null) throw new Error('ENOENT'); return state.file; },
    send: (frame) => state.sent.push(frame),
    isOpen: () => state.open,
  });
  return { state, forwarder };
}
const status = (obj) => JSON.stringify(obj);

test('forwarder sends each new status once, typed as on-claim-status', () => {
  const { state, forwarder } = harness(status({ state: 'running' }));
  const f = forwarder();
  f.tick(); f.tick();
  state.file = status({ state: 'succeeded' });
  f.tick();
  assert.deepEqual(state.sent, [
    { state: 'running', type: 'on-claim-status' },
    { state: 'succeeded', type: 'on-claim-status' },
  ]);
});

test('a change while the socket is closed is not marked sent, and goes out once it is open', () => {
  const { state, forwarder } = harness(status({ state: 'running' }));
  const f = forwarder();
  f.tick();
  state.open = false;
  state.file = status({ state: 'succeeded' });
  f.tick();
  state.open = true;
  f.tick();
  assert.deepEqual(state.sent.map(s => s.state), ['running', 'succeeded']);
});

test('a run that finished while disconnected reaches the next socket', () => {
  const { state, forwarder } = harness(status({ state: 'running' }));
  forwarder().tick();
  state.file = status({ state: 'skipped', reason: 'needs-auth' });
  // The old socket is gone; the reconnect builds a fresh forwarder.
  forwarder().tick();
  assert.deepEqual(state.sent.map(s => s.state), ['running', 'skipped']);
});

test('a rerun of the claim hook, long after the run ended, is forwarded', () => {
  const { state, forwarder } = harness(status({ state: 'skipped', reason: 'needs-auth' }));
  const f = forwarder();
  f.tick();
  for (let i = 0; i < 5; i++) f.tick();
  state.file = status({ state: 'succeeded' });
  f.tick();
  assert.deepEqual(state.sent.map(s => s.state), ['skipped', 'succeeded']);
});

test('forwarder sends nothing without a status file, and ignores one it cannot parse', () => {
  const { state, forwarder } = harness(null);
  const f = forwarder();
  f.tick();
  state.file = '{"state": "runn';
  f.tick();
  state.file = '[1,2]';
  f.tick();
  assert.deepEqual(state.sent, []);
});

test('a status file cannot redirect the frame with its own type', () => {
  const { state, forwarder } = harness(status({ state: 'running', type: 'terminal-data' }));
  forwarder().tick();
  assert.equal(state.sent[0].type, 'on-claim-status');
});

test('agent.js arms a forwarder per socket, disarms it on close, and reports it to box-claim', () => {
  const src = fs.readFileSync(path.join(__dirname, 'agent.js'), 'utf8');
  const onOpen = src.slice(src.indexOf("ws.on('open'"), src.indexOf("ws.on('message'"));
  const onClose = src.slice(src.indexOf("ws.on('close'"));
  assert.match(onOpen, /startOnClaimForwarder\(ws\)/);
  assert.match(onClose.slice(0, 2000), /stopOnClaimForwarder\(\)/);
  assert.match(src, /respond\(ws, requestId, \{ ok: true, reportsOnClaim: Boolean\(dotfilesRepoUrl\) \}\)/);
  assert.equal(/startOnClaimPoller|maybeResumeOnClaim/.test(src), false);
});
