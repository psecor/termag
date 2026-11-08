// The preview relay end to end over tunnelTestHarness (ported from #167):
// the preview host, AgentTunnels' preview tunnels, a fake box agent that
// connects and dials back, and loopback apps
// ("Testing", Integration and the pinning tests). HTTP keep-alive over a
// pooled tunnel, one pool per viewer session (SR7), an HMR WebSocket, SSE, a
// 100 MB upload, backpressure, a revoke closing a live socket, and the
// cookie rules on the wire (I1, I7, SR12).
import { afterAll, describe, expect, it } from 'vitest';
import http from 'http';
import { type AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { DOMAIN, openWs, previewFixture, previewHeaders, request, signIn } from './previewHostFixture';
import { PREVIEW_COOKIE } from './previewHostRules';
import { onPreviewSessionsRevoked, previewSessionsRevoked } from './previewSessionEvents';
import { makeClosers, startFloodSource, startHttpEcho } from './tunnelTestHarness';

const closers = makeClosers();
afterAll(() => closers.closeAll());

function listen(server: http.Server): Promise<number> {
  closers.add(() => { server.closeAllConnections(); server.close(); });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
}

const ORIGIN = `https://my-app--abcdef.${DOMAIN}`;

/** An app with a WebSocket endpoint that echoes what it got: the message, its URL, its subprotocol and its Cookie header. */
async function startWsApp(): Promise<{ port: number; seen: Array<{ url: string; cookie: string | undefined; headers: http.IncomingHttpHeaders }> }> {
  const seen: Array<{ url: string; cookie: string | undefined; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((_req, res) => { res.end('ok'); });
  const wss = new WebSocketServer({ server, handleProtocols: (p) => (p.has('vite-hmr') ? 'vite-hmr' : false) });
  wss.on('connection', (ws, req) => {
    seen.push({ url: req.url!, cookie: req.headers.cookie, headers: req.headers });
    ws.on('message', (m) => ws.send(`echo:${m}:${ws.protocol}`));
  });
  return { port: await listen(server), seen };
}

async function setup(port: number, agentOpts: Parameters<typeof previewFixture>[2] = {}) {
  const f = await previewFixture(closers, {}, agentOpts);
  f.mem.addLink({ name: 'my-app', port });
  const off = onPreviewSessionsRevoked((linkId, ids) => f.host.revoked(linkId, ids));
  closers.add(off);
  return f;
}

describe('HTTP over pooled tunnels', () => {
  it('keeps one tunnel for a kept-alive connection\'s many requests, per viewer session', async () => {
    const app = await startHttpEcho(closers);
    const f = await setup(app.port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const keep = new http.Agent({ keepAlive: true, maxSockets: 1 });
    closers.add(() => keep.destroy());
    const get = (path: string) => new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: f.port, path, agent: keep, headers: previewHeaders('my-app', { cookie }) }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }).on('error', reject);
    });
    for (const p of ['/', '/@vite/client', '/src/main.ts', '/src/App.tsx', '/node_modules/.vite/deps/react.js']) expect(await get(p)).toBe(200);
    expect(f.agent.opened).toEqual([{ kind: 'preview', port: app.port, confine: null }]);
    expect(app.connections()).toBe(1);
    expect(f.tunnels.count('owner', 'box-1', 'preview')).toBe(1);
  });

  it('dials the new port when a renew moves the link, rather than the pool\'s first target (Bugbot)', async () => {
    const first = await startHttpEcho(closers);
    const second = await startHttpEcho(closers);
    const f = await setup(first.port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const keep = new http.Agent({ keepAlive: true, maxSockets: 1 });
    closers.add(() => keep.destroy());
    const get = () => new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: f.port, path: '/', agent: keep, headers: previewHeaders('my-app', { cookie }) }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }).on('error', reject);
    });
    expect(await get()).toBe(200);
    f.mem.links.get('link-my-app')!.link.port = second.port;
    f.now.t += 31_000; // past the session check's 30 s recheck, which reads the link again
    expect(await get()).toBe(200);
    expect(f.agent.opened.map(o => o.port)).toEqual([first.port, second.port]);
    expect(second.connections()).toBe(1);
    expect(f.host.relay.stats().pools).toBe(1);
  });

  it('a revoke also ends a stream still open on the pool a target change retired (Devin)', async () => {
    // The old target: an event stream that stays open.
    const old = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: old\n\n'); });
    const oldPort = await listen(old);
    const next = await startHttpEcho(closers);
    const f = await setup(oldPort);
    const { cookie, idHash } = await signIn(f, 'my-app', 'owner');
    const ended = new Promise<void>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: f.port, path: '/__events', headers: previewHeaders('my-app', { cookie }) }, (res) => {
        res.resume();
        res.on('close', () => resolve());
      }).on('error', () => resolve());
      setTimeout(() => reject(new Error('the old stream outlived the revoke')), 3_000);
    });
    // Wait for the stream to be open, then move the link and use the new pool once.
    for (let i = 0; i < 50 && f.agent.opened.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    f.mem.links.get('link-my-app')!.link.port = next.port;
    f.now.t += 31_000;
    expect((await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) })).status).toBe(200);
    f.mem.sessions.get(idHash)!.revokedAt = new Date(f.now.t);
    previewSessionsRevoked('link-my-app', [idHash]);
    await ended;
  });

  it('gives each viewer session its own pool, so no two viewers share a connection to the app (SR7)', async () => {
    const app = await startHttpEcho(closers);
    const f = await setup(app.port);
    f.mem.share('proj-1', 'viewer');
    const a = await signIn(f, 'my-app', 'owner');
    const b = await signIn(f, 'my-app', 'viewer', 'collaborator');
    for (let i = 0; i < 3; i++) {
      expect((await request(f.port, `/a${i}`, { headers: previewHeaders('my-app', { cookie: a.cookie }) })).status).toBe(200);
      expect((await request(f.port, `/b${i}`, { headers: previewHeaders('my-app', { cookie: b.cookie }) })).status).toBe(200);
    }
    expect(f.agent.opened).toHaveLength(2);
    expect(app.connections()).toBe(2);
    expect(f.host.relay.stats().pools).toBe(2);
    // Both count against the owner's preview budget, never a viewer's.
    expect(f.tunnels.count('owner', 'box-1', 'preview')).toBe(2);
    expect(f.tunnels.count('viewer', 'box-1', 'preview')).toBe(0);
  });

  it('never lets __Host-termag-preview reach the app, and passes the app\'s own cookies (I1, SR12)', async () => {
    const app = await startHttpEcho(closers);
    const f = await setup(app.port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const a = await request(f.port, '/', { headers: previewHeaders('my-app', { cookie: `theme=dark; ${cookie}; __Host-termag.sid=s%3Aprod; termag.sid=s%3Adev; sid=app`, 'x-amzn-oidc-data': 'jwt' }) });
    const seen = JSON.parse(a.body) as { headers: Record<string, string> };
    expect(seen.headers.cookie).toBe('theme=dark; sid=app');
    expect(JSON.stringify(seen.headers)).not.toContain(PREVIEW_COOKIE);
    // termag's own session, under its production and dev names (#1106), never reaches the app either.
    expect(JSON.stringify(seen.headers)).not.toContain('termag.sid');
    expect(JSON.stringify(seen.headers)).not.toContain(cookie.split('=')[1]);
    expect(seen.headers).toMatchObject({ host: `localhost:${app.port}`, 'x-forwarded-host': `my-app--abcdef.${DOMAIN}`, 'x-forwarded-proto': 'https' });
    for (const h of ['x-termag-preview-host', 'x-termag-preview-name', 'x-amzn-oidc-data']) expect(seen.headers[h], h).toBeUndefined();
  });

  it('hands the browser an app\'s Set-Cookie without its Domain, and never one named __Host-termag-preview (I7)', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('set-cookie', [`sid=1; Domain=${DOMAIN}; Path=/; HttpOnly`, `${PREVIEW_COOKIE}=forged; Path=/; Secure`]);
      res.setHeader('clear-site-data', '"cookies"');
      res.setHeader('location', `http://localhost:${(server.address() as AddressInfo).port}/next`);
      res.statusCode = 302;
      res.end();
    });
    const port = await listen(server);
    const f = await setup(port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const a = await request(f.port, '/login', { headers: previewHeaders('my-app', { cookie }) });
    expect(a.status).toBe(302);
    expect(a.headers['set-cookie']).toEqual(['sid=1; Path=/; HttpOnly']);
    expect(a.headers['clear-site-data']).toBeUndefined();
    expect(a.headers.location).toBe(`${ORIGIN}/next`);
    expect(a.headers['x-robots-tag']).toBe('noindex');
  });

  it('streams server-sent events as they come', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: one\n\n');
      void gate.then(() => { res.write('data: two\n\n'); res.end(); });
    });
    const port = await listen(server);
    const f = await setup(port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: f.port, path: '/__events', headers: previewHeaders('my-app', { cookie }) }, (res) => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          events.push(c);
          // The first event arrived while the app still holds the second: nothing buffered it.
          if (events.length === 1) release();
        });
        res.on('end', () => resolve());
      }).on('error', reject);
    });
    expect(events.join('')).toBe('data: one\n\ndata: two\n\n');
    expect(events[0]).toBe('data: one\n\n');
  });

  it('carries a 100 MB upload, and refuses one byte more mid-stream (U1)', async () => {
    let received = 0;
    const server = http.createServer((req, res) => {
      let n = 0;
      req.on('data', (c: Buffer) => { n += c.length; });
      req.on('end', () => { received = n; res.end(String(n)); });
    });
    const port = await listen(server);
    const f = await setup(port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const upload = (bytes: number, chunked: boolean) => new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: f.port, path: '/upload', method: 'POST',
        headers: { ...previewHeaders('my-app', { cookie }), ...(chunked ? {} : { 'content-length': String(bytes) }), 'sec-fetch-site': 'same-origin' },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', () => resolve(-1));
      const chunk = Buffer.alloc(1 << 20, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < bytes) {
          const n = Math.min(chunk.length, bytes - sent);
          sent += n;
          if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { req.once('drain', pump); return; }
        }
        req.end();
      };
      pump();
      req.on('error', reject);
    });
    expect(await upload(100 * 1024 * 1024, false)).toBe(200);
    expect(received).toBe(100 * 1024 * 1024);
    const over = await upload(100 * 1024 * 1024 + 4096, true);
    expect([413, -1]).toContain(over);
  }, 60_000);

  it('moves 16 MiB to a slow reader without losing a byte (backpressure)', async () => {
    const port = await startFloodSource(closers, 16 << 20);
    const f = await setup(port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const n = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: f.port, path: '/', headers: previewHeaders('my-app', { cookie }) }, (res) => {
        let got = 0;
        res.pause();
        setTimeout(() => { res.on('data', (c: Buffer) => { got += c.length; }); res.on('end', () => resolve(got)); res.resume(); }, 300);
      }).on('error', reject);
    });
    expect(n).toBe(16 << 20);
  }, 30_000);

  it('answers the box\'s refusals with termag pages: not running, can\'t be shared, busy', async () => {
    const closed = await setup(1);
    const c = await signIn(closed, 'my-app', 'owner');
    const notRunning = await request(closed.port, '/', { headers: previewHeaders('my-app', { cookie: c.cookie }) });
    expect(notRunning.status).toBe(502);
    expect(notRunning.body).toContain('isn&#39;t running');

    const app = await startHttpEcho(closers);
    const guarded = await setup(app.port, { refuse: () => ({ code: 'port_refused', reason: 'debugger or shell' }) });
    const g = await signIn(guarded, 'my-app', 'owner');
    const refused = await request(guarded.port, '/', { headers: previewHeaders('my-app', { cookie: g.cookie }) });
    expect(refused.status).toBe(502);
    expect(refused.body).toContain('can&#39;t be shared');
    expect(refused.body).not.toContain('debugger');
  });
});

