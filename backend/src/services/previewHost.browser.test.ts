/**
 * A first open of a preview link in a real Chromium (pl-bounce): the landing page's hand-off makes one
 * exchange, and the app loads with the session, even when the viewer clicks while the exchange is
 * still on its way. Box-only: it needs the Playwright boxes ship in /opt/playwright and openssl for a
 * throwaway certificate, and skips without them (CI has neither). Run it with
 * `npx vitest run src/services/previewHost.browser.test.ts`.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness, formatLog, MAIN, type BrowserHarness } from './previewHostBrowserHarness';
import { HANDOFF_FALLBACK_S, renderHandoff } from '../previewPages';

const PLAYWRIGHT = '/opt/playwright/node_modules/playwright/index.mjs';

function hasOpenssl(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const runnable = fs.existsSync(PLAYWRIGHT) && hasOpenssl();

describe.skipIf(!runnable)('a first open in Chromium (box-only)', () => {
  let tls: { key: Buffer; cert: Buffer };
  let chromium: any;
  let browser: any;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-bounce-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=termag-test', '-addext', 'subjectAltName=DNS:app.termag.test,DNS:*.ldpreview.test'], { stdio: 'ignore' });
    tls = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
    ({ chromium } = await import(/* @vite-ignore */ PLAYWRIGHT));
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Open the share URL; optionally slow the exchange and click where "Continue" is, at `clickAt` ms. */
  async function firstOpen(opts: { exchangeDelayMs?: number; clickAt?: number } = {}): Promise<{ h: BrowserHarness; api: string | null; url: string }> {
    const h = await browserHarness(tls);
    if (opts.exchangeDelayMs) {
      const create = h.f.mem.store.createSession.bind(h.f.mem.store);
      h.f.mem.store.createSession = async (row) => { await new Promise(r => setTimeout(r, opts.exchangeDelayMs)); return create(row); };
    }
    browser = await chromium.launch({ proxy: { server: `http://127.0.0.1:${h.proxyPort}` } });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(`https://${MAIN}/termag/previews/my-app`);
    if (opts.clickAt !== undefined) {
      // A person's click on the page where its link is, whatever navigation is pending: Playwright's
      // own click would wait for that navigation, or for the link to be clickable.
      const box = await page.locator('a.continue').boundingBox();
      await page.waitForTimeout(Math.max(0, opts.clickAt - (Date.now() - t0)));
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    }
    await page.waitForSelector('#api:text("api ok")', { timeout: 15_000 }).catch(() => {});
    const api = await page.locator('#api').textContent().catch(() => null);
    const url = page.url();
    await browser.close();
    browser = null;
    h.close();
    return { h, api, url };
  }

  const exchanges = (h: BrowserHarness) => h.log.filter(e => e.path.startsWith('/__termag/auth'));
  const landings = (h: BrowserHarness) => h.log.filter(e => e.host === MAIN);

  it('makes one landing and one exchange, and the app loads with the session', async () => {
    const { h, api, url } = await firstOpen();
    expect(landings(h), formatLog(h.log)).toHaveLength(1);
    expect(exchanges(h), formatLog(h.log)).toHaveLength(1);
    expect(url).toBe('https://my-app--abcdef.ldpreview.test/');
    expect(api).toBe('api ok');
    // The app's own requests carried the session the one exchange set.
    expect(h.log.find(e => e.path === '/api/ping')?.sent).toContain('__Host-termag-preview');
    expect(h.f.mem.sessions.size).toBe(1);
  }, 30_000);

  it('still makes one exchange when the viewer clicks while the exchange is on its way', async () => {
    // Production's bounce: the refresh's exchange takes a while, the viewer clicks "Continue", and that
    // second navigation to the used code went back round the landing page for another (pl-bounce).
    const { h, api } = await firstOpen({ exchangeDelayMs: 1500, clickAt: 1300 });
    expect(exchanges(h), formatLog(h.log)).toHaveLength(1);
    expect(landings(h), formatLog(h.log)).toHaveLength(1);
    expect(api).toBe('api ok');
    expect(h.f.mem.sessions.size).toBe(1);
  }, 30_000);

  it('offers the link, unclickable until then, once the refresh is long overdue', async () => {
    // A browser that doesn't follow the refresh: the same page without it.
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(renderHandoff('Olive Owner', 'https://my-app--abcdef.ldpreview.test/__termag/auth?code=x').replace(/<meta http-equiv="refresh"[^>]*>/, ''));
    const visibility = () => page.locator('a.continue').evaluate((a: Element) => getComputedStyle(a).visibility);
    expect(await visibility()).toBe('hidden');
    await page.waitForTimeout(HANDOFF_FALLBACK_S * 1000 + 300);
    expect(await visibility()).toBe('visible');
    await browser.close();
    browser = null;
  }, 30_000);
});
