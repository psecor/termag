'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { EventEmitter } = require('node:events');
const {
  CAPABILITIES, UPDATE_CAPABILITIES, SESSION_NAME, createT3Bridge, createPinnedInstall, createReleaseInstall, compareVersions, commandFromDropin, resolveT3Command, resolveT3ClaudeCommand, pinClaudeBinary, pinGatewayModels, gatewayModelSlug, parseFireworksParam, piFireworksModelIds, pinFireworksInstance, serverCommandLine, parsePairingOutput, parseThreadOutput, tunnelDialUrl, probeT3,
  descendants, listeningInodes, parseListOutput, staleAuthFor,
} = require('./t3-bridge');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't3-bridge-'));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** A stand-in t3 server: the descriptor on GET, an echo of the request line on anything else. */
function fakeT3(serverVersion = '0.1.1') {
  return http.createServer((req, res) => {
    if (req.url === '/.well-known/t3/environment') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ environmentId: 'env-1', label: 'box', serverVersion }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${req.method} ${req.url} ${req.headers.authorization || '-'} ${body}`);
    });
  });
}

test('advertises t3-v1 and t3-revoke-v1, and t3-update-v1 apart', () => {
  assert.deepEqual(CAPABILITIES, ['t3-v1', 't3-revoke-v1']);
  assert.deepEqual(UPDATE_CAPABILITIES, ['t3-update-v1']);
});

test('resolveT3Command: env over config over t3, only when it resolves, as an absolute path', () => {
  const home = tmpHome();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const t3 = path.join(bin, 't3');
  fs.writeFileSync(t3, '#!/bin/sh\n', { mode: 0o755 });
  const other = path.join(home, 'other-t3');
  fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });
  // The PATH hit, not the name: tmux's PATH is not the agent's.
  assert.equal(resolveT3Command({ env: { PATH: bin } }), t3);
  assert.equal(resolveT3Command({ env: { PATH: '/nowhere' } }), null);
  assert.equal(resolveT3Command({ env: { PATH: '/nowhere', TERMAG_T3_COMMAND: other } }), other);
  assert.equal(resolveT3Command({ env: { PATH: '/nowhere' }, config: { t3Command: other } }), other);
  assert.equal(resolveT3Command({ env: { PATH: bin, TERMAG_T3_COMMAND: path.join(home, 'missing') } }), null);
  const notExec = path.join(home, 'plain');
  fs.writeFileSync(notExec, 'x', { mode: 0o644 });
  assert.equal(resolveT3Command({ env: { PATH: '/nowhere', TERMAG_T3_COMMAND: notExec } }), null);
});

test('gatewayModelSlug: Bedrock ids as t3 slugs, nothing else', () => {
  assert.equal(gatewayModelSlug('us.anthropic.claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(gatewayModelSlug('anthropic.claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(gatewayModelSlug('global.anthropic.claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(gatewayModelSlug('us-gov.anthropic.claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(gatewayModelSlug('-us.anthropic.claude-opus-5-5'), null);
  assert.equal(gatewayModelSlug('us.anthropic.claude-haiku-4-5-20251001-v1:0'), null);
  assert.equal(gatewayModelSlug('claude-opus-5-5'), null);
  assert.equal(gatewayModelSlug(undefined), null);
});

test("pinGatewayModels: a gateway box's t3 defaults to its own models, once, and keeps the app's choice", () => {
  const home = tmpHome();
  const claude = path.join(home, '.claude');
  const t3 = path.join(home, '.t3', 'userdata', 'settings.json');
  fs.mkdirSync(claude, { recursive: true });
  // Not a gateway box: nothing written.
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'us.anthropic.claude-opus-5-5' } }));
  assert.deepEqual(pinGatewayModels(home), []);
  assert.equal(fs.existsSync(t3), false);
  // The gateway: the box's default, and its Sonnet for titles and commit messages.
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ apiKeyHelper: 'x', env: {
    CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'us.anthropic.claude-opus-5-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-5-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  } }));
  fs.mkdirSync(path.dirname(t3), { recursive: true });
  fs.writeFileSync(t3, JSON.stringify({ enableProviderUpdateChecks: false }));
  assert.deepEqual(pinGatewayModels(home), ['defaultModelSelection=claude-opus-5-5', 'textGenerationModelSelection=claude-sonnet-5-5']);
  const written = JSON.parse(fs.readFileSync(t3, 'utf8'));
  assert.deepEqual(written, {
    enableProviderUpdateChecks: false,
    defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
    textGenerationModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' },
  });
  // Already set (by this or by the app): left alone.
  written.defaultModelSelection = { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' };
  fs.writeFileSync(t3, JSON.stringify(written));
  assert.deepEqual(pinGatewayModels(home), []);
  assert.equal(JSON.parse(fs.readFileSync(t3, 'utf8')).defaultModelSelection.model, 'claude-sonnet-5-5');
});

test('serverCommandLine: loopback, the port, state under ~/.t3, analytics off, quoted', () => {
  const line = serverCommandLine({ command: "/opt/t3's/t3", port: 4100, home: '/home/a b' });
  assert.match(line, /^exec env T3CODE_TELEMETRY_ENABLED=false T3CODE_NO_BROWSER=1 TERMAG_T3=1 '/);
  assert.ok(line.includes(`'/opt/t3'\\''s/t3' serve --host 127.0.0.1 --port 4100 --base-dir '/home/a b/.t3'`));
  assert.ok(line.endsWith(`>> '/home/a b/.termag/t3.log' 2>&1`));
});

test('parsePairingOutput: the JSON object, after any logs', () => {
  const out = 'some log line\n{\n  "id": "p1",\n  "credential": "ABCDEF",\n  "expiresAt": "2026-10-21T00:05:00.000Z"\n}\n';
  assert.deepEqual(parsePairingOutput(out), { credential: 'ABCDEF', expiresAt: '2026-10-21T00:05:00.000Z', id: 'p1' });
  assert.deepEqual(parsePairingOutput('{"credential":"X"}'), { credential: 'X', expiresAt: null, id: null });
  assert.throws(() => parsePairingOutput('nothing here'), /no pairing credential/);
  assert.throws(() => parsePairingOutput('{"id":"p1"}'), /no pairing credential/);
});

test('tunnelDialUrl: the agent URL with /ws/agent-tunnel and the id, no token', () => {
  assert.equal(
    tunnelDialUrl('wss://orch.example/termag/ws/agent?token=tmag_x', 'ab'.repeat(32)),
    `wss://orch.example/termag/ws/agent-tunnel?id=${'ab'.repeat(32)}`,
  );
  assert.equal(tunnelDialUrl('ws://127.0.0.1:3041/termag/ws/agent', 'cd'), 'ws://127.0.0.1:3041/termag/ws/agent-tunnel?id=cd');
});

test('probeT3: t3 when the descriptor answers, false for something else, null for nothing', async () => {
  const t3 = fakeT3();
  const t3Port = await listen(t3);
  const other = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  const otherPort = await listen(other);
  const freePort = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  try {
    assert.deepEqual(await probeT3(t3Port), { t3: true, version: '0.1.1' });
    assert.deepEqual(await probeT3(otherPort), { t3: false });
    assert.equal(await probeT3(freePort), null);
  } finally {
    t3.close();
    other.close();
  }
});

/**
 * execFile that runs nothing: records calls, says the tmux session is absent
 * until new-session (or from the start with `session`). The session's pane is
 * this test process, so a server the test runs is the pane's own; `listener`
 * says who lsof finds on a port instead: 'self' (this process), another pid,
 * or 'unknown' (no lsof). `run` answers any command first.
 */
function fakeExec({ onNewSession, beforeKill, onKillSession, session: hasSession = false, run, listener = 'self' } = {}) {
  const calls = [];
  let session = hasSession;
  const execFile = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tmux' && args[0] === 'has-session') { if (!session) throw new Error('no session'); return { stdout: '' }; }
    if (cmd === 'tmux' && args[0] === 'new-session') { session = true; await onNewSession?.(args, opts); return { stdout: '' }; }
    if (cmd === 'tmux' && args[0] === 'kill-session') { await beforeKill?.(); session = false; await onKillSession?.(); return { stdout: '' }; }
    if (run) { const r = await run(cmd, args); if (r !== undefined) return r; }
    if (cmd === 'tmux' && args[0] === 'list-panes') { if (!session) throw new Error('no session'); return { stdout: `${process.pid}\n` }; }
    if (cmd === 'ps') return { stdout: `${process.pid} 1\n` };
    if (cmd === 'lsof') {
      if (listener === 'unknown') throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
      return { stdout: `${listener === 'self' ? process.pid : listener}\n` };
    }
    return { stdout: '' };
  };
  return { execFile, calls };
}

/** fsImpl with no /proc, as on macOS: with no lsof either, nothing can say who listens. */
const noProc = { ...fs, existsSync: (p) => (String(p).startsWith('/proc') ? false : fs.existsSync(p)) };

test('ensure: ready when the termag-t3 pane\'s t3 already answers on the kept port; nothing started', async () => {
  const home = tmpHome();
  const t3 = fakeT3();
  const port = await listen(t3);
  fs.mkdirSync(path.join(home, '.termag'));
  fs.writeFileSync(path.join(home, '.termag', 't3.json'), JSON.stringify({ port }));
  const { execFile, calls } = fakeExec({ session: true });
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  try {
    assert.deepEqual(await bridge.ensure(), { state: 'ready', port, version: '0.1.1', home });
    assert.deepEqual(calls.filter(c => c[1] === 'new-session' || c[1] === 'kill-session'), []);
  } finally { t3.close(); }
});

