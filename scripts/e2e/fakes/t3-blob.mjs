#!/usr/bin/env node
// Stand-in t3 server for the relay's slow-client check (t3-slow-relay.test.sh),
// run by the box agent as E2E_T3_COMMAND: `t3-blob.mjs serve --host 127.0.0.1
// --port N …`, other flags ignored. It answers the descriptor the agent probes
// for (agent/t3-bridge.js probeT3) and GET /blob?mb=N: N MiB of a fixed 1 MiB
// pattern, byte i = (31i + 7) mod 256 (the test hashes the same), with Content-Length,
// written with backpressure. `auth …` commands fail: nothing here pairs.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
if (args[0] !== 'serve') { console.error('t3-blob: only `serve`'); process.exit(1); }
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const MiB = 1024 * 1024;
const pattern = Buffer.alloc(MiB);
for (let i = 0; i < MiB; i++) pattern[i] = (i * 31 + 7) & 0xff;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/.well-known/t3/environment') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ environmentId: 'e2e-t3-blob', serverVersion: '0.0.0-blob' }));
    return;
  }
  if (url.pathname !== '/blob') { res.writeHead(404).end(); return; }
  const mb = Math.max(0, Math.min(1024, Math.floor(Number(url.searchParams.get('mb')) || 0)));
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': mb * MiB });
  let left = mb;
  const pump = () => {
    while (left > 0) {
      left--;
      if (!res.write(pattern)) { res.once('drain', pump); return; }
    }
    res.end();
  };
  res.on('close', () => { left = 0; });
  pump();
}).listen(Number(flag('--port')), flag('--host') ?? '127.0.0.1', () => {
  console.error(`t3-blob listening on ${flag('--host') ?? '127.0.0.1'}:${flag('--port')}`);
});
