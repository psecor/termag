'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const {
  CAPABILITIES, MAX_PANES, VIEWPORT, QUALITY_RUNGS, SLOW_ACK_MS, FAST_ACK_MS, ADAPT_AFTER, MIN_FRAME_INTERVAL_MS, findChromium, profileRoot, clampViewport, normalizeUrl, chromiumArgs,
  inputToCdp, parseListeners, isCandidatePort, devStackHost, rankSuggestions, suggestions,
  PipeFramer, CdpClient, BrowserPane, createManager,
} = require('./browser-pane');

// A pane whose browser is a fake: a child that never exits on its own and a
// protocol client that records calls, so the exit and frame paths run
// without Chromium.
// A real profile name (what profileName makes), for the tests that make profiles.
const P = (n) => profileName(`test:${n}`);

function fakePane(onExit, extra = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); child.signalCode = signal; child.emit('exit', null, signal); };
  const calls = [];
  const cdp = { send: (method, params, sessionId) => { calls.push({ method, params, sessionId }); return Promise.resolve(method === 'Page.captureScreenshot' ? { data: 'U05BUA==' } : { entries: [{ id: 1, url: 'http://x/', title: 'X' }], currentIndex: 0 }); }, close: () => { calls.push({ method: 'close' }); } };
  const sent = [];
  const transport = { send: (m) => sent.push(m), bufferedAmount: () => 0 };
  const pane = new BrowserPane({ streamId: 's1', paneKey: 'k1', binary: '/x/chromium', home: '/h', transport, log: () => {}, onExit, killGraceMs: 10, ackTimeoutMs: 30, ...extra });
  pane.child = child;
  pane.cdp = cdp;
  pane.sessionId = 'S';
  return { pane, child, calls, sent, transport };
}

test('the caret stylesheet is one idempotent rule, added once per document', () => {
  const { CARET_STILL_SCRIPT } = require('./browser-pane');
  assert.match(CARET_STILL_SCRIPT, /caret-animation: manual !important/);
  assert.match(CARET_STILL_SCRIPT, /getElementById\("termag-browser-pane-caret"\)\) return/);
  assert.doesNotThrow(() => new Function(CARET_STILL_SCRIPT));
});

test('the capability names the protocol version', () => {
  assert.deepEqual(CAPABILITIES, ['browser-pane-v1']);
  assert.ok(MAX_PANES >= 1);
});

test('findChromium: the override wins, then the snap, then PATH; null when nothing exists', () => {
  const have = new Set(['/snap/bin/chromium', '/usr/bin/chromium-browser', '/opt/chrome/chrome']);
  const exists = (p) => have.has(p);
  const env = { PATH: '/usr/local/bin:/usr/bin' };
  assert.equal(findChromium(env, exists), '/snap/bin/chromium');
  assert.equal(findChromium({ ...env, TERMAG_CHROMIUM: '/opt/chrome/chrome' }, exists), '/opt/chrome/chrome');
  assert.equal(findChromium({ ...env, TERMAG_CHROMIUM: '/nowhere/chrome' }, exists), '/snap/bin/chromium');
  assert.equal(findChromium(env, (p) => p === '/usr/bin/chromium-browser'), '/usr/bin/chromium-browser');
  assert.equal(findChromium(env, () => false), null);
});

test('profileRoot: the snap writes under its own data dir, anything else under ~/.cache', () => {
  assert.equal(profileRoot('/snap/bin/chromium', '/home/u'), '/home/u/snap/chromium/common/termag-browser-pane');
  assert.equal(profileRoot('/usr/bin/chromium', '/home/u'), '/home/u/.cache/termag/browser-pane');
});

test('clampViewport: bounds, rounding, defaults for garbage', () => {
  assert.deepEqual(clampViewport(1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(clampViewport(10, 99999), { width: VIEWPORT.minWidth, height: VIEWPORT.maxHeight });
  assert.deepEqual(clampViewport('800.6', '600.2'), { width: 801, height: 600 });
  assert.deepEqual(clampViewport(undefined, NaN), { width: VIEWPORT.defaultWidth, height: VIEWPORT.defaultHeight });
});

test('normalizeUrl: http(s) and about:blank only; a bare host or host:port gets http://', () => {
  assert.equal(normalizeUrl('http://127.0.0.2/'), 'http://127.0.0.2/');
  assert.equal(normalizeUrl('  https://example.test/a?b=1 '), 'https://example.test/a?b=1');
  assert.equal(normalizeUrl('127.0.0.2:3012/flags'), 'http://127.0.0.2:3012/flags');
  assert.equal(normalizeUrl('localhost'), 'http://localhost/');
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeUrl('localhost:3000/flags?x=1'), 'http://localhost:3000/flags?x=1');
  assert.equal(normalizeUrl(''), 'about:blank');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('mailto:someone@example.test'), null);
  assert.equal(normalizeUrl('chrome://settings'), null);
  assert.equal(normalizeUrl(42), null);
  assert.equal(normalizeUrl('http://'), null);
});

test('chromiumArgs: headless over the pipe, the profile dir, the window size, no debugging port', () => {
  const args = chromiumArgs({ profileDir: '/p/d', width: 1024, height: 768 });
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--remote-debugging-pipe'));
  assert.ok(args.includes('--user-data-dir=/p/d'));
  assert.ok(args.includes('--window-size=1024,768'));
  assert.ok(!args.some((a) => a.startsWith('--remote-debugging-port')));
  assert.equal(args[args.length - 1], 'about:blank');
});

test('inputToCdp: mouse events are clamped to the viewport and carry only known fields', () => {
  const vp = { width: 800, height: 600 };
  assert.deepEqual(inputToCdp({ kind: 'mouse', type: 'mousePressed', x: 10.4, y: 20.6, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 }, vp), {
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x: 10, y: 21, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 },
  });
  assert.deepEqual(inputToCdp({ kind: 'mouse', type: 'mouseMoved', x: -50, y: 9999, button: 'back', buttons: 999, clickCount: 9, modifiers: 99 }, vp).params,
    { type: 'mouseMoved', x: 0, y: 600, button: 'none', buttons: 31, clickCount: 3, modifiers: 15 });
  assert.deepEqual(inputToCdp({ kind: 'mouse', type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: 120 }, vp).params,
    { type: 'mouseWheel', x: 1, y: 1, button: 'none', buttons: 0, clickCount: 0, modifiers: 0, deltaX: 0, deltaY: 120 });
  assert.equal(inputToCdp({ kind: 'mouse', type: 'mouseDoubleClicked', x: 1, y: 1 }, vp), null);
  assert.equal(inputToCdp({ kind: 'mouse', type: 'mousePressed', x: 'a', y: 1 }, vp), null);
});