test('ensure: a t3 answering on the kept port outside the termag-t3 pane is not the server: it moves', async () => {
  // Another local user's process can bind a loopback port and answer as t3;
  // tunnels would hand it the desktop's credentials.
  const home = tmpHome();
  const impostor = fakeT3();
  const taken = await listen(impostor);
  keepPort(home, taken);
  const { execFile, calls } = fakeExec({ session: true, listener: 424242 });
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10 });
  try {
    const state = await bridge.ensure({ waitMs: 30 });
    assert.notEqual(state.port, taken);
    assert.notEqual(state.state, 'ready');
    assert.ok(calls.some(c => c[1] === 'new-session'));
  } finally { impostor.close(); }
});

test('ensure: fails closed when nothing can say who listens on the port', async () => {
  const home = tmpHome();
  const t3 = fakeT3();
  const port = await listen(t3);
  keepPort(home, port);
  const { execFile } = fakeExec({ session: true, listener: 'unknown' });
  const bridge = createT3Bridge({ command: 't3', home, execFile, fsImpl: noProc, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  try {
    await assert.rejects(bridge.ensure({ waitMs: 30 }), /can't tell what listens/);
  } finally { t3.close(); }
});

test('ensure: starts the server in the termag-t3 session on a kept port, then reports ready', async () => {
  const home = tmpHome();
  let t3;
  const { execFile, calls } = fakeExec({
    onNewSession: async (args) => {
      const port = Number(/--port (\d+)/.exec(args.at(-1))[1]);
      t3 = fakeT3();
      await new Promise((r) => t3.listen(port, '127.0.0.1', r));
    },
  });
  const bridge = createT3Bridge({ command: '/opt/t3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 20 });
  try {
    const first = await bridge.ensure();
    assert.equal(first.state, 'ready');
    const kept = JSON.parse(fs.readFileSync(path.join(home, '.termag', 't3.json'), 'utf8'));
    assert.equal(kept.port, first.port);
    const newSession = calls.find(c => c[1] === 'new-session');
    assert.deepEqual(newSession.slice(0, 7), ['tmux', 'new-session', '-d', '-s', SESSION_NAME, '-c', home]);
    // Again: answers from the running server, starts nothing more.
    const again = await bridge.ensure();
    assert.deepEqual(again, first);
    assert.equal(calls.filter(c => c[1] === 'new-session').length, 1);
  } finally { t3?.close(); }
});

test('ensure: starting when the server is slow; concurrent callers share one start', async () => {
  const home = tmpHome();
  const { execFile, calls } = fakeExec();
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10 });
  const [a, b] = await Promise.all([bridge.ensure({ waitMs: 50 }), bridge.ensure({ waitMs: 50 })]);
  assert.equal(a.state, 'starting');
  assert.deepEqual(a, b);
  assert.equal(calls.filter(c => c[1] === 'new-session').length, 1);
});

test('ensure: a port held by something else moves to a free one', async () => {
  const home = tmpHome();
  const squatter = http.createServer((_q, r) => { r.writeHead(200); r.end('not t3'); });
  const taken = await listen(squatter);
  fs.mkdirSync(path.join(home, '.termag'));
  fs.writeFileSync(path.join(home, '.termag', 't3.json'), JSON.stringify({ port: taken }));
  const { execFile } = fakeExec();
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10 });
  try {
    const state = await bridge.ensure({ waitMs: 30 });
    assert.notEqual(state.port, taken);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.termag', 't3.json'), 'utf8')).port, state.port);
  } finally { squatter.close(); }
});

test('pair: runs auth pairing create --json with the state dir; no label, nothing else', async () => {
  const home = tmpHome();
  const calls = [];
  const execFile = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: '{\n  "id": "p1",\n  "credential": "CRED1",\n  "expiresAt": "2026-10-21T00:05:00.000Z"\n}\n' };
  };
  const bridge = createT3Bridge({ command: '/opt/t3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  assert.deepEqual(await bridge.pair({}), { credential: 'CRED1', expiresAt: '2026-10-21T00:05:00.000Z' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/opt/t3');
  assert.deepEqual(calls[0].args, ['auth', 'pairing', 'create', '--json', '--base-dir', path.join(home, '.t3')]);
  assert.equal(calls[0].opts.env.T3CODE_TELEMETRY_ENABLED, 'false');
  await assert.rejects(bridge.pair({ label: 'bad\nlabel' }), /label/);
  await assert.rejects(bridge.pair({ label: 42 }), /label/);
  assert.equal(calls.length, 1);
});

/**
 * A stand-in for the t3 CLI's auth commands over one box's state: sessions
 * and pairing credentials, each with a label, as `--json` prints them.
 */
