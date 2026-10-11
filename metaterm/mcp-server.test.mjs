// Tests for metaterm/mcp-server.mjs. No dependencies: `node --test metaterm/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baseUrlFromAgentUrl, resolveBaseUrl, resolveToken, configCandidates, loadAgentConfig,
  sendKeysSetting, findProjectSetting, isSelfTarget, toolsFor, createServer,
} from './mcp-server.mjs';

const SERVER = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));

function files(map) {
  return (p) => {
    if (p in map) return map[p];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
}

test('baseUrlFromAgentUrl maps the agent websocket URL to the API base', () => {
  assert.equal(baseUrlFromAgentUrl('wss://orch.example/termag/ws/agent'), 'https://orch.example/termag');
  assert.equal(baseUrlFromAgentUrl('ws://127.0.0.1:3041/termag/ws/agent?token=x'), 'http://127.0.0.1:3041/termag');
  assert.equal(baseUrlFromAgentUrl('https://orch.example/termag'), null);
  assert.equal(baseUrlFromAgentUrl(undefined), null);
});

test('resolveBaseUrl: TERMAG_URL wins, then the agent config, then the co-located default', () => {
  const cfg = { cfg: { termag_url: 'wss://orch.example/termag/ws/agent' } };
  assert.equal(resolveBaseUrl({ TERMAG_URL: 'http://x/termag/' }, cfg), 'http://x/termag');
  assert.equal(resolveBaseUrl({}, cfg), 'https://orch.example/termag');
  assert.equal(resolveBaseUrl({}, null), 'http://localhost:3040/termag');
});

test('config search order matches deploy/termag-status', () => {
  assert.deepEqual(configCandidates({ TERMAG_AGENT_CONFIG: '/o.json' }, '/h'), [
    '/o.json',
    '/h/src/termag/agent/agent.config.json',
    '/h/.termag/agent.config.json',
    '/h/.config/termag/agent.config.json',
  ]);
  const box = loadAgentConfig({}, '/h', files({
    '/h/src/termag/agent/agent.config.json': '{"token":"tmag_box","termag_url":"wss://o/termag/ws/agent"}',
    '/h/.termag/agent.config.json': '{"token":"tmag_other"}',
  }));
  assert.equal(box.path, '/h/src/termag/agent/agent.config.json');
  assert.equal(resolveToken({}, box), 'tmag_box');
  assert.equal(resolveToken({ TERMAG_TOKEN: 'tmag_env' }, box), 'tmag_env');
  assert.throws(() => resolveToken({}, null), /no agent token/);
});

test('send_keys is on by default, so the orchestrator MetaTerm keeps it', () => {
  const s = sendKeysSetting({ env: {}, cwd: '/h/p', home: '/h', read: files({}) });
  assert.deepEqual(s, { enabled: true, source: 'default' });
  assert.deepEqual(toolsFor(s).map(t => t.name), ['list_sessions', 'capture_pane', 'session_status', 'send_keys']);
});

test('the box registration default turns send_keys off', () => {
  const s = sendKeysSetting({ env: { METATERM_SEND_KEYS_DEFAULT: 'off' }, cwd: '/h/p', home: '/h', read: files({}) });
  assert.equal(s.enabled, false);
  assert.deepEqual(toolsFor(s).map(t => t.name), ['list_sessions', 'capture_pane', 'session_status']);
});

test('a project opts in with .claude/metaterm.json, found from a subdirectory', () => {
  const read = files({ '/h/p/.claude/metaterm.json': '{"sendKeys": true}' });
  const s = sendKeysSetting({ env: { METATERM_SEND_KEYS_DEFAULT: 'off' }, cwd: '/h/p/src/deep', home: '/h', read });
  assert.deepEqual(s, { enabled: true, source: '/h/p/.claude/metaterm.json' });
});

test('the session switch beats the project file, both ways', () => {
  const on = files({ '/h/p/.claude/metaterm.json': '{"sendKeys": true}' });
  assert.equal(sendKeysSetting({ env: { METATERM_SEND_KEYS: 'off' }, cwd: '/h/p', home: '/h', read: on }).enabled, false);
  const off = files({ '/h/p/.claude/metaterm.json': '{"sendKeys": false}' });
  assert.equal(sendKeysSetting({ env: { METATERM_SEND_KEYS: 'on', METATERM_SEND_KEYS_DEFAULT: 'off' }, cwd: '/h/p', home: '/h', read: off }).enabled, true);
});

test('the project search stops at home and ignores unparseable values', () => {
  const read = files({ '/.claude/metaterm.json': '{"sendKeys": true}', '/h/p/.claude/metaterm.json': '{"sendKeys": "maybe"}' });
  assert.equal(findProjectSetting('/h/p', '/h', read).path, '/h/p/.claude/metaterm.json');
  assert.equal(sendKeysSetting({ env: { METATERM_SEND_KEYS_DEFAULT: 'off' }, cwd: '/h/p', home: '/h', read }).enabled, false);
});

test('isSelfTarget needs the same session on the caller host', () => {
  assert.equal(isSelfTarget({ session: 'u-p-agent', onCallerHost: true }, 'u-p-agent'), true);
  assert.equal(isSelfTarget({ session: 'u-p-agent', onCallerHost: false }, 'u-p-agent'), false);
  // An older backend sends no onCallerHost; the name alone refuses.
  assert.equal(isSelfTarget({ session: 'u-p-agent' }, 'u-p-agent'), true);
  assert.equal(isSelfTarget({ session: 'u-p-ctrl', onCallerHost: true }, 'u-p-agent'), false);
  assert.equal(isSelfTarget(undefined, 'u-p-agent'), false);
  assert.equal(isSelfTarget({ session: 'u-p-agent' }, null), false);
});

// ── dispatcher against a scripted fetch ────────────────────────────────────
const ROWS = [
  { projectId: 'p1', projectName: 'sample', owner: 'u', access: 'owner', workstream: 'main', role: 'agent', session: 'u-sample-agent', instanceId: 'i-1', onCallerHost: true, connected: true, alive: true, status: 'idle' },
  { projectId: 'p2', projectName: 'sample', owner: 'u', access: 'owner', workstream: 'main', role: 'agent', session: 'u-sample-agent', instanceId: 'i-2', onCallerHost: false, connected: true, alive: true, status: 'working' },
];

function scripted(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
    const path = new URL(url).pathname;
    const [status, body, ct = 'application/json'] = routes(path, init) ?? [404, { error: 'nope' }];
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, ok: status < 400, statusText: '', text: async () => text, headers: { get: () => ct } };
  };
  return { fetchFn, calls };
}

