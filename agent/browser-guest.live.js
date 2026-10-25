#!/usr/bin/env node
'use strict';
// Manual check of guest panes against the real
// Chromium and the box's guest launcher: opens a guest pane through
// `createManager` the way a reviewer's attach does, and checks what a guest
// must and must not be able to do. Not a `node --test` file on purpose: CI
// has no Chromium and no termag-guest user.
//
//   node agent/browser-guest.live.js
//   WEBAPP=~/termag/projects/webapp node agent/browser-guest.live.js
//
// Needs the box's guest setup (deploy/termag-guest-browser-setup). With
// WEBAPP set to a checkout whose dev stack is up, also opens the
// webapp-dev-stack recipe against it.
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const browserPane = require('./browser-pane');
const guest = require('./browser-guest');

const page = (other) => `<html><head><title>guest live check</title></head><body style="margin:0;font:20px sans-serif">
<h1 id="h">guest</h1>
<a id="pop" href="/popup-page" target="_blank" style="position:absolute;left:0;top:200px;width:400px;height:200px;display:block;background:#ccf">popup</a>
<script>
  fetch('http://127.0.0.1:${other}/escape', { mode: 'no-cors' }).catch(() => {});
  window.open('about:blank#popup');
  setTimeout(() => { alert('a dialog nobody can answer'); document.getElementById('h').textContent = 'after alert'; history.pushState({}, '', '/after-alert'); }, 300);
</script></body></html>`;

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures += 1;
};