function fakeT3Auth({ sessions = [], pairings = [], gate = null, failLists = false, createId = true, logFirst = false } = {}) {
  const calls = [];
  let minted = 0;
  const execFile = async (cmd, args) => {
    const [, group, verb, ...rest] = args;
    const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
    calls.push(`${group} ${verb}${verb === 'revoke' ? ` ${rest[0]}` : ''}${flag('--label') ? ` ${flag('--label')}` : ''}`);
    assert.equal(flag('--base-dir') ?? rest[rest.length - 1], rest[rest.length - 1]);
    // Numbered as they are asked for, whatever order they finish in.
    const mint = verb === 'create' ? ++minted : 0;
    if (gate) await gate(`${group} ${verb}`);
    if (verb === 'list') {
      if (failLists) throw Object.assign(new Error('Command failed: t3 auth list'), { code: 1 });
      const list = group === 'session'
        ? sessions.map((s) => ({ sessionId: s.id, method: 'bearer-access-token', subject: 'one-time-token', client: s.label ? { label: s.label } : {}, connected: false }))
        : pairings.map((p) => ({ id: p.id, ...(p.label ? { label: p.label } : {}), scopes: [] }));
      return { stdout: `${JSON.stringify(list, null, 2)}\n` };
    }
    if (verb === 'create') {
      const id = `p-new-${mint}`;
      pairings.push({ id, label: flag('--label') });
      return { stdout: `${JSON.stringify({ ...(createId ? { id } : {}), credential: `CRED${mint}`, label: flag('--label'), expiresAt: 'x' }, null, 2)}\n` };
    }
    if (verb === 'revoke') {
      const id = rest[0];
      const from = group === 'session' ? sessions : pairings;
      const i = from.findIndex((e) => e.id === id);
      if (i < 0) return { stdout: `No active ${group} found for ${id}.\n` };
      from.splice(i, 1);
      return { stdout: `${logFirst ? 'a log line\n' : ''}Revoked ${group === 'session' ? 'session' : 'pairing credential'} ${id}.\n` };
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { execFile, calls, sessions, pairings };
}

const LABEL = 'termag-desktop 0123abcd box-1';

test('pair with a label: revokes the sessions and unredeemed credentials an earlier pair of it left, never its own', async () => {
  const auth = fakeT3Auth({
    sessions: [{ id: 's-old', label: LABEL }, { id: 's-other', label: 'termag-desktop ffff box-1' }, { id: 's-cli' }],
    pairings: [{ id: 'p-old', label: LABEL }, { id: 'p-other', label: 'someone else' }],
  });
  const logs = [];
  const bridge = createT3Bridge({ command: '/opt/t3', home: tmpHome(), execFile: auth.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', log: (m) => logs.push(m) });
  assert.deepEqual(await bridge.pair({ label: LABEL }), { credential: 'CRED1', expiresAt: 'x' });
  assert.deepEqual(auth.sessions.map((s) => s.id), ['s-other', 's-cli']);
  // The credential just minted stays: the lists are read before it is.
  assert.deepEqual(auth.pairings.map((p) => p.id), ['p-other', 'p-new-1']);
  assert.ok(auth.calls.includes(`pairing create ${LABEL}`));
  assert.ok(logs.some((l) => /revoked 1 session\(s\) and 1 pairing credential\(s\)/.test(l)));

  // The desktop redeems it, then pairs again (Reconnect): one session of the label is left.
  auth.pairings.splice(auth.pairings.findIndex((p) => p.id === 'p-new-1'), 1);
  auth.sessions.push({ id: 's-from-1', label: LABEL });
  await bridge.pair({ label: LABEL });
  auth.pairings.splice(auth.pairings.findIndex((p) => p.id === 'p-new-2'), 1);
  auth.sessions.push({ id: 's-from-2', label: LABEL });
  assert.deepEqual(auth.sessions.filter((s) => s.label === LABEL).map((s) => s.id), ['s-from-2']);
});

test('pair with a label: never revokes its own credential, even when t3 prints no id for it', async () => {
  const auth = fakeT3Auth({ createId: false, pairings: [{ id: 'p-old', label: LABEL }] });
  const bridge = createT3Bridge({ command: '/opt/t3', home: tmpHome(), execFile: auth.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  assert.deepEqual(await bridge.pair({ label: LABEL }), { credential: 'CRED1', expiresAt: 'x' });
  assert.deepEqual(auth.pairings.map((p) => p.id), ['p-new-1']);
  assert.deepEqual(auth.calls.filter((c) => c.startsWith('pairing')), [`pairing list`, `pairing create ${LABEL}`, 'pairing revoke p-old']);
});

test('pair with a label: a list or revoke that fails still hands out the credential', async () => {
  const auth = fakeT3Auth({ failLists: true, sessions: [{ id: 's-old', label: LABEL }] });
  const logs = [];
  const bridge = createT3Bridge({ command: '/opt/t3', home: tmpHome(), execFile: auth.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', log: (m) => logs.push(m) });
  assert.deepEqual(await bridge.pair({ label: LABEL }), { credential: 'CRED1', expiresAt: 'x' });
  assert.deepEqual(auth.sessions.map((s) => s.id), ['s-old']);
  assert.ok(logs.some((l) => /could not list t3 sessions/.test(l)));
});

test('pair: two of one label run one after the other, so only the later credential is left', async () => {
  let releaseFirstCreate;
  const firstCreate = new Promise((r) => { releaseFirstCreate = r; });
  let creates = 0;
  const order = [];
  const auth = fakeT3Auth({
    gate: async (what) => {
      order.push(what);
      if (what === 'pairing create' && ++creates === 1) await firstCreate;
    },
  });
  const bridge = createT3Bridge({ command: '/opt/t3', home: tmpHome(), execFile: auth.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  const a = bridge.pair({ label: LABEL });
  const b = bridge.pair({ label: LABEL });
  const other = bridge.pair({ label: 'termag-desktop 9999 box-1' });
  // Another label isn't held up behind this one; b hasn't started while a runs.
  assert.deepEqual(await other, { credential: 'CRED2', expiresAt: 'x' });
  assert.equal(order.filter((w) => w === 'pairing create').length, 2);
  releaseFirstCreate();
  assert.deepEqual(await a, { credential: 'CRED1', expiresAt: 'x' });
  assert.deepEqual(await b, { credential: 'CRED3', expiresAt: 'x' });
  // b listed after a was done, so a's unredeemed credential went.
  assert.deepEqual(auth.pairings.filter((p) => p.label === LABEL).map((p) => p.id), ['p-new-3']);
});

test('revoke: the sessions and unredeemed credentials of a label, with how many', async () => {
  const auth = fakeT3Auth({
    sessions: [{ id: 's1', label: LABEL }, { id: 's2', label: LABEL }, { id: 's3', label: 'other' }],
    pairings: [{ id: 'p1', label: LABEL }],
  });
  const home = tmpHome();
  const bridge = createT3Bridge({ command: '/opt/t3', home, execFile: auth.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  assert.deepEqual(await bridge.revoke({ label: LABEL }), { sessions: 2, pairings: 1 });
  assert.deepEqual(auth.sessions.map((s) => s.id), ['s3']);
  assert.deepEqual(auth.pairings, []);
  assert.deepEqual(await bridge.revoke({ label: LABEL }), { sessions: 0, pairings: 0 });
  // Counted when t3 logs before its `Revoked` line, too.
  const noisy = fakeT3Auth({ logFirst: true, sessions: [{ id: 's1', label: LABEL }], pairings: [{ id: 'p1', label: LABEL }] });
  assert.deepEqual(await createT3Bridge({ command: '/opt/t3', home, execFile: noisy.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' }).revoke({ label: LABEL }), { sessions: 1, pairings: 1 });
  await assert.rejects(bridge.revoke({}), /label/);
  await assert.rejects(bridge.revoke({ label: 'x'.repeat(81) }), /label/);
  await assert.rejects(createT3Bridge({ command: '/opt/t3', home, execFile: fakeT3Auth({ failLists: true }).execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' }).revoke({ label: LABEL }), /Command failed/);
});

test('parseListOutput and staleAuthFor', () => {
  assert.deepEqual(parseListOutput('[]\n', 'session'), []);
  assert.deepEqual(parseListOutput('a log line\n[\n  {\n    "id": "p1"\n  }\n]\n', 'pairing'), [{ id: 'p1' }]);
  assert.throws(() => parseListOutput('No active sessions.\n', 'session'), /no session list/);
  assert.throws(() => parseListOutput('[ nope', 'session'), /unreadable session list/);
  assert.throws(() => parseListOutput('{"id":"x"}', 'pairing'), /no pairing list/);
  assert.deepEqual(staleAuthFor('L', {
    sessions: [{ sessionId: 'a', client: { label: 'L' } }, { sessionId: 'b', client: {} }, { sessionId: 'c' }, null],
    pairings: [{ id: 'p', label: 'L' }, { id: 'q', label: 'L' }, { id: 'r' }],
  }), { sessionIds: ['a'], pairingIds: ['p', 'q'] });
});

test('paths: remapped, with whether each directory exists', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'termag', 'projects', 'sample'), { recursive: true });
  const bridge = createT3Bridge({
    command: 't3', home, execFile: async () => ({ stdout: '' }), WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't',
    remapPath: (p) => p.replace(/^\/home\/alice/, home),
  });
  assert.deepEqual(bridge.paths({ paths: ['/home/alice/termag/projects/sample', '/home/alice/termag/projects/gone', 'relative', 7] }), [
    { path: path.join(home, 'termag', 'projects', 'sample'), exists: true },
    { path: path.join(home, 'termag', 'projects', 'gone'), exists: false },
    { path: null, exists: false },
    { path: null, exists: false },
  ]);
  assert.throws(() => bridge.paths({ paths: 'x' }), /array/);
});

test('openTunnel: refuses other targets and malformed ids, and says so while no server runs', async () => {
  const bridge = createT3Bridge({ command: 't3', home: tmpHome(), execFile: async () => ({ stdout: '' }), WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  await assert.rejects(bridge.openTunnel({ tunnelId: 'a'.repeat(64), target: 'ssh' }), /unknown tunnel target/);
  await assert.rejects(bridge.openTunnel({ tunnelId: 'nope', target: 't3' }), /bad tunnel id/);
  assert.deepEqual(await bridge.openTunnel({ tunnelId: 'a'.repeat(64), target: 't3' }), { ok: false, reason: 't3_not_running' });
});

test('openTunnel: dials back with the agent token and carries HTTP to the t3 server', async () => {
  const home = tmpHome();
  const t3 = fakeT3();
  const t3Port = await listen(t3);
  fs.mkdirSync(path.join(home, '.termag'));
  fs.writeFileSync(path.join(home, '.termag', 't3.json'), JSON.stringify({ port: t3Port }));

  // The orchestrator side: accept the dial-back, then speak HTTP through it.
  const orch = http.createServer();
  const wss = new WebSocket.Server({ noServer: true });
  let seen = null;
  const tunnel = new Promise((resolve) => {
    orch.on('upgrade', (req, socket, head) => {
      seen = { url: req.url, auth: req.headers.authorization };
      wss.handleUpgrade(req, socket, head, (ws) => resolve(ws));
    });
  });
  const orchPort = await listen(orch);
  const bridge = createT3Bridge({ command: 't3', home, execFile: fakeExec({ session: true }).execFile, WebSocket, termagUrl: `ws://127.0.0.1:${orchPort}/termag/ws/agent`, token: 'tmag_box' });
  const id = crypto.randomBytes(32).toString('hex');
  try {
    assert.deepEqual(await bridge.openTunnel({ tunnelId: id, target: 't3' }), { ok: true, port: t3Port });
    const ws = await tunnel;
    assert.equal(seen.url, `/termag/ws/agent-tunnel?id=${id}`);
    assert.equal(seen.auth, 'Bearer tmag_box');
    const stream = WebSocket.createWebSocketStream(ws);
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ createConnection: () => stream, method: 'POST', path: '/oauth/token', headers: { host: '127.0.0.1', authorization: 'Bearer t3tok', connection: 'close' } }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve(b));
      });
      req.on('error', reject);
      req.end('grant=x');
    });
    assert.equal(body, 'POST /oauth/token Bearer t3tok grant=x');
    // The t3 side closed (Connection: close): the tunnel goes away.
    for (let i = 0; i < 50 && bridge.openTunnels() > 0; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(bridge.openTunnels(), 0);
  } finally {
    t3.close();
    orch.close();
  }
});

test('openTunnel: a refused dial-back fails the RPC and leaves nothing open', async () => {
  const home = tmpHome();
  const t3 = fakeT3();
  const t3Port = await listen(t3);
  fs.mkdirSync(path.join(home, '.termag'));
  fs.writeFileSync(path.join(home, '.termag', 't3.json'), JSON.stringify({ port: t3Port }));
  const orch = http.createServer();
  orch.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); });
  const orchPort = await listen(orch);
  const bridge = createT3Bridge({ command: 't3', home, execFile: fakeExec({ session: true }).execFile, WebSocket, termagUrl: `ws://127.0.0.1:${orchPort}/termag/ws/agent`, token: 't' });
  try {
    await assert.rejects(bridge.openTunnel({ tunnelId: 'e'.repeat(64), target: 't3' }), /refused the tunnel \(404\)/);
    assert.equal(bridge.openTunnels(), 0);
  } finally {
    t3.close();
    orch.close();
  }
});

/**
 * A dial-back the test drives: it opens at once and holds what the agent sends
 * (its bufferedAmount) until the test drains it, as a slow client would.
 */
class HeldDialBack extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = 0;
    this.closes = [];
    this.terminated = false;
    HeldDialBack.last = this;
    setImmediate(() => { this.readyState = HeldDialBack.OPEN; this.emit('open'); });
  }
  send(chunk) { this.bufferedAmount += chunk.length; this.sent += chunk.length; }
  drain(n) { this.bufferedAmount = Math.max(0, this.bufferedAmount - n); }
  close(code) { this.closes.push(code); this.readyState = 2; }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006); }
  pause() {}
  resume() {}
}
HeldDialBack.OPEN = 1;

/** A t3 stand-in that answers `bytes` and closes, as t3 does with Connection: close. */
async function answersAndCloses(bytes) {
  const server = net.createServer((c) => { c.on('error', () => {}); c.end(Buffer.alloc(bytes, 1)); });
  return { server, port: await listen(server) };
}

async function heldTunnel(home, port, opts = {}) {
  keepPort(home, port);
  const logs = [];
  const bridge = createT3Bridge({
    command: 't3', home, execFile: fakeExec({ session: true }).execFile, WebSocket: HeldDialBack,
    termagUrl: 'ws://127.0.0.1:1/termag/ws/agent', token: 't', log: (m) => logs.push(m), ...opts,
  });
  assert.deepEqual(await bridge.openTunnel({ tunnelId: 'c'.repeat(64), target: 't3' }), { ok: true, port });
  return { ws: HeldDialBack.last, logs };
}

const until = async (ok, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 5));
  }
};

test('openTunnel: once t3 has answered, the tunnel closes only after its queued bytes are sent, however long a slow reader takes', async () => {
  const { server, port } = await answersAndCloses(200_000);
  try {
    const { ws } = await heldTunnel(tmpHome(), port);
    await until(() => ws.sent === 200_000);
    // Past the 2 s after which the tunnel used to be terminated, tail unsent.
    await new Promise(r => setTimeout(r, 2300));
    assert.deepEqual(ws.closes, []);
    assert.equal(ws.terminated, false);
    ws.drain(150_000);
    await new Promise(r => setTimeout(r, 250));
    assert.deepEqual(ws.closes, []);
    ws.drain(50_000);
    await until(() => ws.closes.length > 0, 1000);
    assert.deepEqual(ws.closes, [1000]);
    assert.equal(ws.terminated, false);
  } finally {
    server.close();
  }
});

test('openTunnel: a finished tunnel whose bytes keep moving is kept; one whose bytes stop for the stall bound is given up', async () => {
  const { server, port } = await answersAndCloses(200_000);
  try {
    const { ws, logs } = await heldTunnel(tmpHome(), port, { tunnelStallMs: 300, tunnelDrainPollMs: 20 });
    await until(() => ws.sent === 200_000);
    // A slow reader: a little every 100 ms, for well over the stall bound.
    let lastMove = 0;
    for (let i = 0; i < 10; i++) {
      ws.drain(10_000);
      lastMove = Date.now();
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(ws.terminated, false);
    assert.deepEqual(ws.closes, []);
    // Then nothing moves: given up after about the bound, with a line saying so.
    await until(() => ws.terminated, 2000);
    assert.ok(Date.now() - lastMove >= 280, 'not before the stall bound');
    assert.deepEqual(ws.closes, []);
    assert.match(logs.join('\n'), /\[T3\] tunnel gave up: 100000 bytes unsent for 0s/);
  } finally {
    server.close();
  }
});

test('openTunnel: t3 answering before the request body is all in still closes promptly; the rest of the body is dropped, not waited on', async () => {
  const home = tmpHome();
  // t3 reads nothing of the request (its socket's buffers fill, so the agent's
  // writes return false), answers, and closes.
  const t3 = net.createServer((c) => {
    c.on('error', () => {});
    c.pause();
    setTimeout(() => c.end('HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'), 300);
  });
  const t3Port = await listen(t3);
  keepPort(home, t3Port);
  // The orchestrator: sends a 64 MiB body down the tunnel, as an upload would.
  const orch = http.createServer();
  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
  const closed = new Promise((resolve) => {
    orch.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
      const opened = Date.now();
      const chunk = Buffer.alloc(1024 * 1024, 3);
      for (let i = 0; i < 64; i++) ws.send(chunk);
      ws.on('close', (code) => resolve({ code, ms: Date.now() - opened }));
    }));
  });
  const orchPort = await listen(orch);
  const bridge = createT3Bridge({
    command: 't3', home, execFile: fakeExec({ session: true }).execFile, WebSocket,
    termagUrl: `ws://127.0.0.1:${orchPort}/termag/ws/agent`, token: 't',
    // Before the fix the dial-back stayed paused, the orchestrator's close
    // unread, until this ran out.
    tunnelCloseTimeoutMs: 10_000,
  });
  try {
    assert.deepEqual(await bridge.openTunnel({ tunnelId: 'b'.repeat(64), target: 't3' }), { ok: true, port: t3Port });
    const { code, ms } = await closed;
    assert.equal(code, 1000);
    assert.ok(ms < 3000, `the close handshake took ${ms} ms`);
    assert.equal(bridge.openTunnels(), 0);
  } finally {
    t3.close();
    orch.closeAllConnections?.();
    orch.close();
  }
});