function server(routes, extra = {}) {
  const s = scripted(routes);
  const srv = createServer({
    env: {},
    fetch: s.fetchFn,
    loadAgentConfig: () => ({ path: '/cfg', cfg: { token: 'tmag_box', termag_url: 'wss://o/termag/ws/agent' } }),
    ownSession: () => null,
    sendKeys: { enabled: true, source: 'test' },
    ...extra,
  });
  return { srv, calls: s.calls };
}

test('list_sessions uses the box token and URL, and marks this host', async () => {
  const { srv, calls } = server((p) => (p === '/termag/api/sessions' ? [200, ROWS] : null));
  const text = await srv.callTool('list_sessions');
  assert.equal(calls[0].url, 'https://o/termag/api/sessions');
  assert.equal(calls[0].auth, 'Bearer tmag_box');
  assert.match(text, /box=i-1 \(this host\)/);
  assert.doesNotMatch(text, /box=i-2 \(this host\)/);
});

test('send_keys refuses when switched off, before any HTTP call', async () => {
  const { srv, calls } = server(() => [200, {}], { sendKeys: { enabled: false, source: 'x' } });
  await assert.rejects(srv.callTool('send_keys', { projectId: 'p2', role: 'agent', keys: 'hi' }), /send_keys is off/);
  assert.equal(calls.length, 0);
  const listed = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(!listed.result.tools.some(t => t.name === 'send_keys'));
});

test('send_keys refuses its own pane but reaches the same-named session on another box', async () => {
  const routes = (p) => {
    if (p === '/termag/api/sessions') return [200, ROWS];
    if (p.endsWith('/send-keys')) return [200, { ok: true, session: 'u-sample-agent' }];
    return null;
  };
  const { srv, calls } = server(routes, { ownSession: () => 'u-sample-agent' });
  await assert.rejects(srv.callTool('send_keys', { projectId: 'p1', role: 'agent', keys: 'x' }), /session this Claude is running in/);
  assert.ok(!calls.some(c => c.url.endsWith('/send-keys')));
  const ok = await srv.callTool('send_keys', { projectId: 'p2', role: 'agent', keys: "it's", enter: false });
  assert.equal(ok, 'sent to u-sample-agent');
  const sent = calls.find(c => c.url.endsWith('/send-keys'));
  assert.deepEqual(sent.body, { workstream: 'main', keys: "it's", enter: false, literal: true });
});