(async () => {
  const deadline = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 150_000);
  const env = guest.guestEnvironment();
  if (!env.ok) { console.error(`guest mode unavailable: ${env.reason}`); process.exit(1); }
  const binary = browserPane.findChromium();
  console.log(`chromium: ${binary}; guest profiles: ${env.profilesRoot}`);

  const other = http.createServer((req, res) => res.end('should never be reached'));
  let otherHits = 0;
  other.on('request', () => { otherHits += 1; });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  let popupLoads = 0;
  const app = http.createServer((req, res) => {
    if (req.url === '/popup-page') popupLoads += 1;
    res.setHeader('content-type', 'text/html');
    res.end(page(other.address().port));
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;

  const events = [];
  const logs = [];
  const manager = browserPane.createManager({ binary, home: os.homedir(), guestEnv: env, log: (l) => { logs.push(l); console.log(`  ${l}`); } });
  manager.bindSocket({ send: (m) => events.push(m), bufferedAmount: () => 0 });
  const waitFor = (pred, ms = 20_000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { const hit = events.find(pred); if (hit || Date.now() - t0 > ms) resolve(hit); else setTimeout(tick, 100); };
    tick();
  });
  const ack = setInterval(() => { for (const e of events.splice(0)) { kept.push(e); if (e.type === 'browser-frame') manager.frameAck({ streamId: e.streamId }); } }, 50);
  const kept = [];
  const seen = (pred, ms = 20_000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { const hit = kept.find(pred); if (hit || Date.now() - t0 > ms) resolve(hit); else setTimeout(tick, 100); };
    tick();
  });
  void waitFor;

  // 1. A guest pane on a manual recipe: launch, canary, frame.
  const t0 = Date.now();
  const opened = await manager.attach({ streamId: 'g1', paneKey: 'guest:live:me', mode: 'guest', url: `${base}/`, width: 800, height: 600,
    recipe: { kind: 'manual', origins: [`127.0.0.1:${app.address().port}`] }, cwd: path.resolve(__dirname, '..'), maxGuestPanes: 5 }).catch((e) => ({ error: e.message }));
  check(opened.ok === true, 'a guest pane opens (canary passed)', opened.error || `${Date.now() - t0} ms`);
  check(!!(await seen((e) => e.type === 'browser-frame' && e.streamId === 'g1')), 'its first frame arrives');
  check(!!(await seen((e) => e.type === 'browser-checkout' && e.head)), 'it reports the checkout', JSON.stringify(kept.find((e) => e.type === 'browser-checkout') || {}));

  // 2. What the page tries on its own.
  const blockedFetch = await seen((e) => e.type === 'browser-blocked' && e.origin === `127.0.0.1:${other.address().port}`);
  check(!!blockedFetch, 'a fetch to another loopback port is blocked and reported');
  check(otherHits === 0, 'that port was never reached', `${otherHits} hits`);
  const afterAlert = await seen((e) => e.type === 'browser-nav' && /after-alert/.test(e.url), 8000);
  check(!!afterAlert, 'an alert() does not stop the page');

  // A click on a target=_blank link: a real popup, with a user gesture.
  for (const type of ['mousePressed', 'mouseReleased']) {
    manager.input({ streamId: 'g1', event: { kind: 'mouse', type, x: 100, y: 300, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 } });
  }
  await new Promise((r) => setTimeout(r, 1500));
  check(logs.some((l) => /closed a page it did not open/.test(l)), 'a popup from a click is closed');
  check(popupLoads === 0, 'the popup never loaded its page', `${popupLoads} loads`);

  // 3. What the guest tries through the pane.
  manager.navigate({ streamId: 'g1', url: `http://127.0.0.1:${other.address().port}/typed` });
  check(!!(await seen((e) => e.type === 'browser-blocked' && e.origin === `127.0.0.1:${other.address().port}` && kept.indexOf(e) > kept.indexOf(blockedFetch))), 'a navigate outside the share is refused');
  manager.navigate({ streamId: 'g1', url: 'http://169.254.169.254/latest/meta-data/' });
  await new Promise((r) => setTimeout(r, 500));
  check(!kept.some((e) => e.type === 'browser-nav' && /169\.254/.test(e.url)), 'a navigate to instance metadata goes nowhere');

  // 4. Parking, the busy limit, and a mode that disagrees with the key.
  manager.close('g1');
  const busy = await manager.attach({ streamId: 'g2', paneKey: 'guest:live:other', mode: 'guest', url: `${base}/`, width: 800, height: 600,
    recipe: { kind: 'manual', origins: [`127.0.0.1:${app.address().port}`] }, maxGuestPanes: 1 }).catch((e) => ({ error: e.message }));
  check(busy.ok === true, 'with one guest allowed, a second guest evicts the parked one', busy.error || '');
  const refused = await manager.attach({ streamId: 'g3', paneKey: 'guest:live:third', mode: 'guest', url: `${base}/`, width: 800, height: 600,
    recipe: { kind: 'manual', origins: [`127.0.0.1:${app.address().port}`] }, maxGuestPanes: 1 }).catch((e) => ({ error: e.message }));
  check(/^guest-busy:/.test(refused.error || ''), 'a third, with one live, is refused as busy', refused.error || 'opened');
  const mismatch = await manager.attach({ streamId: 'g4', paneKey: 'owner-key', mode: 'guest', url: `${base}/` }).catch((e) => ({ error: e.message }));
  check(/^guest-mode:/.test(mismatch.error || ''), 'a guest attach with an owner key is refused', mismatch.error || 'opened');
  const outside = await manager.attach({ streamId: 'g5', paneKey: 'guest:live:x', mode: 'guest', url: 'http://127.0.0.1:1/', recipe: { kind: 'manual', origins: [`127.0.0.1:${app.address().port}`] } }).catch((e) => ({ error: e.message }));
  check(/^guest-url:/.test(outside.error || ''), 'a guest attach at an address outside the share is refused', outside.error || 'opened');
  manager.close('g2');

  // 5. The webapp recipe, against a running stack.
  if (process.env.WEBAPP) {
    const cwd = path.resolve(process.env.WEBAPP.replace(/^~/, os.homedir()));
    const g = await manager.attach({ streamId: 'g6', paneKey: 'guest:live:webapp', mode: 'guest', url: 'about:blank', width: 1280, height: 800,
      recipe: { kind: 'webapp-dev-stack' }, cwd, maxGuestPanes: 5 }).catch((e) => ({ error: e.message }));
    check(g.ok === true, 'the webapp recipe opens', g.error || (g.origins || []).join(' '));
    const nav = await seen((e) => e.type === 'browser-nav' && e.streamId === 'g6' && /Sign in|Example-Org/i.test(e.title || ''), 40_000);
    check(!!nav, 'webapp renders its sign-in page through the proxy', nav ? `${nav.url} "${nav.title}"` : '');
    const other6 = await manager.attach({ streamId: 'g7', paneKey: 'guest:live:wrong', mode: 'guest', url: 'about:blank', recipe: { kind: 'webapp-dev-stack' }, cwd: os.tmpdir() }).catch((e) => ({ error: e.message }));
    check(/^guest-stack:/.test(other6.error || ''), 'the recipe refuses a directory that is not that stack', other6.error || 'opened');
    manager.close('g6');
  }

  manager.closeAll();
  await new Promise((r) => setTimeout(r, 3000));
  const left = (await guest.runLauncher(['--termag-list'])).split('\n').filter((l) => l.startsWith('tmp-'));
  check(left.length === 0, 'every guest profile was deleted', left.join(', '));
  clearInterval(ack);
  clearTimeout(deadline);
  app.close();
  other.close();
  console.log(failures === 0 ? 'guest live check: all passed' : `guest live check: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