test('openTunnel: never pipes to a listener outside the termag-t3 pane', async () => {
  const home = tmpHome();
  let connections = 0;
  const impostor = http.createServer((_q, r) => r.end('ok'));
  impostor.on('connection', () => { connections++; });
  const port = await listen(impostor);
  keepPort(home, port);
  const orch = http.createServer();
  let dialed = false;
  orch.on('upgrade', (_req, socket) => { dialed = true; socket.destroy(); });
  const orchPort = await listen(orch);
  for (const listener of [424242, 'unknown']) {
    const bridge = createT3Bridge({
      command: 't3', home, execFile: fakeExec({ session: true, listener }).execFile, fsImpl: noProc, WebSocket,
      termagUrl: `ws://127.0.0.1:${orchPort}/termag/ws/agent`, token: 't',
    });
    assert.deepEqual(await bridge.openTunnel({ tunnelId: 'f'.repeat(64), target: 't3' }), { ok: false, reason: 't3_not_running' });
  }
  assert.equal(connections, 0);
  assert.equal(dialed, false);
  impostor.close();
  orch.close();
});

test('resolveT3ClaudeCommand: unset is null; a name resolves on the agent PATH to an absolute path', () => {
  const home = tmpHome();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveT3ClaudeCommand({ env: { PATH: bin } }), null);
  assert.equal(resolveT3ClaudeCommand({ env: { PATH: bin, TERMAG_T3_CLAUDE_COMMAND: 'claude' } }), path.join(bin, 'claude'));
  assert.equal(resolveT3ClaudeCommand({ env: { PATH: '/nowhere' }, config: { t3ClaudeCommand: path.join(bin, 'claude') } }), path.join(bin, 'claude'));
  assert.equal(resolveT3ClaudeCommand({ env: { PATH: '/nowhere', TERMAG_T3_CLAUDE_COMMAND: 'claude' } }), null);
});

test('pinClaudeBinary: writes the claudeAgent binary path, keeps the rest, never overrides a hand-set one', () => {
  const home = tmpHome();
  const file = path.join(home, '.t3', 'userdata', 'settings.json');
  assert.equal(pinClaudeBinary(home, '/box/bin/claude'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    providerInstances: { claudeAgent: { driver: 'claudeAgent', config: { binaryPath: '/box/bin/claude' } } },
  });
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', providerInstances: { codex: { driver: 'codex' }, claudeAgent: { driver: 'claudeAgent', enabled: true, config: { homePath: '/h' } } } }));
  assert.equal(pinClaudeBinary(home, '/box/bin/claude'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    theme: 'dark',
    providerInstances: { codex: { driver: 'codex' }, claudeAgent: { driver: 'claudeAgent', enabled: true, config: { homePath: '/h', binaryPath: '/box/bin/claude' } } },
  });
  fs.writeFileSync(file, JSON.stringify({ providerInstances: { claudeAgent: { driver: 'claudeAgent', config: { binaryPath: '/mine/claude' } } } }));
  assert.equal(pinClaudeBinary(home, '/box/bin/claude'), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).providerInstances.claudeAgent.config.binaryPath, '/mine/claude');
});

test('ensure: pins the Claude binary before it starts the server', async () => {
  const home = tmpHome();
  const { execFile } = fakeExec();
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10, claudeCommand: '/box/bin/claude' });
  await bridge.ensure({ waitMs: 20 });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.t3', 'userdata', 'settings.json'), 'utf8'));
  assert.equal(settings.providerInstances.claudeAgent.config.binaryPath, '/box/bin/claude');
});

// ── a live t3 is never killed for a slow or garbled answer ───────────────────

/** A listener that accepts and never answers, like t3 holding requests until its startup is done. */
function silentServer() {
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); });
  server.closeAll = () => { for (const s of sockets) s.destroy(); server.close(); };
  return server;
}

function keepPort(home, port) {
  fs.mkdirSync(path.join(home, '.termag'), { recursive: true });
  fs.writeFileSync(path.join(home, '.termag', 't3.json'), JSON.stringify({ port }));
}

const keptPort = (home) => JSON.parse(fs.readFileSync(path.join(home, '.termag', 't3.json'), 'utf8')).port;

test('probeT3: a timeout, a reset or a 5xx is busy; a non-t3 200, a 404 or a non-HTTP reply is not t3', async () => {
  const silent = silentServer();
  const silentPort = await listen(silent);
  const reset = net.createServer((s) => s.resetAndDestroy());
  const resetPort = await listen(reset);
  const starting = http.createServer((_q, r) => { r.writeHead(503, { 'retry-after': '1' }); r.end(); });
  const startingPort = await listen(starting);
  const html = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html>'); });
  const htmlPort = await listen(html);
  const missing = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  const missingPort = await listen(missing);
  const ssh = net.createServer((s) => { s.on('error', () => {}); s.end('SSH-2.0-OpenSSH_9.6\r\n'); });
  const sshPort = await listen(ssh);
  try {
    assert.deepEqual(await probeT3(silentPort, { timeoutMs: 100 }), { t3: false, busy: true });
    assert.deepEqual(await probeT3(resetPort), { t3: false, busy: true });
    assert.deepEqual(await probeT3(startingPort), { t3: false, busy: true });
    assert.deepEqual(await probeT3(htmlPort), { t3: false });
    assert.deepEqual(await probeT3(missingPort), { t3: false });
    assert.deepEqual(await probeT3(sshPort), { t3: false });
  } finally {
    silent.closeAll();
    for (const s of [reset, starting, html, missing, ssh]) s.close();
  }
});

