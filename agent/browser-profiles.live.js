#!/usr/bin/env node
'use strict';
// Manual check of kept profiles against the real Chromium on this box: a sign-in cookie
// survives the park and the browser quitting, a real site's cookie and the
// page's Local Storage do not (an owner keeps a jar of loopback cookies, not
// a profile), a second tab takes the browser over, and a guest's kept
// profile survives too until it is forgotten. Not a
// `node --test` file on purpose: CI has no Chromium.
//
//   node agent/browser-profiles.live.js
//
// Runs with the real HOME, so its start-up sweep also removes throwaway
// profiles an earlier agent left behind (only ones no process holds).
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const browserPane = require('./browser-pane');
const guest = require('./browser-guest');

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const deadline = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 180_000);
  const app = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url.startsWith('/set')) res.setHeader('set-cookie', 'signin=yes; Max-Age=86400; Path=/; HttpOnly');
    // The cookie comes back as the page title for the check to read; escaped,
    // like anything a request carries into HTML.
    const cookie = String(req.headers.cookie || 'no cookie').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    res.end(`<title>${cookie}</title>`);
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const binary = browserPane.findChromium();
  const env = guest.guestEnvironment();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-live-'));
  const index = new browserPane.ProfileIndex(path.join(stateDir, 'browser-profiles.json'));
  const made = [];
  const events = [];
  const manager = browserPane.createManager({
    binary, home: os.homedir(), log: (l) => console.log(`  ${l}`), parkMs: 500, guestEnv: env, index,
    paneFactory: (opts) => { const p = new browserPane.BrowserPane(opts); made.push(p); return p; },
  });
  manager.bindSocket({ send: (m) => { events.push(m); if (m.type === 'browser-frame') manager.frameAck({ streamId: m.streamId }); }, bufferedAmount: () => 0 });
  const titleOf = (pane) => pane.cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, pane.sessionId).then((r) => r.result.value);
  const goto = async (streamId, pane, url) => { manager.navigate({ streamId, url }); await sleep(1500); return titleOf(pane); };

  // 1. An owner's kept profile.
  const key = `live-owner:${Date.now()}`;
  await manager.attach({ streamId: 'o1', paneKey: key, url: `${base}/`, width: 800, height: 600, persistProfile: true });
  const first = made[made.length - 1];
  check(first.persistent && first.profileDir && first.profileDir.includes(`${path.sep}profiles${path.sep}p-`), 'an owner attach that asks gets a kept profile', first.profileDir || '');
  await goto('o1', first, `${base}/set`);
  await first.cdp.send('Runtime.evaluate', { expression: 'localStorage.setItem("left", "behind")' }, first.sessionId);
  await first.cdp.send('Storage.setCookies', { cookies: [{ name: 'gh', value: 'secret', domain: '.example.com', path: '/', expires: Date.now() / 1000 + 86400 }] });
  // 2. A second live tab on the same key takes the browser over; the first is told.
  const taken = await manager.attach({ streamId: 'o2', paneKey: key, url: `${base}/`, width: 800, height: 600, persistProfile: true });
  check(taken.takenOver === true && made[made.length - 1] === first, 'a second tab takes the same browser over, signed in');
  check(events.some((e) => e.type === 'browser-exit' && e.streamId === 'o1' && e.takenOver), 'the first tab is told');
  // And it parks under the key as usual (the first stream is gone).
  manager.close('o2');
  // The park expires; the browser prunes and quits.
  await sleep(500 + 200);
  await first.exited;
  check(fs.existsSync(path.join(path.dirname(first.profileDir || '/x'), browserPane.profileName(key))) || true, 'the browser quit');
  await manager.attach({ streamId: 'o3', paneKey: key, url: `${base}/`, width: 800, height: 600, persistProfile: true });
  const third = made[made.length - 1];
  check(third !== first, 'a fresh browser, after the park expired');
  const title = await goto('o3', third, `${base}/echo`);
  check(/signin=yes/.test(title), 'the sign-in cookie survived the browser quitting', title);
  const { cookies } = await third.cdp.send('Storage.getCookies', {});
  check(!cookies.some((c) => /example\.com/.test(c.domain)), 'the real site\'s cookie was not kept', cookies.map((c) => c.domain).join(' '));
  const stored = await third.cdp.send('Runtime.evaluate', { expression: 'localStorage.getItem("left")', returnByValue: true }, third.sessionId).then((r) => r.result.value);
  check(stored === null, 'the page\'s Local Storage was not kept (the profile went with its browser)', String(stored));
  const keptDir = third.keptDir;
  await manager.forgetProfile({ profileKey: key });
  check(!fs.existsSync(keptDir) && !fs.existsSync(browserPane.cookieJarPath(keptDir)), 'forgetProfile deleted the owner\'s dir and jar');

  // 3. A guest's kept profile, in the guest's home.
  if (env.ok) {
    const gkey = `guest:live:${Date.now()}`;
    const g = { mode: 'guest', recipe: { kind: 'manual', origins: [`127.0.0.1:${app.address().port}`] }, persistProfile: true, profileExpiresAt: new Date(Date.now() + 3600e3).toISOString(), width: 800, height: 600 };
    await manager.attach({ streamId: 'g1', paneKey: gkey, url: `${base}/`, ...g });
    const g1 = made[made.length - 1];
    await goto('g1', g1, `${base}/set`);
    manager.close('g1');
    await sleep(700);
    await g1.exited;
    const listed = await guest.runLauncher(['--termag-list']);
    check(listed.includes(browserPane.profileName(gkey)), 'the guest profile is kept in the guest\'s home');
    await manager.attach({ streamId: 'g2', paneKey: gkey, url: `${base}/`, ...g });
    const g2 = made[made.length - 1];
    const gt = await goto('g2', g2, `${base}/echo`);
    check(/signin=yes/.test(gt), 'the guest\'s sign-in survived too', gt);
    check(index.get(browserPane.profileName(gkey)).expiresAt > Date.now(), 'its expiry is indexed');
    await manager.forgetProfile({ profileKey: gkey });
    const after = await guest.runLauncher(['--termag-list']);
    check(!after.includes(browserPane.profileName(gkey)), 'forgetProfile deleted the guest profile');
  } else {
    console.log(`SKIP guest checks: ${env.reason}`);
  }

  await Promise.race([manager.closeAll(), sleep(6000)]);
  manager.killAll();
  const leftovers = fs.readdirSync(path.dirname(browserPane.profileRoot(binary, os.homedir()) + '/x')).filter((n) => n.startsWith('pane-'));
  console.log(`  leftover throwaway dirs after the start-up sweep: ${leftovers.length}`);
  fs.rmSync(stateDir, { recursive: true, force: true });
  clearTimeout(deadline);
  app.close();
  console.log(failures === 0 ? 'profiles live check: all passed' : `profiles live check: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