test('inputToCdp: keys carry text only on keyDown, and the virtual key code when given', () => {
  const vp = { width: 800, height: 600 };
  assert.deepEqual(inputToCdp({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, modifiers: 0 }, vp), {
    method: 'Input.dispatchKeyEvent',
    params: { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0, text: 'a', unmodifiedText: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
  });
  assert.deepEqual(inputToCdp({ kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', text: 'a' }, vp).params, { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0 });
  assert.equal(inputToCdp({ kind: 'key', type: 'keyDown', key: 'x'.repeat(40), code: '' }, vp).params.key.length, 32);
  assert.equal(inputToCdp({ kind: 'key', type: 'keyDown' }, vp), null);
  assert.equal(inputToCdp({ kind: 'key', type: 'rawKeyDown', key: 'a' }, vp), null);
  assert.equal(inputToCdp({ kind: 'key', type: 'keyDown', key: 'a', windowsVirtualKeyCode: 9999 }, vp).params.windowsVirtualKeyCode, undefined);
});

test('inputToCdp: text insertion is bounded; anything else is refused', () => {
  const vp = { width: 800, height: 600 };
  assert.deepEqual(inputToCdp({ kind: 'text', text: 'hello' }, vp), { method: 'Input.insertText', params: { text: 'hello' } });
  assert.equal(inputToCdp({ kind: 'text', text: '' }, vp), null);
  assert.equal(inputToCdp({ kind: 'text', text: 'x'.repeat(5000) }, vp), null);
  assert.equal(inputToCdp({ kind: 'touch' }, vp), null);
  assert.equal(inputToCdp(null, vp), null);
});

test('PipeFramer: documents split at NUL across chunks, multi-byte text intact, bad JSON skipped', () => {
  const seen = [];
  const framer = new PipeFramer((m) => seen.push(m));
  const whole = Buffer.from(JSON.stringify({ id: 1, result: { t: 'héllo ✓' } }) + '\0' + 'not json\0' + JSON.stringify({ method: 'E' }) + '\0');
  const cut = whole.indexOf(Buffer.from('✓')) + 1;
  framer.push(whole.subarray(0, cut));
  assert.equal(seen.length, 0);
  framer.push(whole.subarray(cut));
  assert.deepEqual(seen, [{ id: 1, result: { t: 'héllo ✓' } }, { method: 'E' }]);
});

test('CdpClient: replies resolve their request, errors reject, events reach listeners, close rejects the rest', async () => {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const client = new CdpClient(toBrowser, fromBrowser);
  const written = [];
  toBrowser.on('data', (d) => written.push(d.toString()));
  const events = [];
  client.on((m) => events.push(m));
  const ok = client.send('Browser.getVersion');
  const bad = client.send('Page.navigate', { url: 'x' }, 'S1');
  const hanging = client.send('Page.enable', {}, 'S1');
  await new Promise((r) => setImmediate(r));
  const sent = written.map((w) => JSON.parse(w.slice(0, -1)));
  assert.deepEqual(sent[0], { id: 1, method: 'Browser.getVersion', params: {} });
  assert.deepEqual(sent[1], { id: 2, method: 'Page.navigate', params: { url: 'x' }, sessionId: 'S1' });
  fromBrowser.write(JSON.stringify({ id: 1, result: { product: 'Chrome/1' } }) + '\0');
  fromBrowser.write(JSON.stringify({ method: 'Page.loadEventFired', params: {}, sessionId: 'S1' }) + '\0');
  fromBrowser.write(JSON.stringify({ id: 2, error: { code: -32000, message: 'Cannot navigate to invalid URL' } }) + '\0');
  assert.deepEqual(await ok, { product: 'Chrome/1' });
  await assert.rejects(bad, /Page.navigate: Cannot navigate to invalid URL/);
  assert.deepEqual(events, [{ method: 'Page.loadEventFired', params: {}, sessionId: 'S1' }]);
  client.close();
  await assert.rejects(hanging, /browser closed/);
  await assert.rejects(client.send('Page.enable'), /browser closed/);
});

test('a crashed page is reported and takes the browser process down with it', async () => {
  const exits = [];
  const { pane, child, calls } = fakePane((reason) => exits.push(reason));
  pane.handleEvent({ method: 'Inspector.targetCrashed', sessionId: 'S' });
  assert.deepEqual(exits, ['page crashed']);
  assert.ok(calls.some((c) => c.method === 'Browser.close'));
  assert.equal(pane.closed, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(child.killed, ['SIGKILL']);
  pane.handleEvent({ method: 'Target.detachedFromTarget', sessionId: 'S', params: { sessionId: 'S' } });
  pane.handleProcessExit('browser exited');
  assert.deepEqual(exits, ['page crashed']);
});

test('a page that closes itself is reported like a crash; a requested close is not reported', async () => {
  const exits = [];
  const gone = fakePane((reason) => exits.push(reason));
  gone.pane.handleEvent({ method: 'Target.detachedFromTarget', sessionId: 'S', params: { sessionId: 'S' } });
  assert.deepEqual(exits, ['page closed']);
  const other = fakePane((reason) => exits.push(reason));
  other.pane.handleEvent({ method: 'Target.detachedFromTarget', sessionId: 'S', params: { sessionId: 'OTHER' } });
  assert.equal(other.pane.closed, false);
  const quiet = fakePane((reason) => exits.push(`unexpected ${reason}`));
  quiet.pane.close();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(quiet.child.killed, ['SIGKILL']);
  quiet.pane.handleProcessExit('browser exited');
  assert.deepEqual(exits, ['page closed']);
});

test('frames wait for the backend ack before Chromium gets the next, with a timeout as the fallback', async () => {
  const { pane, calls, sent } = fakePane(() => {});
  const frame = (sid) => ({ data: 'AAAA', sessionId: sid, metadata: { deviceWidth: 800, deviceHeight: 600 } });
  pane.handleFrame(frame(1));
  pane.handleFrame(frame(2));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { type: 'browser-frame', streamId: 's1', data: 'AAAA', width: 800, height: 600 });
  const acks = () => calls.filter((c) => c.method === 'Page.screencastFrameAck').map((c) => c.params.sessionId);
  assert.deepEqual(acks(), [], 'nothing acked until the backend says the frame left');
  pane.frameAck();
  assert.deepEqual(acks(), [1], 'the oldest frame is acked first');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(acks(), [1, 2], 'a frame nobody acked is released by the timeout');
  pane.frameAck();
  assert.deepEqual(acks(), [1, 2], 'a stray ack with nothing pending is ignored');
});

test('a frame that arrives while parked is acked at once so Chromium is never stuck', async () => {
  const { pane, calls, sent } = fakePane(() => {});
  await pane.suspend();
  assert.equal(pane.parked, true);
  assert.equal(pane.streamId, null);
  assert.ok(calls.some((c) => c.method === 'Page.stopScreencast'));
  pane.handleFrame({ data: 'AAAA', sessionId: 7, metadata: { deviceWidth: 800, deviceHeight: 600 } });
  assert.deepEqual(sent, [], 'no viewer, no frame');
  assert.ok(calls.some((c) => c.method === 'Page.screencastFrameAck' && c.params.sessionId === 7));
  const result = await pane.resume({ streamId: 's2', width: 640, height: 480 });
  assert.deepEqual(result, { ok: true, streamId: 's2', resumed: true });
  assert.ok(calls.some((c) => c.method === 'Emulation.setDeviceMetricsOverride' && c.params.width === 640));
  assert.ok(calls.filter((c) => c.method === 'Page.startScreencast').length >= 1);
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(sent.map((m) => m.type), ['browser-frame', 'browser-nav'], 'the new viewer gets a frame of the page as it stands, then its place');
  assert.equal(sent[0].data, 'U05BUA==');
  assert.equal(sent[1].streamId, 's2');
});

test('a press where the page has not seen the pointer is preceded by a move to that spot', () => {
  const { pane, calls } = fakePane(() => {});
  pane.input({ kind: 'mouse', type: 'mousePressed', x: 100, y: 50, button: 'left', buttons: 1, clickCount: 1 });
  const mouse = calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params.type);
  assert.deepEqual(mouse, ['mouseMoved', 'mousePressed']);
  pane.input({ kind: 'mouse', type: 'mouseReleased', x: 100, y: 50, button: 'left', buttons: 0, clickCount: 1 });
  pane.input({ kind: 'mouse', type: 'mousePressed', x: 100, y: 50, button: 'left', buttons: 1, clickCount: 1 });
  const again = calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params.type);
  assert.deepEqual(again, ['mouseMoved', 'mousePressed', 'mouseReleased', 'mousePressed'], 'a press where the pointer already is needs no move');
});

test('parseListeners: LISTEN rows on loopback or every interface, ports in hex, both families', () => {
  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1',
    '   1: 0200007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2',
    '   2: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 3',
    '   3: 0A62014F:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4',
    '   4: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1001        0 5',
  ].join('\n');
  const tcp6 = [
    '  sl  local_address                         remote_address                        st',
    '   0: 00000000000000000000000000000000:0BC4 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0 0 1',
    '   1: 00000000000000000000000001000000:0050 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0 0 2',
  ].join('\n');
  assert.deepEqual(parseListeners([tcp, tcp6]), [
    { host: '127.0.0.1', port: 80 },
    { host: '127.0.0.2', port: 80 },
    { host: '127.0.0.1', port: 3000 },
    { host: '127.0.0.1', port: 3012 },
    { host: '[::1]', port: 80 },
  ]);
});

test('isCandidatePort: port 80 and unprivileged ports under 10000, minus the databases and local AWS stand-ins', () => {
  assert.equal(isCandidatePort(80), true);
  assert.equal(isCandidatePort(3000), true);
  assert.equal(isCandidatePort(5190), true);
  assert.equal(isCandidatePort(22), false);
  assert.equal(isCandidatePort(5432), false);
  assert.equal(isCandidatePort(5470), false);
  assert.equal(isCandidatePort(6380), false);
  assert.equal(isCandidatePort(7003), false);
  assert.equal(isCandidatePort(8123), false);
  assert.equal(isCandidatePort(26257), false);
  assert.equal(isCandidatePort(55470), false);
});

test('devStackHost: the slot from a webapp checkout\'s dev-stack override, or null', () => {
  const files = { '/p/dev-stack/.env.override': 'STACK_AWS_PROFILE=\nDEV_INSTANCE=2\nEXAMPLE_API_KEY=x\n' };
  const read = (f) => { if (f in files) return files[f]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.equal(devStackHost('/p', read), '127.0.0.2');
  assert.equal(devStackHost('/q', read), null);
  assert.equal(devStackHost(null, read), null);
  assert.equal(devStackHost('/p', () => 'DEV_INSTANCE=999\n'), null);
});

test('rankSuggestions: the slot front door, then any port 80, then titled pages, then the lowest port; the hint lifts only the front door', () => {
  const items = [
    { host: '127.0.0.1', port: 3012, title: '' },
    { host: '127.0.0.1', port: 3000, title: 'Example App' },
    { host: '127.0.0.1', port: 80, title: 'Sign in' },
    { host: '127.0.0.2', port: 80, title: 'Sign in' },
    { host: '127.0.0.2', port: 8000, title: 'Floci' },
    { host: '127.0.0.2', port: 8082, title: 'Cockroach Console' },
    { host: '127.0.0.1', port: 3070, title: '' },
  ];
  assert.deepEqual(rankSuggestions(items, '127.0.0.2').map((s) => `${s.host}:${s.port}`),
    ['127.0.0.2:80', '127.0.0.1:80', '127.0.0.1:3000', '127.0.0.2:8000', '127.0.0.2:8082', '127.0.0.1:3012', '127.0.0.1:3070']);
});

test('suggestions: probes candidate listeners and keeps those that answer HTTP, best first', async () => {
  const tcp = [
    'hdr',
    '   0: 0200007F:0050 00000000:0000 0A 0 0 0 0 0 0 0 1',
    '   1: 00000000:0BB8 00000000:0000 0A 0 0 0 0 0 0 0 2',
    '   2: 00000000:1538 00000000:0000 0A 0 0 0 0 0 0 0 3',
    '   3: 00000000:0016 00000000:0000 0A 0 0 0 0 0 0 0 4',
  ].join('\n');
  const files = { '/proc/net/tcp': tcp, '/proc/net/tcp6': '', '/p/dev-stack/.env.override': 'DEV_INSTANCE=2\n' };
  const read = (f) => { if (f in files) return files[f]; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  const probed = [];
  const probe = async (url) => {
    probed.push(url);
    if (url === 'http://127.0.0.2/') return { ok: true, status: 200, title: 'Sign in' };
    if (url === 'http://127.0.0.1:3000/') return { ok: true, status: 302, title: '' };
    return { ok: false };
  };
  const out = await suggestions({ cwd: '/p', readFileSync: read, probe });
  assert.deepEqual(out.map((s) => [s.url, s.title, s.status]), [['http://127.0.0.2/', 'Sign in', 200], ['http://127.0.0.1:3000/', '', 302]]);
  assert.ok(!probed.some((u) => u.endsWith(':22/')), 'ssh is never probed');
  assert.ok(!probed.some((u) => u.endsWith(':5432/')), 'postgres is never probed');
});

test('manager: parks a closed pane under its key, reclaims it on the next attach, kills it when the park expires', async () => {
  const log = [];
  const made = [];
  const paneFactory = (opts) => {
    const f = fakePane(opts.onExit, { streamId: opts.streamId, paneKey: opts.paneKey, transport: opts.transport });
    f.pane.open = async ({ url }) => { f.opened = url; return { ok: true, streamId: f.pane.streamId }; };
    made.push(f);
    return f.pane;
  };
  const manager = createManager({ binary: '/x/chromium', home: '/h', log: (l) => log.push(l), parkMs: 60, paneFactory });
  const sent = [];
  manager.bindSocket({ send: (m) => sent.push(m), bufferedAmount: () => 0 });

  await manager.attach({ streamId: 'a', paneKey: 'u:p/main', url: 'http://x/', width: 800, height: 600 });
  assert.equal(made.length, 1);
  assert.equal(manager.size(), 1);
  assert.equal(manager.close('a'), true);
  assert.equal(manager.size(), 0);
  assert.equal(manager.parkedSize(), 1);
  assert.equal(made[0].pane.parked, true);
  assert.deepEqual(made[0].child.killed, [], 'parked, not killed');

  const again = await manager.attach({ streamId: 'b', paneKey: 'u:p/main', url: 'about:blank', width: 640, height: 480 });
  assert.deepEqual(again, { ok: true, streamId: 'b', resumed: true });
  assert.equal(made.length, 1, 'no second browser');
  assert.equal(manager.parkedSize(), 0);
  assert.equal(made[0].pane.streamId, 'b');

  manager.close('b');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(manager.parkedSize(), 0, 'the park expired');
  assert.deepEqual(made[0].child.killed, ['SIGKILL']);
  assert.ok(log.some((l) => /parked browser expired/.test(l)));

  // A pane without a key is closed outright.
  await manager.attach({ streamId: 'c', url: 'http://x/' });
  manager.close('c');
  assert.equal(manager.parkedSize(), 0);
  assert.equal(made[1].pane.closed, true);
});

test('manager: a socket drop parks every active pane, and the viewer is told when a parked browser dies', async () => {
  const made = [];
  const paneFactory = (opts) => {
    const f = fakePane(opts.onExit, { streamId: opts.streamId, paneKey: opts.paneKey, transport: opts.transport });
    f.pane.open = async () => ({ ok: true, streamId: f.pane.streamId });
    made.push(f);
    return f.pane;
  };
  const manager = createManager({ binary: '/x/chromium', home: '/h', log: () => {}, parkMs: 1000, paneFactory });
  const sent = [];
  manager.bindSocket({ send: (m) => sent.push(m), bufferedAmount: () => 0 });
  await manager.attach({ streamId: 'a', paneKey: 'k-a', url: 'http://x/' });
  await manager.attach({ streamId: 'b', paneKey: 'k-b', url: 'http://x/' });
  manager.unbindSocket();
  manager.parkAll();
  assert.equal(manager.size(), 0);
  assert.equal(manager.parkedSize(), 2);
  // An active pane whose process dies tells its viewer; a parked one just leaves the lot.
  manager.bindSocket({ send: (m) => sent.push(m), bufferedAmount: () => 0 });
  await manager.attach({ streamId: 'c', paneKey: 'k-a', url: 'http://x/' });
  assert.equal(manager.parkedSize(), 1);
  made[0].pane.handleProcessExit('browser exited (SIGKILL)');
  assert.deepEqual(sent.filter((m) => m.type === 'browser-exit'), [{ type: 'browser-exit', streamId: 'c', reason: 'browser exited (SIGKILL)' }]);
  assert.equal(manager.size(), 0);
  made[1].pane.handleProcessExit('browser exited');
  assert.equal(manager.parkedSize(), 0);
  manager.closeAll();
});

test('manager: at the cap, the oldest parked browser makes room; with none parked the attach is refused', async () => {
  const made = [];
  const paneFactory = (opts) => {
    const f = fakePane(opts.onExit, { streamId: opts.streamId, paneKey: opts.paneKey, transport: opts.transport });
    f.pane.open = async () => ({ ok: true, streamId: f.pane.streamId });
    made.push(f);
    return f.pane;
  };
  const manager = createManager({ binary: '/x/chromium', home: '/h', log: () => {}, parkMs: 10_000, paneFactory });
  manager.bindSocket({ send: () => {}, bufferedAmount: () => 0 });
  for (let i = 0; i < MAX_PANES; i++) await manager.attach({ streamId: `s${i}`, paneKey: `k${i}`, url: 'http://x/' });
  await assert.rejects(manager.attach({ streamId: 'extra', paneKey: 'kx', url: 'http://x/' }), /at most/);
  manager.close('s0');
  await manager.attach({ streamId: 'extra', paneKey: 'kx', url: 'http://x/' });
  assert.equal(made[0].pane.closed, true, 'the parked one was evicted');
  assert.equal(manager.size(), MAX_PANES);
  manager.closeAll();
  assert.equal(manager.size() + manager.parkedSize(), 0);
});

test('manager: refuses without a binary, requires a stream id and an http url, ignores unknown streams', async () => {
  const none = createManager({ binary: null, home: '/h', log: () => {} });
  await assert.rejects(none.attach({ streamId: 's', url: 'http://localhost/' }), /no Chromium/);
  const manager = createManager({ binary: '/nonexistent/chromium', home: '/h', log: () => {} });
  await assert.rejects(manager.attach({ url: 'http://localhost/' }), /streamId is required/);
  await assert.rejects(manager.attach({ streamId: 's', url: 'file:///x' }), /url must be http or https/);
  manager.input({ streamId: 'nope', event: { kind: 'text', text: 'x' } });
  manager.frameAck({ streamId: 'nope' });
  assert.equal(manager.close('nope'), false);
  manager.parkAll();
  manager.closeAll();
});

test('a snapshot frame waits for its ack like any other, releases nothing to Chromium, and is dropped when a screencast frame or a later snapshot overtook it', async () => {
  const { pane, calls, sent } = fakePane(() => {});
  const frame = (sid) => ({ data: 'AAAA', sessionId: sid, metadata: { deviceWidth: 800, deviceHeight: 600 } });
  const acks = () => calls.filter((c) => c.method === 'Page.screencastFrameAck').map((c) => c.params.sessionId);
  pane.sendSnapshot();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data, 'U05BUA==');
  assert.equal(pane.pendingFrames.length, 1, 'the snapshot is in the ack queue');
  assert.equal(pane.pendingFrames[0].sid, null);
  pane.handleFrame(frame(1));
  assert.equal(pane.pendingFrames.length, 2);
  pane.frameAck();
  assert.deepEqual(acks(), [], 'the first ack is the snapshot\'s: Chromium is not released for it');
  pane.frameAck();
  assert.deepEqual(acks(), [1], 'the second ack releases the screencast frame');

  // A slow screenshot that a screencast frame overtakes never reaches the viewer.
  const send = pane.cdp.send;
  const shots = [];
  pane.cdp.send = (method, params, sessionId) => (method === 'Page.captureScreenshot' ? new Promise((r) => { shots.push(r); }) : send(method, params, sessionId));
  pane.sendSnapshot();
  pane.handleFrame(frame(2));
  shots.shift()({ data: 'STALE' });
  await new Promise((r) => setImmediate(r));
  assert.ok(!sent.some((m) => m.data === 'STALE'), 'the stale snapshot is dropped');
  assert.equal(pane.pendingFrames.length, 1, 'only the screencast frame waits');
  pane.frameAck();

  // Two snapshots in flight (a resize right behind an attach): screenshots
  // resolve in request order, and only the later one is shown.
  pane.sendSnapshot();
  pane.sendSnapshot();
  assert.equal(shots.length, 2);
  shots[0]({ data: 'OLDER' });
  await new Promise((r) => setImmediate(r));
  assert.ok(!sent.some((m) => m.data === 'OLDER'), 'the older of two overlapping snapshots is dropped');
  shots[1]({ data: 'NEWER' });
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.some((m) => m.data === 'NEWER'), 'the later one is sent');
  assert.equal(pane.pendingFrames.length, 1);
});

test('acks to Chromium keep at least the frame interval apart, so a fast link is capped near 20 fps', async () => {
  const { pane, calls } = fakePane(() => {});
  const frame = (sid) => ({ data: 'AAAA', sessionId: sid, metadata: { deviceWidth: 800, deviceHeight: 600 } });
  const acks = () => calls.filter((c) => c.method === 'Page.screencastFrameAck').map((c) => c.params.sessionId);
  pane.handleFrame(frame(1));
  pane.frameAck();
  assert.deepEqual(acks(), [1], 'the first ack is immediate');
  pane.handleFrame(frame(2));
  pane.frameAck();
  assert.deepEqual(acks(), [1], 'the second waits for the interval');
  await new Promise((r) => setTimeout(r, MIN_FRAME_INTERVAL_MS + 20));
  assert.deepEqual(acks(), [1, 2]);
});

test('quality steps down after slow acks and back up after a run of fast ones, restarting the screencast each time', async () => {
  const { pane, calls } = fakePane(() => {});
  assert.equal(pane.quality, QUALITY_RUNGS[0]);
  for (let i = 0; i < ADAPT_AFTER; i++) pane.noteAckLatency(SLOW_ACK_MS + 50);
  assert.equal(pane.quality, QUALITY_RUNGS[1]);
  await new Promise((r) => setImmediate(r));
  const starts = () => calls.filter((c) => c.method === 'Page.startScreencast');
  assert.equal(starts().length, 1);
  assert.equal(starts()[0].params.quality, QUALITY_RUNGS[1], 'the restart carries the new quality');
  for (let i = 0; i < ADAPT_AFTER; i++) pane.noteAckLatency(SLOW_ACK_MS + 50);
  assert.equal(pane.quality, QUALITY_RUNGS[2], 'down to the floor');
  for (let i = 0; i < ADAPT_AFTER; i++) pane.noteAckLatency(SLOW_ACK_MS + 50);
  assert.equal(pane.quality, QUALITY_RUNGS[2], 'never below the floor');
  // A middling ack resets both counts; a run of fast ones climbs one rung.
  pane.noteAckLatency((SLOW_ACK_MS + FAST_ACK_MS) / 2);
  for (let i = 0; i < ADAPT_AFTER * 4; i++) pane.noteAckLatency(FAST_ACK_MS - 10);
  assert.equal(pane.quality, QUALITY_RUNGS[1]);
});

// ── Guest panes ─────────────────────────────────────

test('chromiumArgs: a guest gets the proxy, loopback included, no QUIC and a big cache; an owner gets none of it', () => {
  const owner = chromiumArgs({ profileDir: '/p', width: 800, height: 600 });
  assert.ok(!owner.some((a) => /proxy|quic|disk-cache/.test(a)));
  const guest = chromiumArgs({ profileDir: '/p', width: 800, height: 600, proxyPort: 47100 });
  for (const want of ['--proxy-server=http://127.0.0.1:47100', '--proxy-bypass-list=<-loopback>', '--disable-quic', '--disk-cache-size=1073741824']) {
    assert.ok(guest.includes(want), want);
  }
  assert.ok(guest.includes('--disable-component-update'));
  assert.equal(guest.filter((a) => a.startsWith('--disable-features=')).length, 1, 'Chromium reads only the last --disable-features');
  assert.ok(!owner.includes('--disable-component-update'));
  assert.equal(guest[guest.length - 1], 'about:blank');
  assert.ok(guest.includes('--remote-debugging-pipe'));
});

test('isGuestKey: only the backend-built guest:<share>:<viewer> form', () => {
  const { isGuestKey } = require('./browser-pane');
  assert.equal(isGuestKey('guest:s1:u1'), true);
  for (const k of ['u1:p/main', 'guestx:1', '', null, undefined]) assert.equal(isGuestKey(k), false, String(k));
});

const GUEST = { origins: ['127.0.0.2:80', '127.0.0.2:3012'], profilesRoot: '/home/termag-guest/p', cwd: '/w' };

test('a guest pane navigates only within the share, and reports what it refused', () => {
  const { pane, calls, sent } = fakePane(() => {}, { guest: GUEST });
  pane.navigate('http://127.0.0.2/flags');
  pane.navigate('127.0.0.2:3012/x');
  pane.navigate('about:blank');
  pane.navigate('http://127.0.0.2:26257/');
  pane.navigate('http://169.254.169.254/latest/meta-data/');
  assert.deepEqual(calls.filter((c) => c.method === 'Page.navigate').map((c) => c.params.url), ['http://127.0.0.2/flags', 'http://127.0.0.2:3012/x', 'about:blank']);
  assert.deepEqual(sent.filter((m) => m.type === 'browser-blocked').map((m) => [m.origin, m.local]), [['127.0.0.2:26257', true], ['169.254.169.254:80', false]]);
  // An owner's pane has no such limit.
  const owner = fakePane(() => {});
  owner.pane.navigate('http://127.0.0.2:26257/');
  assert.equal(owner.calls.filter((c) => c.method === 'Page.navigate').length, 1);
});

test('a guest pane resumes its own new pages and closes any other: a popup never runs', () => {
  const log = [];
  const { pane, calls } = fakePane(() => {}, { guest: GUEST, log: (l) => log.push(l) });
  pane.expectOwnPage = 1;
  pane.handleEvent({ method: 'Target.attachedToTarget', params: { sessionId: 'own-s', waitingForDebugger: true, targetInfo: { targetId: 'own', type: 'page' } } });
  pane.handleEvent({ method: 'Target.attachedToTarget', params: { sessionId: 'pop-s', waitingForDebugger: true, targetInfo: { targetId: 'pop', type: 'page' } } });
  pane.handleEvent({ method: 'Target.attachedToTarget', params: { sessionId: 'w-s', waitingForDebugger: true, targetInfo: { targetId: 'w', type: 'worker' } } });
  // A child of the page's own session is not the browser's auto-attach.
  pane.handleEvent({ sessionId: 'S', method: 'Target.attachedToTarget', params: { sessionId: 'f-s', targetInfo: { targetId: 'f', type: 'page' } } });
  assert.deepEqual(calls.filter((c) => c.method === 'Runtime.runIfWaitingForDebugger').map((c) => c.sessionId), ['own-s']);
  assert.deepEqual(calls.filter((c) => c.method === 'Target.closeTarget').map((c) => c.params.targetId), ['pop']);
  assert.ok(log.some((l) => /closed a page it did not open/.test(l)));
  // An owner's pane closes nothing.
  const owner = fakePane(() => {});
  owner.pane.handleEvent({ method: 'Target.attachedToTarget', params: { sessionId: 'x', targetInfo: { targetId: 'x', type: 'page' } } });
  assert.equal(owner.calls.filter((c) => c.method === 'Target.closeTarget').length, 0);
});

test('a guest pane\'s own-page expectation balances whichever comes first, the attach or the answer, and a failed create', async () => {
  const log = [];
  const { pane, calls } = fakePane(() => {}, { guest: GUEST, log: (l) => log.push(l) });
  const attach = (id) => pane.handleEvent({ method: 'Target.attachedToTarget', params: { sessionId: `s-${id}`, waitingForDebugger: true, targetInfo: { targetId: id, type: 'page' } } });
  // The answer first, the attach after: the page is known by id; nothing is left over.
  pane.cdp.send = (method, params, sessionId) => { calls.push({ method, params, sessionId }); return Promise.resolve(method === 'Target.createTarget' ? { targetId: 'late' } : {}); };
  await pane.createOwnTarget('about:blank');
  assert.equal(pane.expectOwnPage, 0);
  attach('late');
  // The attach first (while the call is in flight), the answer after.
  let answer;
  pane.cdp.send = (method, params, sessionId) => { calls.push({ method, params, sessionId }); return method === 'Target.createTarget' ? new Promise((r) => { answer = r; }) : Promise.resolve({}); };
  const early = pane.createOwnTarget('about:blank');
  attach('early');
  answer({ targetId: 'early' });
  await early;
  assert.equal(pane.expectOwnPage, 0);
  // A failed create gives its expectation back.
  pane.cdp.send = (method) => (method === 'Target.createTarget' ? Promise.reject(new Error('boom')) : Promise.resolve({}));
  await assert.rejects(pane.createOwnTarget('about:blank'), /boom/);
  assert.equal(pane.expectOwnPage, 0);
  // A page opened by another page is a popup even while a create is in flight.
  let answer2;
  pane.cdp.send = (method, params, sessionId) => { calls.push({ method, params, sessionId }); return method === 'Target.createTarget' ? new Promise((r) => { answer2 = r; }) : Promise.resolve({}); };
  const third = pane.createOwnTarget('about:blank');
  pane.handleEvent({ method: 'Target.attachedToTarget', params: { sessionId: 's-opened', waitingForDebugger: true, targetInfo: { targetId: 'opened', type: 'page', openerId: 'late' } } });
  // And a foreign page without an opener that takes the expectation first is closed once the answer names the real one.
  attach('stray');
  answer2({ targetId: 'mine' });
  await third;
  attach('mine');
  assert.equal(pane.expectOwnPage, 0);
  assert.ok(calls.some((c) => c.method === 'Target.closeTarget' && c.params.targetId === 'opened'));
  assert.ok(calls.some((c) => c.method === 'Target.closeTarget' && c.params.targetId === 'stray'));
  assert.ok(pane.ownTargets.has('mine') && !pane.ownTargets.has('stray'));
  pane.cdp.send = (method, params, sessionId) => { calls.push({ method, params, sessionId }); return Promise.resolve({}); };
  calls.length = 0;
  // So the next page nobody asked for is a popup.
  pane.cdp.send = (method, params, sessionId) => { calls.push({ method, params, sessionId }); return Promise.resolve({}); };
  attach('popup');
  assert.deepEqual(calls.filter((c) => c.method === 'Target.closeTarget').map((c) => c.params.targetId), ['popup']);
});

test('a JavaScript dialog is shown to a viewer who can answer it, and their answer goes to the page', () => {
  const { pane, calls, sent } = fakePane(() => {});
  pane.relayDialogs = true;
  const answers = () => calls.filter((c) => c.method === 'Page.handleJavaScriptDialog').map((c) => c.params);
  pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: 'Delete this flag?' } });
  assert.deepEqual(sent.filter((m) => m.type === 'browser-dialog'), [{ type: 'browser-dialog', id: 1, kind: 'confirm', message: 'Delete this flag?', streamId: 's1' }]);
  assert.deepEqual(answers(), [], 'the page waits for the viewer');
  // A second dialog while one is open: answered at once, as before.
  pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x' } });
  assert.deepEqual(answers(), [{ accept: false }]);
  // A stale answer is ignored; the right one goes through, and the viewer is told it closed.
  pane.answerDialog({ id: 99, accept: true });
  pane.answerDialog({ id: 1, accept: true });
  assert.deepEqual(answers(), [{ accept: false }, { accept: true }]);
  assert.ok(sent.some((m) => m.type === 'browser-dialog-closed' && m.id === 1));
  // A prompt takes the viewer's text, bounded; a beforeunload never asks.
  pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogOpening', params: { type: 'prompt', message: 'Name?', defaultPrompt: 'flag-1' } });
  assert.equal(sent.filter((m) => m.type === 'browser-dialog').pop().defaultPrompt, 'flag-1');
  pane.answerDialog({ id: 2, accept: true, text: 'x'.repeat(5000) });
  assert.equal(answers().pop().promptText.length, 2000);
  pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogOpening', params: { type: 'beforeunload' } });
  assert.deepEqual(answers().pop(), { accept: true });
});