test('ensure: a kept port that is listening but slow is waited for; within the grace the session is never killed nor the port moved', async () => {
  const home = tmpHome();
  const silent = silentServer();
  const port = await listen(silent);
  keepPort(home, port);
  // A session this process didn't start (an agent restart): before, it was killed.
  const { execFile, calls } = fakeExec({ session: true });
  const logs = [];
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10, log: (m) => logs.push(m) });
  try {
    const state = await bridge.ensure({ waitMs: 50 });
    assert.equal(state.state, 'starting');
    assert.equal(state.port, port);
    assert.equal(keptPort(home), port);
    assert.deepEqual(calls.filter(c => c[1] === 'kill-session' || c[1] === 'new-session'), []);
    assert.ok(logs.some(l => /not answering yet/.test(l)));
  } finally { silent.closeAll(); }
});

test('ensure: the pane\'s own server, silent for a whole grace, is restarted on a fresh port', async () => {
  const home = tmpHome();
  // Answers, but never as t3 is up: 503 is busy, at once.
  const wedged = http.createServer((_q, r) => { r.writeHead(503); r.end(); });
  const port = await listen(wedged);
  keepPort(home, port);
  const { execFile, calls } = fakeExec({ session: true });
  let t = 1_000_000;
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 1, now: () => t });
  const restarts = () => calls.filter(c => c[1] === 'kill-session' || c[1] === 'new-session').map(c => c[1]);
  try {
    assert.equal((await bridge.ensure({ waitMs: 0 })).state, 'starting');
    // Slow once, then again long after: two moments, not one silence.
    t += 2 * 90_000;
    assert.equal((await bridge.ensure({ waitMs: 0 })).state, 'starting');
    t += 90_000 - 1;
    assert.equal((await bridge.ensure({ waitMs: 0 })).state, 'starting');
    assert.deepEqual(restarts(), []);
    assert.equal(keptPort(home), port);
    t += 1;
    const state = await bridge.ensure({ waitMs: 0 });
    assert.equal(state.state, 'starting');
    assert.deepEqual(restarts(), ['kill-session', 'new-session']);
    assert.notEqual(keptPort(home), port);
    assert.equal(state.port, keptPort(home));
  } finally { wedged.close(); }
});

test('ensure: a foreign answer from the termag-t3 pane\'s own process tree is left alone', async () => {
  const home = tmpHome();
  const odd = http.createServer((_q, r) => { r.writeHead(200); r.end('not the descriptor'); });
  const port = await listen(odd);
  keepPort(home, port);
  // The pane runs a wrapper (pid 4000) whose child (this test, the listener) holds the port.
  const run = async (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '4000\n' };
    if (cmd === 'ps') return { stdout: `  1     0\n 4000     1\n ${process.pid}  4000\n 4100     1\n` };
    if (cmd === 'lsof') { assert.deepEqual(args, ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']); return { stdout: `${process.pid}\n` }; }
    return undefined;
  };
  const { execFile, calls } = fakeExec({ session: true, run });
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10 });
  try {
    const state = await bridge.ensure({ waitMs: 30 });
    assert.equal(state.state, 'starting');
    assert.equal(keptPort(home), port);
    assert.deepEqual(calls.filter(c => c[1] === 'kill-session' || c[1] === 'new-session'), []);
  } finally { odd.close(); }
});

test('ensure: a foreign listener outside the pane\'s tree is given up: session killed, port moved', async () => {
  const home = tmpHome();
  const odd = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  const port = await listen(odd);
  keepPort(home, port);
  const run = async (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '4000\n' };
    if (cmd === 'ps') return { stdout: ' 4000     1\n 4001  4000\n' };
    if (cmd === 'lsof') return { stdout: `${process.pid}\n` };
    return undefined;
  };
  const { execFile, calls } = fakeExec({ session: true, run });
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10 });
  try {
    const state = await bridge.ensure({ waitMs: 30 });
    assert.notEqual(state.port, port);
    assert.equal(keptPort(home), state.port);
    assert.ok(calls.some(c => c[1] === 'kill-session'));
  } finally { odd.close(); }
});

test('ensure: without lsof, /proc says whether the pane holds the port', async () => {
  const home = tmpHome();
  const odd = http.createServer((_q, r) => { r.writeHead(200); r.end('{}'); });
  const port = await listen(odd);
  keepPort(home, port);
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const proc = {
    '/proc/net/tcp': [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      `   0: 0100007F:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0`,
      `   1: 0100007F:${hex} 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 555555 1 0000000000000000 20 4 30 10 -1`,
    ].join('\n'),
    '/proc/net/tcp6': '',
  };
  const fsImpl = {
    ...fs,
    existsSync: (p) => (String(p).startsWith('/proc') ? p in proc : fs.existsSync(p)),
    readFileSync: (p, ...rest) => (String(p).startsWith('/proc') ? proc[p] : fs.readFileSync(p, ...rest)),
    readdirSync: (p, ...rest) => (p === '/proc/4000/fd' ? ['0', '1', '7'] : fs.readdirSync(p, ...rest)),
    readlinkSync: (p) => ({ '/proc/4000/fd/0': '/dev/null', '/proc/4000/fd/1': 'pipe:[9]', '/proc/4000/fd/7': 'socket:[424242]' })[p] ?? fs.readlinkSync(p),
  };
  const run = async (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '4000\n' };
    if (cmd === 'ps') return { stdout: ' 4000     1\n' };
    if (cmd === 'lsof') throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
    return undefined;
  };
  const { execFile, calls } = fakeExec({ session: true, run });
  const bridge = createT3Bridge({ command: 't3', home, execFile, fsImpl, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10 });
  try {
    await bridge.ensure({ waitMs: 30 });
    assert.equal(keptPort(home), port);
    assert.deepEqual(calls.filter(c => c[1] === 'kill-session'), []);
  } finally { odd.close(); }
});

test('descendants and listeningInodes: the pane\'s tree from ps; LISTEN inodes on the port', () => {
  assert.deepEqual([...descendants('  1 0\n 10 1\n 11 10\n 12 11\n 20 1\n junk\n', [10])].sort(), [10, 11, 12]);
  assert.deepEqual([...descendants('', [10])], [10]);
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1',
    '   1: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 222 1',
    '   2: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 333 1',
    '   3: 0100007F:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1',
  ].join('\n');
  assert.deepEqual([...listeningInodes(table, 8080)].sort(), ['111', '222']);
});

test('serverCommandLine: the box name labels the environment, quoted', () => {
  const line = serverCommandLine({ command: 't3', port: 4100, home: '/home/a', label: "alice's box" });
  assert.match(line, /T3CODE_ENVIRONMENT_LABEL='alice'\\''s box'/);
  assert.doesNotMatch(serverCommandLine({ command: 't3', port: 4100, home: '/home/a' }), /T3CODE_ENVIRONMENT_LABEL/);
});

// ── the pinned server, installed on demand ─────────────────────────────────

const flush = () => new Promise((r) => setImmediate(r));

/** An installed server and the drop-in naming it, as deploy/termag-t3-install leaves them. */
function installServer(home) {
  const bin = path.join(home, 'opt', 'bin', 't3');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const dropin = path.join(home, 't3.conf');
  fs.writeFileSync(dropin, `# written by termag-t3-install\n[Service]\nEnvironment=TERMAG_T3_COMMAND=${bin}\n`);
  return { bin, dropin };
}

/**
 * The installer, run as `bash <installer> [--check]`: --check exits
 * `checkCode`; an install waits for `release()` and then runs `onInstall`.
 */
function fakeInstaller({ checkCode = 1, onInstall = () => ({ stdout: '' }) } = {}) {
  const calls = [];
  let release;
  const execFile = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === '--check') {
      if (checkCode === 0) return { stdout: '' };
      throw Object.assign(new Error(`exit ${checkCode}`), { code: checkCode });
    }
    await new Promise((r) => { release = r; });
    return onInstall();
  };
  return { execFile, calls, release: () => release() };
}

test('commandFromDropin: the last TERMAG_T3_COMMAND line, null for none', () => {
  const home = tmpHome();
  const file = path.join(home, 't3.conf');
  assert.equal(commandFromDropin(file), null);
  fs.writeFileSync(file, '[Service]\nEnvironment=TERMAG_T3_COMMAND=/opt/a/t3\nEnvironment=TERMAG_T3_COMMAND=/opt/b/t3\n');
  assert.equal(commandFromDropin(file), '/opt/b/t3');
  fs.writeFileSync(file, '[Service]\nEnvironment=OTHER=1\n');
  assert.equal(commandFromDropin(file), null);
});

