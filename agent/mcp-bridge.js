#!/usr/bin/env node
// termag-mcp-bridge: one termag MCP connector as a stdio MCP server.
//
//
// Claude Code reaches the MCP broker over Streamable HTTP and mints its
// Authorization header per request with termag-mcp-headers. No other agent
// CLI can run a header helper: the most they take is a static header or an
// environment variable read once at start, which would put the box token in
// their config or in the environment of every command they run. So the box
// registers this bridge with them as a stdio server instead. It speaks MCP
// over stdin/stdout to the agent and forwards every message to the broker's
// /c/<id> URL, reading the box token from the agent config on each request
// (a rotated token is picked up at once). Nothing is stored, and neither the
// token nor a header is ever logged; stderr gets only HTTP statuses.
//
// Usage: node mcp-bridge.js <broker>/c/<id> <agent.config.json>
//
// stdout is the JSON-RPC channel: nothing but a message may be written there.

const fs = require('node:fs');

const PROTOCOL_HEADER = 'mcp-protocol-version';
const SESSION_HEADER = 'mcp-session-id';
// Reconnect delays for the optional GET stream (server-initiated messages).
const STREAM_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];

/** The box token, read fresh each time; throws without naming a value. */
function tokenFrom(configPath, readFile = fs.readFileSync) {
  let token;
  try {
    token = JSON.parse(readFile(configPath, 'utf8')).token;
  } catch {
    throw new Error(`cannot read the agent config ${configPath}`);
  }
  if (typeof token !== 'string' || !token) throw new Error(`no agent token in ${configPath}`);
  return token;
}

/** Ids of the requests in one JSON-RPC message or batch (responses and notifications have none). */
function requestIds(msg) {
  const all = Array.isArray(msg) ? msg : [msg];
  return all.filter(m => m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null)
    .map(m => m.id);
}

function rpcError(id, message, data) {
  return { jsonrpc: '2.0', id, error: { code: -32000, message, ...(data ? { data } : {}) } };
}

/** Calls onEvent(data) for every SSE event with data, as the stream arrives. */
async function readSse(body, onEvent) {
  const decoder = new TextDecoder();
  let buf = '';
  let data = [];
  const line = (l) => {
    if (l === '') {
      if (data.length) onEvent(data.join('\n'));
      data = [];
    } else if (l.startsWith('data:')) {
      data.push(l.slice(5).replace(/^ /, ''));
    }
    // id:, event:, retry: and comments carry nothing the client needs here.
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r\n|\n|\r/)) >= 0) {
      const sep = buf.startsWith('\r\n', i) ? 2 : 1;
      line(buf.slice(0, i));
      buf = buf.slice(i + sep);
    }
  }
  buf += decoder.decode();
  if (buf) line(buf);
  line('');
}

/**
 * The bridge's state machine, with its I/O injected for tests. `send` writes
 * one message to the agent, `log` one line to stderr.
 */
