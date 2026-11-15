/**
 * A link-audience viewer's first open in a real Chromium: someone who isn't the owner, let in by the link's
 * token alone, whose landing URL without that token is the not-found page. The hand-off page's second
 * navigation to its used code, whichever moment it lands, must not strand them there. Box-only, like
 * previewHost.browser.test.ts: it needs /opt/playwright and openssl, and skips without them (CI has neither).
 * Run it with `npx vitest run src/services/previewHost.linkBrowser.test.ts`.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness, formatLog, MAIN, type BrowserHarness } from './previewHostBrowserHarness';
import { linkTokenHash } from './previewLinkRules';

const PLAYWRIGHT = '/opt/playwright/node_modules/playwright/index.mjs';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const APP = 'https://my-app--abcdef.ldpreview.test/';

function hasOpenssl(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const runnable = fs.existsSync(PLAYWRIGHT) && hasOpenssl();

describe.skipIf(!runnable)('a link-audience viewer\'s first open in Chromium (box-only)', () => {
  let tls: { key: Buffer; cert: Buffer };
  let chromium: any;
  let browser: any;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-link-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=termag-test', '-addext', 'subjectAltName=DNS:app.termag.test,DNS:*.ldpreview.test'], { stdio: 'ignore' });
    tls = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
    ({ chromium } = await import(/* @vite-ignore */ PLAYWRIGHT));
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Open the token's share URL as the viewer. `clickAt`: a click where "Continue" is, that many ms in.
   * `exchangeDelayMs`: the exchange is slow on the server. `holdMs`: the browser holds the exchange's answer
   * that long before it goes on (CDP), as Chrome does while it runs a Clear-Site-Data on a full profile.
   */
  async function open(opts: { clickAt?: number; exchangeDelayMs?: number; holdMs?: number } = {}) {
    const h: BrowserHarness = await browserHarness(tls, {}, {
      viewer: { id: 'viewer', googleEmail: 'viewer@example.com' },
      link: { audience: 'link', linkTokenHash: linkTokenHash(TOKEN) },
    });
    if (opts.exchangeDelayMs) {
      const create = h.f.mem.store.createSession.bind(h.f.mem.store);
      h.f.mem.store.createSession = async (row) => { await new Promise(r => setTimeout(r, opts.exchangeDelayMs)); return create(row); };
    }
    browser = await chromium.launch({ proxy: { server: `http://127.0.0.1:${h.proxyPort}` } });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    if (opts.holdMs) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*__termag/auth*', requestStage: 'Response' }] });
      cdp.on('Fetch.requestPaused', (e: { requestId: string }) => {
        setTimeout(() => cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => { /* the navigation was dropped */ }), opts.holdMs);
      });
    }
    const t0 = Date.now();
    await page.goto(`https://${MAIN}/termag/previews/my-app/${TOKEN}`);
    if (opts.clickAt !== undefined) {
      // A person's click where the link is, whatever navigation is pending (Playwright's own would wait).
      const box = await page.locator('a.continue').boundingBox();
      await page.waitForTimeout(Math.max(0, opts.clickAt - (Date.now() - t0)));
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    }
    await page.waitForSelector('#api:text("api ok")', { timeout: 10_000 }).catch(() => {});
    const api = await page.locator('#api').textContent().catch(() => null);
    const url = page.url();
    // Later, the same browser straight to the app's own URL.
    const later = await context.newPage();
    await later.goto(APP);
    await later.waitForSelector('#api:text("api ok")', { timeout: 10_000 }).catch(() => {});
    const direct = await later.locator('#api').textContent().catch(() => null);
    await browser.close();
    browser = null;
    h.close();
    return { h, api, url, direct, log: formatLog(h.log) };
  }

  const notFound = (h: BrowserHarness) => h.log.filter(e => e.host === MAIN && e.status === 404);

  it('opens the app with a session, and opens it again later', async () => {
    const r = await open();
    expect(r.url, r.log).toBe(APP);
    expect(r.api, r.log).toBe('api ok');
    expect(r.direct, r.log).toBe('api ok');
    expect(r.h.f.mem.sessions.size).toBe(1);
  }, 40_000);

  it('a click while the browser holds the exchange\'s answer still lands in the app, never on the not-found page', async () => {
    // Production, 2026-11-12: the exchange's 302 held for 8 s, the viewer clicked, the used code went to the landing
    // page without the token: 404, for good.
    const r = await open({ holdMs: 7000, clickAt: 6500 });
    expect(notFound(r.h), r.log).toHaveLength(0);
    expect(r.url, r.log).toBe(APP);
    expect(r.api, r.log).toBe('api ok');
    expect(r.direct, r.log).toBe('api ok');
  }, 40_000);

  it('a click while the exchange is still on its way gets back in through a rebound, never the not-found page', async () => {
    // The first exchange's answer never reaches the browser: no cookie, and its code is used.
    const r = await open({ exchangeDelayMs: 7000, clickAt: 6500 });
    expect(notFound(r.h), r.log).toHaveLength(0);
    expect(r.url, r.log).toBe(APP);
    expect(r.api, r.log).toBe('api ok');
    expect(r.direct, r.log).toBe('api ok');
    // The way back went through the landing page with a ticket, never the token.
    const back = r.h.log.filter(e => e.host === MAIN && e.path.includes('/reverify?ticket='));
    expect(back, r.log).toHaveLength(1);
    expect(r.h.log.filter(e => e.host === MAIN && e.path.includes(TOKEN)), r.log).toHaveLength(1);
  }, 40_000);
});