test('a dialog the viewer leaves is dismissed after a while, and at once when the page parks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pane, calls, sent } = fakePane(() => {});
  pane.relayDialogs = true;
  const answers = () => calls.filter((c) => c.method === 'Page.handleJavaScriptDialog').map((c) => c.params);
  pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: 'Sure?' } });
  t.mock.timers.tick(59_000);
  assert.deepEqual(answers(), []);
  t.mock.timers.tick(1_000);
  assert.deepEqual(answers(), [{ accept: false }]);
  assert.ok(sent.some((m) => m.type === 'browser-dialog-closed' && m.id === 1));
  pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'Hi' } });
  await pane.suspend();
  assert.deepEqual(answers(), [{ accept: false }, { accept: false }], 'nobody left to answer it');
  // The page closing it itself (it navigated) clears it too.
  const g = fakePane(() => {});
  g.pane.relayDialogs = true;
  g.pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'Hi' } });
  g.pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogClosed', params: { result: false } });
  assert.equal(g.pane.pendingDialog, null);
  assert.ok(g.sent.some((m) => m.type === 'browser-dialog-closed'));
});

test('a JavaScript dialog is answered at once where nobody can answer it: leaving the page is allowed, the rest dismissed', () => {
  const { pane, calls } = fakePane(() => {});
  pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x' } });
  pane.handleEvent({ sessionId: 'S', method: 'Page.javascriptDialogOpening', params: { type: 'beforeunload' } });
  assert.deepEqual(calls.filter((c) => c.method === 'Page.handleJavaScriptDialog').map((c) => c.params.accept), [false, true]);
});

