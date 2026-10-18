// Stand-in for slack.com's Web API and Socket Mode, plain HTTP on loopback, for
// overlap.test.sh: the backend points SLACK_API_URL at it. auth.test and
// apps.connections.open answer what Bolt's start needs; the socket URL they
// hand out is this server, which says hello and pings like Slack. Every other
// method answers { ok: true }. GET /_e2e/sockets returns
// { open, opened, closed } so a test can tell how many processes hold a
// Socket Mode connection.
//
// Run from backend/ (for `ws`): node ../scripts/e2e/fakes/slack-stub.mjs <port>
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const port = Number(process.argv[2]);
const { WebSocketServer } = createRequire(join(process.cwd(), 'package.json'))('ws');

const counts = { open: 0, opened: 0, closed: 0 };
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && path === '/_e2e/sockets') return json(res, counts);
  req.resume();
  req.on('end', () => {
    const method = path.replace(/^\/api\//, '');
    console.log(`[slack-stub] ${method}`);
    if (method === 'auth.test') return json(res, { ok: true, url: 'https://e2e.slack.test/', team: 'e2e', user: 'termag', team_id: 'T0E2E', user_id: 'U0E2E', bot_id: 'B0E2E' });
    if (method === 'apps.connections.open') return json(res, { ok: true, url: `ws://127.0.0.1:${port}/link` });
    return json(res, { ok: true });
  });
});

const wss = new WebSocketServer({ server, path: '/link' });
wss.on('connection', ws => {
  counts.open++; counts.opened++;
  console.log(`[slack-stub] socket opened (${counts.open} open)`);
  ws.send(JSON.stringify({ type: 'hello', num_connections: counts.open, debug_info: { host: 'e2e' }, connection_info: { app_id: 'A0E2E' } }));
  const ping = setInterval(() => ws.ping(), 5000);
  ws.on('close', () => {
    clearInterval(ping);
    counts.open--; counts.closed++;
    console.log(`[slack-stub] socket closed (${counts.open} open)`);
  });
});

server.listen(port, '127.0.0.1', () => console.log(`[slack-stub] listening on ${port}`));
