/**
 * A first open of a preview link in a real browser, for previewHost.browser.test.ts and the
 * pl-bounce demo: the main host's landing page and the preview host as termag runs them
 * (previewLandingRouter, createPreviewHost over the in-memory store, the fake box agent relaying
 * to a real local dev server), behind one HTTPS front that adds nginx's preview headers, as
 * deploy/nginx's preview server block does. The browser reaches every name through a CONNECT
 * proxy, so URLs stay `https://<host>/` on 443 as in production, and the main host and the
 * preview domain are different sites (`termag.test`, `ldpreview.test`), as they are there.
 *
 * Every request is logged with what decides a bounce: the cookies it carried, the Set-Cookie
 * names and Clear-Site-Data its answer had. Never a cookie's value.
 */
import express from 'express';
import http from 'http';
import https from 'https';
import net, { type AddressInfo } from 'net';
import { previewLandingRouter } from '../routes/previewLanding';
import { previewFixture, SECRET, type Fixture } from './previewHostFixture';
import { makeClosers } from './tunnelTestHarness';
import type { PreviewHostDeps } from './previewHost';
import type { HostLinkContext } from './previewHostStore';

export const MAIN = 'app.termag.test';
export const PDOMAIN = 'ldpreview.test';
export const SITE_BASE = `https://${MAIN}/termag`;

export interface LoggedRequest {
  at: number;
  method: string;
  host: string;
  path: string;
  status: number;
  /** Cookie names the request carried. */
  sent: string[];
  /** Cookie names the answer set. */
  set: string[];
  clearSiteData: string | null;
  location: string | null;
}

export interface BrowserHarness {
  f: Fixture;
  proxyPort: number;
  log: LoggedRequest[];
  close(): void;
}

const names = (cookieHeader: string | undefined) =>
  (cookieHeader ?? '').split(';').map(s => s.trim().split('=')[0]).filter(Boolean);

/** An app on the box: a page that calls its own API, so "the app loaded with the session" is one fetch. */
function devServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/api/ping') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"pong":true}'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>The app</title><h1 id="app">The app</h1><p id="api">…</p>'
      + '<script>fetch("/api/ping").then(r=>r.json()).then(j=>{document.getElementById("api").textContent=j.pong?"api ok":"api bad"},()=>{document.getElementById("api").textContent="api failed"})</script>');
  });
}

const listen = (s: net.Server) => new Promise<number>(r => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

export interface HarnessOptions {
  /** Who is signed in to termag on the main host: the project's owner unless said. */
  viewer?: { id: string; googleEmail: string };
  /** The link's own fields: its audience and token hash, for a link-audience open. */
  link?: Partial<HostLinkContext['link']>;
}

export async function browserHarness(tls: { key: Buffer | string; cert: Buffer | string }, over: Partial<PreviewHostDeps> = {}, opts: HarnessOptions = {}): Promise<BrowserHarness> {
  const closers = makeClosers();
  const app = devServer();
  const appPort = await listen(app);
  closers.add(() => { app.closeAllConnections(); app.close(); });
  const f = await previewFixture(closers, { domain: () => PDOMAIN, siteBase: () => SITE_BASE, now: () => new Date(), ...over });
  f.mem.addLink({ name: 'my-app', port: appPort, ...opts.link });

  const landing = express();
  landing.use('/termag/previews', previewLandingRouter({
    store: f.mem.store,
    domain: () => PDOMAIN,
    cookieSecret: () => SECRET,
    flags: async () => ({ ...f.flags }),
    allowed: (e) => f.allowed.has(e),
    user: () => opts.viewer ?? { id: 'owner', googleEmail: 'owner@example.com' },
    boxStatus: async () => 'ready',
  }));

  const log: LoggedRequest[] = [];
  const front = https.createServer(tls, (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const entry: LoggedRequest = { at: Date.now(), method: req.method ?? '', host, path: req.url ?? '', status: 0, sent: names(req.headers.cookie), set: [], clearSiteData: null, location: null };
    log.push(entry);
    const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => http.ServerResponse;
    // The answer as it leaves, whichever handler wrote it.
    res.writeHead = ((...a: unknown[]) => {
      const out = writeHead(...a);
      entry.status = res.statusCode;
      const set = res.getHeader('set-cookie');
      entry.set = ([] as string[]).concat((set as string[] | string | undefined) ?? []).map(c => c.split('=')[0]);
      entry.clearSiteData = (res.getHeader('clear-site-data') as string | undefined) ?? null;
      entry.location = (res.getHeader('location') as string | undefined) ?? null;
      return out;
    }) as typeof res.writeHead;
    if (host.endsWith(`.${PDOMAIN}`)) {
      // nginx's preview server block: the marker and the whole label, then the backend.
      const label = host.slice(0, -PDOMAIN.length - 1);
      const up = http.request({ host: '127.0.0.1', port: f.port, path: req.url, method: req.method, headers: { ...req.headers, 'x-termag-preview-host': '1', 'x-termag-preview-name': label } }, (r) => {
        // Through writeHead, so the log sees it.
        const headers: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) headers[k] = v;
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.writeHead(r.statusCode!);
        r.pipe(res);
      });
      up.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(up);
      return;
    }
    if (host === MAIN) { landing(req, res); return; }
    res.writeHead(404); res.end();
  });
  const frontPort = await listen(front);
  closers.add(() => { front.closeAllConnections(); front.close(); });

  // Every name resolves to the front, on 443 as far as the browser knows.
  const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connect', (_req, client: net.Socket, head) => {
    const s = net.connect(frontPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); s.write(head); s.pipe(client); client.pipe(s); });
    s.on('error', () => client.destroy());
    client.on('error', () => s.destroy());
  });
  const proxyPort = await listen(proxy);
  closers.add(() => { proxy.closeAllConnections(); proxy.close(); });
  return { f, proxyPort, log, close: () => closers.closeAll() };
}

/** One line per request, for a transcript: time from the first, and nothing secret (no query string on the exchange). */
export function formatLog(log: readonly LoggedRequest[]): string {
  const t0 = log[0]?.at ?? 0;
  return log.map(e => {
    const path = e.path.startsWith('/__termag/auth') ? '/__termag/auth?code=<redacted>' : e.path;
    const loc = e.location ? ` -> ${e.location.replace(/code=[^&]+/, 'code=<redacted>')}` : '';
    return `+${String(e.at - t0).padStart(5)}ms ${e.method} https://${e.host}${path} ${e.status}${loc}`
      + `  sent=[${e.sent.join(',')}] set=[${e.set.join(',')}]${e.clearSiteData ? ` clear-site-data=${e.clearSiteData}` : ''}`;
  }).join('\n');
}