test('pinned check: drift this box can fix, or a drop-in naming an installed server; nothing else', async () => {
  const home = tmpHome();
  const dropin = path.join(home, 't3.conf');
  const check = (code) => createPinnedInstall({ installer: '/i', dropin, execFile: fakeInstaller({ checkCode: code }).execFile }).check();
  assert.equal(await check(1), true);
  assert.equal(await check(0), false);
  // No installer in the checkout (bash: 127), or a failed check.
  assert.equal(await check(127), false);
  assert.equal(await check(2), false);
  // Installed by a box update that deferred the agent's restart.
  installServer(home);
  assert.equal(await check(0), true);
});

test('pinned install: one run at a time, starting until it is in place, then the drop-in command', async () => {
  const home = tmpHome();
  const dropin = path.join(home, 't3.conf');
  let bin;
  const installer = fakeInstaller({ onInstall: () => { bin = installServer(home).bin; return { stdout: 'reconciled: t3 server' }; } });
  const pinned = createPinnedInstall({ installer: '/i', dropin, execFile: installer.execFile });
  assert.equal(pinned.commandOrInstall(), null);
  assert.equal(pinned.commandOrInstall(), null);
  await flush();
  installer.release();
  await flush();
  assert.equal(pinned.commandOrInstall(), bin);
  assert.deepEqual(installer.calls, [['bash', '/i']]);
});

test('pinned install: a failure says why, and is not run again until retryMs has passed', async () => {
  let t = 0;
  const installer = fakeInstaller({
    onInstall: () => { throw Object.assign(new Error('Command failed'), { stderr: 'termag-t3-install: could not fetch gh://o/r/t/x.tar.gz\n' }); },
  });
  const pinned = createPinnedInstall({ installer: '/i', dropin: path.join(tmpHome(), 't3.conf'), execFile: installer.execFile, now: () => t, retryMs: 1000 });
  assert.equal(pinned.commandOrInstall(), null);
  await flush();
  installer.release();
  await flush();
  assert.throws(() => pinned.commandOrInstall(), /could not install the pinned t3 server: termag-t3-install: could not fetch gh:\/\/o\/r\/t\/x\.tar\.gz/);
  t = 999;
  assert.throws(() => pinned.commandOrInstall(), /could not fetch/);
  assert.equal(installer.calls.length, 1);
  t = 1000;
  assert.equal(pinned.commandOrInstall(), null);
  assert.equal(installer.calls.length, 2);
});

test('pinned install: retry (the owner\'s gh login) installs again at once, past the backoff or right after the run in flight', async () => {
  let t = 0;
  let ok = false;
  const home = tmpHome();
  let bin;
  const installer = fakeInstaller({
    onInstall: () => {
      if (!ok) throw Object.assign(new Error('Command failed'), { stderr: 'termag-t3-install: could not fetch gh://o/r/t/x.tar.gz\n' });
      bin = installServer(home).bin;
      return { stdout: '' };
    },
  });
  const pinned = createPinnedInstall({ installer: '/i', dropin: path.join(home, 't3.conf'), execFile: installer.execFile, now: () => t, retryMs: 1000 });
  // An ensure starts one before the login; it fails, and the backoff holds.
  pinned.commandOrInstall();
  installer.release();
  await flush();
  assert.throws(() => pinned.commandOrInstall(), /could not fetch/);
  // The login: a new run, the backoff notwithstanding.
  ok = true;
  pinned.retry();
  assert.equal(installer.calls.length, 2);
  installer.release();
  await flush();
  assert.equal(pinned.commandOrInstall(), bin);
  // Installed: a later login runs nothing.
  pinned.retry();
  assert.equal(installer.calls.length, 2);
});

test('pinned install: a retry while a run is in flight runs once more after it, not alongside it', async () => {
  const home = tmpHome();
  let bin;
  // The run in flight started before the login and fails; the next has it.
  const installer = fakeInstaller({
    onInstall: () => {
      if (installer.calls.length === 1) throw Object.assign(new Error('Command failed'), { stderr: 'no gh login\n' });
      bin = installServer(home).bin;
      return { stdout: '' };
    },
  });
  const pinned = createPinnedInstall({ installer: '/i', dropin: path.join(home, 't3.conf'), execFile: installer.execFile });
  pinned.commandOrInstall();
  pinned.retry();
  assert.equal(installer.calls.length, 1);
  installer.release();
  await flush();
  assert.equal(installer.calls.length, 2);
  assert.equal(pinned.commandOrInstall(), null);
  installer.release();
  await flush();
  assert.equal(pinned.commandOrInstall(), bin);
});

test('pinned install: an installer that succeeds but names no server is a failure', async () => {
  const installer = fakeInstaller({ onInstall: () => ({ stdout: 't3 server 0.1.1-abc: not installed (no source: base_url in pin is unset)\n' }) });
  const pinned = createPinnedInstall({ installer: '/i', dropin: path.join(tmpHome(), 't3.conf'), execFile: installer.execFile });
  pinned.commandOrInstall();
  await flush();
  installer.release();
  await flush();
  assert.throws(() => pinned.commandOrInstall(), /could not install the pinned t3 server: .*base_url in pin is unset/);
});

test('ensure with a pinned server: starting while it installs, nothing started; then the installed command runs', async () => {
  const home = tmpHome();
  let bin;
  let t3;
  const installer = fakeInstaller({ onInstall: () => { bin = installServer(home).bin; return { stdout: '' }; } });
  const tmux = fakeExec({
    onNewSession: async (args) => {
      const port = Number(/--port (\d+)/.exec(args.at(-1))[1]);
      t3 = fakeT3();
      await new Promise((r) => t3.listen(port, '127.0.0.1', r));
    },
  });
  const execFile = (cmd, args, opts) => (cmd === 'bash' ? installer.execFile(cmd, args, opts) : tmux.execFile(cmd, args, opts));
  const pinned = createPinnedInstall({ installer: '/i', dropin: path.join(home, 't3.conf'), execFile });
  const bridge = createT3Bridge({ command: null, pinned, home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 20 });
  try {
    assert.deepEqual(await bridge.ensure(), { state: 'starting', port: null, version: null, home });
    await assert.rejects(bridge.pair(), /not installed yet/);
    assert.deepEqual(tmux.calls, []);
    installer.release();
    await flush();
    const ready = await bridge.ensure();
    assert.equal(ready.state, 'ready');
    const newSession = tmux.calls.find(c => c[1] === 'new-session');
    assert.match(newSession.at(-1), new RegExp(`'${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' serve`));
  } finally { t3?.close(); }
});

// ── t3's Fireworks instance ──────────────────────────────────────────────────

const KIMI = 'accounts/fireworks/models/kimi-k3';
const FLASH = 'accounts/fireworks/models/deepseek-v4p1-flash';
const t3Settings = (home) => JSON.parse(fs.readFileSync(path.join(home, '.t3', 'userdata', 'settings.json'), 'utf8'));

test('parseFireworksParam: nothing said, off, malformed models dropped, default kept only if listed', () => {
  assert.equal(parseFireworksParam(undefined), undefined);
  assert.equal(parseFireworksParam(null), null);
  assert.equal(parseFireworksParam({ models: [] }), null);
  assert.equal(parseFireworksParam({ models: [{ id: '../../etc' }] }), null);
  assert.deepEqual(parseFireworksParam({ models: [{ id: KIMI, context: 262144 }, { id: FLASH, context: 'big' }, { id: 'nope' }], defaultModel: FLASH }),
    { models: [{ id: KIMI, context: 262144 }, { id: FLASH, context: null }], defaultModel: FLASH });
  assert.equal(parseFireworksParam({ models: [{ id: KIMI }], defaultModel: 'accounts/x/models/gone' }).defaultModel, KIMI);
});

test('pinFireworksInstance: writes it beside the rest, keeps the owner\'s name and on/off, updates, removes', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.t3', 'userdata'), { recursive: true });
  fs.writeFileSync(path.join(home, '.t3', 'userdata', 'settings.json'),
    JSON.stringify({ enableProviderUpdateChecks: false, providerInstances: { claudeAgent: { driver: 'claudeAgent' } } }));
  assert.equal(pinFireworksInstance(home, { piPath: '/box/bin/pi', defaultModel: KIMI }), true);
  let s = t3Settings(home);
  assert.equal(s.enableProviderUpdateChecks, false);
  assert.deepEqual(s.providerInstances.claudeAgent, { driver: 'claudeAgent' });
  assert.deepEqual(s.providerInstances['termag-fireworks'], {
    driver: 'pi', displayName: 'Fireworks', enabled: true,
    config: { binaryPath: '/box/bin/pi', launchArgs: `--provider termag-fireworks --model ${KIMI}` },
  });
  assert.equal(pinFireworksInstance(home, { piPath: '/box/bin/pi', defaultModel: KIMI }), false);
  // The owner renamed and switched it off in the app: both stay as a new default lands.
  s.providerInstances['termag-fireworks'] = { ...s.providerInstances['termag-fireworks'], displayName: 'Kimi', enabled: false };
  fs.writeFileSync(path.join(home, '.t3', 'userdata', 'settings.json'), JSON.stringify(s));
  assert.equal(pinFireworksInstance(home, { piPath: '/box/bin/pi', defaultModel: FLASH }), true);
  s = t3Settings(home);
  assert.equal(s.providerInstances['termag-fireworks'].displayName, 'Kimi');
  assert.equal(s.providerInstances['termag-fireworks'].enabled, false);
  assert.match(s.providerInstances['termag-fireworks'].config.launchArgs, /deepseek-v4p1-flash$/);
  assert.equal(pinFireworksInstance(home, null), true);
  assert.deepEqual(Object.keys(t3Settings(home).providerInstances), ['claudeAgent']);
  assert.equal(pinFireworksInstance(home, null), false);
});

