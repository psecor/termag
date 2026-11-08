/**
 * A preview host on real sockets for tests (previewHost.test.ts,
 * previewRelay.integration.test.ts): createPreviewHost over the in-memory
 * store, AgentTunnels with tunnelTestHarness's fake box agent, and a server
 * that mounts the dispatch first and a sentinel after it, the way index.ts
 * does, so a test can tell whether anything ever fell through to termag.
 */
import express from 'express';
import http from 'http';
import net, { type AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { AgentTunnels } from './agentTunnels';
import { createPreviewHost, type PreviewHost, type PreviewHostDeps } from './previewHost';
import { codeHash, CODE_TTL_MS, newSecret, PREVIEW_COOKIE, signSessionCookie, sessionIdHash } from './previewHostRules';
import { isViewerInput } from './previewLinkActivity';
import { memoryHostStore, type MemoryHostStore } from './previewHostTestStore';
import { previewRelayServerOptions } from './previewRelay';
import { dialBackEndpoint, fakeBoxAgent, type Closers, type FakeBoxAgent } from './tunnelTestHarness';

export const DOMAIN = 'previews.test';
export const SITE = 'https://app.termag.test/termag';
export const SECRET = Buffer.alloc(32, 9);
export const CHECKOUT = '/home/owner/termag/projects/app';

export interface Fixture {
  mem: MemoryHostStore;
  host: PreviewHost;
  agent: FakeBoxAgent;
  tunnels: AgentTunnels;
  port: number;
  /** Requests and upgrades that reached the route after the dispatch: must stay 0 for preview hosts. */
  sentinel: { http: number; upgrade: number; paths: string[] };
  flags: { enabled: boolean; killSwitch: boolean };
  box: { status: string | null; connected: boolean; capabilities: string[] };
  allowed: Set<string>;
  now: { t: number };
  /** Boxes noteActivity was called for, in order: the viewer input that keeps the owner's box awake. */
  activity: string[];
}

export async function previewFixture(closers: Closers, over: Partial<PreviewHostDeps> = {}, agentOpts: Parameters<typeof fakeBoxAgent>[1] = {}): Promise<Fixture> {
  const mem = memoryHostStore();
  mem.addUser('owner', 'owner@example.com');
  mem.addUser('viewer', 'viewer@example.com');
  let base = '';
  const agent = fakeBoxAgent(() => base, agentOpts);
  const tunnels = new AgentTunnels({ send: agent.send });
  base = await dialBackEndpoint(tunnels, closers);
  const flags = { enabled: true, killSwitch: false };
  const box = { status: 'ready' as string | null, connected: true, capabilities: ['preview-link-v1'] };
  const allowed = new Set(['owner@example.com', 'viewer@example.com']);
  const now = { t: Date.now() };
  const activity: string[] = [];
  const wss = new WebSocketServer(previewRelayServerOptions());
  const host = createPreviewHost({
    store: mem.store,
    domain: () => DOMAIN,
    cookieSecret: () => SECRET,
    siteBase: () => SITE,
    flags: async () => ({ ...flags }),
    allowed: (email) => allowed.has(email),
    tunnels,
    box: { status: async () => box.status, connected: () => box.connected, capabilities: () => box.capabilities },
    checkoutDir: () => CHECKOUT,
    isServing: () => true,
    wss,
    now: () => new Date(now.t),
    // PR 1's rule, without its database write.
    noteActivity: (boxId, headers) => { if (isViewerInput(headers)) activity.push(boxId); },
    ...over,
  });
  const sentinel = { http: 0, upgrade: 0, paths: [] as string[] };
  const app = express();
  app.use(host.dispatch);
  // Everything termag mounts after the dispatch: a preview host must never get here.
  app.use((req, res) => { sentinel.http++; sentinel.paths.push(req.url); res.status(299).type('text/plain').send('termag'); });
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (host.dispatchUpgrade(req, socket, head)) return;
    sentinel.upgrade++;
    socket.end('HTTP/1.1 299 termag\r\nConnection: close\r\n\r\n');
  });
  closers.add(() => { host.closeAll(1001, 'test over'); host.stop(); server.closeAllConnections(); server.close(); wss.close(); });
  const port = await new Promise<number>(r => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  return { mem, host, agent, tunnels, port, sentinel, flags, box, allowed, now, activity };
}

/** The test store's host suffix for every link (previewHostTestStore.addLink). */
export const SUFFIX = 'abcdef';

/** Headers as nginx's preview server block sends them for `name`, on its link's own host `<name>--<suffix>` (null: the bare name). */
export function previewHeaders(name = 'my-app', extra: Record<string, string> = {}, suffix: string | null = SUFFIX): Record<string, string> {
  const label = suffix === null ? name : `${name}--${suffix}`;
  return { host: `${label}.${DOMAIN}`, 'x-termag-preview-host': '1', 'x-termag-preview-name': label, ...extra };
}

export interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string }

export function request(port: number, path: string, opts: { method?: string; headers?: Record<string, string | number>; body?: string | Buffer } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** A raw request line and headers, for targets http.request won't send (absolute-form, `*`). */
export function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let out = '';
    s.on('data', (c) => { out += c.toString(); });
    s.on('end', () => resolve(out));
    s.on('close', () => resolve(out));
    s.on('error', reject);
  });
}

/** A code as the landing page writes it, for `userId` on the link `name` serves. */
export async function landingCode(f: Fixture, name: string, userId: string, basis = 'owner', extra: { tokenHash?: string | null; next?: string; sessionIdHash?: string | null } = {}): Promise<string> {
  const ctx = await f.mem.store.resolveName(name);
  const code = newSecret();
  await f.mem.store.createCode({
    codeHash: codeHash('code', code)!, linkId: ctx!.link.id, userId, basis, tokenHash: extra.tokenHash ?? null,
    sessionIdHash: extra.sessionIdHash ?? null, next: extra.next ?? '/', expiresAt: new Date(f.now.t + CODE_TTL_MS),
  });
  return code;
}

/** Sign in through the exchange: the session cookie's pair, as the browser would send it back, and its id hash. */
export async function signIn(f: Fixture, name: string, userId: string, basis = 'owner', extra: { tokenHash?: string | null; next?: string } = {}): Promise<{ cookie: string; idHash: string; answer: Answer }> {
  const code = await landingCode(f, name, userId, basis, extra);
  const answer = await request(f.port, `/__termag/auth?code=${code}`, { headers: previewHeaders(name) });
  const set = ([] as string[]).concat(answer.headers['set-cookie'] ?? [])[0] ?? '';
  const pair = set.split(';')[0];
  const value = pair.slice(PREVIEW_COOKIE.length + 1);
  const id = value.split('.')[0];
  return { cookie: pair, idHash: id ? sessionIdHash(id) : '', answer };
}

/** A cookie for a session the test made itself (no exchange). */
export function cookieFor(name: string, id: string): string {
  return `${PREVIEW_COOKIE}=${signSessionCookie(SECRET, name, id)}`;
}

/** Open a WebSocket to the preview host; resolves on open, rejects with the refusal's status. */
export function openWs(port: number, path: string, headers: Record<string, string>, protocols: string[] = []): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
}