test('a guest pane deletes its profile through the launcher, never itself', async () => {
  const forgot = [];
  const { pane } = fakePane(() => {}, { guest: GUEST, guestDeps: { runLauncher: async (args) => { forgot.push(args); return ''; } } });
  pane.guestProfile = 'tmp-abc';
  pane.profileDir = '/home/termag-guest/p/tmp-abc';
  pane.child.exitCode = 0;
  pane.close();
  assert.deepEqual(forgot, [['--termag-forget', 'tmp-abc']]);
  assert.equal(pane.profileDir, null);
});

test('a guest pane closed by force loses its sudo parent and its DevTools pipe, which ends its Chromium', async () => {
  const { pane, child } = fakePane(() => {}, { guest: GUEST, guestDeps: { runLauncher: async () => '' } });
  const destroyed = [];
  child.stdio = [null, null, null, { destroy: () => destroyed.push(3) }, { destroy: () => destroyed.push(4) }];
  child.kill = (signal) => { child.killed.push(signal); };
  pane.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(child.killed, ['SIGKILL']);
  assert.deepEqual(destroyed, [3, 4]);
});

function guestManager({ resolveRecipe, mem = 64 * 1024 ** 3, envOk = true } = {}) {
  const made = [];
  const forgot = [];
  const paneFactory = (opts) => {
    const f = fakePane(opts.onExit, { streamId: opts.streamId, paneKey: opts.paneKey, transport: opts.transport, guest: opts.guest, guestDeps: opts.guestDeps });
    f.pane.open = async ({ url }) => { f.opened = url; return { ok: true, streamId: f.pane.streamId }; };
    f.pane.resume = async ({ streamId }) => { f.pane.streamId = streamId; return { ok: true, streamId, resumed: true }; };
    made.push(f);
    return f.pane;
  };
  const guestDeps = {
    resolveRecipe: resolveRecipe || (async () => ({ ok: true, origins: ['127.0.0.2:80', '127.0.0.2:3012'], primaryUrl: 'http://127.0.0.2/' })),
    memAvailableBytes: () => mem,
    runLauncher: async (args) => { forgot.push(args); return args[0] === '--termag-list' ? 'tmp-old 1\nkept 2\n' : ''; },
  };
  const manager = createManager({ binary: '/x/chromium', home: '/h', log: () => {}, parkMs: 10_000, paneFactory,
    guestEnv: envOk ? { ok: true, profilesRoot: '/home/termag-guest/p' } : { ok: false, reason: 'no launcher' }, guestDeps });
  manager.bindSocket({ send: () => {}, bufferedAmount: () => 0 });
  return { manager, made, forgot };
}
const guestAttach = (streamId, key, extra = {}) => ({ streamId, paneKey: key, mode: 'guest', url: 'about:blank', recipe: { kind: 'webapp-dev-stack' }, cwd: '/w', maxGuestPanes: 2, ...extra });

test('manager: a guest attach fails closed when its mode, key, box, stack or URL is wrong', async () => {
  const { manager } = guestManager();
  await assert.rejects(manager.attach({ streamId: 'a', paneKey: 'u:p/main', mode: 'guest', url: 'http://x/' }), /^Error: guest-mode:/);
  await assert.rejects(manager.attach({ streamId: 'b', paneKey: 'guest:s:u', url: 'http://x/' }), /^Error: guest-mode:/, 'a guest key without guest mode');
  await assert.rejects(manager.attach(guestAttach('c', 'guest:s:u', { url: 'http://127.0.0.2:26257/' })), /^Error: guest-url:/);
  const down = guestManager({ resolveRecipe: async () => ({ ok: false, reason: 'other-workstream' }) });
  await assert.rejects(down.manager.attach(guestAttach('d', 'guest:s:u')), /^Error: guest-stack:other-workstream/);
  const off = guestManager({ envOk: false });
  await assert.rejects(off.manager.attach(guestAttach('e', 'guest:s:u')), /^Error: guest-unavailable: no launcher/);
  const low = guestManager({ mem: 1024 ** 3 });
  await assert.rejects(low.manager.attach(guestAttach('f', 'guest:s:u')), /^Error: guest-memory:/);
});

