#!/usr/bin/env node
'use strict';
// Stand-in box services for forward.test.sh, and the laptop-side clients that
// talk to them through `termag forward`. CommonJS so `ws` resolves through
// NODE_PATH (backend/node_modules).
//
//   forward-stand-ins.cjs serve <http> <ws> <half> <greet>
//       on 127.0.0.1, as the test's own uid (the agent's port guard allows only that):
//       <http>   GET /blob?mb=N: N MiB of a fixed 1 MiB pattern, byte i =
//                (31i + 7) mod 256, as fakes/t3-blob.mjs serves; any other
//                path answers "hello from the box\n"
//       <ws>     a WebSocket echo (an HMR socket's stand-in)
//       <half>   reads to EOF, then writes "got <n> bytes: <data>" and ends
//       <greet>  writes "SSH-2.0-e2e-greeting\r\n" the moment it accepts,
//                before the client says anything, then echoes
//   forward-stand-ins.cjs ws <port>        prints the echo of two messages, text and binary
//   forward-stand-ins.cjs half <port>      writes, half-closes, prints the reply and "eof"
//   forward-stand-ins.cjs greet <port>     prints the greeting read before writing, then an echo
//   forward-stand-ins.cjs hold <port> <seconds> <every>
//                                          a WebSocket held open for <seconds>, an echo
//                                          every <every> seconds; prints "held <n> echoes"
//                                          or how it ended early
// Each client gives up after 20 s (hold: after <seconds> + 20) and prints "timeout".
const net = require('node:net');
const http = require('node:http');

const [mode, ...rest] = process.argv.slice(2);
const MiB = 1024 * 1024;
const done = (line) => { console.log(line); process.exit(0); };

function serve([httpPort, wsPort, halfPort, greetPort]) {
  const { WebSocketServer } = require('ws');
  const pattern = Buffer.alloc(MiB);
  for (let i = 0; i < MiB; i++) pattern[i] = (i * 31 + 7) & 0xff;

  http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/blob') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from the box\n');
      return;
    }
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
  }).listen(Number(httpPort), '127.0.0.1');

  const wsHttp = http.createServer((_req, res) => res.writeHead(426).end());
  new WebSocketServer({ server: wsHttp }).on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  wsHttp.listen(Number(wsPort), '127.0.0.1');

  net.createServer({ allowHalfOpen: true }, (sock) => {
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      const got = Buffer.concat(chunks);
      sock.end(`got ${got.length} bytes: ${got.toString('utf8')}`);
    });
    sock.on('error', () => {});
  }).listen(Number(halfPort), '127.0.0.1');

  net.createServer((sock) => {
    sock.write('SSH-2.0-e2e-greeting\r\n');
    sock.pipe(sock);
    sock.on('error', () => {});
  }).listen(Number(greetPort), '127.0.0.1');

  console.error(`forward stand-ins: http ${httpPort}, ws ${wsPort}, half-close ${halfPort}, greeting ${greetPort}`);
}

function wsClient(port) {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`);
  const got = [];
  ws.on('open', () => { ws.send('hello hmr'); ws.send(Buffer.from([0, 1, 2, 255])); });
  ws.on('message', (data, isBinary) => {
    got.push(isBinary ? `binary:${Buffer.from(data).toString('hex')}` : `text:${data}`);
    if (got.length === 2) { ws.close(1000); done(got.join(' ')); }
  });
  ws.on('unexpected-response', (_q, res) => done(`http ${res.statusCode}`));
  ws.on('error', (e) => done(`error ${e.message}`));
}

function halfClient(port) {
  const sock = net.connect({ host: '127.0.0.1', port: Number(port), allowHalfOpen: true });
  const chunks = [];
  sock.on('connect', () => { sock.write('half-close please'); sock.end(); });
  sock.on('data', (c) => chunks.push(c));
  sock.on('end', () => done(`${Buffer.concat(chunks).toString('utf8')} | eof`));
  sock.on('error', (e) => done(`error ${e.code ?? e.message}`));
}

function greetClient(port) {
  const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
  let greeting = null;
  let echo = '';
  sock.on('data', (c) => {
    if (greeting === null) {
      greeting = c.toString('utf8').trim();
      sock.write('client speaks second\n');
      return;
    }
    echo += c.toString('utf8');
    if (echo.endsWith('\n')) { sock.destroy(); done(`${greeting} | ${echo.trim()}`); }
  });
  sock.on('end', () => done(`ended early: ${greeting ?? 'no greeting'}`));
  sock.on('error', (e) => done(`error ${e.code ?? e.message}`));
}

function holdClient(port, seconds, every) {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/hold`);
  let echoes = 0;
  let sent = 0;
  const started = Date.now();
  ws.on('open', () => {
    const tick = setInterval(() => {
      if (Date.now() - started >= Number(seconds) * 1000) {
        clearInterval(tick);
        done(echoes === sent ? `held ${echoes} echoes` : `held, but ${sent - echoes} of ${sent} echoes missing`);
      }
      ws.send(`tick ${++sent}`);
    }, Number(every) * 1000);
  });
  ws.on('message', () => { echoes++; });
  ws.on('close', (code) => done(`closed ${code} after ${Math.round((Date.now() - started) / 1000)} s, ${echoes} echoes`));
  ws.on('unexpected-response', (_q, res) => done(`http ${res.statusCode}`));
  ws.on('error', (e) => done(`error ${e.message}`));
}

const clients = { ws: wsClient, half: halfClient, greet: greetClient };
if (mode === 'serve') {
  serve(rest);
} else if (mode === 'hold') {
  setTimeout(() => done('timeout'), (Number(rest[1]) + 20) * 1000);
  holdClient(...rest);
} else if (clients[mode]) {
  setTimeout(() => done('timeout'), 20_000);
  clients[mode](rest[0]);
} else {
  console.error('usage: forward-stand-ins.cjs serve <http> <ws> <half> <greet> | ws|half|greet <port> | hold <port> <seconds> <every>');
  process.exit(2);
}
