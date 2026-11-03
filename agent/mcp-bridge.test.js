const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createBridge, tokenFrom, requestIds } = require('./mcp-bridge');

const TOKEN = 'tmag_sentinel_7f3e'; // gitleaks:allow

// A Streamable HTTP server that wants the box token: initialize hands out a
// session, tools/call `slow` answers as SSE, `refuse` as the broker's 403.
function upstream() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      calls.push({ method: req.method, auth: req.headers.authorization === `Bearer ${TOKEN}`, session: req.headers['mcp-session-id'] || null, protocol: req.headers['mcp-protocol-version'] || null });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'refused' } }));
        return;
      }
      if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      const msg = JSON.parse(body);
      if (!('method' in msg) || msg.method.startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }));
        return;
      }
      if (msg.method === 'tools/call' && msg.params.name === 'slow') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
        setTimeout(() => {
          res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'slow done' }] } })}\r\n\r\n`);
        }, 30);
        return;
      }
      if (msg.method === 'tools/call' && msg.params.name === 'refuse') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'MCP server "x" is not linked. Link it at https://t/settings' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo' }] } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/c/abc` });
  }));
}

function harness(url, readToken = () => TOKEN) {
  const out = [];
  const logs = [];
  const bridge = createBridge({ url, readToken, send: m => out.push(m), log: l => logs.push(l) });
  return { bridge, out, logs };
}

const line = m => JSON.stringify(m);

test('forwards a session with the box token on every request, and the session id and protocol after initialize', async (t) => {
  const up = await upstream();
  t.after(() => up.server.close());
  const { bridge, out } = harness(up.url);
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  await bridge.handleLine(line({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  await bridge.close();
  assert.deepStrictEqual(out.map(m => m.id), [1, 2]);
  assert.strictEqual(out[1].result.tools[0].name, 'echo');
  const posts = up.calls.filter(c => c.method === 'POST');
  assert.ok(up.calls.every(c => c.auth));
  assert.deepStrictEqual(posts.map(c => c.session), [null, 'sess-1', 'sess-1']);
  assert.deepStrictEqual(posts.map(c => c.protocol), [null, '2025-06-18', '2025-06-18']);
  assert.ok(up.calls.some(c => c.method === 'DELETE' && c.session === 'sess-1'), 'the session is ended on close');
});

test('passes an SSE answer through as it streams, notifications first', async (t) => {
  const up = await upstream();
  t.after(() => up.server.close());
  const { bridge, out } = harness(up.url);
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow' } }));
  assert.deepStrictEqual(out.map(m => m.method || m.id), ['notifications/progress', 7]);
  assert.strictEqual(out[1].result.content[0].text, 'slow done');
});

test("answers a refused request with the broker's own message, never the token", async (t) => {
  const up = await upstream();
  t.after(() => up.server.close());
  const { bridge, out, logs } = harness(up.url);
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'refuse' } }));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 3);
  assert.match(out[0].error.message, /is not linked/);
  assert.deepStrictEqual(out[0].error.data, { status: 403 });
  assert.ok(!JSON.stringify({ out, logs }).includes(TOKEN));
});

test("passes an upstream's JSON-RPC error body on", async (t) => {
  const up = await upstream();
  t.after(() => up.server.close());
  const { bridge, out } = harness(up.url, () => 'tmag_wrong');
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 4, method: 'tools/list' }));
  assert.strictEqual(out[0].error.message, 'refused');
});

test('a missing token answers the request with an error naming the file only', async (t) => {
  const up = await upstream();
  t.after(() => up.server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-bridge-'));
  const cfg = path.join(dir, 'agent.config.json');
  fs.writeFileSync(cfg, '{}');
  const { bridge, out } = harness(up.url, () => tokenFrom(cfg));
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }));
  assert.strictEqual(out[0].id, 'a');
  assert.match(out[0].error.message, /no agent token in .*agent\.config\.json/);
  assert.strictEqual(up.calls.length, 0);
});

test('reads the token on each request, so a rotation reaches the next one', async (t) => {
  const up = await upstream();
  t.after(() => up.server.close());
  let token = 'tmag_old';
  const { bridge, out } = harness(up.url, () => token);
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  token = TOKEN;
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  assert.ok(out[0].error);
  assert.ok(out[1].result);
});

// A broker whose GET stream stays open until it is aborted, and hands out a
// new session id on every initialize.
function streamingFetch() {
  const gets = [];
  let n = 0;
  const fetchImpl = async (url, { method, headers, body, signal }) => {
    if (method === 'GET') {
      const get = { session: headers['mcp-session-id'], aborted: false };
      let push;
      const stream = new ReadableStream({ start(c) { push = c; } });
      get.push = (m) => push.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(m)}\n\n`));
      signal.addEventListener('abort', () => { get.aborted = true; push.error(new Error('aborted')); });
      gets.push(get);
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (method === 'DELETE') return new Response(null, { status: 200 });
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      n += 1;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }),
        { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': `sess-${n}` } });
    }
    return new Response(null, { status: 202 });
  };
  return { fetchImpl, gets };
}

test('a second initialize ends the old GET stream and opens one for the new session', async () => {
  const { fetchImpl, gets } = streamingFetch();
  const out = [];
  const bridge = createBridge({ url: 'https://broker.test/c/x', readToken: () => TOKEN, fetchImpl, send: m => out.push(m) });
  const settle = () => new Promise(r => setTimeout(r, 20));
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  await bridge.handleLine(line({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  await settle();
  assert.deepStrictEqual(gets.map(g => g.session), ['sess-1']);
  await bridge.handleLine(line({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }));
  await bridge.handleLine(line({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  await settle();
  assert.ok(gets[0].aborted, "the old session's stream is ended");
  assert.deepStrictEqual(gets.map(g => g.session), ['sess-1', 'sess-2']);
  gets[1].push({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  await settle();
  assert.ok(out.some(m => m.method === 'notifications/tools/list_changed'), "the new session's messages reach the agent");
  await bridge.close();
});

test('an unreachable broker answers every request in the message', async () => {
  const { bridge, out } = harness('http://127.0.0.1:9/c/x');
  await bridge.handleLine(line([{ jsonrpc: '2.0', id: 1, method: 'a' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'b' }]));
  assert.deepStrictEqual(out.map(m => m.id), [1, 2]);
  assert.match(out[0].error.message, /unreachable/);
});

test('requestIds skips notifications and responses', () => {
  assert.deepStrictEqual(requestIds({ jsonrpc: '2.0', id: 0, method: 'x' }), [0]);
  assert.deepStrictEqual(requestIds([{ id: 1, result: {} }, { method: 'n' }, { id: 'q', method: 'm' }]), ['q']);
});

test('the command runs a whole session over stdio', async (t) => {
  const up = await upstream();
  t.after(() => up.server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termag-bridge-'));
  const cfg = path.join(dir, 'agent.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ token: TOKEN }));
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-bridge.js'), up.url, cfg], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.stdin.write(`${line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  child.stdin.write(`${line({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${line({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } })}\n`);
  child.stdin.end(`${line({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.strictEqual(code, 0, stderr);
  const msgs = stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(msgs.filter(m => m.id !== undefined).map(m => m.id).sort(), [1, 2, 3]);
  assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN));
});