test('manager: an owner\'s own share link opens on the share\'s app, not the remembered one; a recipe that does not resolve changes nothing', async () => {
  let { manager, made } = guestManager();
  await manager.attach({ streamId: 'a', paneKey: 'u:p/main', url: 'http://127.0.0.1:3000/', openRecipe: { kind: 'webapp-dev-stack' }, cwd: '/w', atPath: '/flags?x=1' });
  assert.equal(made[0].opened, 'http://127.0.0.2/flags?x=1');
  assert.equal(made[0].pane.guest, null, 'still the owner\'s own browser');
  // Parked, then handed back to the same link: it goes there too.
  const navigated = [];
  made[0].pane.navigate = (u) => navigated.push(u);
  manager.close('a');
  await manager.attach({ streamId: 'b', paneKey: 'u:p/main', url: 'http://127.0.0.1:3000/x', openRecipe: { kind: 'webapp-dev-stack' }, cwd: '/w' });
  assert.deepEqual(navigated, ['http://127.0.0.2/']);
  // The stack is down (or another workstream's): the pane opens as it would have.
  ({ manager, made } = guestManager({ resolveRecipe: async () => ({ ok: false, reason: 'stack-not-running' }) }));
  await manager.attach({ streamId: 'c', paneKey: 'u:p/main', url: 'http://127.0.0.1:3000/', openRecipe: { kind: 'webapp-dev-stack' }, cwd: '/w', atPath: '/flags' });
  assert.equal(made[0].opened, 'http://127.0.0.1:3000/');
});

test('manager: a guest opens at the share\'s primary URL, with its origins, and its pane is a guest pane', async () => {
  const { manager, made } = guestManager();
  const result = await manager.attach(guestAttach('a', 'guest:s:u'));
  assert.deepEqual(result, { ok: true, streamId: 'a', origins: ['127.0.0.2:80', '127.0.0.2:3012'] });
  assert.equal(made[0].opened, 'http://127.0.0.2/');
  assert.deepEqual(made[0].pane.guest, { origins: ['127.0.0.2:80', '127.0.0.2:3012'], profilesRoot: '/home/termag-guest/p', cwd: '/w' });
});

test('manager: guests and owners are counted apart, and neither evicts the other\'s browser', async () => {
  const { manager, made } = guestManager();
  for (let i = 0; i < MAX_PANES; i++) await manager.attach({ streamId: `o${i}`, paneKey: `u:p/w${i}`, url: 'http://x/' });
  // Owners full; guests still fit, up to their own limit.
  await manager.attach(guestAttach('g1', 'guest:s:u1'));
  await manager.attach(guestAttach('g2', 'guest:s:u2'));
  await assert.rejects(manager.attach(guestAttach('g3', 'guest:s:u3')), /^Error: guest-busy: 2 reviewers are already using this preview/);
  // A parked guest makes room for a guest, never an owner's parked browser.
  manager.close('o0');
  await assert.rejects(manager.attach(guestAttach('g3', 'guest:s:u3')), /guest-busy/);
  assert.equal(made[0].pane.closed, false, 'the owner\'s parked browser is untouched');
  manager.close('g1');
  await manager.attach(guestAttach('g3', 'guest:s:u3'));
  assert.equal(made[MAX_PANES].pane.closed, true, 'the parked guest went');
  // And a guest never makes room for an owner.
  await manager.attach({ streamId: 'o-new', paneKey: 'u:p/new', url: 'http://x/' });
  assert.equal(made[0].pane.closed, true, 'the owner\'s parked browser made room for an owner');
  await assert.rejects(manager.attach({ streamId: 'o-more', paneKey: 'u:p/more', url: 'http://x/' }), /at most/);
  manager.closeAll();
});

test('manager: a zero or lowered guest limit refuses, evicting parked guests only as far as it takes', async () => {
  const { manager, made } = guestManager();
  await manager.attach(guestAttach('g1', 'guest:s:u1', { maxGuestPanes: 3 }));
  await manager.attach(guestAttach('g2', 'guest:s:u2', { maxGuestPanes: 3 }));
  await manager.attach(guestAttach('g3', 'guest:s:u3', { maxGuestPanes: 3 }));
  manager.close('g1'); manager.close('g2');
  await assert.rejects(manager.attach(guestAttach('z', 'guest:s:z', { maxGuestPanes: 0 })), /guest-busy: this box takes no reviewers/);
  assert.equal(made[0].pane.closed || made[1].pane.closed, false, 'a zero limit evicts nobody');
  // Lowered to 2 with one live and two parked: both parked go to make room.
  await manager.attach(guestAttach('g4', 'guest:s:u4', { maxGuestPanes: 2 }));
  assert.equal(made[0].pane.closed && made[1].pane.closed, true);
  // At the limit with only live guests: refused, nothing closed.
  await assert.rejects(manager.attach(guestAttach('g5', 'guest:s:u5', { maxGuestPanes: 2 })), /guest-busy: 2 reviewers/);
  manager.closeAll();
});

test('manager: a memory refusal comes before any eviction', async () => {
  let mem = 64 * 1024 ** 3;
  const made = [];
  const paneFactory = (opts) => {
    const f = fakePane(opts.onExit, { streamId: opts.streamId, paneKey: opts.paneKey, transport: opts.transport, guest: opts.guest });
    f.pane.open = async () => ({ ok: true, streamId: f.pane.streamId });
    made.push(f);
    return f.pane;
  };
  const manager = createManager({ binary: '/x/chromium', home: '/h', log: () => {}, parkMs: 10_000, paneFactory,
    guestEnv: { ok: true, profilesRoot: '/g' },
    guestDeps: { resolveRecipe: async () => ({ ok: true, origins: ['127.0.0.2:80'], primaryUrl: 'http://127.0.0.2/' }), memAvailableBytes: () => mem, runLauncher: async () => '' } });
  manager.bindSocket({ send: () => {}, bufferedAmount: () => 0 });
  await manager.attach(guestAttach('g1', 'guest:s:u1', { maxGuestPanes: 1 }));
  manager.close('g1');
  mem = 1024 ** 3;
  await assert.rejects(manager.attach(guestAttach('g2', 'guest:s:u2', { maxGuestPanes: 1 })), /guest-memory/);
  assert.equal(made[0].pane.closed, false, 'the parked reviewer keeps their browser');
  manager.closeAll();
});

test('manager: the flag-sized guest limit is clamped to the hard ceiling', async () => {
  const { MAX_GUEST_PANES_CEILING } = require('./browser-guest');
  const { manager } = guestManager();
  for (let i = 0; i < MAX_GUEST_PANES_CEILING; i++) await manager.attach(guestAttach(`g${i}`, `guest:s:u${i}`, { maxGuestPanes: 50 }));
  await assert.rejects(manager.attach(guestAttach('over', 'guest:s:over', { maxGuestPanes: 50 })), /guest-busy/);
  manager.closeAll();
});

test('manager: a parked guest browser is handed back only while the share names the same origins', async () => {
  let origins = ['127.0.0.2:80'];
  const { manager, made } = guestManager({ resolveRecipe: async () => ({ ok: true, origins, primaryUrl: 'http://127.0.0.2/' }) });
  await manager.attach(guestAttach('a', 'guest:s:u'));
  manager.close('a');
  const again = await manager.attach(guestAttach('b', 'guest:s:u'));
  assert.equal(again.resumed, true);
  assert.equal(made.length, 1);
  manager.close('b');
  origins = ['127.0.0.2:80', '127.0.0.2:3012'];
  const changed = await manager.attach(guestAttach('c', 'guest:s:u'));
  assert.equal(changed.resumed, undefined, 'a fresh browser');
  assert.equal(made.length, 2);
  assert.equal(made[0].pane.closed, true);
  manager.closeAll();
});

test('manager: a reclaimed guest browser goes to a link\'s at, and counts against a lowered limit', async () => {
  const { manager, made } = guestManager({ resolveRecipe: async () => ({ ok: true, origins: ['127.0.0.2:80'], primaryUrl: 'http://127.0.0.2/' }) });
  await manager.attach(guestAttach('a', 'guest:s:u', { maxGuestPanes: 2 }));
  manager.close('a');
  const navigated = [];
  made[0].pane.navigate = (u) => navigated.push(u);
  await manager.attach(guestAttach('b', 'guest:s:u', { maxGuestPanes: 2, url: 'http://127.0.0.2/flags/b', atPath: '/flags/b' }));
  assert.deepEqual(navigated, ['http://127.0.0.2/flags/b'], 'the link\'s page, not the last one');
  manager.close('b');
  await manager.attach(guestAttach('c', 'guest:s:u', { maxGuestPanes: 2 }));
  assert.deepEqual(navigated, ['http://127.0.0.2/flags/b'], 'a plain reconnect stays where it was');
  manager.close('c');
  // Lowered to zero while parked: refused, and still parked for later.
  await assert.rejects(manager.attach(guestAttach('d', 'guest:s:u', { maxGuestPanes: 0 })), /guest-busy: this box takes no reviewers/);
  assert.equal(manager.parkedSize(), 1);
  manager.closeAll();
});

test('manager: an extended share keeps its guest\'s kept profile until the new expiry', () => {
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'bp-exp-'));
  const index = new ProfileIndex(pathp.join(dir, 'i.json'));
  const manager = createManager({ binary: '/x/chromium', home: dir, log: () => {}, index, sweepEveryMs: 1e9 });
  const name = profileName('guest:s:u');
  assert.deepEqual(manager.profileExpiry({ profileKey: 'guest:s:u', expiresAt: '2030-01-01T00:00:00Z' }), { ok: true, known: false });
  index.touch(name, { key: 'guest:s:u', kind: 'guest', expiresAt: 1 });
  assert.deepEqual(manager.profileExpiry({ profileKey: 'guest:s:u', expiresAt: '2030-01-01T00:00:00Z' }), { ok: true, known: true });
  assert.equal(index.get(name).expiresAt, Date.parse('2030-01-01T00:00:00Z'));
  assert.deepEqual(manager.profileExpiry({ profileKey: 'u:p/main', expiresAt: '2030-01-01T00:00:00Z' }), { ok: false }, 'owners have no expiry');
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('manager: at start, stale guest profiles left by an earlier agent are deleted', async () => {
  const { forgot } = guestManager();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(forgot, [['--termag-list'], ['--termag-forget', 'tmp-old']], 'only throwaway ones, never another kind');
});

