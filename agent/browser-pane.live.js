#!/usr/bin/env node
'use strict';
// Manual check of the browser pane against the real Chromium on this box:
// serves a page from this process, opens it through
// `createManager`, waits for a frame, clicks, types, navigates, goes back,
// resizes and closes. Not a `node --test` file on purpose: CI has no Chromium.
//
//   node agent/browser-pane.live.js
//   TERMAG_CHROMIUM=/path/to/chrome node agent/browser-pane.live.js
const http = require('node:http');
const os = require('node:os');
const browserPane = require('./browser-pane');

const page = `<html><head><title>live check</title></head><body style="margin:0;background:#fff;font:20px sans-serif">
<button id="b" style="position:absolute;left:100px;top:100px;font-size:40px" onclick="document.body.style.background='#cfc';history.pushState({}, '', '/clicked')">Click</button>
<input id="t" style="position:absolute;top:300px;left:20px;font-size:24px"
  onkeydown="if(event.key==='Enter'){history.pushState({}, '', '/typed-'+encodeURIComponent(this.value))}"></body></html>`;

(async () => {
  const deadline = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 60_000);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/second' ? '<title>second page</title><h1>second</h1>' : page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const binary = browserPane.findChromium();
  if (!binary) { console.error('no Chromium found'); process.exit(1); }
  console.log(`chromium: ${binary}`);

  const frames = [];
  const exits = [];
  let waiters = [];
  const send = (msg) => {
    if (msg.type === 'browser-frame') frames.push(msg);
    else if (msg.type === 'browser-exit') exits.push(msg);
    for (const w of waiters.splice(0)) w(msg);
  };
  const next = (type, pred = () => true) => new Promise((resolve) => {
    const check = (msg) => { if (msg.type === type && pred(msg)) resolve(msg); else waiters.push(check); };
    waiters.push(check);
  });
  // Frames are acked back as the backend would once each has gone out.
  const manager = browserPane.createManager({ binary, home: os.homedir(), log: console.log, parkMs: 4000 });
  manager.bindSocket({ send: (msg) => { send(msg); if (msg.type === 'browser-frame') manager.frameAck({ streamId: msg.streamId }); }, bufferedAmount: () => 0 });
  const S = 'live-1';
  const KEY = 'live:key';

  const t0 = Date.now();
  const firstFrame = next('browser-frame');
  const firstNav = next('browser-nav');
  const result = await manager.attach({ streamId: S, paneKey: KEY, url: `${base}/`, width: 800, height: 600 });
  console.log(`attach: ${JSON.stringify(result)} in ${Date.now() - t0}ms`);
  const f = await firstFrame;
  console.log(`first frame: ${Buffer.from(f.data, 'base64').length}B ${f.width}x${f.height} after ${Date.now() - t0}ms`);
  const nav0 = await firstNav;
  console.log(`nav: ${nav0.url} "${nav0.title}" back=${nav0.canGoBack} fwd=${nav0.canGoForward}`);

  const clicked = next('browser-nav', (m) => m.url.endsWith('/clicked'));
  const t1 = Date.now();
  manager.input({ streamId: S, event: { kind: 'mouse', type: 'mouseMoved', x: 140, y: 130, button: 'none' } });
  manager.input({ streamId: S, event: { kind: 'mouse', type: 'mousePressed', x: 140, y: 130, button: 'left', buttons: 1, clickCount: 1 } });
  manager.input({ streamId: S, event: { kind: 'mouse', type: 'mouseReleased', x: 140, y: 130, button: 'left', clickCount: 1 } });
  await clicked;
  console.log(`click: same-document nav seen in ${Date.now() - t1}ms`);

  const typed = next('browser-nav', (m) => m.url.includes('/typed-'));
  manager.input({ streamId: S, event: { kind: 'mouse', type: 'mousePressed', x: 60, y: 315, button: 'left', buttons: 1, clickCount: 1 } });
  manager.input({ streamId: S, event: { kind: 'mouse', type: 'mouseReleased', x: 60, y: 315, button: 'left', clickCount: 1 } });
  manager.input({ streamId: S, event: { kind: 'text', text: 'typed' } });
  manager.input({ streamId: S, event: { kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 } });
  manager.input({ streamId: S, event: { kind: 'key', type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 } });
  const navTyped = await typed;
  console.log(`type: ${navTyped.url}`);

  const second = next('browser-nav', (m) => m.url.endsWith('/second'));
  manager.navigate({ streamId: S, url: `${base}/second` });
  const nav2 = await second;
  console.log(`navigate: ${nav2.url} "${nav2.title}" back=${nav2.canGoBack}`);
  const back = next('browser-nav', (m) => !m.url.endsWith('/second') && m.canGoForward);
  manager.history({ streamId: S, action: 'back' });
  const nav3 = await back;
  console.log(`back: ${nav3.url} fwd=${nav3.canGoForward}`);
  const resized = next('browser-frame', (m) => m.width === 640);
  manager.resize({ streamId: S, width: 640, height: 480 });
  const fr = await resized;
  console.log(`resize: frame ${fr.width}x${fr.height}`);

  // Close parks the browser; a second attach under the same key gets it back with its page.
  manager.close(S);
  console.log(`close: active=${manager.size()} parked=${manager.parkedSize()}`);
  const t3 = Date.now();
  const resumedNav = next('browser-nav');
  const resumed = await manager.attach({ streamId: 'live-2', paneKey: KEY, url: 'about:blank', width: 800, height: 600 });
  const navR = await resumedNav;
  console.log(`reattach: ${JSON.stringify(resumed)} in ${Date.now() - t3}ms, page still at ${navR.url}`);
  const items = await manager.suggest({ cwd: process.argv[2] || process.cwd() });
  console.log(`suggest: ${items.length} apps listening: ${items.map((i) => `${i.url} "${i.title}"`).join(', ')}`);
  manager.close('live-2');
  await new Promise((r) => setTimeout(r, 5500));
  console.log(`park expired: active=${manager.size()} parked=${manager.parkedSize()} unexpected-exits=${exits.length}`);
  server.close();
  clearTimeout(deadline);
  const total = frames.reduce((a, m) => a + Buffer.from(m.data, 'base64').length, 0);
  console.log(`OK: ${frames.length} frames, ${Math.round(total / frames.length)}B avg`);
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
