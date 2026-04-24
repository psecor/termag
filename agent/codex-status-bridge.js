#!/usr/bin/env node

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { CodexStatusTracker } = require('./codex-status-normalizer');

function parseArgs(argv) {
  const out = {
    session: null,
    cwd: process.cwd(),
    listenPort: null,
    listenOnly: false,
    model: null,
    approvalPolicy: null,
    mode: null,
    developerInstructions: null,
    prompt: null,
    statusEndpoint: 'http://127.0.0.1:3040/termag/api/status',
    statusBearerToken: null,
    timeoutMs: null,
    shortDecayMs: 3000,
    verboseServer: false,
    noPost: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--session') out.session = argv[++i];
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--listen-port') out.listenPort = Number(argv[++i]);
    else if (arg === '--listen-only') out.listenOnly = true;
    else if (arg === '--model') out.model = argv[++i];
    else if (arg === '--approval-policy') out.approvalPolicy = argv[++i];
    else if (arg === '--mode') out.mode = argv[++i];
    else if (arg === '--developer-instructions') out.developerInstructions = argv[++i];
    else if (arg === '--prompt') out.prompt = argv[++i];
    else if (arg === '--status-endpoint') out.statusEndpoint = argv[++i];
    else if (arg === '--status-bearer-token') out.statusBearerToken = argv[++i];
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (arg === '--short-decay-ms') out.shortDecayMs = Number(argv[++i]);
    else if (arg === '--verbose-server') out.verboseServer = true;
    else if (arg === '--no-post') out.noPost = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

function printHelp() {
  console.log(`Usage:
  node codex-status-bridge.js --session secorp-demo-agent --cwd /path/to/project
`);
}

function nowIso() {
  return new Date().toISOString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((err) => {
        if (err) reject(err);
        else if (!port) reject(new Error('Failed to allocate a free port'));
        else resolve(port);
      });
    });
  });
}

async function connectWebSocket(url, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const ws = await new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const onOpen = () => {
          cleanup();
          resolve(socket);
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const onClose = () => {
          cleanup();
          reject(new Error('WebSocket closed before open'));
        };
        const cleanup = () => {
          socket.removeEventListener('open', onOpen);
          socket.removeEventListener('error', onError);
          socket.removeEventListener('close', onClose);
        };
        socket.addEventListener('open', onOpen);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      });
      return ws;
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw lastError || new Error(`Timed out connecting to ${url}`);
}

class RpcClient {
  constructor(ws, onMessage) {
    this.ws = ws;
    this.onMessage = onMessage;
    this.nextId = 1;
    this.pending = new Map();
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.onMessage({ kind: 'parse_error', payload: { raw, error: String(error) } });
      return;
    }

    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.onMessage({ kind: 'server_request', payload: message });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.method) {
      this.onMessage({ kind: 'notification', payload: message });
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }
}

function buildDeveloperInstructions(args) {
  if (args.developerInstructions) return args.developerInstructions;
  if (args.mode) return `<collaboration_mode>${args.mode === 'plan' ? 'Plan' : 'Default'}</collaboration_mode>`;
  return undefined;
}

async function postStatus(endpoint, payload, bearerToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${endpoint} failed with ${res.status}: ${text}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.session) {
    throw new Error('--session is required');
  }

  const tracker = new CodexStatusTracker(args.session, { shortDecayMs: args.shortDecayMs });
  let lastPosted = null;
  let shuttingDown = false;
  const port = Number.isFinite(args.listenPort) && args.listenPort > 0 ? args.listenPort : await getFreePort();
  const url = `ws://127.0.0.1:${port}`;

  const server = spawn('codex', ['app-server', '--listen', url], {
    cwd: args.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', (chunk) => { if (args.verboseServer) process.stdout.write(`[server stdout] ${chunk}`); });
  server.stderr.on('data', (chunk) => { if (args.verboseServer) process.stderr.write(`[server stderr] ${chunk}`); });

  const ws = await connectWebSocket(url, 15000);
  const emitSnapshot = async (snapshot) => {
    const json = JSON.stringify(snapshot);
    if (!args.noPost && args.statusEndpoint && json !== lastPosted) {
      await postStatus(args.statusEndpoint, snapshot, args.statusBearerToken);
      lastPosted = json;
    }
  };

  const rpc = new RpcClient(ws, async (message) => {
    if (message.kind === 'notification') {
      const snapshot = tracker.ingestNotification(message.payload);
      await emitSnapshot(snapshot);
    } else if (message.kind === 'server_request') {
      const snapshot = tracker.ingestServerRequest(message.payload);
      await emitSnapshot(snapshot);
    }
  });
  ws.addEventListener('message', (event) => rpc.handleMessage(String(event.data)));

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await emitSnapshot(tracker.markNotRunning(`Bridge shutdown: ${reason}`));
    } catch {}
    try { ws.close(); } catch {}
    try { server.kill('SIGTERM'); } catch {}
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  await rpc.request('initialize', {
    clientInfo: { name: 'termag-codex-bridge', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });

  await emitSnapshot(tracker.markReady());

  if (!args.listenOnly) {
    const threadParams = {
      cwd: path.resolve(args.cwd),
      ephemeral: true,
    };
    if (args.model) threadParams.model = args.model;
    if (args.approvalPolicy) threadParams.approvalPolicy = args.approvalPolicy;
    const developerInstructions = buildDeveloperInstructions(args);
    if (developerInstructions) threadParams.developerInstructions = developerInstructions;

    const threadResp = await rpc.request('thread/start', threadParams);

    if (args.prompt) {
      const turnParams = {
        threadId: threadResp.thread.id,
        input: [{ type: 'text', text: args.prompt }],
      };
      if (args.model) turnParams.model = args.model;
      if (args.approvalPolicy) turnParams.approvalPolicy = args.approvalPolicy;
      await rpc.request('turn/start', turnParams);
    }
  }

  if (args.timeoutMs) {
    setTimeout(() => { void shutdown('timeout'); }, args.timeoutMs);
  }

  while (!shuttingDown) {
    await wait(1000);
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