test('manager: the guest sweep leaves a held or just-made throwaway profile alone', async () => {
  const now = Math.floor(Date.now() / 1000);
  const forgot = [];
  const runLauncher = async (args) => { forgot.push(args); return args[0] === '--termag-list' ? `tmp-held ${now - 3600} 1\ntmp-new ${now} 0\ntmp-stale ${now - 3600} 0\n` : ''; };
  createManager({ binary: '/x/chromium', home: '/h', log: () => {}, guestEnv: { ok: true, profilesRoot: '/g' }, guestDeps: { runLauncher } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(forgot.filter((a) => a[0] === '--termag-forget').map((a) => a[1]), ['tmp-stale']);
});

test('a throwaway guest profile\'s delete is asked again while a quitting Chromium still holds it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const runLauncher = async (args) => { calls.push(args); if (calls.length < 3) throw new Error('exit 66: in use'); return ''; };
  const f = fakePane(() => {}, { guest: { origins: ['127.0.0.2:80'], profilesRoot: '/g', cwd: null }, guestDeps: { runLauncher } });
  f.pane.guestProfile = 'tmp-abc';
  f.pane.profileDir = '/g/tmp-abc';
  f.pane.removeProfile();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2);
  t.mock.timers.tick(4000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [['--termag-forget', 'tmp-abc'], ['--termag-forget', 'tmp-abc'], ['--termag-forget', 'tmp-abc']]);
});

// ── Persistent profiles ─────────────────────────────

const os = require('node:os');
const fsp = require('node:fs');
const pathp = require('node:path');
const { profileName, isLoopbackCookieDomain, cookieParam, ProfileIndex, ensurePrivateDir, profileLockPid, PERSISTENT_KILL_GRACE_MS, OWNER_PROFILE_IDLE_MS } = require('./browser-pane');

test('profileName: a stable hash of the pane key that fits the guest launcher\'s name rule', () => {
  const a = profileName('u1:p1/main');
  assert.match(a, /^p-[0-9a-f]{32}$/);
  assert.equal(a, profileName('u1:p1/main'));
  assert.notEqual(a, profileName('u1:p1/other'));
  assert.ok(a.length <= 64);
});

test('isLoopbackCookieDomain and cookieParam: what an owner\'s kept profile keeps, and how it is put back', () => {
  for (const d of ['localhost', '.localhost', '127.0.0.2', '127.1.2.3', '[::1]', '::1']) assert.equal(isLoopbackCookieDomain(d), true, d);
  for (const d of ['github.com', '.github.com', 'app.example.com', '10.0.0.1', '127.0.0.2.evil.com', '', undefined]) assert.equal(isLoopbackCookieDomain(d), false, String(d));
  assert.deepEqual(cookieParam({ name: 'a', value: 'b', domain: '127.0.0.2', path: '/', secure: false, httpOnly: true, sameSite: 'Lax', session: false, expires: 2e9, size: 3, priority: 'Medium' }),
    { name: 'a', value: 'b', domain: '127.0.0.2', path: '/', secure: false, httpOnly: true, sameSite: 'Lax', expires: 2e9, priority: 'Medium' });
  assert.equal('expires' in cookieParam({ name: 'a', value: 'b', domain: 'x', path: '/', session: true, expires: -1 }), false, 'a session cookie stays one');
});

test('ProfileIndex: remembers key, kind, last use and expiry across restarts, in a private file', () => {
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'bp-index-'));
  const file = pathp.join(dir, 'state', 'browser-profiles.json');
  let t = 1000;
  const index = new ProfileIndex(file, { now: () => t });
  index.touch(P('a'), { key: 'u:p/main', kind: 'owner' });
  index.touch(P('b'), { key: 'guest:s:u', kind: 'guest', expiresAt: 5000 });
  t = 2000;
  index.touch(P('b'), { key: 'guest:s:u', kind: 'guest' });
  const again = new ProfileIndex(file);
  assert.deepEqual(again.get(P('a')), { key: 'u:p/main', kind: 'owner', lastUsedAt: 1000 });
  assert.deepEqual(again.get(P('b')), { key: 'guest:s:u', kind: 'guest', lastUsedAt: 2000, expiresAt: 5000 }, 'a touch without an expiry keeps the old one');
  assert.equal(fsp.statSync(file).mode & 0o777, 0o600);
  again.remove(P('a'));
  assert.deepEqual(new ProfileIndex(file).names(), [P('b')]);
  fsp.writeFileSync(file, 'not json');
  assert.deepEqual(new ProfileIndex(file).names(), [], 'a broken index starts over');
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('ensurePrivateDir: 0700, this user\'s, never through a symlink', () => {
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'bp-priv-'));
  const root = pathp.join(dir, 'root');
  fsp.mkdirSync(root, { mode: 0o775 });
  fsp.chmodSync(root, 0o775);
  const made = ensurePrivateDir(pathp.join(root, 'profiles', P('x')), [root, pathp.join(root, 'profiles')]);
  for (const d of [root, pathp.join(root, 'profiles'), made]) assert.equal(fsp.statSync(d).mode & 0o777, 0o700, d);
  fsp.symlinkSync(os.tmpdir(), pathp.join(root, 'profiles', P('link')));
  assert.throws(() => ensurePrivateDir(pathp.join(root, 'profiles', P('link')), []), /not a plain directory/);
  // Never outside the root, and never a path that isn't in normal form.
  const parents = [root, pathp.join(root, 'profiles')];
  assert.throws(() => ensurePrivateDir(pathp.join(dir, 'elsewhere'), parents), /is not inside/);
  assert.throws(() => ensurePrivateDir(`${root}/profiles/../../escape`, parents), /not a plain absolute path/);
  assert.throws(() => ensurePrivateDir('relative/x', parents), /not a plain absolute path/);
  assert.throws(() => ensurePrivateDir(root, parents), /is not inside/);
  assert.equal(fsp.existsSync(pathp.join(dir, 'elsewhere')), false, 'nothing was made');
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('withTimeout: the value, or "timed out"; a finished promise leaves no timer and no stray rejection', async () => {
  const { withTimeout } = require('./browser-pane');
  const stray = [];
  const onStray = (err) => stray.push(err);
  process.on('unhandledRejection', onStray);
  try {
    assert.equal(await withTimeout(Promise.resolve('saved'), 20), 'saved');
    await assert.rejects(withTimeout(new Promise(() => {}), 20), /timed out/);
    await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 20), /boom/);
    // Past the timeout of the call that finished first: nothing fires.
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(stray, []);
  } finally {
    process.off('unhandledRejection', onStray);
  }
});

test('profile names: only what profileName makes is ever turned into a path', async () => {
  const { isProfileName } = require('./browser-pane');
  assert.ok(isProfileName(profileName('u:p/main')));
  for (const bad of ['p-x', '../p-0123456789abcdef0123456789abcdef', 'p-0123456789ABCDEF0123456789ABCDEF', `${profileName('a')}/x`, null, 42]) {
    assert.equal(isProfileName(bad), false, String(bad));
  }
  const { manager, index, dir, home } = keptManager();
  // The sweep leaves anything in the root that isn't one of ours alone, and an
  // old jar temp file goes.
  const profiles = pathp.join(profileRoot('/x/chromium', home), 'profiles');
  fsp.mkdirSync(pathp.join(profiles, 'p-not-ours'), { recursive: true });
  const tmp = pathp.join(profiles, `${P('t')}.cookies.json.123.tmp`);
  fsp.writeFileSync(tmp, '[]');
  const { LEFTOVER_DIR_MIN_AGE_MS } = require('./browser-pane');
  const old = new Date(Date.now() - LEFTOVER_DIR_MIN_AGE_MS - 60_000);
  fsp.utimesSync(tmp, old, old);
  index.touch('../escape', { key: 'x', kind: 'owner' });
  await manager.sweepProfiles();
  assert.ok(fsp.existsSync(pathp.join(profiles, 'p-not-ours')));
  assert.equal(fsp.existsSync(tmp), false);
  assert.equal(index.get('../escape'), null, 'an index entry that is not a profile name is dropped');
  manager.closeAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('profileLockPid reads the pid out of Chromium\'s SingletonLock', () => {
  assert.equal(profileLockPid('/p', () => 'ip-10-0-0-1-12345'), 12345);
  assert.equal(profileLockPid('/p', () => { throw new Error('ENOENT'); }), null);
});

test('chromiumArgs: an owner\'s browser gets no cache flag (its profile goes with it)', () => {
  assert.ok(!chromiumArgs({ profileDir: '/p', width: 800, height: 600 }).some((a) => a.startsWith('--disk-cache-size')));
});

test('a kept profile survives its browser, crash included; a throwaway one does not', () => {
  const kept = fakePane(() => {}, { persistent: true, profileName: P('x') });
  kept.pane.profileDir = '/nonexistent/kept';
  kept.pane.handleProcessExit('browser exited (SIGSEGV)');
  assert.equal(kept.pane.profileDir, null);
  const throwaway = fakePane(() => {}, {});
  assert.equal(throwaway.pane.persistent, false);
});

test('closing an owner\'s kept browser saves only its loopback cookies to the jar, then quits; a guest\'s and a throwaway one just quit', async () => {
  const { cookieJarPath } = require('./browser-pane');
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'bp-jar-'));
  const cookies = [
    { name: 'webapp', value: '1', domain: '127.0.0.2', path: '/', session: false, expires: 2e9 },
    { name: 'gh', value: 's', domain: '.github.com', path: '/', session: false, expires: 2e9 },
  ];
  const f = fakePane(() => {}, { persistent: true, profileName: P('x') });
  f.pane.keptDir = pathp.join(dir, P('x'));
  const order = [];
  f.pane.cdp.send = (method, params) => { order.push(method); f.calls.push({ method, params }); return Promise.resolve(method === 'Storage.getCookies' ? { cookies } : {}); };
  f.pane.cdp.closed = false;
  f.pane.close();
  assert.equal(f.pane.gone, true, 'gone at once, for the manager');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order.slice(0, 2), ['Storage.getCookies', 'Browser.close'], 'the browser is not asked to change anything');
  const jar = cookieJarPath(f.pane.keptDir);
  assert.deepEqual(JSON.parse(fsp.readFileSync(jar, 'utf8')).map((c) => c.name), ['webapp']);
  assert.equal(fsp.statSync(jar).mode & 0o777, 0o600);
  for (const extra of [{ persistent: true, profileName: P('g'), guest: { origins: ['127.0.0.2:80'], profilesRoot: '/g', cwd: null } }, {}]) {
    const g = fakePane(() => {}, extra);
    g.pane.close();
    assert.equal(g.calls.some((c) => c.method === 'Storage.getCookies'), false);
    assert.equal(g.calls.some((c) => c.method === 'Browser.close'), true);
  }
  fsp.rmSync(dir, { recursive: true, force: true });
});

