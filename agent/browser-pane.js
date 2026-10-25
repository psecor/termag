'use strict';
// Browser pane: a headless Chromium on the box, driven
// over the DevTools protocol, screencast to the orchestrator as a stream beside
// the terminal streams, with pointer and keyboard events relayed back.
//
// The browser runs here, where the app's loopback ports, cookies and absolute
// asset URLs resolve. Only JPEG frames leave and only input events arrive, so
// no app code ever reaches the viewer's browser.
//
// Transport is `--remote-debugging-pipe` (fds 3 and 4), never a TCP debugging
// port: nothing else on the box can attach to the browser. Messages on the
// pipe are JSON documents separated by NUL bytes.
//
// One manager per agent process (not per socket): a browser whose viewer
// closed the pane, or whose agent socket dropped, is PARKED for a minute under
// its pane key and reclaimed by the next attach with that key, page and all.
//
// A reviewer's pane is a GUEST pane: its Chromium runs
// as termag-guest through the box's launcher, forced through a per-pane
// allowlisting proxy, checked by a canary before it shows anything, and kept
// to the share's origins (browser-guest.js). Owner panes are unchanged.
//
// Pure helpers are exported for the unit tests; `createManager` is what
// agent.js wires to its socket.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const guestMode = require('./browser-guest');

const CAPABILITIES = ['browser-pane-v1'];
// Advertised beside them only on a box whose guest launcher works (agent.js).
const GUEST_CAPABILITY = 'browser-pane-guest-v1';
// How often a guest pane reports the workstream checkout it is showing.
const CHECKOUT_EVERY_MS = 60_000;
// A guest's cache must hold a dev stack's bundles: Chromium caps one entry at
// about an eighth of the cache, and webapp's dev common.js is 79 MB.
const GUEST_DISK_CACHE_BYTES = 1024 ** 3;
// A throwaway guest profile's delete, asked again after these delays while a
// quitting Chromium still holds it; and the sweep that takes what is left.
const GUEST_FORGET_RETRY_MS = [0, 1000, 4000];
const GUEST_SWEEP_EVERY_MS = 3600 * 1000;
const GUEST_SWEEP_MIN_AGE_MS = 10 * 60 * 1000;
// Persistent profiles: a pane's
// profile outlives its browser, so a sign-in survives the 60 s park. Behind
// browser-pane-persistent-profiles-enabled: the backend asks with
// `persistProfile` on attach.
const PROFILES_CAPABILITY = 'browser-pane-profiles-v1';
// Chromium writes cookies to disk on a timer (about 30 s); a clean exit
// flushes them, so a guest's kept profile's browser gets longer to quit.
const PERSISTENT_KILL_GRACE_MS = 5000;
// Saving an owner's cookie jar at close: each call, and the save as a whole.
const JAR_TIMEOUT_MS = 1500;
const JAR_TOTAL_MS = 4000;
// How long a closing browser's profile is waited for before an attach (or a
// forget) gives up on it: the slowest close there is, an owner's jar save
// and then a guest-length quit, and a second to spare.
const PROFILE_WAIT_MS = JAR_TOTAL_MS + PERSISTENT_KILL_GRACE_MS + 1000;
const OWNER_PROFILE_IDLE_MS = 14 * 24 * 3600 * 1000;
// An owner's browser dir the sweep finds with no live browser is removed only
// once it is this old: another agent sharing HOME may have just made it.
const LEFTOVER_DIR_MIN_AGE_MS = 10 * 60 * 1000;
const PROFILE_SWEEP_EVERY_MS = 3600 * 1000;
// TERMAG_CHROMIUM overrides; otherwise the snap first (the box image bakes it;
// packer/scripts/setup.sh), then whatever is on PATH.
const CHROMIUM_CANDIDATES = ['/snap/bin/chromium', 'chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'];
const MAX_PANES = 4;
const VIEWPORT = { minWidth: 320, maxWidth: 2560, minHeight: 240, maxHeight: 1600, defaultWidth: 1024, defaultHeight: 768 };
// Frame quality adapts to the viewer's link: the ack for a frame comes back
// when it has left for the viewer, so a slow link shows as a slow ack. Three
// rungs, stepped down after a few slow acks and up after a run of fast ones.
const QUALITY_RUNGS = [60, 45, 30];
const SLOW_ACK_MS = 300;
const FAST_ACK_MS = 80;
const ADAPT_AFTER = 3;
// Even on a fast link, no more than about 20 frames a second: a page that
// animates would otherwise saturate the link for nothing a person can see.
const MIN_FRAME_INTERVAL_MS = 50;
// A closed pane's browser waits this long for a reattach before it is killed.
const PARK_MS = 60_000;
// Frame acks are the backpressure: Chromium holds the next frame until the
// previous one is acked. The backend acks a frame once it has left for the
// viewer, so the page repaints at the pace the viewer's link can carry; this
// is the fallback when that ack never comes (an older backend, a lost frame).
const ACK_TIMEOUT_MS = 1500;
// And the local guard: never ack while this many bytes sit unsent on the
// agent socket, so a burst cannot starve the terminal streams sharing it.
const ACK_HOLD_BYTES = 1024 * 1024;
const ACK_POLL_MS = 50;
const NAV_DEBOUNCE_MS = 60;
const CDP_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 1500;
// A page's dialog shown to the viewer is answered for them (dismissed) if
// they haven't within this, so a tab left alone doesn't stop the page.
const DIALOG_ANSWER_MS = 60_000;
const MAX_DIALOG_TEXT = 2000;
const MAX_TEXT_CHARS = 4096;
// A blinking text caret repaints the page twice a second, and every repaint
// is a full JPEG frame to the viewer: an idle pane with a focused field would
// stream for ever. This stylesheet, added to every document the pane shows,
// keeps the caret still (Chromium 139+ honours `caret-animation`; older
// builds ignore the rule). Styling only; nothing of the page is read.
const CARET_STILL_STYLE_ID = 'termag-browser-pane-caret';
const CARET_STILL_SCRIPT = `(() => {
  if (document.getElementById(${JSON.stringify(CARET_STILL_STYLE_ID)})) return;
  const add = () => {
    if (!document.head || document.getElementById(${JSON.stringify(CARET_STILL_STYLE_ID)})) return;
    const style = document.createElement('style');
    style.id = ${JSON.stringify(CARET_STILL_STYLE_ID)};
    style.textContent = '*, *::before, *::after { caret-animation: manual !important; }';
    document.head.appendChild(style);
  };
  if (document.head) add(); else document.addEventListener('DOMContentLoaded', add, { once: true });
})();`;

// URL suggestions: listening loopback ports that answer HTTP.
// A cold dev stack can take a second to answer its first request.
const SUGGEST_PROBE_TIMEOUT_MS = 1500;
const SUGGEST_MAX_PORTS = 48;
const SUGGEST_CONCURRENCY = 8;
const SUGGEST_MAX_RESULTS = 8;