describe('WebSockets', () => {
  it('relays an HMR socket with its subprotocol, without the session cookie, from the preview\'s own origin only', async () => {
    const app = await startWsApp();
    const f = await setup(app.port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const ws = await openWs(f.port, '/__vite_hmr?token=x', previewHeaders('my-app', { cookie: `theme=dark; ${cookie}; __Host-termag.sid=s%3Aprod; termag.sid=s%3Adev`, origin: ORIGIN }), ['vite-hmr']);
    closers.add(() => ws.terminate());
    expect(ws.protocol).toBe('vite-hmr');
    const reply = new Promise<string>(r => ws.once('message', m => r(String(m))));
    ws.send('ping');
    expect(await reply).toBe('echo:ping:vite-hmr');
    expect(app.seen[0].url).toBe('/__vite_hmr?token=x');
    expect(app.seen[0].cookie).toBe('theme=dark');
    expect(app.seen[0].headers.host).toBe(`localhost:${app.port}`);
    expect(f.host.relay.stats().sockets).toBe(1);

    await expect(openWs(f.port, '/__vite_hmr', previewHeaders('my-app', { cookie, origin: `https://other.${DOMAIN}` }))).rejects.toMatchObject({ status: 403 });
    await expect(openWs(f.port, '/__vite_hmr', previewHeaders('my-app', { cookie }))).rejects.toMatchObject({ status: 403 });
    await expect(openWs(f.port, '/__vite_hmr', previewHeaders('my-app', { origin: ORIGIN }))).rejects.toMatchObject({ status: 401 });
  });

  it('refuses the DevTools protocol\'s socket paths on every link (SR6)', async () => {
    const app = await startWsApp();
    const f = await setup(app.port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    for (const path of ['/devtools/browser/1', '/0f8fad5b-d9cb-469f-a165-70867728950e']) {
      await expect(openWs(f.port, path, previewHeaders('my-app', { cookie, origin: ORIGIN }))).rejects.toMatchObject({ status: 403 });
    }
    expect(app.seen).toHaveLength(0);
  });

  it('a revoke closes a live socket with 1008 at once', async () => {
    const app = await startWsApp();
    const f = await setup(app.port);
    const { cookie, idHash } = await signIn(f, 'my-app', 'owner');
    const ws = await openWs(f.port, '/__vite_hmr', previewHeaders('my-app', { cookie, origin: ORIGIN }), ['vite-hmr']);
    const closed = new Promise<number>(r => ws.once('close', code => r(code)));
    f.mem.sessions.get(idHash)!.revokedAt = new Date(f.now.t);
    previewSessionsRevoked('link-my-app', [idHash]);
    expect(await closed).toBe(1008);
    expect(f.host.relay.stats()).toEqual({ pools: 0, sockets: 0 });
  });

  it('the 30 s recheck closes a socket whose session stopped holding in another process', async () => {
    const app = await startWsApp();
    const f = await previewFixture(closers, { recheckMs: 50, cacheMs: 10 });
    f.mem.addLink({ name: 'my-app', port: app.port });
    f.mem.share('proj-1', 'viewer');
    const { cookie } = await signIn(f, 'my-app', 'viewer', 'collaborator');
    const ws = await openWs(f.port, '/__vite_hmr', previewHeaders('my-app', { cookie, origin: ORIGIN }), ['vite-hmr']);
    const closed = new Promise<number>(r => ws.once('close', code => r(code)));
    // Unshared elsewhere: nothing told this process.
    f.mem.unshare('proj-1', 'viewer');
    f.now.t += 1_000;
    expect(await closed).toBe(1008);
  });

  it('a parked box refuses the upgrade', async () => {
    const app = await startWsApp();
    const f = await setup(app.port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    f.box.status = 'hibernated';
    await expect(openWs(f.port, '/__vite_hmr', previewHeaders('my-app', { cookie, origin: ORIGIN }))).rejects.toMatchObject({ status: 503 });
  });
});

describe('keep-awake: viewer input, not open tunnels', () => {
  /** A dev server with an HMR socket that pings, an SSE stream that sends keep-alives, and Vite's ping route. */
  async function startDevApp() {
    const server = http.createServer((req, res) => {
      if (req.url === '/__events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const t = setInterval(() => res.write(': keep-alive\n\n'), 20);
        req.on('close', () => clearInterval(t));
        return;
      }
      res.end(req.url === '/__vite_ping' ? 'pong' : 'ok');
    });
    const wss = new WebSocketServer({ server, handleProtocols: (p) => (p.has('vite-hmr') ? 'vite-hmr' : false) });
    // The app's own traffic toward the viewer: an update every 20 ms.
    wss.on('connection', (ws) => { const t = setInterval(() => ws.send('{"type":"update"}'), 20); ws.on('close', () => clearInterval(t)); });
    return listen(server);
  }

  it('a silent open tab (HMR socket, its pings, an SSE stream, Vite\'s ping) never moves the idle clock', async () => {
    const f = await setup(await startDevApp());
    const { cookie } = await signIn(f, 'my-app', 'owner');
    const ws = await openWs(f.port, '/__vite_hmr', previewHeaders('my-app', { cookie, origin: ORIGIN }), ['vite-hmr']);
    closers.add(() => ws.terminate());
    const sse = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: f.port, path: '/__events', headers: previewHeaders('my-app', { cookie, accept: 'text/event-stream' }) }, resolve).on('error', reject);
    });
    closers.add(() => sse.destroy());
    let keepAlives = 0;
    sse.on('data', () => { keepAlives++; });
    let updates = 0;
    ws.on('message', () => { updates++; });
    for (let i = 0; i < 5; i++) {
      ws.send('{"type":"ping"}');
      await new Promise(r => setTimeout(r, 30));
    }
    expect((await request(f.port, '/__vite_ping', { headers: previewHeaders('my-app', { cookie, accept: 'text/x-vite-ping' }) })).status).toBe(200);
    expect(keepAlives).toBeGreaterThan(2);
    expect(updates).toBeGreaterThan(2);
    // Tunnels are open the whole time; none of it is a person.
    expect(f.tunnels.count('owner', 'box-1', 'preview')).toBeGreaterThan(0);
    expect(f.activity).toEqual([]);
  });

  it('a navigation and a user-activated request count, on the owner\'s box; a fetch, a socket and its messages don\'t', async () => {
    const f = await setup(await startDevApp());
    const { cookie } = await signIn(f, 'my-app', 'owner');
    await request(f.port, '/', { headers: previewHeaders('my-app', { cookie, 'sec-fetch-mode': 'navigate' }) });
    expect(f.activity).toEqual(['box-1']);
    // A fetch the page makes by itself (polling, a subresource) is no input.
    await request(f.port, '/api/items', { headers: previewHeaders('my-app', { cookie, 'sec-fetch-mode': 'cors' }) });
    expect(f.activity).toHaveLength(1);
    // One a click started is.
    await request(f.port, '/api/save', { method: 'POST', headers: previewHeaders('my-app', { cookie, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'sec-fetch-user': '?1' }), body: '{}' });
    expect(f.activity).toEqual(['box-1', 'box-1']);
    // WebSocket messages never count for now: a page's own sockets send without the viewer.
    const ws = await openWs(f.port, '/__vite_hmr', previewHeaders('my-app', { cookie, origin: ORIGIN }), ['vite-hmr']);
    closers.add(() => ws.terminate());
    ws.send('{"type":"custom","event":"save","data":{"x":1}}');
    await new Promise(r => setTimeout(r, 100));
    expect(f.activity).toHaveLength(2);
  });
});

describe('the parked box', () => {
  it('gets the asleep page and opens no tunnel', async () => {
    const app = await startHttpEcho(closers);
    const f = await setup(app.port);
    const { cookie } = await signIn(f, 'my-app', 'owner');
    f.box.status = 'stopped';
    const a = await request(f.port, '/', { headers: previewHeaders('my-app', { cookie }) });
    expect(a.status).toBe(503);
    expect(a.body).toContain('This preview is asleep');
    expect(f.agent.opened).toHaveLength(0);
  });
});