test('a 401 explains itself; a non-JSON body is an error, not an empty list', async () => {
  const unauth = server(() => [401, { error: 'Unauthorized' }]).srv;
  await assert.rejects(unauth.callTool('list_sessions'), /not accepted.*not been claimed/);
  const spa = server(() => [200, '<!doctype html>', 'text/html']).srv;
  await assert.rejects(spa.callTool('list_sessions'), /non-JSON/);
});

test('tools/call errors come back as isError results, unknown methods as JSON-RPC errors', async () => {
  const { srv } = server(() => [503, { error: "Owner's agent is offline" }]);
  const r = await srv.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'capture_pane', arguments: { projectId: 'p', role: 'ctrl' } } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /offline/);
  assert.equal((await srv.handle({ jsonrpc: '2.0', id: 8, method: 'nope' })).error.code, -32601);
  assert.equal(await srv.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('an edge sign-in redirect is reported as one, not followed into its HTML page', async () => {
  const idpSeen = [];
  const idp = createHttpServer((req, res) => {
    idpSeen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Sign In</title>');
  });
  await new Promise(r => idp.listen(0, '127.0.0.1', r));
  const idpUrl = `http://127.0.0.1:${idp.address().port}/oauth2/v1/authorize?client_id=x`;
  const alb = createHttpServer((_req, res) => { res.writeHead(302, { location: idpUrl }); res.end(); });
  await new Promise(r => alb.listen(0, '127.0.0.1', r));
  try {
    const srv = createServer({
      env: { TERMAG_URL: `http://127.0.0.1:${alb.address().port}/termag`, TERMAG_TOKEN: 'tmag_box' },
      loadAgentConfig: () => null,
      ownSession: () => null,
      sendKeys: { enabled: false, source: 'test' },
    });
    await assert.rejects(srv.callTool('list_sessions'),
      new RegExp(`GET /sessions → 302 redirect to 127\\.0\\.0\\.1:${idp.address().port}/oauth2/v1/authorize`));
    assert.deepEqual(idpSeen, []);
  } finally {
    alb.close();
    idp.close();
  }
});

// ── the real process, over stdio, against a real HTTP server ───────────────
async function withBackend(fn) {
  const seen = [];
  const http = createHttpServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/termag/api/sessions' ? ROWS : { error: 'nope' }));
  });
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  try { return await fn(http.address().port, seen); } finally { http.close(); }
}

function rpc(env, cwd, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))));
    child.stdin.end(messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  });
}

test('over stdio: a box config is enough, and a project file opts into send_keys', async () => {
  const home = mkdtempSync(join(tmpdir(), 'metaterm-'));
  try {
    await withBackend(async (port, seen) => {
      mkdirSync(join(home, '.termag'), { recursive: true });
      writeFileSync(join(home, '.termag', 'agent.config.json'),
        JSON.stringify({ termag_url: `ws://127.0.0.1:${port}/termag/ws/agent`, token: 'tmag_box' }));
      const project = join(home, 'proj');
      mkdirSync(join(project, '.claude'), { recursive: true });
      const env = { PATH: process.env.PATH, HOME: home, METATERM_SEND_KEYS_DEFAULT: 'off' };
      const msgs = [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } },
      ];

      const [list, call] = await rpc(env, project, msgs);
      assert.deepEqual(list.result.tools.map(t => t.name), ['list_sessions', 'capture_pane', 'session_status']);
      assert.match(call.result.content[0].text, /2 session\(s\)/);
      assert.deepEqual(seen[0], { url: '/termag/api/sessions', auth: 'Bearer tmag_box' });

      writeFileSync(join(project, '.claude', 'metaterm.json'), '{"sendKeys": true}\n');
      const [optedIn] = await rpc(env, project, msgs.slice(0, 1));
      assert.ok(optedIn.result.tools.some(t => t.name === 'send_keys'));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