/** The Chromium to run, or null when the box has none (the capability is then not advertised). */
function findChromium(env = process.env, existsSync = fs.existsSync) {
  const override = (env.TERMAG_CHROMIUM || '').trim();
  const candidates = override ? [override, ...CHROMIUM_CANDIDATES] : CHROMIUM_CANDIDATES;
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of dirs) {
      const full = path.join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function isSnapChromium(binary) {
  return typeof binary === 'string' && binary.startsWith('/snap/');
}

/**
 * Where a pane's throwaway profile lives. The chromium snap is confined: it
 * can write its own data dir under ~/snap/chromium/common and non-hidden
 * paths in $HOME, but not ~/.cache, and its /tmp is a private namespace.
 */
function profileRoot(binary, home) {
  return isSnapChromium(binary)
    ? path.join(home, 'snap', 'chromium', 'common', 'termag-browser-pane')
    : path.join(home, '.cache', 'termag', 'browser-pane');
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampViewport(width, height) {
  return {
    width: clampInt(width, VIEWPORT.minWidth, VIEWPORT.maxWidth, VIEWPORT.defaultWidth),
    height: clampInt(height, VIEWPORT.minHeight, VIEWPORT.maxHeight, VIEWPORT.defaultHeight),
  };
}

// A scheme is a word followed by `://`, or by `:` and something other than a
// digit: `localhost:3000` is a host and port, `javascript:alert(1)` is not.
function hasScheme(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(s);
}

/** `about:blank`, or an http(s) URL (a bare host[:port]/path gets http://); null for anything else. */
function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s === 'about:blank') return 'about:blank';
  const withScheme = hasScheme(s) ? s : `http://${s}`;
  let url;
  try { url = new URL(withScheme); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/**
 * A guest's Chromium also gets the proxy (loopback included: `<-loopback>`
 * drops Chromium's implicit bypass), no QUIC, and a cache big enough for a dev
 * stack's bundles. The WebRTC flag does nothing on the snap's Chromium; the
 * launcher seeds the preference that does, and the box's egress rule rejects
 * the UDP anyway.
 */
function chromiumArgs({ profileDir, width, height, proxyPort = null }) {
  const guest = proxyPort === null ? [] : [
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    // Chromium's own calls home (updates, hints, autofill, pings): the proxy
    // refuses them anyway, and fewer of them is less noise in its reports.
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--no-pings',
    '--disable-features=OptimizationHints,OptimizationHintsFetching,OptimizationGuideModelDownloading,AutofillServerCommunication,Translate,MediaRouter,NetworkTimeServiceQuerying,CertificateTransparencyComponentUpdater',
    `--disk-cache-size=${GUEST_DISK_CACHE_BYTES}`,
  ];
  return [
    '--headless=new',
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-crash-restore-bubble',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    ...guest,
    `--window-size=${width},${height}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ];
}

/**
 * A kept profile's directory name: a hash of the pane key, so no key text
 * reaches a path (and it fits the guest launcher's name rule).
 */
function profileName(paneKey) {
  return `p-${crypto.createHash('sha256').update(String(paneKey)).digest('hex').slice(0, 32)}`;
}

// What profileName makes, and the only names a profile path is built from:
// a name from the index, a directory listing or a message that isn't one is
// refused, so no path leaves the profile root.
const PROFILE_NAME = /^p-[0-9a-f]{32}$/;
function isProfileName(name) {
  return typeof name === 'string' && PROFILE_NAME.test(name);
}

/**
 * An owner's kept profile is a cookie jar, `profiles/<name>.cookies.json`
 * (0600), not a Chromium profile: owner panes are not proxied, so the
 * profile that browsed may hold any site's state (cookies, Local Storage,
 * IndexedDB, caches, service workers), and an agent on the box runs as the
 * same user. The browser runs in `profiles/<name>`, emptied at launch and
 * deleted on exit like a throwaway one; at close only its loopback cookies
 * are saved to the jar, and the next launch sets them before its first page.
 * A save that fails leaves the previous jar: a sign-in is lost, never a real
 * site's state kept.
 */
function cookieJarPath(dir) {
  return `${dir}.cookies.json`;
}

/**
 * `promise`, or a rejection once `ms` pass first. The timer is cleared the
 * moment either settles, so nothing is left armed after a save that finished.
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A cookie for a loopback app (localhost, 127.0.0.0/8, ::1): what an owner's cookie jar keeps. */
function isLoopbackCookieDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(d) || d === '::1' || d === '[::1]';
}

/** A cookie as Storage.getCookies reports it, as Storage.setCookies takes it back. */
function cookieParam(c) {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: !!c.secure, httpOnly: !!c.httpOnly };
  if (c.sameSite) out.sameSite = c.sameSite;
  if (!c.session && typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
  for (const k of ['priority', 'sourceScheme', 'sourcePort', 'partitionKey']) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

// The profile index's lock (ProfileIndex.update): how long a write waits for
// it, and the age at which a lock is a dead writer's, well inside that wait.
const INDEX_LOCK_WAIT_MS = 3000;
const INDEX_LOCK_STALE_MS = 1000;

/**
 * What the agent knows of its kept profiles, in its own state dir (0600):
 * `{ [name]: { key, kind: 'owner'|'guest', lastUsedAt, expiresAt? } }`. A
 * guest's profile lives in the guest's home, out of the agent's reach, so the
 * index is the only place its key and expiry are kept.
 */
class ProfileIndex {
  constructor(file, { now = Date.now, lockWaitMs = INDEX_LOCK_WAIT_MS } = {}) {
    this.file = file;
    this.now = now;
    this.lockWaitMs = lockWaitMs;
    this.entries = {};
    this.reload();
  }

  /**
   * The file as it is now. Another agent sharing this HOME (the staging
   * mirror) writes the same index, so every read starts from the file and
   * every write merges into it under a lock: neither can drop the other's
   * entries and have its sweep take those profiles for unknown.
   */
  reload() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { this.entries = {}; }
    return this.entries;
  }

  get(name) { return this.reload()[name] || null; }
  names() { return Object.keys(this.reload()); }

  touch(name, { key, kind, expiresAt }) {
    this.update((entries) => {
      const prev = entries[name] || {};
      entries[name] = { key, kind, lastUsedAt: this.now(), ...(expiresAt ? { expiresAt } : prev.expiresAt ? { expiresAt: prev.expiresAt } : {}) };
    });
  }

  remove(name) {
    this.update((entries) => { delete entries[name]; });
  }

  /**
   * Read, change, write, under `<file>.lock` (a directory: mkdir is atomic),
   * and only under it: a write without the lock could drop the other agent's
   * entries. The lock is held for one small read and write, so one older
   * than INDEX_LOCK_STALE_MS is a dead writer's and is taken over, well
   * inside the wait; a lock that stays fresh past the wait means the change
   * is not made (false), never made unlocked.
   */
  update(change) {
    const lock = `${this.file}.lock`;
    let locked = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const deadline = Date.now() + this.lockWaitMs;
      while (!locked) {
        try { fs.mkdirSync(lock); locked = true; } catch (err) {
          if (err.code !== 'EEXIST' || Date.now() >= deadline) break;
          try { if (Date.now() - fs.statSync(lock).mtimeMs > INDEX_LOCK_STALE_MS) fs.rmdirSync(lock); } catch { /* gone */ }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      if (!locked) return false;
      change(this.reload());
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch { /* the index is a cache of what the sweep needs; a failed write costs a late sweep */ return false; } finally {
      if (locked) { try { fs.rmdirSync(lock); } catch { /* gone */ } }
    }
  }
}

/** Whether a pane key is a guest's (`guest:<share>:<viewer>`, built by the backend). */
function isGuestKey(key) {
  return typeof key === 'string' && key.startsWith('guest:');
}

const MOUSE_TYPES = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']);
const MOUSE_BUTTONS = new Set(['none', 'left', 'middle', 'right']);
const KEY_TYPES = new Set(['keyDown', 'keyUp']);

/**
 * A viewer's input event as the DevTools call it becomes, or null when it is
 * not one we relay. Coordinates are clamped to the viewport, counts and
 * modifier masks to their protocol ranges, text to a bounded length.
 */
function inputToCdp(event, viewport) {
  if (!event || typeof event !== 'object') return null;
  if (event.kind === 'mouse') {
    if (!MOUSE_TYPES.has(event.type)) return null;
    const x = clampInt(event.x, 0, viewport.width, null);
    const y = clampInt(event.y, 0, viewport.height, null);
    if (x === null || y === null) return null;
    const params = {
      type: event.type,
      x,
      y,
      button: MOUSE_BUTTONS.has(event.button) ? event.button : 'none',
      buttons: clampInt(event.buttons, 0, 31, 0),
      clickCount: clampInt(event.clickCount, 0, 3, 0),
      modifiers: clampInt(event.modifiers, 0, 15, 0),
    };
    if (event.type === 'mouseWheel') {
      params.deltaX = clampInt(event.deltaX, -4000, 4000, 0);
      params.deltaY = clampInt(event.deltaY, -4000, 4000, 0);
    }
    return { method: 'Input.dispatchMouseEvent', params };
  }
  if (event.kind === 'key') {
    if (!KEY_TYPES.has(event.type)) return null;
    const key = typeof event.key === 'string' ? event.key.slice(0, 32) : '';
    const code = typeof event.code === 'string' ? event.code.slice(0, 32) : '';
    if (!key && !code) return null;
    const params = { type: event.type, key, code, modifiers: clampInt(event.modifiers, 0, 15, 0) };
    if (event.type === 'keyDown' && typeof event.text === 'string' && event.text.length > 0 && event.text.length <= 8) {
      params.text = event.text;
      params.unmodifiedText = event.text;
    }
    // Chromium interprets Backspace, Enter, the arrows and the rest of the
    // non-printing keys by their virtual key code, not their name.
    if (Number.isInteger(event.windowsVirtualKeyCode) && event.windowsVirtualKeyCode > 0 && event.windowsVirtualKeyCode < 256) {
      params.windowsVirtualKeyCode = event.windowsVirtualKeyCode;
      params.nativeVirtualKeyCode = event.windowsVirtualKeyCode;
    }
    return { method: 'Input.dispatchKeyEvent', params };
  }
  if (event.kind === 'text') {
    if (typeof event.text !== 'string' || !event.text || event.text.length > MAX_TEXT_CHARS) return null;
    return { method: 'Input.insertText', params: { text: event.text } };
  }
  return null;
}

/** Splits the pipe's byte stream into JSON documents at NUL bytes; a document that does not parse is skipped. */
class PipeFramer {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    let at;
    while ((at = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      let message;
      try { message = JSON.parse(raw); } catch { continue; }
      this.onMessage(message);
    }
  }
}

/** The DevTools protocol over a pair of streams: numbered requests with replies, and events to listeners. */
class CdpClient {
  constructor(writable, readable) {
    this.writable = writable;
    this.pending = new Map();
    this.nextId = 0;
    this.listeners = new Set();
    this.closed = false;
    this.framer = new PipeFramer((message) => this.dispatch(message));
    readable.on('data', (chunk) => this.framer.push(chunk));
    // A browser that dies mid-write resets both pipes; the exit handler reports it.
    readable.on('error', () => {});
    writable.on('error', () => {});
  }

  dispatch(message) {
    if (message.id && this.pending.has(message.id)) {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners) {
      try { listener(message); } catch { /* a listener's failure is its own */ }
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error(`${method}: browser closed`));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.writable.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error(`${request.method}: browser closed`));
    }
    this.pending.clear();
    this.listeners.clear();
  }
}

/**
 * One browser process, one page, one screencast: the box side of a stream.
 * `transport` is the manager's live socket (send a frame, how much is
 * queued); it changes under the pane when the agent reconnects.
 */
class BrowserPane {
  /**
   * `guest`, for a reviewer's pane: `{ origins, profilesRoot, cwd }`, with
   * origins already canonical and resolved for this attach. Null for an
   * owner's pane.
   */
  constructor({ streamId, paneKey = null, binary, home, transport, log, onExit, killGraceMs = KILL_GRACE_MS, ackTimeoutMs = ACK_TIMEOUT_MS, stillCaret = true, guest = null, guestDeps = {}, persistent = false, profileName: keptName = null }) {
    this.streamId = streamId;
    /** A kept profile (`profileName`), which outlives this browser; otherwise a throwaway one. */
    this.persistent = !!(persistent && keptName);
    this.keptName = this.persistent ? keptName : null;
    /** An owner's kept profile dir, whose cookie jar sits beside it (profileDir is cleared on exit). */
    this.keptDir = null;
    this.exitCode = null;
    this.closing = false;
    /** Resolves once the browser process is gone (or never ran): its profile is free then. */
    this.exited = new Promise((resolve) => { this.markExited = resolve; });
    this.guest = guest;
    this.guestDeps = guestDeps;
    this.allowed = guest ? new Set(guest.origins) : null;
    this.proxy = null;
    this.guestProfile = null;
    this.checkoutTimer = null;
    this.lastCheckout = null;
    this.canaryRunning = false;
    /** Page targets this pane created itself; any other page target in a guest's browser is a popup. */
    this.ownTargets = new Set();
    /** createTarget calls in flight whose page has not been attached yet. */
    this.expectOwnPage = 0;
    /** Own pages the attach announced before their createTarget answered (they took an expectation). */
    this.claimedEarly = new Set();
    this.paneKey = paneKey;
    this.stillCaret = stillCaret;
    this.binary = binary;
    this.home = home;
    this.transport = transport;
    this.log = log;
    this.onExit = onExit;
    this.killGraceMs = killGraceMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.viewport = clampViewport();
    this.closed = false;
    this.parked = false;
    this.child = null;
    this.cdp = null;
    this.sessionId = null;
    this.profileDir = null;
    this.ackTimer = null;
    this.navTimer = null;
    /**
     * Frames sent and not yet acked by the backend, oldest first: { sid, timer, sentAt }.
     * `sid` is the screencast session to ack to Chromium, or null for a snapshot.
     */
    this.pendingFrames = [];
    /** Counts screencast frames sent, so a snapshot overtaken by one is dropped: the page has newer pixels. */
    this.castSeq = 0;
    /** Counts snapshot requests, so of two in flight only the later one is sent: screenshots resolve in request order. */
    this.snapshotSeq = 0;
    this.qualityRung = 0;
    this.slowAcks = 0;
    this.fastAcks = 0;
    this.lastAckAt = 0;
    this.restartingScreencast = false;
    /** Where the page last saw the pointer, so a press lands where the page thinks the mouse is. */
    this.pointer = null;
    /** Whether this pane's viewer can answer a page's dialogs (the attach asked with relayDialogs). */
    this.relayDialogs = false;
    /** The page's open dialog the viewer was asked about: { id, type, timer }. */
    this.pendingDialog = null;
    this.dialogSeq = 0;
  }

  send(frame) {
    if (this.streamId) this.transport.send({ ...frame, streamId: this.streamId });
  }

  async open({ url, width, height }) {
    this.viewport = clampViewport(width, height);
    const child = this.guest ? await this.spawnGuest() : this.spawnOwner();
    this.child = child;
    let stderrTail = '';
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); });
    child.on('error', (err) => this.handleProcessExit(`browser failed to start: ${err.message}`));
    child.on('exit', (code, signal) => {
      this.exitCode = code;
      const lastLine = stderrTail.trim().split('\n').pop() || '';
      this.handleProcessExit(code === 0 ? 'browser exited' : `browser exited (${signal || code})${lastLine ? `: ${lastLine.slice(0, 200)}` : ''}`);
    });
    this.cdp = new CdpClient(child.stdio[3], child.stdio[4]);
    this.cdp.on((message) => this.handleEvent(message));

    if (this.guest) {
      await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      // Every new page is attached paused, before it runs or loads anything:
      // this pane's own are resumed, any other (a popup: a click on a
      // target=_blank link, window.open) is closed. A popup is a new
      // top-level target, not the page's child, so only the browser sees it.
      await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: false }, { exclude: true }] });
      await this.runCanary();
    }
    // An owner's saved sign-ins are in place before the first page asks.
    if (this.keptDir) await this.restoreCookies();
    // A guest's page starts blank: everything below is in place before the
    // first byte of the shared app runs.
    const { targetId } = await this.createOwnTarget(this.guest ? 'about:blank' : url);
    this.targetId = targetId;
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.cdp.send('Page.enable', {}, sessionId);
    this.cdp.send('Inspector.enable', {}, sessionId).catch(() => {});
    if (this.guest) {
      // No file from the box reaches a page: the chooser is intercepted and never answered.
      await this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
    }
    if (this.stillCaret) {
      // Every later document gets the stylesheet before its own scripts run;
      // the first one is already loading, so it gets it now and on load.
      this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CARET_STILL_SCRIPT }, sessionId).catch(() => {});
      this.cdp.send('Runtime.evaluate', { expression: CARET_STILL_SCRIPT }, sessionId).catch(() => {});
    }
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: 1, mobile: false }, sessionId);
    await this.startScreencast();
    if (this.guest) {
      if (url !== 'about:blank') await this.cdp.send('Page.navigate', { url }, sessionId);
      this.startCheckoutReports();
    }
    this.emitNav();
    return { ok: true, streamId: this.streamId };
  }

  spawnOwner() {
    const root = profileRoot(this.binary, this.home);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (this.persistent) {
      // Starts empty: whatever is there is a browser's that never exited
      // cleanly (a crash, an agent killed), and may hold any site's state.
      // The attach checked that no live process holds it.
      if (!isProfileName(this.keptName)) throw new Error(`not a profile name: ${String(this.keptName).slice(0, 40)}`);
      const dir = path.join(root, 'profiles', this.keptName);
      const parents = [root, path.join(root, 'profiles')];
      fs.rmSync(dir, { recursive: true, force: true });
      ensurePrivateDir(dir, parents);
      this.keptDir = dir;
      this.profileDir = dir;
    } else {
      this.profileDir = fs.mkdtempSync(path.join(root, 'pane-'));
    }
    return spawn(this.binary, chromiumArgs({ profileDir: this.profileDir, ...this.viewport }), {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: this.home },
    });
  }

  /**
   * A guest's Chromium: the proxy first, then the box's launcher as
   * termag-guest. `-C 5` keeps fds 3 and 4, the DevTools pipe, across sudo.
   * The profile is a fresh name under the guest's profile root, which the
   * launcher creates and seeds; it lives in the guest's home, not here.
   */
  async spawnGuest() {
    const Proxy = this.guestDeps.GuestProxy || guestMode.GuestProxy;
    this.proxy = new Proxy({
      origins: this.guest.origins,
      log: this.log,
      onBlocked: ({ origin, local }) => { if (!this.canaryRunning) this.send({ type: 'browser-blocked', origin, local }); },
    });
    const port = await this.proxy.listen();
    this.guestProfile = this.persistent ? this.keptName : `tmp-${crypto.randomBytes(8).toString('hex')}`;
    this.profileDir = path.join(this.guest.profilesRoot, this.guestProfile);
    const spawnImpl = this.guestDeps.spawn || spawn;
    return spawnImpl('sudo', ['-n', '-C', '5', '-u', guestMode.GUEST_USER, guestMode.GUEST_LAUNCHER,
      ...chromiumArgs({ profileDir: this.profileDir, ...this.viewport, proxyPort: port })], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
  }

  /**
   * Before a guest sees anything: a page served from here tries TCP and WebRTC
   * UDP around the proxy. Unless the page ran, neither canary was reached and
   * the proxy itself refused the TCP attempt, the pane is refused: this is
   * what catches a Chromium update that stops honouring the proxy.
   */
  async runCanary() {
    const Canary = this.guestDeps.Canary || guestMode.Canary;
    const canary = new Canary();
    this.canaryRunning = true;
    try {
      const page = await canary.start();
      this.proxy.allow(page.origin);
      const { targetId } = await this.createOwnTarget(page.url);
      await canary.wait();
      await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      this.proxy.disallow(page.origin);
      if (!canary.passed(this.proxy)) {
        this.log(`[BROWSER-PANE] ${this.paneKey}: guest canary FAILED (ran=${canary.ran} tcp=${canary.tcpHits} udp=${canary.udpHits})`);
        throw new Error('guest-unsafe: this box could not confirm the guest browser is kept to the shared app');
      }
      this.log(`[BROWSER-PANE] ${this.paneKey}: guest canary passed`);
    } finally {
      this.canaryRunning = false;
      canary.close();
    }
  }

  /**
   * Target.createTarget, with its target known as this pane's own. The
   * auto-attach may announce the new page before the call answers or after;
   * one expectation is held for it either way. Whichever comes first takes it
   * (an attach while it is held is this pane's page; the answer names the id
   * for an attach that comes later), and a failed call gives it back, so a
   * popup can never ride on a leftover.
   */
  async createOwnTarget(url) {
    this.expectOwnPage += 1;
    let result;
    try {
      result = await this.cdp.send('Target.createTarget', { url });
    } catch (err) {
      this.expectOwnPage = Math.max(0, this.expectOwnPage - 1);
      this.closeClaimed(null);
      throw err;
    }
    if (this.claimedEarly.has(result.targetId)) this.claimedEarly.delete(result.targetId);
    else this.expectOwnPage = Math.max(0, this.expectOwnPage - 1);
    this.ownTargets.add(result.targetId);
    // The pane creates its pages one at a time, so any other page that took
    // the expectation while this one was in flight was not this pane's.
    this.closeClaimed(result.targetId);
    return result;
  }

  /** Pages that claimed an expectation but are not `ownId`: foreign after all, closed. */
  closeClaimed(ownId) {
    for (const id of this.claimedEarly) {
      if (id === ownId) continue;
      this.ownTargets.delete(id);
      this.cdp.send('Target.closeTarget', { targetId: id }).catch(() => {});
      this.log(`[BROWSER-PANE] ${this.paneKey}: closed a page it did not open`);
    }
    this.claimedEarly.clear();
  }

  /** Whether a guest pane may show this URL: about:blank, or a page of one of the share's origins. */
  allowsUrl(url) {
    if (!this.allowed) return true;
    const origin = guestMode.originOfUrl(url);
    return origin === '' || (origin !== null && this.allowed.has(origin));
  }

  /** The workstream checkout, now and every minute, when it changed: the guest's header shows it. */
  startCheckoutReports() {
    if (!this.guest || !this.guest.cwd) return;
    const state = this.guestDeps.checkoutState || guestMode.checkoutState;
    const report = () => {
      state(this.guest.cwd).then((s) => {
        if (this.closed || !s) return;
        const key = JSON.stringify(s);
        if (key === this.lastCheckout) return;
        this.lastCheckout = key;
        this.send({ type: 'browser-checkout', ...s });
      }).catch(() => {});
    };
    report();
    clearInterval(this.checkoutTimer);
    this.checkoutTimer = setInterval(report, CHECKOUT_EVERY_MS);
    if (this.checkoutTimer.unref) this.checkoutTimer.unref();
  }

  get quality() { return QUALITY_RUNGS[this.qualityRung]; }

  /**
   * Start (or restart) the screencast, then send one frame straight away:
   * Chromium only emits screencast frames on a repaint, so a page that sits
   * still after an attach, a reclaim or a resize would otherwise show nothing.
   */
  async startScreencast() {
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: this.quality, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1,
    }, this.sessionId);
    this.sendSnapshot();
  }

  /** One frame of the page as it is now, outside the screencast's repaint cadence. */
  sendSnapshot() {
    if (this.closed || this.parked || !this.streamId) return;
    const mine = ++this.snapshotSeq;
    const cast = this.castSeq;
    this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.quality }, this.sessionId, 5000)
      .then((shot) => {
        if (this.closed || this.parked || !this.streamId || !shot || !shot.data) return;
        // Stale if a screencast frame went out meanwhile (the page has newer
        // pixels) or a later snapshot was asked for (a resize or a quality
        // restart right behind this one: that shot is the one to show, and it
        // resolves after this one, so this one must not take its place).
        if (this.castSeq !== cast || this.snapshotSeq !== mine) return;
        this.sendFrame({ sid: null, data: shot.data, width: this.viewport.width, height: this.viewport.height });
      })
      .catch(() => {});
  }

  /**
   * Send a frame and hold it until the backend's ack. The backend acks every
   * frame in order, snapshots included, so each ack releases the frame it is
   * for and Chromium is never released for a frame the viewer has not had.
   */
  sendFrame({ sid, data, width, height }) {
    if (sid !== null) this.castSeq += 1;
    const entry = { sid, timer: null, sentAt: Date.now() };
    entry.timer = setTimeout(() => this.releaseFrame(entry, false), this.ackTimeoutMs);
    this.pendingFrames.push(entry);
    this.send({ type: 'browser-frame', data, width, height });
  }

  /** Apply a changed quality rung: a stop and start of the screencast, which also yields a frame. */
  restartScreencast() {
    if (this.closed || this.parked || this.restartingScreencast) return;
    this.restartingScreencast = true;
    this.cdp.send('Page.stopScreencast', {}, this.sessionId)
      .then(() => this.startScreencast())
      .catch(() => {})
      .then(() => { this.restartingScreencast = false; });
  }

  /** A frame's ack came back this long after it was sent: step the quality down on a slow link, up on a fast one. */
  noteAckLatency(ms) {
    if (ms > SLOW_ACK_MS) {
      this.fastAcks = 0;
      if (++this.slowAcks >= ADAPT_AFTER && this.qualityRung < QUALITY_RUNGS.length - 1) {
        this.qualityRung += 1;
        this.slowAcks = 0;
        this.log(`[BROWSER-PANE] ${this.streamId}: slow link, quality ${this.quality}`);
        this.restartScreencast();
      }
    } else if (ms < FAST_ACK_MS) {
      this.slowAcks = 0;
      if (++this.fastAcks >= ADAPT_AFTER * 4 && this.qualityRung > 0) {
        this.qualityRung -= 1;
        this.fastAcks = 0;
        this.log(`[BROWSER-PANE] ${this.streamId}: link recovered, quality ${this.quality}`);
        this.restartScreencast();
      }
    } else {
      this.slowAcks = 0;
      this.fastAcks = 0;
    }
  }

  /**
   * A page's alert, confirm or prompt. An open one stops the page, so it is
   * shown to a viewer who can answer it (relayDialogs) and answered for them
   * after DIALOG_ANSWER_MS; with nobody to ask (no such viewer, a parked
   * page) it is answered at once, as before: leaving the page allowed,
   * everything else dismissed. A beforeunload is always allowed: the viewer
   * asked to leave through the pane.
   */
  openDialog(params) {
    const type = typeof params.type === 'string' ? params.type : 'alert';
    const fallback = { accept: type === 'beforeunload' };
    if (type === 'beforeunload' || !this.relayDialogs || !this.streamId || this.parked || this.pendingDialog) {
      this.cdp.send('Page.handleJavaScriptDialog', fallback, this.sessionId).catch(() => {});
      return;
    }
    const id = ++this.dialogSeq;
    const timer = setTimeout(() => this.answerDialog({ id, accept: false }), DIALOG_ANSWER_MS);
    if (timer.unref) timer.unref();
    this.pendingDialog = { id, type, timer };
    this.send({
      type: 'browser-dialog', id, kind: type,
      message: String(params.message || '').slice(0, MAX_DIALOG_TEXT),
      ...(type === 'prompt' ? { defaultPrompt: String(params.defaultPrompt || '').slice(0, MAX_DIALOG_TEXT) } : {}),
    });
  }

  /** The viewer's answer to the dialog it was shown (a stale id is ignored). */
  answerDialog({ id, accept, text }) {
    const d = this.pendingDialog;
    if (!d || d.id !== id) return;
    const answer = { accept: accept === true };
    if (d.type === 'prompt' && answer.accept && typeof text === 'string') answer.promptText = text.slice(0, MAX_DIALOG_TEXT);
    this.cdp.send('Page.handleJavaScriptDialog', answer, this.sessionId).catch(() => {});
    this.dialogGone();
  }

  dialogGone() {
    const d = this.pendingDialog;
    if (!d) return;
    this.pendingDialog = null;
    clearTimeout(d.timer);
    this.send({ type: 'browser-dialog-closed', id: d.id });
  }

  /** The viewer is gone for now: stop painting, keep the page. The manager decides when the process goes. */
  async suspend() {
    if (this.closed || this.parked) return;
    // Nobody is left to answer it: the page shouldn't wait out the park.
    if (this.pendingDialog) this.answerDialog({ id: this.pendingDialog.id, accept: false });
    this.parked = true;
    this.streamId = null;
    clearTimeout(this.navTimer);
    this.navTimer = null;
    for (const entry of this.pendingFrames.splice(0)) clearTimeout(entry.timer);
    await this.cdp.send('Page.stopScreencast', {}, this.sessionId).catch(() => {});
  }

  /** A new viewer takes the parked page over, at their size. */
  async resume({ streamId, width, height }) {
    if (this.closed) throw new Error('browser closed');
    this.parked = false;
    this.streamId = streamId;
    const next = clampViewport(width, height);
    if (next.width !== this.viewport.width || next.height !== this.viewport.height) {
      this.viewport = next;
      await this.cdp.send('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: 1, mobile: false }, this.sessionId);
    }
    await this.startScreencast();
    if (this.guest) {
      this.lastCheckout = null;
      this.startCheckoutReports();
    }
    this.emitNav();
    return { ok: true, streamId, resumed: true };
  }

  handleEvent(message) {
    if (this.closed) return;
    if (message.sessionId && message.sessionId !== this.sessionId) return;
    switch (message.method) {
      case 'Page.screencastFrame':
        this.handleFrame(message.params);
        break;
      case 'Page.frameNavigated':
        if (message.params.frame && !message.params.frame.parentId) this.emitNav();
        break;
      case 'Page.loadEventFired':
        if (this.stillCaret) this.cdp.send('Runtime.evaluate', { expression: CARET_STILL_SCRIPT }, this.sessionId).catch(() => {});
        this.emitNav();
        break;
      case 'Page.navigatedWithinDocument':
        this.emitNav();
        break;
      case 'Inspector.targetCrashed':
        this.handlePageGone('page crashed');
        break;
      case 'Target.detachedFromTarget':
        if (message.params.sessionId === this.sessionId) this.handlePageGone('page closed');
        break;
      case 'Page.javascriptDialogOpening':
        this.openDialog(message.params || {});
        break;
      case 'Page.javascriptDialogClosed':
        // Answered (by the viewer or the fallback), or gone with its page.
        if (message.sessionId === this.sessionId) this.dialogGone();
        break;
      case 'Target.attachedToTarget':
        // Browser-level only: the auto-attach above announces itself without
        // a session; the page's own children (frames, workers) are not held.
        if (!message.sessionId) this.handleAttachedPage(message.params);
        break;
      case 'Page.fileChooserOpened':
        // Intercepted (guests only) and never answered: no file leaves the box.
        break;
      default:
        break;
    }
  }

  /**
   * A new page in a guest's browser, attached paused. This pane's own (the
   * canary, the page) are resumed; anything else is a popup and is closed
   * before it has loaded a byte. Chromium attaches a new target before it
   * answers the Target.createTarget that made it, so the next page attached
   * while one is expected is this pane's.
   */
  handleAttachedPage(params) {
    if (!this.guest || !params || !params.targetInfo || params.targetInfo.type !== 'page') return;
    const { targetId, openerId } = params.targetInfo;
    let own = this.ownTargets.has(targetId);
    // A page another page opened is a popup, expectation or not.
    if (!own && this.expectOwnPage > 0 && !openerId) {
      // Announced before its createTarget answered: it takes the expectation.
      this.expectOwnPage -= 1;
      this.claimedEarly.add(targetId);
      this.ownTargets.add(targetId);
      own = true;
    }
    if (own) {
      if (params.waitingForDebugger) this.cdp.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
      return;
    }
    this.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    // A popup, or Chromium's own first tab from the command line.
    this.log(`[BROWSER-PANE] ${this.paneKey}: closed a page it did not open`);
  }

  handleFrame(frame) {
    if (this.parked || !this.streamId) {
      // A frame in flight when the pane was parked: let Chromium move on.
      this.ackWhenDrained(frame.sessionId);
      return;
    }
    this.sendFrame({ sid: frame.sessionId, data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight });
  }

  /** The backend says the oldest frame has left for the viewer: let Chromium paint the next. */
  frameAck() {
    const entry = this.pendingFrames[0];
    if (entry) this.releaseFrame(entry, true);
  }

  releaseFrame(entry, acked) {
    const at = this.pendingFrames.indexOf(entry);
    if (at < 0) return;
    this.pendingFrames.splice(at, 1);
    clearTimeout(entry.timer);
    if (acked) this.noteAckLatency(Date.now() - entry.sentAt);
    // A snapshot has nothing to ack to Chromium; the screencast runs on.
    if (entry.sid !== null) this.ackWhenDrained(entry.sid);
  }

  /** Ack to Chromium once the agent socket has room and the frame interval has passed. */
  ackWhenDrained(frameSessionId) {
    const tick = () => {
      this.ackTimer = null;
      if (this.closed) return;
      const wait = this.lastAckAt + MIN_FRAME_INTERVAL_MS - Date.now();
      if (wait > 0) {
        this.ackTimer = setTimeout(tick, wait);
      } else if (this.transport.bufferedAmount() < ACK_HOLD_BYTES) {
        this.lastAckAt = Date.now();
        this.cdp.send('Page.screencastFrameAck', { sessionId: frameSessionId }, this.sessionId).catch(() => {});
      } else {
        this.ackTimer = setTimeout(tick, ACK_POLL_MS);
      }
    };
    tick();
  }

  /** The current entry of the page's history, debounced: a navigation fires several page events. */
  emitNav() {
    if (this.navTimer || !this.streamId) return;
    this.navTimer = setTimeout(async () => {
      this.navTimer = null;
      if (this.closed || !this.streamId) return;
      try {
        const history = await this.cdp.send('Page.getNavigationHistory', {}, this.sessionId);
        const current = history.entries[history.currentIndex];
        this.send({
          type: 'browser-nav',
          url: current ? current.url : '',
          title: current ? current.title : '',
          canGoBack: history.currentIndex > 0,
          canGoForward: history.currentIndex < history.entries.length - 1,
        });
      } catch { /* the page is going away */ }
    }, NAV_DEBOUNCE_MS);
  }

  input(event) {
    if (this.closed) return;
    const call = inputToCdp(event, this.viewport);
    if (!call) return;
    if (call.method === 'Input.dispatchMouseEvent') {
      const p = call.params;
      // A press where the page has not seen the pointer yet: move it there
      // first, as a real mouse would have. Menus and hover-revealed controls
      // open on the move and take the click; without it some ignore the press.
      if (p.type === 'mousePressed' && (!this.pointer || this.pointer.x !== p.x || this.pointer.y !== p.y)) {
        this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0, clickCount: 0, modifiers: p.modifiers }, this.sessionId).catch(() => {});
      }
      if (p.type !== 'mouseWheel') this.pointer = { x: p.x, y: p.y };
    }
    this.cdp.send(call.method, call.params, this.sessionId).catch(() => {});
  }

  navigate(url) {
    const target = normalizeUrl(url);
    if (!target || this.closed) return;
    if (!this.allowsUrl(target)) {
      const origin = guestMode.originOfUrl(target);
      this.send({ type: 'browser-blocked', origin: origin || guestMode.displayOrigin(target), local: origin !== null });
      return;
    }
    this.cdp.send('Page.navigate', { url: target }, this.sessionId).catch(() => {});
  }

  async history(action) {
    if (this.closed) return;
    if (action === 'reload') {
      this.cdp.send('Page.reload', {}, this.sessionId).catch(() => {});
      return;
    }
    if (action !== 'back' && action !== 'forward') return;
    const history = await this.cdp.send('Page.getNavigationHistory', {}, this.sessionId).catch(() => null);
    if (!history || this.closed) return;
    const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
    if (entry) this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, this.sessionId).catch(() => {});
  }

  async resize(width, height) {
    if (this.closed || this.parked) return;
    const next = clampViewport(width, height);
    if (next.width === this.viewport.width && next.height === this.viewport.height) return;
    this.viewport = next;
    try {
      await this.cdp.send('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: 1, mobile: false }, this.sessionId);
      // The restart sends a frame at the new size even when the page did not repaint.
      await this.cdp.send('Page.stopScreencast', {}, this.sessionId);
      await this.startScreencast();
    } catch { /* the page is going away */ }
  }

  /** Stop relaying and forget the protocol session; idempotent. */
  teardown() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.ackTimer);
    clearTimeout(this.navTimer);
    clearInterval(this.checkoutTimer);
    if (this.proxy) this.proxy.close();
    for (const entry of this.pendingFrames.splice(0)) clearTimeout(entry.timer);
    if (this.cdp) this.cdp.close();
  }

  /** Closed, or on its way: what the manager asks before reusing a pane or its profile. */
  get gone() { return this.closed || this.closing; }

  /**
   * Quit the browser, kill it if it lingers, remove its profile once it is
   * gone (a guest's kept one stays). An owner's kept browser first saves its
   * loopback cookies to the jar (cookieJarPath); its profile then goes like
   * a throwaway one, with every other site's state in it.
   */
  close() {
    if (this.gone) return;
    this.closing = true;
    if (this.keptDir && this.cdp && !this.cdp.closed) {
      withTimeout(this.saveCookies(), JAR_TOTAL_MS)
        .catch((err) => this.log(`[BROWSER-PANE] ${this.paneKey}: could not save its sign-ins (${err.message}); the last saved ones stay`))
        .then(() => this.quit());
      return;
    }
    this.quit();
  }

  /** The browser's loopback cookies, and only those, to the jar: written whole (0600) or not at all. */
  async saveCookies() {
    const { cookies = [] } = await this.cdp.send('Storage.getCookies', {}, undefined, JAR_TIMEOUT_MS);
    let keep = cookies.filter((c) => isLoopbackCookieDomain(c.domain)).map(cookieParam);
    const jar = cookieJarPath(this.keptDir);
    if (this.jarNotRestored) {
      // This browser never got the jar's sign-ins: what it has is laid over
      // them, never in place of them, so a failed restore loses nothing.
      let saved = [];
      try { saved = JSON.parse(fs.readFileSync(jar, 'utf8')); } catch { saved = []; }
      const id = (c) => `${c.name}\n${c.domain}\n${c.path}`;
      const merged = new Map((Array.isArray(saved) ? saved : []).filter((c) => c && typeof c === 'object' && isLoopbackCookieDomain(c.domain)).map((c) => [id(c), cookieParam(c)]));
      for (const c of keep) merged.set(id(c), c);
      keep = [...merged.values()];
    }
    const tmp = `${jar}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keep), { mode: 0o600 });
    fs.renameSync(tmp, jar);
  }

  /** The jar's cookies into this browser, before its first page: loopback ones that have not expired. */
  async restoreCookies() {
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(cookieJarPath(this.keptDir), 'utf8')); } catch { return; }
    if (!Array.isArray(saved)) return;
    const nowSec = Date.now() / 1000;
    const cookies = saved.filter((c) => c && typeof c === 'object' && isLoopbackCookieDomain(c.domain) && !(typeof c.expires === 'number' && c.expires <= nowSec)).map(cookieParam);
    if (!cookies.length) return;
    await this.cdp.send('Storage.setCookies', { cookies }, undefined, JAR_TIMEOUT_MS)
      .catch((err) => {
        this.jarNotRestored = true;
        this.log(`[BROWSER-PANE] ${this.paneKey}: could not restore its sign-ins (${err.message}); its jar is kept and added to at close`);
      });
  }

  quit() {
    if (this.closed) return;
    if (this.cdp) this.cdp.send('Browser.close', {}, undefined, 1000).catch(() => {});
    this.teardown();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      // A guest's child is sudo: killing it can't reach termag-guest's
      // Chromium, but closing the DevTools pipe ends it (measured), so the
      // pipe goes too.
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        for (const fd of [3, 4]) { try { if (child.stdio && child.stdio[fd]) child.stdio[fd].destroy(); } catch { /* gone */ } }
      }, this.killGraceMs);
      child.once('exit', () => clearTimeout(killTimer));
    } else {
      this.removeProfile();
      this.markExited();
    }
  }

  /** Kill a browser still running at agent shutdown, after closeAll had its chance. */
  kill() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    for (const fd of [3, 4]) { try { if (child.stdio && child.stdio[fd]) child.stdio[fd].destroy(); } catch { /* gone */ } }
  }

  /**
   * The page crashed or went away while the browser process lives (a renderer
   * crash, a `window.close()`): report it upstream, then take the process down
   * too, so a dead pane never leaves a Chromium behind or holds a MAX_PANES slot.
   */
  handlePageGone(reason) {
    if (this.gone) return;
    const onExit = this.onExit;
    this.close();
    if (onExit) onExit(reason);
  }

  /** The browser process ended, asked to or not; an unasked end is reported upstream. */
  handleProcessExit(reason) {
    const unexpected = !this.gone;
    this.teardown();
    // A guest's kept profile survives its browser; an owner's goes (its jar stays).
    this.removeProfile();
    this.markExited();
    if (unexpected && this.onExit) this.onExit(reason);
  }

  removeProfile() {
    const dir = this.profileDir;
    if (!dir) return;
    this.profileDir = null;
    if (this.persistent && this.guest) return;
    if (this.guest) {
      // In the guest's home: only the launcher, as termag-guest, can delete it.
      // It refuses (exit 66) while a Chromium still holds the profile, which a
      // browser that is still quitting can for a moment, so it is asked again
      // a few times; the guest sweep takes whatever is left.
      const forget = this.guestDeps.runLauncher || guestMode.runLauncher;
      const name = this.guestProfile;
      const attempt = (n) => forget(['--termag-forget', name]).catch((err) => {
        if (n + 1 < GUEST_FORGET_RETRY_MS.length) {
          const t = setTimeout(() => attempt(n + 1), GUEST_FORGET_RETRY_MS[n + 1]);
          if (t.unref) t.unref();
          return;
        }
        this.log(`[BROWSER-PANE] ${this.paneKey}: could not delete guest profile ${name} (${err.message}); the guest sweep will`);
      });
      attempt(0);
      return;
    }
    if (this.keptDir) {
      // The next launch on this key reuses the path as soon as this browser
      // has exited: it is moved aside now, at once, and deleted from there,
      // so a delete still running never reaches the new browser's tree.
      const aside = `${dir}.gone-${crypto.randomBytes(6).toString('hex')}`;
      try { fs.renameSync(dir, aside); } catch {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the sweep catches it */ }
        return;
      }
      fs.rm(aside, { recursive: true, force: true }, () => {});
      return;
    }
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