function createBridge({ url, readToken, fetchImpl = fetch, send, log = () => {}, streamBackoff = STREAM_BACKOFF_MS }) {
  let session = null;
  let protocol = null;
  let closed = false;
  let stream = null;

  function headers(extra = {}) {
    const h = { authorization: `Bearer ${readToken()}`, ...extra };
    if (session) h[SESSION_HEADER] = session;
    if (protocol) h[PROTOCOL_HEADER] = protocol;
    return h;
  }

  function emit(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { log('dropped a message from the broker that is not JSON'); return; }
    // A batch answer is passed on as it came; stdio carries batches too.
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m && m.result && typeof m.result.protocolVersion === 'string' && !protocol) protocol = m.result.protocolVersion;
    }
    send(msg);
  }

  async function post(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const ids = requestIds(msg);
    const methods = (Array.isArray(msg) ? msg : [msg]).map(m => m && m.method);
    const isInitialize = methods.includes('initialize');
    const isInitialized = methods.includes('notifications/initialized');
    // A new initialize starts a new session: the old one's GET stream goes
    // with it, or it would keep the slot and never reopen for the new one.
    if (isInitialize) { session = null; protocol = null; dropStream(); }
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
        body: line,
      });
    } catch (err) {
      log(`the MCP broker is unreachable: ${err.message}`);
      for (const id of ids) send(rpcError(id, `termag MCP broker unreachable: ${err.message}`));
      return;
    }
    const sid = res.headers.get(SESSION_HEADER);
    if (sid && isInitialize) session = sid;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && type.includes('text/event-stream') && res.body) {
      const answered = new Set();
      await readSse(res.body, (data) => {
        try {
          const m = JSON.parse(data);
          for (const r of Array.isArray(m) ? m : [m]) if (r && r.id !== undefined && !r.method) answered.add(r.id);
        } catch { /* emit drops it */ }
        emit(data);
      }).catch(err => log(`the broker's event stream broke: ${err.message}`));
      for (const id of ids) if (!answered.has(id)) send(rpcError(id, 'termag MCP broker closed the stream without an answer'));
      return;
    }
    const text = await res.text().catch(() => '');
    if (res.ok) {
      if (text.trim()) emit(text);
      else for (const id of ids) send(rpcError(id, `termag MCP broker answered HTTP ${res.status} with no body`));
      // Once the client says it is initialized, the server may start messages.
      if (isInitialized) openStream();
      return;
    }
    log(`the MCP broker answered HTTP ${res.status}`);
    if (res.status === 404 && session) {
      // The upstream dropped the session; the agent has to initialize again.
      session = null;
      dropStream();
    }
    // The broker's refusals carry the reason as {message} (ext_authz: "MCP
    // server "x" is not linked. Link it at …", "Unknown or revoked box
    // token"), an upstream's as a JSON-RPC error; the agent gets either.
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const reason = (body && body.error && typeof body.error.message === 'string' && body.error.message)
      || (body && typeof body.message === 'string' && body.message)
      || `termag MCP broker answered HTTP ${res.status}`;
    for (const id of ids) send(rpcError(id, reason, { status: res.status }));
  }

  function dropStream() {
    if (stream) stream.abort();
    stream = null;
  }

  // The optional GET stream for messages the server starts. A 405 means the
  // server has none; anything else is retried with a backoff while the
  // session lasts.
  function openStream(attempt = 0) {
    if (closed || stream || !session) return;
    const controller = new AbortController();
    stream = controller;
    const current = session;
    (async () => {
      let res;
      try {
        res = await fetchImpl(url, { method: 'GET', headers: headers({ accept: 'text/event-stream' }), signal: controller.signal });
      } catch {
        res = null;
      }
      // Once dropped, the slot may already hold the next session's stream.
      const release = () => { if (stream === controller) stream = null; };
      if (res && res.status === 405) { release(); return; }
      if (res && res.ok && res.body) {
        attempt = 0;
        await readSse(res.body, emit).catch(() => {});
      } else if (res) {
        await res.text().catch(() => '');
      }
      release();
      if (closed || session !== current || (res && (res.status === 404 || res.status === 401 || res.status === 403))) return;
      const delay = streamBackoff[Math.min(attempt, streamBackoff.length - 1)];
      setTimeout(() => openStream(attempt + 1), delay).unref?.();
    })();
  }

  async function close() {
    closed = true;
    if (stream) stream.abort();
    if (!session) return;
    try {
      await fetchImpl(url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(3000) });
    } catch { /* best effort */ }
  }

  return {
    handleLine(line) {
      if (!line.trim()) return Promise.resolve();
      return post(line).catch(err => {
        // readToken's message names the file, never a value.
        log(err.message);
        try {
          for (const id of requestIds(JSON.parse(line))) send(rpcError(id, `termag-mcp-bridge: ${err.message}`));
        } catch { /* nothing to answer */ }
      });
    },
    close,
    get session() { return session; },
  };
}

function main(argv) {
  const [url, config] = argv;
  if (!url || !/^https?:\/\//.test(url) || !config) {
    process.stderr.write('usage: termag-mcp-bridge <broker>/c/<id> <agent.config.json>\n');
    process.exit(2);
  }
  const log = (m) => process.stderr.write(`termag-mcp-bridge: ${m}\n`);
  const bridge = createBridge({
    url,
    readToken: () => tokenFrom(config),
    send: (m) => process.stdout.write(`${JSON.stringify(m)}\n`),
    log,
  });
  const pending = new Set();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      // Each request runs on its own: a slow tool call never holds up the next.
      const p = bridge.handleLine(line);
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  });
  process.stdin.on('end', async () => {
    if (buf.trim()) pending.add(bridge.handleLine(buf));
    await Promise.allSettled([...pending]);
    await bridge.close();
    process.exit(0);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { bridge.close().finally(() => process.exit(0)); });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { createBridge, tokenFrom, requestIds, readSse };