test('ensure: adds the missing Fireworks models to pi, then pins t3\'s instance; off removes it', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'),
    JSON.stringify({ providers: { 'termag-fireworks': { models: [{ id: KIMI }] } } }));
  assert.deepEqual([...piFireworksModelIds(home)], [KIMI]);
  const { execFile, calls } = fakeExec();
  const bridge = createT3Bridge({ command: 't3', home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10,
    piCommand: '/box/bin/pi', credentials: '/box/deploy/termag-credentials' });
  await bridge.ensure({ waitMs: 20, fireworks: { models: [{ id: KIMI, context: 262144 }, { id: FLASH, context: 131072 }], defaultModel: KIMI } });
  assert.deepEqual(calls.filter((c) => c[0] === '/box/deploy/termag-credentials'),
    [['/box/deploy/termag-credentials', 'pi-model', '--model', FLASH, '--context', '131072']]);
  assert.equal(t3Settings(home).providerInstances['termag-fireworks'].config.binaryPath, '/box/bin/pi');
  await bridge.ensure({ waitMs: 20 });
  assert.ok(t3Settings(home).providerInstances['termag-fireworks'], 'nothing said: the instance stays');
  await bridge.ensure({ waitMs: 20, fireworks: null });
  assert.equal(t3Settings(home).providerInstances['termag-fireworks'], undefined);
});

test('ensure: no Fireworks instance where pi-model refuses (not set up here) or there is no pi', async () => {
  const home = tmpHome();
  const refusing = fakeExec({ run: (cmd) => {
    if (cmd === '/box/deploy/termag-credentials') throw Object.assign(new Error('exit 1'), { stderr: 'termag-credentials: Fireworks is not set up on this box\n' });
    return undefined;
  } });
  const logs = [];
  const bridge = createT3Bridge({ command: 't3', home, execFile: refusing.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10,
    piCommand: '/box/bin/pi', credentials: '/box/deploy/termag-credentials', log: (m) => logs.push(m) });
  await bridge.ensure({ waitMs: 20, fireworks: { models: [{ id: KIMI }], defaultModel: KIMI } });
  assert.equal(fs.existsSync(path.join(home, '.t3', 'userdata', 'settings.json')) ? t3Settings(home).providerInstances?.['termag-fireworks'] : undefined, undefined);
  assert.ok(logs.some((m) => /could not add Fireworks model .* for pi: termag-credentials: Fireworks is not set up on this box/.test(m)));
  const noPi = createT3Bridge({ command: 't3', home, execFile: fakeExec().execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10 });
  await noPi.ensure({ waitMs: 20, fireworks: { models: [{ id: KIMI }], defaultModel: KIMI } });
  assert.equal(fs.existsSync(path.join(home, '.t3', 'userdata', 'settings.json')) ? t3Settings(home).providerInstances?.['termag-fireworks'] : undefined, undefined);
});

test('ensure: a model pi-model fails to add leaves the Fireworks instance on the models pi has', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'),
    JSON.stringify({ providers: { 'termag-fireworks': { models: [{ id: KIMI }] } } }));
  const failing = fakeExec({ run: (cmd, args) => {
    if (cmd === '/box/deploy/termag-credentials' && args.includes(FLASH)) throw Object.assign(new Error('timeout'), { stderr: '' });
    return undefined;
  } });
  const logs = [];
  const bridge = createT3Bridge({ command: 't3', home, execFile: failing.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10,
    piCommand: '/box/bin/pi', credentials: '/box/deploy/termag-credentials', log: (m) => logs.push(m) });
  // FLASH is the default but can't be added: the instance stays, starting on KIMI, which pi has.
  await bridge.ensure({ waitMs: 20, fireworks: { models: [{ id: KIMI }, { id: FLASH }], defaultModel: FLASH } });
  const instance = t3Settings(home).providerInstances['termag-fireworks'];
  assert.equal(instance.config.launchArgs, `--provider termag-fireworks --model ${KIMI}`);
  assert.ok(logs.some((m) => m.includes(`could not add Fireworks model ${FLASH}`)));
});

// ── t3-update: the desktop's own release ───────────────────────────────────