function keptManager({ guestEnv = { ok: false, reason: 'off' }, runLauncher = async () => '', now = () => Date.now(), ownerRoot } = {}) {
  const made = [];
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'bp-kept-'));
  const home = pathp.join(dir, 'home');
  const index = new ProfileIndex(pathp.join(dir, 'index.json'), { now });
  const paneFactory = (opts) => {
    const f = fakePane(opts.onExit, { streamId: opts.streamId, paneKey: opts.paneKey, transport: opts.transport, persistent: opts.persistent, profileName: opts.profileName, guest: opts.guest, killGraceMs: 10 });
    f.child.on('exit', () => f.pane.handleProcessExit('browser exited'));
    f.pane.open = async () => ({ ok: true, streamId: f.pane.streamId });
    f.pane.resume = async ({ streamId }) => { f.pane.streamId = streamId; f.pane.parked = false; return { ok: true, streamId, resumed: true }; };
    f.opts = opts;
    made.push(f);
    return f.pane;
  };
  const manager = createManager({ binary: '/x/chromium', home: ownerRoot || home, log: () => {}, parkMs: 10_000, paneFactory, index, guestEnv, now, sweepEveryMs: 1e9,
    guestDeps: { runLauncher, resolveRecipe: async () => ({ ok: true, origins: ['127.0.0.2:80'], primaryUrl: 'http://127.0.0.2/' }), memAvailableBytes: () => 64 * 1024 ** 3 } });
  const sent = [];
  manager.bindSocket({ send: (m) => sent.push(m), bufferedAmount: () => 0 });
  return { manager, made, index, dir, home, sent };
}