/**
 * A kept profile's directory, made private: it and the given parents are 0700
 * and owned by this user, and none of them is a symlink (a profile is never
 * written somewhere a link points). Throws otherwise.
 */
function ensurePrivateDir(dir, parents = []) {
  // Only ever a directory inside the first parent (the profile root), named
  // in normal form: never somewhere a `..` or a stray absolute path leads.
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) throw new Error(`${dir} is not a plain absolute path`);
  if (parents.length) {
    const rel = path.relative(parents[0], dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${dir} is not inside ${parents[0]}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const uid = process.getuid ? process.getuid() : null;
  for (const d of [...parents, dir]) {
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a plain directory`);
    if (uid !== null && st.uid !== uid) throw new Error(`${d} is not this user's`);
    if ((st.mode & 0o777) !== 0o700) fs.chmodSync(d, 0o700);
  }
  return dir;
}

// ── URL suggestions ─────────────────────────────────────────────────────────

/** Listening TCP sockets on loopback or every interface, from /proc/net/tcp{,6} text: [{ host, port }]. */
function parseListeners(tcpTexts) {
  const out = [];
  const seen = new Set();
  tcpTexts.forEach((text, index) => {
    if (!text) return;
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue;
      const [addrHex, portHex] = (cols[1] || '').split(':');
      const port = parseInt(portHex, 16);
      if (!Number.isInteger(port)) continue;
      let host = null;
      if (index === 0 && addrHex && addrHex.length === 8) {
        // IPv4, host byte order: 0100007F is 127.0.0.1.
        const bytes = [6, 4, 2, 0].map((i) => parseInt(addrHex.slice(i, i + 2), 16));
        if (addrHex === '00000000') host = '127.0.0.1';
        else if (bytes[0] === 127) host = bytes.join('.');
      } else if (index === 1 && addrHex && addrHex.length === 32) {
        if (addrHex === '00000000000000000000000000000000') host = '127.0.0.1';
        else if (addrHex === '00000000000000000000000001000000') host = '[::1]';
      }
      if (!host) continue;
      const key = `${host}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ host, port });
    }
  });
  return out;
}

// Ports no web app answers on but which sit in the ranges below: databases,
// caches, the local AWS stand-ins. Probing them would only cost time.
const SUGGEST_DENY = new Set([4566, 4567, 5432, 6379, 7001, 7002, 7003, 7004, 7005, 7006, 8123, 8443, 9000, 9001, 9009, 9324]);

/** Whether a listener is worth an HTTP probe: port 80, or an unprivileged port under 10000 that is not a known database. */
function isCandidatePort(port) {
  if (port === 80) return true;
  if (port < 1024 || port > 9999) return false;
  if (SUGGEST_DENY.has(port)) return false;
  if (port >= 5432 && port <= 5499) return false;
  if (port >= 6379 && port <= 6399) return false;
  return true;
}

/** `127.0.0.<DEV_INSTANCE>` from a webapp checkout's dev-stack override, the slot's front door; null otherwise. */
function devStackHost(cwd, readFileSync = fs.readFileSync) {
  if (!cwd) return null;
  let text;
  try { text = readFileSync(path.join(cwd, 'dev-stack', '.env.override'), 'utf8'); } catch { return null; }
  const m = text.match(/^DEV_INSTANCE=(\d+)\s*$/m);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 254 ? `127.0.0.${n}` : null;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/** GET a candidate once: `{ ok, status, title }`; `ok` only for an HTTP answer under 500 (non-HTTP listeners reset or time out). */
function probeHttp(url, timeoutMs = SUGGEST_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    const req = http.get(url, { timeout: timeoutMs, headers: { accept: 'text/html,*/*' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 65536) body += chunk;
        else res.destroy();
      });
      res.on('end', () => {
        const m = body.match(/<title[^>]*>([^<]*)<\/title>/i);
        finish({ ok: res.statusCode < 500, status: res.statusCode, title: m ? decodeEntities(m[1]).slice(0, 80) : '' });
      });
      res.on('error', () => finish({ ok: res.statusCode < 500, status: res.statusCode, title: '' }));
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false }); });
    req.on('error', () => finish({ ok: false }));
  });
}

/**
 * Best first: the dev-stack slot's own front door (port 80 on the hinted
 * address), then any port 80, then titled pages, then the lowest port. The
 * hint lifts only the front door: a slot's databases and stand-ins share its
 * address and must not outrank a real app on another.
 */
function rankSuggestions(items, preferredHost) {
  const score = (s) => (s.port === 80 ? (s.host === preferredHost ? 200 : 100) : 0) + (s.title ? 10 : 0) - s.port / 100000;
  return [...items].sort((a, b) => score(b) - score(a));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * Web apps listening on this box, for the pane's URL bar: `[{ url, title, status, host, port }]`.
 * `cwd` is the project's directory, read for a dev-stack slot hint.
 */
async function suggestions({ cwd, readFileSync = fs.readFileSync, probe = probeHttp } = {}) {
  const texts = ['/proc/net/tcp', '/proc/net/tcp6'].map((f) => {
    try { return readFileSync(f, 'utf8'); } catch { return ''; }
  });
  const listeners = parseListeners(texts).filter((l) => isCandidatePort(l.port));
  const preferred = devStackHost(cwd, readFileSync);
  // Probe the likeliest first, so the cap keeps them.
  const ordered = rankSuggestions(listeners.map((l) => ({ ...l, title: '' })), preferred).slice(0, SUGGEST_MAX_PORTS);
  const probed = await mapLimit(ordered, SUGGEST_CONCURRENCY, async (l) => {
    const url = `http://${l.host}${l.port === 80 ? '' : `:${l.port}`}/`;
    const result = await probe(url);
    return result && result.ok ? { url, title: result.title || '', status: result.status, host: l.host, port: l.port } : null;
  });
  return rankSuggestions(probed.filter(Boolean), preferred).slice(0, SUGGEST_MAX_RESULTS);
}

// ── Manager ─────────────────────────────────────────────────────────────────

/**
 * The agent's browser panes: active ones by stream id, parked ones by pane
 * key. One per process; `bindSocket` points it at the live orchestrator
 * socket on each connect, and `parkAll` keeps the browsers through a drop.
 *
 * Guest panes are counted apart: owners keep
 * MAX_PANES among themselves, guests get the share's `maxGuestPanes` (a flag,
 * clamped to a hard ceiling), and neither ever evicts the other's browser.
 * `guestEnv` is `guestEnvironment()`'s answer, asked once at agent start.
 */
function sameOrigins(a, b) {
  return a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
}

/** A guest attach's `profileExpiresAt` (the share's expiry, ISO 8601) in ms; undefined when absent or garbage. */
function expiresAtOf(msg) {
  const t = Date.parse(msg && msg.profileExpiresAt);
  return Number.isFinite(t) ? t : undefined;
}

/** Whether a process id is alive (a signal 0 reaches it); a pid that can't be told is taken as alive. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * The pid holding a Chromium profile, from its SingletonLock symlink
 * (`<host>-<pid>`); null when nothing holds it.
 */
function profileLockPid(dir, readlinkSync = fs.readlinkSync) {
  try {
    const m = readlinkSync(path.join(dir, 'SingletonLock')).match(/-(\d+)$/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/**
 * Persistent profiles (`index`, a ProfileIndex) are on when the agent hands
 * one in; the backend then asks for them per attach with `persistProfile`.
 */
function createManager({ binary, home, log = console.log, parkMs = PARK_MS, paneFactory = null, guestEnv = { ok: false, reason: 'not checked' }, guestDeps = {}, index = null, now = Date.now, sweepEveryMs = PROFILE_SWEEP_EVERY_MS }) {
  const transport = { send: () => {}, bufferedAmount: () => 0 };
  const panes = new Map();
  const parked = new Map();
  /** Every pane whose browser may still be running, live, parked or closing: the profile each holds, and the stragglers at shutdown. */
  const running = new Set();
  /** Kept profile name → the pane whose browser has it open. */
  const holders = new Map();
  const ownerProfiles = binary ? path.join(profileRoot(binary, home), 'profiles') : null;
  const makePane = paneFactory || ((opts) => new BrowserPane(opts));
  const resolveRecipe = guestDeps.resolveRecipe || guestMode.resolveRecipe;
  const memAvailable = guestDeps.memAvailableBytes || guestMode.memAvailableBytes;
  const runLauncher = guestDeps.runLauncher || guestMode.runLauncher;

  const isGuestPane = (pane) => !!pane.guest;
  function counts() {
    let owner = 0;
    let guest = 0;
    for (const p of panes.values()) { if (isGuestPane(p)) guest += 1; else owner += 1; }
    for (const e of parked.values()) { if (isGuestPane(e.pane)) guest += 1; else owner += 1; }
    return { owner, guest, liveGuests: [...panes.values()].filter(isGuestPane).length };
  }
  /** The oldest parked browser of one kind, evicted to make room; whether there was one. */
  function evictParked(guest) {
    for (const [key, entry] of parked) {
      if (isGuestPane(entry.pane) !== guest) continue;
      unpark(key).close();
      log(`[BROWSER-PANE] ${key}: parked browser evicted for a new pane`);
      return true;
    }
    return false;
  }

  /**
   * Throwaway guest profiles nobody is using: ones an agent that stopped
   * without closing them left behind, or whose delete never got through. At
   * start and hourly; never one a live Chromium holds (perhaps another agent's
   * sharing this box), one of this agent's panes, or one made in the last few
   * minutes (a browser still starting).
   */
  async function sweepGuestProfiles() {
    if (!guestEnv.ok) return;
    let listing;
    try { listing = await runLauncher(['--termag-list']); } catch (err) {
      log(`[BROWSER-PANE] could not list guest profiles: ${err.message}`);
      return;
    }
    const live = new Set([...panes.values(), ...[...parked.values()].map((e) => e.pane)].map((p) => p.guestProfile).filter(Boolean));
    for (const line of listing.split('\n')) {
      const [name, mtime, held] = line.split(' ');
      if (!name || !name.startsWith('tmp-') || live.has(name) || held === '1') continue;
      if (Number(mtime) * 1000 > Date.now() - GUEST_SWEEP_MIN_AGE_MS) continue;
      await runLauncher(['--termag-forget', name]).then(
        () => log(`[BROWSER-PANE] removed a stale guest profile ${name}`),
        (err) => log(`[BROWSER-PANE] could not remove guest profile ${name}: ${err.message}`),
      );
    }
  }
  if (guestEnv.ok) {
    sweepGuestProfiles();
    const timer = setInterval(() => { sweepGuestProfiles().catch(() => {}); }, GUEST_SWEEP_EVERY_MS);
    if (timer.unref) timer.unref();
  }

  /**
   * Everything that picks, opens or deletes one kept profile runs in turn:
   * two attaches on the same key, or an attach and the sweep, never decide on
   * a profile at the same time.
   */
  const profileLocks = new Map();
  function withProfileLock(name, fn) {
    const prev = profileLocks.get(name) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    profileLocks.set(name, tail);
    tail.then(() => { if (profileLocks.get(name) === tail) profileLocks.delete(name); });
    return run;
  }

  /**
   * Whether a browser this manager doesn't own has the profile open: another
   * agent sharing HOME (the staging mirror). An owner's profile shows it in
   * its SingletonLock; a guest's only the launcher can see (its held column).
   */
  async function heldElsewhere(name, kind) {
    if (!isProfileName(name)) return true;
    if (kind === 'guest') {
      if (!guestEnv.ok) return false;
      try {
        const line = (await runLauncher(['--termag-list'])).split('\n').find((l) => l.split(' ')[0] === name);
        return !!line && line.split(' ')[2] === '1';
      } catch { return true; }
    }
    if (!ownerProfiles) return false;
    const pid = profileLockPid(path.join(ownerProfiles, name));
    return !!pid && pidAlive(pid) && ![...running].some((p) => p.child && p.child.pid === pid);
  }

  function track(pane) {
    running.add(pane);
    if (pane.keptName) holders.set(pane.keptName, pane);
    Promise.resolve(pane.exited).then(() => {
      running.delete(pane);
      if (pane.keptName && holders.get(pane.keptName) === pane) holders.delete(pane.keptName);
    });
  }

  /**
   * Delete a kept profile, owner's or guest's, once no browser has it open,
   * here or in another agent. `onlyIf` is checked again inside the profile's
   * lock (the sweep's "still stale?"), so an attach that touched the profile
   * meanwhile keeps it. Resolves whether it was deleted.
   */
  function deleteProfile(name, kind, onlyIf = null) {
    if (!isProfileName(name)) return Promise.reject(new Error('not a profile name'));
    return withProfileLock(name, async () => {
      const holder = holders.get(name);
      if (holder) await Promise.race([holder.exited, new Promise((r) => setTimeout(r, PROFILE_WAIT_MS))]);
      if (holders.has(name)) throw new Error(`profile ${name} is still in use`);
      if (onlyIf && !onlyIf()) return false;
      if (await heldElsewhere(name, kind)) throw new Error(`profile ${name} is in use by another process`);
      // The launcher refuses a held guest profile too (exit 66).
      if (kind === 'guest') await runLauncher(['--termag-forget', name]);
      else if (ownerProfiles) {
        await fs.promises.rm(path.join(ownerProfiles, name), { recursive: true, force: true });
        await fs.promises.rm(cookieJarPath(path.join(ownerProfiles, name)), { force: true });
      }
      if (index) index.remove(name);
      return true;
    });
  }

  /**
   * The kept profiles' sweep, at start and hourly: an owner's cookie jar
   * after 14 days unused, a guest's profile once its share's expiry passed
   * (or 14 days unused with none), any the index no longer knows, an owner's
   * browser dir no live browser has (it never exited cleanly), and the
   * throwaway `pane-*` dirs an agent that stopped without closing left behind.
   * Only ever what no live process holds: the staging mirror agent shares
   * this HOME.
   */
  async function sweepProfiles() {
    if (!index) return;
    const t = now();
    const stale = (entry) => !entry || (entry.expiresAt ? entry.expiresAt < t : t - (entry.lastUsedAt || 0) > OWNER_PROFILE_IDLE_MS);
    const busy = (name) => holders.has(name);
    if (ownerProfiles) {
      let names = [];
      try { names = fs.readdirSync(ownerProfiles); } catch { /* none yet */ }
      for (const entryName of names) {
        // A jar, a browser dir, a dir moved aside on exit, a jar's temp file:
        // anything else in the root is not ours to touch.
        const m = /^(p-[0-9a-f]{32})(\.cookies\.json|\.gone-[0-9a-f]{12}|\.cookies\.json\.\d{1,10}\.tmp)?$/.exec(entryName);
        if (!m) continue;
        const name = m[1];
        const kindOfEntry = m[2] === '.cookies.json' ? 'jar' : m[2] && m[2].endsWith('.tmp') ? 'tmp' : 'dir';
        if (busy(name)) continue;
        const entry = index.get(name);
        if (entry && entry.kind === 'guest') continue;
        if (kindOfEntry !== 'jar') {
          // A browser dir with no live browser: one that never exited
          // cleanly (or one moved aside whose delete never finished), or a
          // jar write that never finished. It may hold any site's state, so
          // it goes now; the jar beside it is what is kept.
          // Another agent sharing HOME (the staging mirror) may be launching
          // on it right now: one touched in the last few minutes, or whose
          // SingletonLock names a live process, is left alone, checked again
          // inside the lock, just before the delete.
          const dir = path.join(ownerProfiles, entryName);
          const inUse = () => {
            const pid = kindOfEntry === 'dir' ? profileLockPid(dir) : null;
            if (pid && pidAlive(pid)) return true;
            try { return now() - fs.statSync(dir).mtimeMs < LEFTOVER_DIR_MIN_AGE_MS; } catch { return true; }
          };
          if (inUse()) continue;
          await withProfileLock(name, async () => {
            if (holders.has(name) || inUse()) return;
            await fs.promises.rm(dir, { recursive: true, force: true });
            log(`[BROWSER-PANE] removed a kept browser's leftover ${entryName}`);
          }).catch(() => {});
          continue;
        }
        if (!stale(entry)) continue;
        await deleteProfile(name, 'owner', () => stale(index.get(name)))
          .then((gone) => { if (gone) log(`[BROWSER-PANE] removed an unused profile ${name}`); }, () => {});
      }
      const root = path.dirname(ownerProfiles);
      let legacy = [];
      try { legacy = fs.readdirSync(root).filter((n) => n.startsWith('pane-')); } catch { /* none */ }
      const live = new Set([...running].map((p) => p.profileDir).filter(Boolean));
      for (const name of legacy) {
        const dir = path.join(root, name);
        if (live.has(dir)) continue;
        const pid = profileLockPid(dir);
        if (pid && pidAlive(pid)) continue;
        await fs.promises.rm(dir, { recursive: true, force: true }).then(() => log(`[BROWSER-PANE] removed a leftover throwaway profile ${name}`), () => {});
      }
    }
    if (guestEnv.ok) {
      let listing = '';
      try { listing = await runLauncher(['--termag-list']); } catch { return; }
      for (const line of listing.split('\n')) {
        const [name, , held] = line.split(' ');
        // Held: a live Chromium has it, perhaps another agent's.
        if (!name || !name.startsWith('p-') || busy(name) || held === '1') continue;
        if (!stale(index.get(name))) continue;
        await deleteProfile(name, 'guest', () => stale(index.get(name)))
          .then((gone) => { if (gone) log(`[BROWSER-PANE] removed an expired guest profile ${name}`); }, () => {});
      }
    }
    // Owner entries whose jar is gone (deleted by hand, or a box rebuilt) go too.
    for (const name of index.names()) {
      if (!isProfileName(name)) { index.remove(name); continue; }
      const entry = index.get(name);
      if (entry && entry.kind === 'owner' && ownerProfiles && !busy(name)
        && !fs.existsSync(cookieJarPath(path.join(ownerProfiles, name))) && !fs.existsSync(path.join(ownerProfiles, name))) index.remove(name);
    }
  }
  if (index) {
    sweepProfiles().catch((err) => log(`[BROWSER-PANE] profile sweep failed: ${err.message}`));
    const timer = setInterval(() => sweepProfiles().catch(() => {}), sweepEveryMs);
    if (timer.unref) timer.unref();
  }

  function unpark(key) {
    const entry = parked.get(key);
    if (!entry) return null;
    clearTimeout(entry.timer);
    parked.delete(key);
    return entry.pane;
  }

  /** Keep the browser for a reattach; a pane without a key, or when parking is off, is closed. */
  function park(pane) {
    if (!pane.paneKey || parkMs <= 0 || pane.gone) {
      pane.close();
      return false;
    }
    const previous = unpark(pane.paneKey);
    if (previous && previous !== pane) previous.close();
    pane.suspend().catch(() => {});
    parked.set(pane.paneKey, {
      pane,
      timer: setTimeout(() => {
        parked.delete(pane.paneKey);
        pane.close();
        log(`[BROWSER-PANE] ${pane.paneKey}: parked browser expired`);
      }, parkMs),
    });
    return true;
  }

  function onPaneExit(pane, reason) {
    for (const [streamId, p] of panes) {
      if (p !== pane) continue;
      panes.delete(streamId);
      transport.send({ type: 'browser-exit', streamId, reason });
    }
    const entry = pane.paneKey ? parked.get(pane.paneKey) : null;
    if (entry && entry.pane === pane) {
      clearTimeout(entry.timer);
      parked.delete(pane.paneKey);
    }
    log(`[BROWSER-PANE] ${pane.paneKey || pane.streamId || 'pane'}: ${reason}`);
  }

  function liveStreamOf(pane) {
    for (const [sid, p] of panes) if (p === pane) return sid;
    return null;
  }

  /**
   * The rest of an attach, once the request is checked (and, for a kept
   * profile, inside its lock). `o`: { streamId, paneKey, url, guest,
   * guestOpts, keptName, openedShare }.
   */
  async function attachPane(msg, o) {
    const { streamId, url, guest, guestOpts, openedShare } = o;
    let { paneKey, keptName } = o;
    const sameShare = (pane) => isGuestPane(pane) === guest && (!guest || (pane.guest && sameOrigins(pane.guest.origins, guestOpts.origins)));
    // A link's `at` asked for a page (or an owner's share link resolved its
    // app): a browser handed back (taken over or reclaimed) goes there; a
    // plain reconnect stays where it was.
    const goToAt = (pane) => {
      if (url === 'about:blank') return;
      if ((guest && typeof msg.atPath === 'string' && msg.atPath) || openedShare) pane.navigate(url);
    };
    // A guest's browser handed back still counts against today's limit: a
    // lowered (or zero) limit applies to a parked reviewer too.
    const guestRoom = () => {
      if (!guest) return;
      const max = clampInt(msg.maxGuestPanes, 0, guestMode.MAX_GUEST_PANES_CEILING, guestMode.DEFAULT_MAX_GUEST_PANES);
      if (max === 0) throw new Error('guest-busy: this box takes no reviewers right now');
      const live = counts().liveGuests;
      if (live >= max) throw new Error(`guest-busy: ${live} reviewer${live === 1 ? ' is' : 's are'} already using this preview`);
    };
    const touch = (name) => { if (index && name) index.touch(name, { key: paneKey, kind: guest ? 'guest' : 'owner', expiresAt: guest ? expiresAtOf(msg) : undefined }); };

    // A live browser on this kept profile (another tab, or a redial that
    // overlapped the first attach) is handed to this viewer: the newest
    // attach wins, and the older viewer is told, finally, rather than both
    // getting a browser of their own on one profile or this one starting
    // signed out.
    if (keptName) {
      const holder = holders.get(keptName);
      const oldStream = holder && !holder.gone ? liveStreamOf(holder) : null;
      if (oldStream && sameShare(holder)) {
        panes.delete(oldStream);
        transport.send({ type: 'browser-exit', streamId: oldStream, reason: 'This browser opened in another tab.', takenOver: true });
        await holder.suspend();
        panes.set(streamId, holder);
        holder.relayDialogs = msg.relayDialogs === true;
        touch(keptName);
        try {
          const result = await holder.resume({ streamId, width: msg.width, height: msg.height });
          goToAt(holder);
          log(`[BROWSER-PANE] ${streamId}: took ${paneKey} over from ${oldStream}`);
          return { ...result, takenOver: true, ...(guest ? { origins: guestOpts.origins } : {}) };
        } catch (err) {
          panes.delete(streamId);
          holder.close();
          throw err;
        }
      }
      if (oldStream) {
        // The grant changed under a live guest: its browser goes, and a fresh one comes.
        panes.delete(oldStream);
        transport.send({ type: 'browser-exit', streamId: oldStream, reason: 'The preview changed; reopening.' });
        holder.close();
      }
    }

    const reclaimed = paneKey ? unpark(paneKey) : null;
    if (reclaimed && !reclaimed.gone) {
      // A guest's browser is handed back only while the share still names
      // the same origins: a changed grant gets a fresh browser.
      if (sameShare(reclaimed)) {
        try { guestRoom(); } catch (err) { park(reclaimed); throw err; }
        panes.set(streamId, reclaimed);
        reclaimed.relayDialogs = msg.relayDialogs === true;
        touch(reclaimed.keptName);
        try {
          const result = await reclaimed.resume({ streamId, width: msg.width, height: msg.height });
          goToAt(reclaimed);
          log(`[BROWSER-PANE] ${streamId}: resumed ${paneKey} at ${reclaimed.viewport.width}x${reclaimed.viewport.height}`);
          return guest ? { ...result, origins: guestOpts.origins } : result;
        } catch (err) {
          panes.delete(streamId);
          reclaimed.close();
          throw err;
        }
      }
      reclaimed.close();
      log(`[BROWSER-PANE] ${paneKey}: parked browser closed, the share changed`);
    }

    const now = counts();
    if (guest) {
      const max = clampInt(msg.maxGuestPanes, 0, guestMode.MAX_GUEST_PANES_CEILING, guestMode.DEFAULT_MAX_GUEST_PANES);
      const busy = (live) => new Error(`guest-busy: ${live} reviewer${live === 1 ? ' is' : 's are'} already using this preview`);
      if (max === 0) throw new Error('guest-busy: this box takes no reviewers right now');
      // Every refusal that does not depend on room comes first: a parked
      // reviewer's browser is never thrown away for an attach that fails anyway.
      const free = memAvailable();
      if (free !== null && free < guestMode.MIN_MEM_AVAILABLE_BYTES) throw new Error('guest-memory: the box is low on memory');
      if (now.liveGuests >= max) throw busy(now.liveGuests);
      // Room is made from parked guests only, as many as it takes (a lowered
      // limit can leave more than one over).
      while (counts().guest >= max) {
        if (!evictParked(true)) throw busy(counts().liveGuests);
      }
    } else if (now.owner >= MAX_PANES && !evictParked(false)) {
      // A parked browser is the one nobody is looking at: it goes first.
      throw new Error(`at most ${MAX_PANES} browser panes per agent`);
    }

    if (keptName) {
      // A browser of ours still quitting on it is waited for; one that isn't
      // ours (another agent sharing HOME) means a throwaway profile, and no
      // key, so this one never parks over it.
      const quitting = holders.get(keptName);
      if (quitting) await Promise.race([quitting.exited, new Promise((r) => setTimeout(r, PROFILE_WAIT_MS))]);
      if (holders.has(keptName) || await heldElsewhere(keptName, guest ? 'guest' : 'owner')) {
        log(`[BROWSER-PANE] ${paneKey}: its profile is in use elsewhere; this one gets a throwaway profile`);
        keptName = null;
        paneKey = null;
      }
    }
    touch(keptName);
    let pane;
    pane = makePane({
      streamId, paneKey, binary, home, transport, log, onExit: (reason) => onPaneExit(pane, reason), guest: guestOpts, guestDeps,
      // A guest's kept profile is Chromium's own and needs its cookies flushed
      // on the way out; an owner's goes with its browser (its jar is saved
      // before the quit), so it quits on the usual grace.
      persistent: !!keptName, profileName: keptName, ...(keptName && guest ? { killGraceMs: PERSISTENT_KILL_GRACE_MS } : {}),
    });
    track(pane);
    panes.set(streamId, pane);
    pane.relayDialogs = msg.relayDialogs === true;
    try {
      const result = await pane.open({ url, width: msg.width, height: msg.height });
      log(`[BROWSER-PANE] ${streamId}: opened ${url} at ${pane.viewport.width}x${pane.viewport.height}${pane.child ? ` (pid ${pane.child.pid})` : ''}${guest ? ' as a guest' : ''}`);
      return guest ? { ...result, origins: guestOpts.origins } : result;
    } catch (err) {
      panes.delete(streamId);
      pane.close();
      throw err;
    }
  }

  return {
    bindSocket({ send, bufferedAmount }) {
      transport.send = send;
      transport.bufferedAmount = bufferedAmount;
    },

    unbindSocket() {
      transport.send = () => {};
      transport.bufferedAmount = () => 0;
    },

    size() { return panes.size; },
    parkedSize() { return parked.size; },

    /**
     * Open a pane, or hand a parked one back. A guest attach (`mode: 'guest'`)
     * carries the share's `recipe`, the workstream's `cwd` and
     * `maxGuestPanes`; its refusals start with a code the backend maps for the
     * viewer: guest-mode, guest-unavailable, guest-stack:<reason>, guest-url,
     * guest-busy, guest-memory, guest-unsafe.
     */
    async attach(msg) {
      if (!binary) throw new Error('no Chromium on this box');
      const streamId = typeof msg.streamId === 'string' && msg.streamId ? msg.streamId : null;
      if (!streamId) throw new Error('streamId is required');
      if (panes.has(streamId)) throw new Error('stream already attached');
      const paneKey = typeof msg.paneKey === 'string' && msg.paneKey ? msg.paneKey : null;
      let url = normalizeUrl(msg.url);
      if (!url) throw new Error('url must be http or https');

      // Fail closed both ways: a guest key never opens an owner's browser,
      // and a guest attach without a guest key is refused.
      const guest = msg.mode === 'guest';
      if (guest !== isGuestKey(paneKey)) throw new Error('guest-mode: the pane mode and its key disagree');
      let guestOpts = null;
      let openedShare = false;
      if (guest) {
        if (!guestEnv.ok) throw new Error(`guest-unavailable: ${guestEnv.reason}`);
        const resolved = await resolveRecipe(msg.recipe, typeof msg.cwd === 'string' ? msg.cwd : null);
        if (!resolved.ok) throw new Error(`guest-stack:${resolved.reason}`);
        for (const d of resolved.dropped || []) log(`[BROWSER-PANE] ${paneKey}: ${d.origin} left out of the share: ${d.why}`);
        if (url === 'about:blank') url = guestMode.urlAt(resolved.primaryUrl, msg.atPath) || resolved.primaryUrl;
        const origin = guestMode.originOfUrl(url);
        if (origin !== '' && !resolved.origins.includes(origin)) throw new Error('guest-url: that address is not part of the shared preview');
        guestOpts = { origins: resolved.origins, profilesRoot: guestEnv.profilesRoot, cwd: typeof msg.cwd === 'string' ? msg.cwd : null };
      } else if (msg.openRecipe) {
        // An owner's own share link: the page on the share's app, not on
        // whatever app the dock showed last. One that doesn't resolve here
        // (the stack is down) opens as it would have.
        const resolved = await resolveRecipe(msg.openRecipe, typeof msg.cwd === 'string' ? msg.cwd : null).catch(() => null);
        if (resolved && resolved.ok) {
          url = guestMode.urlAt(resolved.primaryUrl, msg.atPath) || resolved.primaryUrl;
          openedShare = true;
        }
      }

      const keptName = index && msg.persistProfile === true && paneKey ? profileName(paneKey) : null;
      const o = { streamId, paneKey, url, guest, guestOpts, keptName, openedShare };
      return keptName ? withProfileLock(keptName, () => attachPane(msg, o)) : attachPane(msg, o);
    },

    input(msg) {
      const pane = panes.get(msg.streamId);
      if (pane) pane.input(msg.event);
    },

    navigate(msg) {
      const pane = panes.get(msg.streamId);
      if (pane) pane.navigate(msg.url);
    },

    /** The viewer answered the page's dialog: `{ streamId, id, accept, text? }`. */
    dialog(msg) {
      const pane = panes.get(msg.streamId);
      if (pane) pane.answerDialog(msg);
    },

    history(msg) {
      const pane = panes.get(msg.streamId);
      if (pane) pane.history(msg.action).catch(() => {});
    },

    resize(msg) {
      const pane = panes.get(msg.streamId);
      if (pane) pane.resize(msg.width, msg.height).catch(() => {});
    },

    frameAck(msg) {
      const pane = panes.get(msg.streamId);
      if (pane) pane.frameAck();
    },

    /** The viewer closed the pane: park the browser for a reattach. */
    close(streamId) {
      const pane = panes.get(streamId);
      if (!pane) return false;
      panes.delete(streamId);
      if (park(pane)) log(`[BROWSER-PANE] ${streamId}: parked ${pane.paneKey} for ${Math.round(parkMs / 1000)}s`);
      else log(`[BROWSER-PANE] ${streamId}: closed`);
      return true;
    },

    /** The orchestrator socket dropped: every viewer is gone for now, every browser waits. */
    parkAll() {
      for (const [streamId, pane] of panes) {
        panes.delete(streamId);
        park(pane);
      }
    },

    /** Close every browser; resolves once all have exited (the caller bounds the wait). */
    closeAll() {
      for (const [streamId, pane] of panes) {
        panes.delete(streamId);
        pane.close();
      }
      for (const key of [...parked.keys()]) unpark(key).close();
      return Promise.all([...running].map((p) => p.exited));
    },

    /** At shutdown, after closeAll had its chance: whatever still runs is killed, pipe and all. */
    killAll() {
      for (const pane of running) { try { pane.kill(); } catch { /* gone */ } }
    },

    /**
     * Forget a pane key's kept profile (a share revoked or expired, a reset):
     * its live browser is told and closed, a parked one closed, and the
     * profile deleted once nothing has it open.
     */
    async forgetProfile(msg) {
      const key = typeof msg.profileKey === 'string' && msg.profileKey ? msg.profileKey : null;
      if (!key) throw new Error('profileKey is required');
      for (const [streamId, pane] of panes) {
        if (pane.paneKey !== key) continue;
        panes.delete(streamId);
        transport.send({ type: 'browser-exit', streamId, reason: 'This browser was reset.' });
        pane.close();
      }
      const parkedPane = unpark(key);
      if (parkedPane) parkedPane.close();
      const name = profileName(key);
      const entry = index ? index.get(name) : null;
      await deleteProfile(name, (entry && entry.kind) || (isGuestKey(key) ? 'guest' : 'owner'));
      log(`[BROWSER-PANE] ${key}: profile forgotten`);
      return { ok: true };
    },

    /** A share's new expiry (an extend): its guest's kept profile is kept until then. */
    profileExpiry(msg) {
      const key = typeof msg.profileKey === 'string' ? msg.profileKey : null;
      const t = Date.parse(msg.expiresAt);
      if (!index || !key || !isGuestKey(key) || !Number.isFinite(t)) return { ok: false };
      const name = profileName(key);
      if (!index.get(name)) return { ok: true, known: false };
      index.touch(name, { key, kind: 'guest', expiresAt: t });
      return { ok: true, known: true };
    },

    /** The viewer's "Reset browser": forget the profile of the pane this stream shows. */
    async resetProfile(msg) {
      const pane = panes.get(msg.streamId);
      if (!pane || !pane.paneKey) throw new Error('no browser with a kept profile on this stream');
      return this.forgetProfile({ profileKey: pane.paneKey });
    },

    sweepProfiles,

    suggest(msg) {
      return suggestions({ cwd: typeof msg.cwd === 'string' ? msg.cwd : null });
    },

    sweepGuestProfiles,
  };
}

module.exports = {
  isProfileName,
  withTimeout,
  CAPABILITIES,
  GUEST_CAPABILITY,
  CHECKOUT_EVERY_MS,
  GUEST_DISK_CACHE_BYTES,
  PROFILES_CAPABILITY,
  PERSISTENT_KILL_GRACE_MS,
  PROFILE_WAIT_MS,
  JAR_TOTAL_MS,
  cookieJarPath,
  OWNER_PROFILE_IDLE_MS,
  LEFTOVER_DIR_MIN_AGE_MS,
  isGuestKey,
  profileName,
  isLoopbackCookieDomain,
  cookieParam,
  profileLockPid,
  ensurePrivateDir,
  ProfileIndex,
  CARET_STILL_SCRIPT,
  QUALITY_RUNGS,
  SLOW_ACK_MS,
  FAST_ACK_MS,
  ADAPT_AFTER,
  MIN_FRAME_INTERVAL_MS,
  MAX_PANES,
  PARK_MS,
  ACK_TIMEOUT_MS,
  VIEWPORT,
  ACK_HOLD_BYTES,
  findChromium,
  isSnapChromium,
  profileRoot,
  clampViewport,
  normalizeUrl,
  chromiumArgs,
  inputToCdp,
  parseListeners,
  isCandidatePort,
  devStackHost,
  rankSuggestions,
  probeHttp,
  suggestions,
  PipeFramer,
  CdpClient,
  BrowserPane,
  createManager,
};