test('compareVersions: x.y.z by number, anything after the core ignored', () => {
  assert.equal(compareVersions('0.1.14', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.9', '0.1.14'), -1);
  assert.equal(compareVersions('0.1.14', '0.1.14-abcdefabcdef'), 0);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('release install: bash <installer> --release <version>; a failure says why; the launcher is the drop-in\'s', async () => {
  const home = tmpHome();
  const { bin, dropin } = installServer(home);
  const calls = [];
  let fail = false;
  const execFile = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (fail) throw Object.assign(new Error('exit 3'), { code: 3, stderr: 'fetching\ntermag-t3-install: could not read release termag-desktop-v0.1.14\n' });
    return { stdout: '' };
  };
  const release = createReleaseInstall({ installer: '/i', dropin, execFile });
  assert.equal(release.launcher(), bin);
  await release.install('0.1.14');
  assert.deepEqual(calls, [['bash', '/i', '--release', '0.1.14']]);
  fail = true;
  await assert.rejects(release.install('0.1.14'), /could not install t3 0\.1\.14: termag-t3-install: could not read release termag-desktop-v0\.1\.14/);
  assert.equal(createReleaseInstall({ installer: '/i', dropin: path.join(home, 'none.conf'), execFile }).launcher(), null);
});

/**
 * A box on `running`, whose installer's --release makes `installed` current:
 * the server restarts on whatever the launcher's --version says.
 */
async function updatableBox({ running, installed, command } = {}) {
  const home = tmpHome();
  const { bin, dropin } = installServer(home);
  let current = running;
  let server = fakeT3(running);
  const port = await listen(server);
  keepPort(home, port);
  const stop = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  const tmux = fakeExec({
    session: true,
    onKillSession: stop,
    onNewSession: async () => {
      server = fakeT3(current);
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
    },
    run: async (cmd, args) => {
      if (cmd === 'bash' && args[1] === '--release') { current = installed; return { stdout: '' }; }
      if (cmd === bin && args[0] === '--version') return { stdout: `t3 v${current}\n` };
      return undefined;
    },
  });
  const release = createReleaseInstall({ installer: '/i', dropin, execFile: tmux.execFile });
  const bridge = createT3Bridge({
    command: command ?? bin, release, home, execFile: tmux.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10,
  });
  return { bridge, calls: tmux.calls, home, port, close: stop };
}

test('update: installs the release, then restarts the server onto it; the answer is the new server', async () => {
  const box = await updatableBox({ running: '0.1.13', installed: '0.1.14' });
  try {
    const state = await box.bridge.update({ version: '0.1.14', label: 'box' });
    assert.deepEqual(state, { state: 'ready', port: box.port, version: '0.1.14', home: box.home });
    const order = box.calls.filter((c) => c[0] === 'bash' || c[1] === 'kill-session' || c[1] === 'new-session').map((c) => c[1] === 'new-session' || c[1] === 'kill-session' ? c[1] : c[2]);
    assert.deepEqual(order, ['--release', 'kill-session', 'new-session']);
    assert.match(box.calls.find((c) => c[1] === 'new-session').at(-1), /T3CODE_ENVIRONMENT_LABEL='box'/);
  } finally { await box.close(); }
});

test('update: a server already on what is installed is left running', async () => {
  // The installer did nothing (the release is no newer than current), and the
  // server runs current: a restart would end turns for nothing.
  const box = await updatableBox({ running: '0.1.14', installed: '0.1.14' });
  try {
    const state = await box.bridge.update({ version: '0.1.14' });
    assert.equal(state.version, '0.1.14');
    assert.deepEqual(box.calls.filter((c) => c[1] === 'kill-session' || c[1] === 'new-session'), []);
  } finally { await box.close(); }
});

test('update: an older desktop never moves a newer server back', async () => {
  const box = await updatableBox({ running: '0.1.15', installed: '0.1.15' });
  try {
    assert.equal((await box.bridge.update({ version: '0.1.14' })).version, '0.1.15');
    assert.deepEqual(box.calls.filter((c) => c[1] === 'kill-session'), []);
  } finally { await box.close(); }
});

test('update: concurrent asks share one install and one restart', async () => {
  const box = await updatableBox({ running: '0.1.13', installed: '0.1.14' });
  try {
    const [a, b] = await Promise.all([box.bridge.update({ version: '0.1.14' }), box.bridge.update({ version: '0.1.14' })]);
    assert.deepEqual(a, b);
    assert.equal(box.calls.filter((c) => c[0] === 'bash').length, 1);
    assert.equal(box.calls.filter((c) => c[1] === 'kill-session').length, 1);
  } finally { await box.close(); }
});

test('update: a pinned install in flight finishes first, then the release goes onto it', async () => {
  // The agent started before the drop-in named a server (a box update
  // deferred its restart), so it adopts the pinned install, which is still
  // running when the desktop asks.
  const home = tmpHome();
  const dropin = path.join(home, 't3.conf');
  let bin;
  let current = '0.1.13';
  let t3;
  const installer = fakeInstaller({ onInstall: () => { bin = installServer(home).bin; return { stdout: '' }; } });
  const tmux = fakeExec({
    onNewSession: async (args) => {
      const port = Number(/--port (\d+)/.exec(args.at(-1))[1]);
      t3 = fakeT3(current);
      await new Promise((r) => t3.listen(port, '127.0.0.1', r));
    },
    run: async (cmd, args) => {
      if (cmd === 'bash' && args[1] === '--release') { current = '0.1.14'; return { stdout: '' }; }
      if (cmd === bin && args[0] === '--version') return { stdout: `t3 v${current}\n` };
      return undefined;
    },
  });
  const execFile = (cmd, args, opts) => (cmd === 'bash' && args.length === 1 ? installer.execFile(cmd, args, opts) : tmux.execFile(cmd, args, opts));
  const pinned = createPinnedInstall({ installer: '/i', dropin, execFile });
  const release = createReleaseInstall({ installer: '/i', dropin, execFile });
  const bridge = createT3Bridge({ command: null, pinned, release, home, execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10 });
  try {
    const asked = bridge.update({ version: '0.1.14' });
    await flush();
    installer.release();
    const state = await asked;
    assert.equal(state.state, 'ready');
    assert.equal(state.version, '0.1.14');
    assert.deepEqual(installer.calls, [['bash', '/i']]);
    assert.deepEqual(tmux.calls.filter((c) => c[0] === 'bash').map((c) => c.slice(1)), [['/i', '--release', '0.1.14']]);
  } finally { t3?.close(); }
});

test('pinned install: idle waits out a retry the run in flight starts', async () => {
  // The owner's GitHub login lands mid-install: that run fails without it, and the retry it asked for succeeds.
  const home = tmpHome();
  let runs = 0;
  const installer = fakeInstaller({
    onInstall: () => {
      runs += 1;
      if (runs === 1) throw Object.assign(new Error('exit 3'), { stderr: 'gh: not logged in\n' });
      installServer(home);
      return { stdout: '' };
    },
  });
  const pinned = createPinnedInstall({ installer: '/i', dropin: path.join(home, 't3.conf'), execFile: installer.execFile });
  assert.equal(pinned.commandOrInstall(), null);
  pinned.retry();
  let settled = false;
  const idle = pinned.idle().then(() => { settled = true; });
  installer.release();
  await flush();
  assert.equal(settled, false);
  installer.release();
  await idle;
  assert.equal(runs, 2);
  assert.match(pinned.commandOrInstall(), /opt\/bin\/t3$/);
});

test('update: a server not answering when the install lands is restarted onto it', async () => {
  // It may still be coming up on the previous tree; with no answer there is
  // no turn to lose.
  const home = tmpHome();
  const { bin, dropin } = installServer(home);
  let current = '0.1.13';
  let server = silentServer();
  const port = await listen(server);
  keepPort(home, port);
  const tmux = fakeExec({
    session: true,
    onKillSession: () => new Promise((r) => { server.closeAll?.(); server.closeAllConnections?.(); server.close(() => r()); }),
    onNewSession: async () => {
      server = fakeT3(current);
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
    },
    run: async (cmd, args) => {
      if (cmd === 'bash' && args[1] === '--release') { current = '0.1.14'; return { stdout: '' }; }
      if (cmd === bin && args[0] === '--version') return { stdout: `t3 v${current}\n` };
      return undefined;
    },
  });
  const release = createReleaseInstall({ installer: '/i', dropin, execFile: tmux.execFile });
  const bridge = createT3Bridge({
    command: bin, release, home, execFile: tmux.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't', pollMs: 10, updateReadyWaitMs: 20,
  });
  try {
    const state = await bridge.update({ version: '0.1.14' });
    assert.equal(state.state, 'ready');
    assert.equal(state.version, '0.1.14');
    assert.equal(tmux.calls.filter((c) => c[1] === 'kill-session').length, 1);
  } finally { server.close(); }
});

test('update: an ensure in flight when the old server is killed is waited out, then the server starts', async () => {
  // A t3-ensure that found the old, silent server in the pane just before the
  // kill is still waiting on it; the restart must not join it and answer
  // "starting" with nothing launched.
  const home = tmpHome();
  const { bin, dropin } = installServer(home);
  let current = '0.1.13';
  let server = silentServer();
  const port = await listen(server);
  keepPort(home, port);
  let bridge;
  let stale;
  let killing = false;
  let checked;
  const heldChecked = new Promise((r) => { checked = r; });
  const tmux = fakeExec({
    session: true,
    beforeKill: async () => {
      killing = true;
      stale = bridge.ensure();
      await heldChecked;
    },
    onKillSession: () => new Promise((r) => { server.closeAll?.(); server.close(() => r()); }),
    onNewSession: async (args) => {
      server = fakeT3(current);
      await new Promise((r) => server.listen(Number(/--port (\d+)/.exec(args.at(-1))[1]), '127.0.0.1', r));
    },
    run: async (cmd, args) => {
      if (cmd === 'bash' && args[1] === '--release') { current = '0.1.14'; return { stdout: '' }; }
      if (cmd === bin && args[0] === '--version') return { stdout: `t3 v${current}\n` };
      if (killing && cmd === 'tmux' && args[0] === 'list-panes') setImmediate(checked);
      return undefined;
    },
  });
  const release = createReleaseInstall({ installer: '/i', dropin, execFile: tmux.execFile });
  bridge = createT3Bridge({
    command: bin, release, home, execFile: tmux.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't',
    pollMs: 10, updateReadyWaitMs: 20, ensureWaitMs: 1500,
  });
  try {
    const state = await bridge.update({ version: '0.1.14' });
    await stale;
    assert.equal(state.state, 'ready');
    assert.equal(state.version, '0.1.14');
    assert.equal(tmux.calls.filter((c) => c[1] === 'new-session').length, 1);
  } finally { server.close(); }
});

test("update: refuses a version that isn't x.y.z, an agent with no installer, and a box that runs its own t3", async () => {
  const box = await updatableBox({ running: '0.1.13', installed: '0.1.14', command: '/home/me/bin/t3-box-dev' });
  try {
    for (const version of [undefined, '0.1', '0.1.14-abc', '../0.1.14']) {
      await assert.rejects(box.bridge.update({ version }), /version must be x\.y\.z/);
    }
    await assert.rejects(box.bridge.update({ version: '0.1.14' }), /runs its own t3 \(\/home\/me\/bin\/t3-box-dev\)/);
    assert.deepEqual(box.calls.filter((c) => c[0] === 'bash' || c[1] === 'kill-session'), []);
  } finally { await box.close(); }
  const bare = createT3Bridge({ command: 't3', home: tmpHome(), execFile: fakeExec().execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  await assert.rejects(bare.update({ version: '0.1.14' }), /no installer/);
});

// Who drives a chat's session: `t3 thread … --json` on the box's own server.
function fakeThreadCli(answer) {
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push(args.join(' '));
    const out = answer(args);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { execFile, calls };
}
const cliError = (stderr) => Object.assign(new Error('Command failed'), { code: 1, stderr });

test('t3 thread: asks the box\'s own server about one thread, under its own t3 home', async () => {
  const home = tmpHome();
  const cli = fakeThreadCli((args) => {
    if (args[1] === 'session') return 'a log line\n{"threadId":"t1","sessionId":"sess-1","busy":false}\n';
    if (args[1] === 'release') return '{"result":"busy","sessionId":"sess-1"}';
    return '{\n  "result": "forked"\n}\n';
  });
  const bridge = createT3Bridge({ command: '/opt/t3', home, execFile: cli.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  assert.deepEqual(await bridge.threadSession({ threadId: 't1' }), { result: 'ok', sessionId: 'sess-1', busy: false });
  assert.deepEqual(await bridge.threadRelease({ threadId: 't1' }), { result: 'busy', sessionId: 'sess-1' });
  assert.deepEqual(await bridge.threadAdopt({ threadId: 't1', sessionId: 'sess-1' }), { result: 'forked' });
  const base = path.join(home, '.t3');
  assert.deepEqual(cli.calls, [
    `thread session --thread t1 --base-dir ${base} --json`,
    `thread release --thread t1 --base-dir ${base} --json`,
    `thread adopt --thread t1 --session sess-1 --base-dir ${base} --json`,
  ]);
});

test('t3 thread: a server without the command is unsupported, one not running is offline, anything else fails', async () => {
  const older = fakeThreadCli(() => cliError('ERRORS\n  Unknown subcommand "release" for "t3 thread"\n  Unrecognized flag: --thread\n'));
  const stopped = fakeThreadCli(() => cliError('No running T3 Code server uses /home/u/.t3\n'));
  const broken = fakeThreadCli(() => cliError('Segmentation fault\n'));
  const make = (cli) => createT3Bridge({ command: '/opt/t3', home: tmpHome(), execFile: cli.execFile, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  assert.deepEqual(await make(older).threadRelease({ threadId: 't1' }), { result: 'unsupported' });
  assert.deepEqual(await make(stopped).threadRelease({ threadId: 't1' }), { result: 'offline' });
  await assert.rejects(make(broken).threadRelease({ threadId: 't1' }), /Command failed/);
  const none = createT3Bridge({ command: null, home: tmpHome(), execFile: async () => { throw new Error('unused'); }, WebSocket, termagUrl: 'ws://x/termag/ws/agent', token: 't' });
  assert.deepEqual(await none.threadAdopt({ threadId: 't1', sessionId: 's' }), { result: 'unsupported' });
});

test('t3 thread: an answer it doesn\'t know is an error, never a release', () => {
  assert.throws(() => parseThreadOutput('release', '{"result":"maybe"}'), /answered "maybe"/);
  assert.throws(() => parseThreadOutput('adopt', 'no json here'), /printed no answer/);
  assert.deepEqual(parseThreadOutput('session', '{"threadId":"t1","sessionId":null,"busy":true}'), { result: 'ok', sessionId: null, busy: true });
});