test('manager: a kept profile only when asked for, named for the pane key; a guest\'s gets the longer grace to quit', async () => {
  const { PROFILE_WAIT_MS, JAR_TOTAL_MS } = require('./browser-pane');
  const { manager, made, index, dir } = keptManager({ guestEnv: { ok: true, profilesRoot: '/g' } });
  await manager.attach({ streamId: 'a', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true });
  await manager.attach({ streamId: 'b', paneKey: 'u:p/other', url: 'http://x/' });
  assert.equal(made[0].opts.profileName, profileName('u:p/main'));
  // An owner's profile goes with its browser (its jar is saved first): the usual grace.
  assert.equal(made[0].opts.killGraceMs, undefined);
  await manager.attach({ streamId: 'g', paneKey: 'guest:s:u', mode: 'guest', url: 'about:blank', recipe: { kind: 'manual', origins: ['127.0.0.2:80'] }, persistProfile: true });
  assert.equal(made[made.length - 1].opts.killGraceMs, PERSISTENT_KILL_GRACE_MS, 'a guest\'s kept profile is Chromium\'s own: cookies flushed on the way out');
  // A reopen or a forget waits out the slowest close there is.
  assert.ok(PROFILE_WAIT_MS > JAR_TOTAL_MS + PERSISTENT_KILL_GRACE_MS);
  assert.equal(made[1].opts.persistent, false, 'not asked: a throwaway profile, as before');
  assert.equal(index.get(profileName('u:p/main')).kind, 'owner');
  manager.closeAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('manager: a newer attach on a live kept profile takes that browser over; the older viewer is told, finally', async () => {
  const { manager, made, dir, sent } = keptManager();
  await manager.attach({ streamId: 'a', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true });
  const second = await manager.attach({ streamId: 'b', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true });
  assert.equal(made.length, 1, 'one browser, one profile');
  assert.equal(second.takenOver, true);
  assert.equal(made[0].pane.streamId, 'b');
  assert.deepEqual(sent.filter((m) => m.type === 'browser-exit'), [{ type: 'browser-exit', streamId: 'a', reason: 'This browser opened in another tab.', takenOver: true }]);
  assert.equal(manager.size(), 1);
  // The first quits; a new attach waits for its exit, then has the profile.
  manager.closeAll();
  const t0 = Date.now();
  await manager.attach({ streamId: 'c', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true });
  assert.equal(made[1].opts.profileName, profileName('u:p/main'));
  assert.ok(Date.now() - t0 < 2000);
  manager.closeAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('manager: two attaches on one kept profile at once never both open it', async () => {
  const { manager, made, dir } = keptManager();
  const [r1, r2] = await Promise.all([
    manager.attach({ streamId: 'a', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true }),
    manager.attach({ streamId: 'b', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true }),
  ]);
  assert.equal(made.length, 1, 'the second waited for the first, then took it over');
  assert.equal(r1.takenOver, undefined);
  assert.equal(r2.takenOver, true);
  manager.closeAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('manager: the sweep and an attach on one profile never cross: a profile touched meanwhile is kept', async () => {
  let t = Date.now();
  const { manager, made, index, dir, home } = keptManager({ now: () => t });
  const profiles = pathp.join(profileRoot('/x/chromium', home), 'profiles');
  const name = profileName('u:p/main');
  fsp.mkdirSync(pathp.join(profiles, name), { recursive: true });
  index.touch(name, { key: 'u:p/main', kind: 'owner' });
  t += OWNER_PROFILE_IDLE_MS + 1000;
  // An attach whose open is slow holds the profile's turn while the sweep starts.
  let release;
  const gate = new Promise((r) => { release = r; });
  const attaching = manager.attach({ streamId: 'a', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true });
  await new Promise((r) => setTimeout(r, 5));
  made[0].pane.open = async () => { await gate; return { ok: true, streamId: 'a' }; };
  const sweeping = manager.sweepProfiles();
  release();
  await Promise.all([attaching, sweeping]);
  assert.equal(fsp.existsSync(pathp.join(profiles, name)), true, 'the attach touched it first: still fresh, kept');
  manager.closeAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('manager: a kept profile another process holds is never opened or deleted here', async () => {
  const { manager, made, dir, home } = keptManager({ guestEnv: { ok: true, profilesRoot: '/g' }, runLauncher: async (args) => (args[0] === '--termag-list' ? `${profileName('guest:s:u')} 1 1\n` : '') });
  const profiles = pathp.join(profileRoot('/x/chromium', home), 'profiles');
  const name = profileName('u:p/main');
  fsp.mkdirSync(pathp.join(profiles, name), { recursive: true });
  // This test process stands in for the staging mirror agent's Chromium.
  fsp.symlinkSync(`host-${process.pid}`, pathp.join(profiles, name, 'SingletonLock'));
  await manager.attach({ streamId: 'a', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true });
  assert.equal(made[0].opts.persistent, false, 'a throwaway profile instead');
  assert.equal(made[0].opts.paneKey, null);
  await assert.rejects(manager.forgetProfile({ profileKey: 'u:p/main' }), /in use by another process/);
  assert.equal(fsp.existsSync(pathp.join(profiles, name)), true);
  // A guest profile the launcher says is held: the same.
  await manager.attach({ streamId: 'g', paneKey: 'guest:s:u', mode: 'guest', url: 'about:blank', recipe: { kind: 'manual', origins: ['127.0.0.2:80'] }, persistProfile: true });
  assert.equal(made[1].opts.persistent, false);
  manager.closeAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('ProfileIndex: two agents sharing HOME never drop each other\'s entries', () => {
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'bp-index2-'));
  const file = pathp.join(dir, 'browser-profiles.json');
  const a = new ProfileIndex(file);
  const b = new ProfileIndex(file);
  a.touch('p-a', { key: 'u:p/a', kind: 'owner' });
  b.touch('p-b', { key: 'u:p/b', kind: 'owner' });
  a.touch('p-a2', { key: 'u:p/a2', kind: 'owner' });
  assert.deepEqual(new ProfileIndex(file).names().sort(), ['p-a', 'p-a2', 'p-b']);
  b.remove('p-a');
  assert.deepEqual(a.names().sort(), ['p-a2', 'p-b'], 'a read sees the other agent\'s write');
  // A dead writer's lock does not block for ever.
  fsp.mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60_000);
  fsp.utimesSync(`${file}.lock`, old, old);
  a.touch('p-c', { key: 'u:p/c', kind: 'owner' });
  assert.ok(new ProfileIndex(file).names().includes('p-c'));
  // A lock that is fresh when found is waited out until it is stale, then taken.
  fsp.mkdirSync(`${file}.lock`);
  const t0 = Date.now();
  a.touch('p-d', { key: 'u:p/d', kind: 'owner' });
  assert.ok(Date.now() - t0 >= 900, 'waited for the lock to go stale');
  assert.ok(new ProfileIndex(file).names().includes('p-d'));
  // One that stays fresh past the wait (a live writer): nothing is written without it.
  fsp.mkdirSync(`${file}.lock`);
  const later = new Date(Date.now() + 60_000);
  fsp.utimesSync(`${file}.lock`, later, later);
  const quick = new ProfileIndex(file, { lockWaitMs: 50 });
  assert.equal(quick.update((e) => { e['p-e'] = { key: 'u:p/e', kind: 'owner' }; }), false);
  assert.ok(!new ProfileIndex(file).names().includes('p-e'), 'not written unlocked');
  assert.ok(fsp.existsSync(`${file}.lock`), 'the other writer\'s lock is left alone');
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('manager: forgetProfile closes the live and parked browsers of a key, tells the viewer, and deletes the profile', async () => {
  const forgot = [];
  const { manager, made, index, dir, home, sent } = keptManager({ guestEnv: { ok: true, profilesRoot: '/g' }, runLauncher: async (args) => { forgot.push(args); return ''; } });
  await manager.attach({ streamId: 'a', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true });
  const ownerDir = pathp.join(profileRoot('/x/chromium', home), 'profiles', profileName('u:p/main'));
  fsp.mkdirSync(ownerDir, { recursive: true });
  assert.deepEqual(await manager.forgetProfile({ profileKey: 'u:p/main' }), { ok: true });
  assert.equal(made[0].pane.gone, true);
  assert.deepEqual(sent.filter((m) => m.type === 'browser-exit').map((m) => m.streamId), ['a']);
  assert.equal(fsp.existsSync(ownerDir), false);
  assert.equal(index.get(profileName('u:p/main')), null);
  // A guest's goes through the launcher.
  await manager.attach({ streamId: 'g', paneKey: 'guest:s:u', mode: 'guest', url: 'about:blank', recipe: { kind: 'manual', origins: ['127.0.0.2:80'] }, persistProfile: true, profileExpiresAt: '2030-01-01T00:00:00Z' });
  assert.equal(index.get(profileName('guest:s:u')).expiresAt, Date.parse('2030-01-01T00:00:00Z'));
  manager.close('g');
  await manager.forgetProfile({ profileKey: 'guest:s:u' });
  assert.ok(forgot.some((a) => a[0] === '--termag-forget' && a[1] === profileName('guest:s:u')));
  await assert.rejects(manager.forgetProfile({}), /profileKey is required/);
  // Reset: the stream's own key.
  await manager.attach({ streamId: 'r', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true });
  assert.deepEqual(await manager.resetProfile({ streamId: 'r' }), { ok: true });
  await assert.rejects(manager.resetProfile({ streamId: 'nope' }), /no browser/);
  manager.closeAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('manager: the sweep removes idle and unknown owner profiles, expired guest ones, and leftover throwaway dirs nobody holds', async () => {
  let t = Date.now();
  const forgot = [];
  const listing = () => `${profileName('guest:old:u')} 1\n${profileName('guest:new:u')} 2\ntmp-x 3\n`;
  const { manager, index, dir, home } = keptManager({ now: () => t, guestEnv: { ok: true, profilesRoot: '/g' },
    runLauncher: async (args) => { forgot.push(args); return args[0] === '--termag-list' ? listing() : ''; } });
  const root = profileRoot('/x/chromium', home);
  const profiles = pathp.join(root, 'profiles');
  fsp.mkdirSync(profiles, { recursive: true });
  for (const n of [P('idle'), P('fresh'), P('unknown')]) fsp.writeFileSync(pathp.join(profiles, `${n}.cookies.json`), '[]');
  index.touch(P('idle'), { key: 'u:p/a', kind: 'owner' });
  t += OWNER_PROFILE_IDLE_MS + 1000;
  index.touch(P('fresh'), { key: 'u:p/b', kind: 'owner' });
  index.touch(profileName('guest:old:u'), { key: 'guest:old:u', kind: 'guest', expiresAt: t - 1 });
  index.touch(profileName('guest:new:u'), { key: 'guest:new:u', kind: 'guest', expiresAt: t + 1e6 });
  // Leftover throwaway dirs: one whose lock names a dead pid, one this test process holds.
  fsp.mkdirSync(pathp.join(root, 'pane-dead'));
  fsp.symlinkSync('host-999999', pathp.join(root, 'pane-dead', 'SingletonLock'));
  fsp.mkdirSync(pathp.join(root, 'pane-live'));
  fsp.symlinkSync(`host-${process.pid}`, pathp.join(root, 'pane-live', 'SingletonLock'));
  await manager.sweepProfiles();
  assert.deepEqual(fsp.readdirSync(profiles).sort(), [`${P('fresh')}.cookies.json`]);
  assert.equal(fsp.existsSync(pathp.join(root, 'pane-dead')), false);
  assert.equal(fsp.existsSync(pathp.join(root, 'pane-live')), true, 'held by a live process (the stage agent shares HOME)');
  const forgotten = forgot.filter((a) => a[0] === '--termag-forget').map((a) => a[1]);
  assert.ok(forgotten.includes(profileName('guest:old:u')));
  assert.ok(!forgotten.includes(profileName('guest:new:u')));
  assert.equal(index.get(P('idle')), null);
  manager.closeAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('manager: closeAll resolves once every browser has exited, and killAll ends what is left', async () => {
  const { manager, made, dir } = keptManager();
  await manager.attach({ streamId: 'a', paneKey: 'u:p/main', url: 'http://x/', persistProfile: true });
  await manager.attach({ streamId: 'b', paneKey: 'u:p/b', url: 'http://x/' });
  await manager.closeAll();
  assert.ok(made.every((f) => f.child.killed.length > 0 || f.pane.closed));
  manager.killAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('an owner\'s kept browser keeps nothing but its jar: a failed save leaves the last one, its profile goes on exit, crash included, and starts empty', async () => {
  const { cookieJarPath } = require('./browser-pane');
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'bp-jar2-'));
  const home = pathp.join(dir, 'home');
  const kept = (cookiesReply) => {
    const f = fakePane(() => {}, { persistent: true, profileName: P('x'), home, binary: '/bin/true' });
    f.pane.keptDir = pathp.join(dir, P('x'));
    fsp.mkdirSync(f.pane.keptDir, { recursive: true });
    f.pane.profileDir = f.pane.keptDir;
    f.pane.cdp.closed = false;
    f.pane.cdp.send = (method) => (method === 'Storage.getCookies' ? cookiesReply() : Promise.resolve({}));
    return f;
  };
  const jar = cookieJarPath(pathp.join(dir, P('x')));
  fsp.writeFileSync(jar, JSON.stringify([{ name: 'old', value: '1', domain: '127.0.0.2', path: '/' }]));
  // A save that fails: the last jar stays as it was.
  let f = kept(() => Promise.reject(new Error('Storage.getCookies: timed out')));
  f.pane.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(JSON.parse(fsp.readFileSync(jar, 'utf8')).map((c) => c.name), ['old']);
  // The browser's exit takes its profile, with whatever site state it held.
  fsp.writeFileSync(pathp.join(f.pane.keptDir, 'Local Storage'), 'a real site\'s state');
  f.pane.handleProcessExit('browser exited');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fsp.existsSync(pathp.join(dir, P('x'))), false);
  // A crash too.
  f = kept(() => Promise.resolve({ cookies: [] }));
  f.pane.exitCode = 139;
  f.pane.handleProcessExit('browser exited (SIGSEGV)');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fsp.existsSync(pathp.join(dir, P('x'))), false);
  assert.ok(fsp.existsSync(jar), 'the jar is what is kept');
  // The path is free the moment the browser has exited: a reopen that makes
  // it again at once is not reached by the delete still running.
  f = kept(() => Promise.resolve({ cookies: [] }));
  fsp.writeFileSync(pathp.join(f.pane.keptDir, 'Cache'), 'x'.repeat(1e5));
  f.pane.handleProcessExit('browser exited');
  assert.equal(fsp.existsSync(pathp.join(dir, P('x'))), false, 'moved aside synchronously');
  fsp.mkdirSync(pathp.join(dir, P('x')));
  fsp.writeFileSync(pathp.join(dir, P('x'), 'SingletonLock'), 'the next browser');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fsp.existsSync(pathp.join(dir, P('x'), 'SingletonLock')), 'the new browser\'s tree is untouched');
  assert.deepEqual(fsp.readdirSync(dir).filter((n) => n.includes('.gone-')), [], 'and the old one is gone');
  fsp.rmSync(pathp.join(dir, P('x')), { recursive: true, force: true });

  // A launch empties a dir a browser left behind; the jar beside it stays.
  const pane = new BrowserPane({ streamId: 's', paneKey: 'u:p/main', binary: '/bin/true', home, transport: { send() {}, bufferedAmount: () => 0 }, log: () => {}, onExit: () => {}, persistent: true, profileName: P('y') });
  const profileDir = pathp.join(profileRoot('/bin/true', home), 'profiles', P('y'));
  fsp.mkdirSync(profileDir, { recursive: true });
  fsp.writeFileSync(pathp.join(profileDir, 'Cookies'), 'real site cookies');
  fsp.writeFileSync(cookieJarPath(profileDir), '[]');
  const child = pane.spawnOwner();
  child.on('error', () => {});
  assert.equal(fsp.existsSync(pathp.join(profileDir, 'Cookies')), false, 'the old store is gone');
  assert.ok(fsp.existsSync(cookieJarPath(profileDir)));
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('a failed restore never costs the jar its sign-ins: the close lays the browser\'s cookies over them', async () => {
  const { cookieJarPath } = require('./browser-pane');
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'bp-jar4-'));
  const f = fakePane(() => {}, { persistent: true, profileName: P('x') });
  f.pane.keptDir = pathp.join(dir, P('x'));
  const jar = cookieJarPath(f.pane.keptDir);
  fsp.writeFileSync(jar, JSON.stringify([
    { name: 'session', value: 'old', domain: '127.0.0.2', path: '/', expires: 2e9 },
    { name: 'pref', value: 'dark', domain: '127.0.0.2', path: '/', expires: 2e9 },
  ]));
  f.pane.cdp.send = (method) => (method === 'Storage.setCookies' ? Promise.reject(new Error('timed out')) : Promise.resolve({}));
  await f.pane.restoreCookies();
  // The browser signed in afresh meanwhile: its cookie wins, the rest of the jar stays.
  f.pane.cdp.send = (method) => Promise.resolve(method === 'Storage.getCookies'
    ? { cookies: [{ name: 'session', value: 'new', domain: '127.0.0.2', path: '/', session: false, expires: 2e9 }, { name: 'gh', value: 's', domain: '.github.com', path: '/' }] } : {});
  await f.pane.saveCookies();
  const saved = Object.fromEntries(JSON.parse(fsp.readFileSync(jar, 'utf8')).map((c) => [c.name, c.value]));
  assert.deepEqual(saved, { session: 'new', pref: 'dark' });
  // After a restore that worked, a save is the browser's cookies alone, as before.
  const g = fakePane(() => {}, { persistent: true, profileName: P('x') });
  g.pane.keptDir = f.pane.keptDir;
  g.pane.cdp.send = (method) => Promise.resolve(method === 'Storage.getCookies' ? { cookies: [{ name: 'only', value: '1', domain: '127.0.0.2', path: '/', expires: 2e9 }] } : {});
  await g.pane.restoreCookies();
  await g.pane.saveCookies();
  assert.deepEqual(JSON.parse(fsp.readFileSync(jar, 'utf8')).map((c) => c.name), ['only']);
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('an owner\'s kept browser gets back only the jar\'s loopback cookies that have not expired, before its first page', async () => {
  const { cookieJarPath } = require('./browser-pane');
  const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'bp-jar3-'));
  const f = fakePane(() => {}, { persistent: true, profileName: P('x') });
  f.pane.keptDir = pathp.join(dir, P('x'));
  fsp.writeFileSync(cookieJarPath(f.pane.keptDir), JSON.stringify([
    { name: 'keep', value: '1', domain: '127.0.0.2', path: '/', expires: 2e9 },
    { name: 'session', value: '1', domain: 'localhost', path: '/' },
    { name: 'stale', value: '1', domain: '127.0.0.2', path: '/', expires: 1000 },
    { name: 'planted', value: '1', domain: '.github.com', path: '/', expires: 2e9 },
  ]));
  await f.pane.restoreCookies();
  const set = f.calls.find((c) => c.method === 'Storage.setCookies');
  assert.deepEqual(set.params.cookies.map((c) => c.name), ['keep', 'session']);
  // No jar, or a broken one: nothing set.
  const g = fakePane(() => {}, { persistent: true, profileName: P('z') });
  g.pane.keptDir = pathp.join(dir, P('z'));
  await g.pane.restoreCookies();
  fsp.writeFileSync(cookieJarPath(g.pane.keptDir), '{not json');
  await g.pane.restoreCookies();
  assert.equal(g.calls.some((c) => c.method === 'Storage.setCookies'), false);
  fsp.rmSync(dir, { recursive: true, force: true });
});

test('manager: the sweep removes a kept browser\'s dir no live browser has, and keeps its jar; a live or just-made one stays', async () => {
  const { LEFTOVER_DIR_MIN_AGE_MS } = require('./browser-pane');
  const { manager, index, dir, home } = keptManager();
  const profiles = pathp.join(profileRoot('/x/chromium', home), 'profiles');
  const old = new Date(Date.now() - LEFTOVER_DIR_MIN_AGE_MS - 60_000);
  for (const n of [P('crashed'), P('live'), P('new')]) {
    fsp.mkdirSync(pathp.join(profiles, n), { recursive: true });
    fsp.writeFileSync(pathp.join(profiles, `${n}.cookies.json`), '[]');
    index.touch(n, { key: `u:p/${n}`, kind: 'owner' });
  }
  fsp.symlinkSync(`host-${process.pid}`, pathp.join(profiles, P('live'), 'SingletonLock'));
  // p-new was just made (another agent sharing HOME, launching): no lock yet, but too fresh to take.
  for (const n of [P('crashed'), P('live')]) fsp.utimesSync(pathp.join(profiles, n), old, old);
  await manager.sweepProfiles();
  assert.deepEqual(fsp.readdirSync(profiles).sort(), [`${P('crashed')}.cookies.json`, P('live'), `${P('live')}.cookies.json`, P('new'), `${P('new')}.cookies.json`].sort());
  manager.closeAll();
  fsp.rmSync(dir, { recursive: true, force: true });
});
