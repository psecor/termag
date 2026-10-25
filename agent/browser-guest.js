'use strict';
// Guest mode for the browser pane: what a reviewer's
// pane needs beyond the owner's, kept out of browser-pane.js.
//
//   * canonicalOrigin: the one rule for "which app is this", shared by the
//     grant's origins, the pane's navigate check and the proxy
//   * GuestProxy: the per-pane allowlisting HTTP/CONNECT proxy guest Chromium
//     is forced through (layer 2)
//   * resolveRecipe: a share's origins, worked out at every attach from the
//     workstream's checkout, and the check that a running dev stack is that
//     workstream's own
//   * Canary: the self-check a guest browser runs before it shows anything:
//     a page that tries to reach a TCP and a UDP canary around the proxy
//   * guestEnvironment, checkoutState, memAvailableBytes: the box facts
//
// Layer 1, the termag-guest user and its egress rule, is the box image's
// (deploy/termag-guest-browser-setup); this file only launches through it.
const { execFile, execFileSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const GUEST_USER = 'termag-guest';
const GUEST_LAUNCHER = '/usr/local/libexec/termag-guest-chromium';
// The range deploy/termag-guest-browser.nft lets termag-guest reach.
const PROXY_PORT_FIRST = 47100;
const PROXY_PORT_LAST = 47131;
const MAX_ORIGINS = 8;
// A guest browser is refused while the box has less than this to give: one
// signed-in webapp dev tab takes about 1.3 GB (measured: 5 tabs, 6.65 GB of
// MemAvailable), and 2 GiB must be left for the dev stack and the owner.
const MIN_MEM_AVAILABLE_BYTES = 3.5 * 1024 ** 3;
// The hard ceiling on guest browsers per box, whatever the flag says.
const MAX_GUEST_PANES_CEILING = 10;
const DEFAULT_MAX_GUEST_PANES = 5;
const BLOCKED_REPORT_EVERY_MS = 10_000;
// Hosts headless Chromium calls by itself, whatever the page (sign-in, push,
// update and hint services). The proxy refuses them like any other, but does
// not report them: the viewer would be told their page was refused sites it
// never asked for.
const BROWSER_SERVICE_HOST = /^(?:accounts|android\.clients|clients\d*|www)\.google\.com:443$|^(?:content-autofill|optimizationguide-pa|update|safebrowsing)\.googleapis\.com:443$|^redirector\.gvt1\.com:(?:80|443)$/;
const CANARY_TIMEOUT_MS = 4000;
const CANARY_SETTLE_MS = 1200;
// Proxy request headers that are for the proxy, not the app.
const HOP_HEADERS = ['proxy-connection', 'proxy-authorization', 'proxy-authenticate'];

/**
 * `host:port` for an origin, the form every check compares: IPv4 loopback as
 * a dotted quad, `[::1]`, and `localhost` as 127.0.0.1 (the proxy resolves it
 * itself, without DNS). The port is explicit or the scheme's default. Null for
 * anything that is not loopback, a port out of range, or garbage: an
 * IPv4-mapped address, 0.0.0.0 and :: included.
 *
 * WHATWG parsing already turns 127.1, 2130706433, 0x7f.0.0.1, 0177.0.0.1 and a
 * trailing dot into 127.0.0.1 (Chromium does the same before the proxy sees a
 * request), so they all compare equal.
 */
function canonicalOrigin(input, { requirePort = false } = {}) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 300) return null;
  let raw = s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (requirePort && !/:\d+$/.test(s)) return null;
    raw = `http://${s}`;
  }
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (url.username || url.password) return null;
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const port = url.port ? Number(url.port) : (secure ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let host = url.hostname.toLowerCase();
  if (host === 'localhost') host = '127.0.0.1';
  if (host === '[::1]') return `[::1]:${port}`;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || Number(m[1]) !== 127 || m.slice(2).some((p) => Number(p) > 255)) return null;
  return `${host}:${port}`;
}

/**
 * A share link's `at`: a path only, starting with one
 * `/` (never `//` or `/\`), with no backslash or control character, decoded
 * or not; null for anything else. The backend checks the same.
 */
function safeAtPath(at) {
  if (typeof at !== 'string' || !at || at.length > 2048) return null;
  if (!/^\/(?![/\\])/.test(at)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(at)) return null;
  let decoded;
  try { decoded = decodeURIComponent(at); } catch { return null; }
  if (/^\/[/\\]/.test(decoded)) return null;
  return at;
}

/** `at` on the share's primary URL, only while it stays on that origin; null otherwise. */
function urlAt(primaryUrl, at) {
  const path = safeAtPath(at);
  if (!path) return null;
  let url;
  try { url = new URL(path, primaryUrl); } catch { return null; }
  return canonicalOrigin(url.href) !== null && canonicalOrigin(url.href) === canonicalOrigin(primaryUrl) ? url.href : null;
}

/** The origin of a URL the pane is asked to show; `about:blank` is always allowed and answers ''. */
function originOfUrl(url) {
  if (url === 'about:blank') return '';
  return canonicalOrigin(url);
}

/** The address and port to connect to for a canonical origin. */
function addressOf(origin) {
  const at = origin.lastIndexOf(':');
  const host = origin.slice(0, at);
  return { host: host === '[::1]' ? '::1' : host, port: Number(origin.slice(at + 1)) };
}

/** The target of a CONNECT: an authority (`host:port`), never a URL. */
function connectOrigin(authority) {
  if (typeof authority !== 'string' || !/^[^/\s]+:\d+$/.test(authority)) return null;
  return canonicalOrigin(authority, { requirePort: true });
}

/** host:port of whatever a refused request named (a URL or a CONNECT authority), for a report; nothing else of it. */
function displayOrigin(what) {
  if (typeof what !== 'string' || !what || what.startsWith('/')) return 'unknown';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(what) ? what : `http://${what}`);
    const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
    return `${url.hostname}:${port}`.slice(0, 200);
  } catch { return 'unknown'; }
}

/** A lookup that never resolves: the proxy only ever connects to an IP literal it already matched. */
function noLookup(hostname, options, cb) {
  (typeof options === 'function' ? options : cb)(new Error(`no DNS from the guest proxy (${hostname})`));
}

/**
 * The per-pane allowlisting proxy. Guest
 * Chromium is started with --proxy-server pointing here and
 * --proxy-bypass-list=<-loopback>, so every request it makes, loopback
 * included, arrives as an absolute-URI request or a CONNECT. Each is matched
 * by canonical origin against the share's set, and an allowed one is
 * connected to the tuple it matched, never to what a Host header says.
 * Anything else is answered 403 and reported once in a while through
 * `onBlocked`, so the viewer can be told what isn't shared.
 */
class GuestProxy {
  constructor({ origins = [], onBlocked = () => {}, log = () => {} } = {}) {
    this.origins = new Set();
    // What each allowed origin connects to, made here from the share's own
    // list: a request picks an entry by its canonical origin, and the
    // address dialed is always the entry's, never anything the request said.
    this.targets = new Map();
    for (const o of origins) this.allow(o);
    this.onBlocked = onBlocked;
    this.log = log;
    this.denials = new Map();
    this.lastReported = new Map();
    this.sockets = new Set();
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on('connect', (req, socket, head) => this.handleConnect(req, socket, head));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* gone */ } });
    this.port = null;
  }

  allow(origin) {
    const canon = canonicalOrigin(origin, { requirePort: true });
    if (canon === null) return;
    this.origins.add(canon);
    this.targets.set(canon, Object.freeze(addressOf(canon)));
  }
  disallow(origin) { this.origins.delete(origin); this.targets.delete(origin); }
  allows(origin) { return origin !== null && this.targets.has(origin); }
  /** The allowlist's own address for an allowed origin, or null. */
  upstreamFor(origin) { return origin === null ? null : this.targets.get(origin) || null; }

  /** Listen on the first free port of the range the egress rule allows; the port, or an error when the range is full. */
  async listen(first = PROXY_PORT_FIRST, last = PROXY_PORT_LAST) {
    for (let port = first; port <= last; port += 1) {
      const ok = await new Promise((resolve) => {
        const onError = (err) => { this.server.off('listening', onListening); resolve(err.code === 'EADDRINUSE' ? false : err); };
        const onListening = () => { this.server.off('error', onError); resolve(true); };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen(port, '127.0.0.1');
      });
      if (ok === true) { this.port = port; return port; }
      if (ok !== false) throw ok;
    }
    throw new Error(`no free guest proxy port in ${first}-${last}`);
  }

  /**
   * Count a refusal and report it now and then: `onBlocked({ origin, local })`.
   * `origin` is host:port only, never a path or query; `local` says whether it
   * is a loopback address the owner could add to the share (an external one,
   * an app's telemetry or a CDN, never can be).
   */
  deny(origin, what) {
    const key = origin || displayOrigin(what);
    this.denials.set(key, (this.denials.get(key) || 0) + 1);
    if (origin === null && BROWSER_SERVICE_HOST.test(key)) return;
    const now = Date.now();
    if (now - (this.lastReported.get(key) || 0) < BLOCKED_REPORT_EVERY_MS) return;
    this.lastReported.set(key, now);
    try { this.onBlocked({ origin: key, local: origin !== null }); } catch { /* the pane's problem */ }
  }

  handleRequest(req, res) {
    const origin = canonicalOrigin(req.url);
    // Origin-form requests ("GET /x") are not proxy requests: nothing to match.
    if (!/^[a-z]+:\/\//i.test(req.url || '') || !this.allows(origin)) {
      this.deny(origin, req.url || '');
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      res.end('This address is not part of the shared preview.\n');
      return;
    }
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    const { host, port } = this.upstreamFor(origin);
    const headers = { ...req.headers };
    for (const h of HOP_HEADERS) delete headers[h];
    const upstream = http.request({ host, port, method: req.method, path: `${target.pathname}${target.search}`, headers, lookup: noLookup }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Nothing is answering at this address.\n');
    });
    req.pipe(upstream);
  }

  handleConnect(req, socket, head) {
    socket.on('error', () => {});
    const origin = connectOrigin(req.url);
    if (!this.allows(origin)) {
      this.deny(origin, req.url || '');
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const { host, port } = this.upstreamFor(origin);
    const upstream = net.connect({ host, port, lookup: noLookup }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => { socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
    socket.on('close', () => upstream.destroy());
  }

  /** A websocket asked for as an absolute-URI upgrade (Chromium tunnels ws:// with CONNECT; this covers anything else). */
  handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const origin = canonicalOrigin(req.url);
    if (!/^[a-z]+:\/\//i.test(req.url || '') || !this.allows(origin)) {
      this.deny(origin, req.url || '');
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = new URL(req.url);
    const { host, port } = this.upstreamFor(origin);
    const upstream = net.connect({ host, port, lookup: noLookup }, () => {
      const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!HOP_HEADERS.includes(req.rawHeaders[i].toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    try { this.server.close(); } catch { /* not listening */ }
  }
}

// ── Recipes ─────────────────────────────────────────────────────────────────

/**
 * The few dev-stack settings a recipe needs, read from the workstream's
 * dev-stack/.env.override. Only these keys are kept: the file also holds
 * credentials (an API key), which never leave this function.
 */
function readDevStackOverride(cwd, readFileSync = fs.readFileSync) {
  let text;
  try { text = readFileSync(path.join(cwd, 'dev-stack', '.env.override'), 'utf8'); } catch { return null; }
  const wanted = new Set(['DEV_INSTANCE', 'DEV_VARNISH_PORT', 'DEV_WEBAPP_DEVSERVER_PORT']);
  const out = {};
  // One fixed pattern per line, the first value of a key winning, as a
  // multiline match for each key would have it.
  for (const line of text.slice(0, 64 * 1024).split('\n')) {
    const m = /^([A-Z_]{1,64})=(\d{1,10})\s*$/.exec(line);
    if (m && wanted.has(m[1]) && !(m[1] in out)) out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * A webapp dev-stack slot's origins (webapp dev-stack.mk and
 * dev-stack/docker-compose.yml): slot N (2..8) binds 127.0.0.N, its asset
 * server on 3002 + 10·(N−1); the default slot sets nothing and webapp names
 * it localhost. The front door is DEV_VARNISH_PORT or 80, the dogfood dev
 * server 8765 on every slot.
 */
function webappSlotOrigins(override) {
  const n = override && Number.isInteger(override.DEV_INSTANCE) ? override.DEV_INSTANCE : null;
  if (n !== null && (n < 2 || n > 8)) return null;
  const ip = n === null ? '127.0.0.1' : `127.0.0.${n}`;
  const front = override && override.DEV_VARNISH_PORT ? override.DEV_VARNISH_PORT : 80;
  const devserver = override && override.DEV_WEBAPP_DEVSERVER_PORT ? override.DEV_WEBAPP_DEVSERVER_PORT : 3002 + 10 * ((n || 1) - 1);
  return {
    ip,
    frontPort: front,
    origins: [`${ip}:${front}`, `${ip}:${devserver}`, `${ip}:8765`],
    // What the pane opens: the name webapp builds its own links with.
    primaryUrl: n === null ? `http://localhost${front === 80 ? '' : `:${front}`}/` : `http://${ip}${front === 80 ? '' : `:${front}`}/`,
  };
}

/** An absolute path already in normal form: no `.` or `..` segment, no doubled slash, no NUL. */
function isPlainAbsolutePath(p) {
  return typeof p === 'string' && p.length > 1 && p.length <= 4096 && !p.includes('\0') && path.isAbsolute(p) && path.normalize(p) === p;
}

/** GET a Docker Engine API path over the unix socket: the parsed JSON, or null when Docker can't be asked. */
function dockerGet(apiPath, socketPath = '/var/run/docker.sock', timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ socketPath, path: apiPath, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4 * 1024 * 1024) body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * The container that publishes ip:port, as `{ workingDir, boundIp }`: its
 * `com.docker.compose.project.working_dir` label ('' without one) and the
 * address the publish is bound to, `ip` itself or 0.0.0.0. `{ workingDir: '',
 * boundIp: null }` when no container publishes it, null when Docker can't be
 * asked.
 */
async function dockerPublisher(ip, port, get = dockerGet) {
  const filters = encodeURIComponent(JSON.stringify({ publish: [String(port)] }));
  const list = await get(`/containers/json?filters=${filters}`);
  if (!Array.isArray(list)) return null;
  for (const c of list) {
    const ports = Array.isArray(c.Ports) ? c.Ports : [];
    const match = ports.find((p) => p && p.PublicPort === port && (p.IP === ip || p.IP === '0.0.0.0'));
    if (match) return { workingDir: (c.Labels && c.Labels['com.docker.compose.project.working_dir']) || '', boundIp: match.IP };
  }
  return { workingDir: '', boundIp: null };
}

/** dockerPublisher's working dir alone: '' when no container publishes ip:port, null when Docker can't be asked. */
async function publisherWorkingDir(ip, port, get = dockerGet) {
  const pub = await dockerPublisher(ip, port, get);
  return pub === null ? null : pub.workingDir;
}

function sameDir(a, b, realpathSync = fs.realpathSync) {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** `/proc/net/tcp{,6}`'s hex address as a dotted IPv4 (an IPv4-mapped IPv6 one too), `::` for the IPv6 wildcard, or null. */
function procAddress(hex) {
  if (hex.length === 8) return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.');
  if (hex.length !== 32) return null;
  if (/^0{32}$/.test(hex)) return '::';
  // Four little-endian 32-bit words: ::ffff:a.b.c.d is 0000…0000, FFFF0000, then the IPv4 word.
  if (hex.slice(0, 16) === '0'.repeat(16) && hex.slice(16, 24).toUpperCase() === 'FFFF0000') return procAddress(hex.slice(24));
  return 'other-v6';
}

/**
 * Who would take a connection to `ip:port`, from the kernel's own tables, as
 * `{ pid, cwd }` per TCP listening socket (both null where it belongs to a
 * process this user can't see: another user's, root's, Docker's proxy among
 * them). The kernel hands an IPv4 connection to the most specific listener:
 * one bound to `ip` itself, else one on 0.0.0.0, else a dual-stack `::`. So
 * only the most specific kind present is returned: an unrelated wildcard
 * beside this address's own listener never counts. (A `::` socket may be
 * IPv6-only, which the tables don't show; alone, it is counted, which leaves
 * an origin out rather than in.) `exactOnly`: the ones bound to `ip` itself,
 * which take its connections even beside a wildcard publish. Linux only; an
 * empty list where nothing listens.
 */
function listenersOn(ip, port, io = {}, { exactOnly = false } = {}) {
  const read = io.readFileSync || fs.readFileSync;
  const readdir = io.readdirSync || fs.readdirSync;
  const readlink = io.readlinkSync || fs.readlinkSync;
  // Listening sockets by how specifically they're bound: 0 this address, 1 0.0.0.0, 2 ::.
  const byRank = [new Set(), new Set(), new Set()];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = read(table, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== '0A') continue; // 0A: LISTEN
      const [addrHex, portHex] = f[1].split(':');
      if (parseInt(portHex, 16) !== port) continue;
      const addr = procAddress(addrHex);
      const rank = addr === ip ? 0 : addr === '0.0.0.0' ? 1 : addr === '::' ? 2 : -1;
      if (rank >= 0) byRank[rank].add(f[9]);
    }
  }
  const inodes = exactOnly ? byRank[0] : byRank.find((set) => set.size > 0) || new Set();
  if (inodes.size === 0) return [];
  const owners = new Map();
  let pids = [];
  try { pids = readdir('/proc').filter((n) => /^\d+$/.test(n)); } catch { /* no /proc: owners stay unknown */ }
  for (const pid of pids) {
    let fds;
    try { fds = readdir(`/proc/${pid}/fd`); } catch { continue; } // not ours to look at
    for (const fd of fds) {
      let link;
      try { link = readlink(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1]) && !owners.has(m[1])) {
        let cwd = null;
        try { cwd = readlink(`/proc/${pid}/cwd`); } catch { /* gone */ }
        owners.set(m[1], { pid: Number(pid), cwd });
      }
    }
    if (owners.size === inodes.size) break;
  }
  return [...inodes].map((inode) => owners.get(inode) || { pid: null, cwd: null });
}

/** Whether `child` is `dir` or inside it (both resolved, so a symlinked checkout still matches). */
function insideDir(child, dir, realpathSync = fs.realpathSync) {
  try {
    const rel = path.relative(realpathSync(dir), realpathSync(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch { return false; }
}

/**
 * Why ip:port's connections would not reach `pub`, the checkout's own Docker
 * publish, or null when they would. A publish on 0.0.0.0 loses them to a
 * socket bound to the address itself (Linux allows that bind beside docker's
 * when the uids match, so under rootless Docker, or for a root process), so
 * every such socket must be a process of this user inside the checkout.
 */
function shadowOf(ip, port, pub, cwd, listeners, inside) {
  if (pub.boundIp === ip) return null;
  const theirs = listeners(ip, port, undefined, { exactOnly: true }).find((l) => !l.cwd || !inside(l.cwd, cwd));
  if (!theirs) return null;
  return theirs.pid === null ? `a listener on ${ip} that is not this user's takes it` : `pid ${theirs.pid}, outside the checkout, listens on ${ip}`;
}

/**
 * Of a slot's origins, the ones this workstream's checkout actually serves.
 * The front door is checked already; for each other one, whoever publishes or
 * listens on it must be this checkout's: a Docker publisher whose compose
 * working dir is its dev-stack (with no socket bound to the address itself
 * taking its connections, shadowOf), or a process of this user running inside
 * it (webapp's dev server listens on every address, `*:30N2`, so another
 * workstream's stray process on this slot's port would otherwise be reached).
 * An origin whose listener is someone else's, or can't be told, is dropped;
 * one nothing listens on yet is kept (there is nothing to reach).
 * `{ origins, dropped: [{ origin, why }] }`.
 */
async function ownedOrigins(slot, cwd, deps = {}) {
  const publisher = deps.dockerPublisher || dockerPublisher;
  const same = deps.sameDir || sameDir;
  const listeners = deps.listenersOn || listenersOn;
  const inside = deps.insideDir || insideDir;
  const origins = [];
  const dropped = [];
  for (const origin of slot.origins) {
    const { host, port } = addressOf(origin);
    if (port === slot.frontPort) { origins.push(origin); continue; }
    const pub = await publisher(host, port);
    if (pub && pub.workingDir) {
      const why = !same(pub.workingDir, path.join(cwd, 'dev-stack'))
        ? 'published by another checkout'
        : shadowOf(host, port, pub, cwd, listeners, inside);
      if (why) dropped.push({ origin, why });
      else origins.push(origin);
      continue;
    }
    const found = listeners(host, port);
    if (found.length === 0) { origins.push(origin); continue; }
    const theirs = found.find((l) => !l.cwd || !inside(l.cwd, cwd));
    if (theirs) dropped.push({ origin, why: theirs.pid === null ? 'its listener is not this user\'s' : `pid ${theirs.pid} runs outside the checkout` });
    else origins.push(origin);
  }
  return { origins, dropped };
}

/**
 * A share's origins for this attach: `{ ok: true, origins, primaryUrl }`, or
 * `{ ok: false, reason }` with reason one of no-checkout, not-a-dev-stack,
 * stack-not-running, other-workstream, unverifiable, no-origins, bad-recipe.
 *
 *   { kind: 'manual', origins: [...] }      literal loopback origins, checked
 *   { kind: 'webapp-dev-stack' }          the workstream's own slot, and only
 *                                           while its own stack serves it; of
 *                                           its other ports, only the ones this
 *                                           checkout serves (ownedOrigins)
 */
async function resolveRecipe(recipe, cwd, deps = {}) {
  const read = deps.readFileSync || fs.readFileSync;
  const publisher = deps.dockerPublisher || dockerPublisher;
  const same = deps.sameDir || sameDir;
  if (!recipe || typeof recipe !== 'object') return { ok: false, reason: 'bad-recipe' };
  if (recipe.kind === 'manual') {
    const list = Array.isArray(recipe.origins) ? recipe.origins : [];
    const origins = [];
    let firstScheme = 'http';
    for (const input of list) {
      const origin = canonicalOrigin(input, { requirePort: true });
      if (!origin || origins.includes(origin) || origins.length >= MAX_ORIGINS) continue;
      // The pane opens the first origin with the scheme it was given: an
      // HTTPS-only app named as https:// must not be opened over HTTP.
      if (origins.length === 0 && /^(https|wss):\/\//i.test(String(input).trim())) firstScheme = 'https';
      origins.push(origin);
    }
    if (origins.length === 0) return { ok: false, reason: 'no-origins' };
    const { host, port } = addressOf(origins[0]);
    const defaultPort = firstScheme === 'https' ? 443 : 80;
    return { ok: true, origins, primaryUrl: `${firstScheme}://${host.includes(':') ? `[${host}]` : host}${port === defaultPort ? '' : `:${port}`}/` };
  }
  if (recipe.kind !== 'webapp-dev-stack') return { ok: false, reason: 'bad-recipe' };
  // The backend sends the checkout as an absolute, normalized path
  // (projectDirUnder); anything else (relative, `..`, a NUL) is no checkout.
  if (!isPlainAbsolutePath(cwd)) return { ok: false, reason: 'no-checkout' };
  try { if (!fs.statSync(path.join(cwd, 'dev-stack')).isDirectory()) return { ok: false, reason: 'not-a-dev-stack' }; } catch {
    if (!deps.skipDirCheck) return { ok: false, reason: 'not-a-dev-stack' };
  }
  const slot = webappSlotOrigins(readDevStackOverride(cwd, read) || {});
  if (!slot) return { ok: false, reason: 'not-a-dev-stack' };
  const front = await publisher(slot.ip, slot.frontPort);
  if (front === null) return { ok: false, reason: 'unverifiable' };
  if (front.workingDir === '') return { ok: false, reason: 'stack-not-running' };
  if (!same(front.workingDir, path.join(cwd, 'dev-stack'))) return { ok: false, reason: 'other-workstream' };
  if (shadowOf(slot.ip, slot.frontPort, front, cwd, deps.listenersOn || listenersOn, deps.insideDir || insideDir)) return { ok: false, reason: 'other-workstream' };
  const owned = await ownedOrigins(slot, cwd, deps);
  return { ok: true, origins: owned.origins, primaryUrl: slot.primaryUrl, ...(owned.dropped.length ? { dropped: owned.dropped } : {}) };
}

// ── The canary ──────────────────────────────────────────────────────────────

/**
 * The page a guest browser opens first. It tries what a page could do to get
 * around the proxy: a fetch to a TCP port the proxy does not allow, and WebRTC
 * to a UDP port (a STUN server and a remote host candidate), then reports.
 * Served by the agent itself on loopback; allowed through the proxy only for
 * the check.
 */
function canaryHtml(tcpPort, udpPort) {
  return `<!doctype html><title>termag canary</title><script>
(async () => {
  const done = (r) => fetch('/done', { method: 'POST', body: r }).catch(() => {});
  try { await fetch('http://127.0.0.1:${tcpPort}/', { mode: 'no-cors' }); } catch (e) {}
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
    pc.createDataChannel('c');
    await pc.setLocalDescription(await pc.createOffer());
    await pc.setRemoteDescription({ type: 'answer', sdp: pc.localDescription.sdp.replace(/a=setup:actpass/g, 'a=setup:active') }).catch(() => {});
    await pc.addIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host', sdpMid: '0', sdpMLineIndex: 0 }).catch(() => {});
  } catch (e) {}
  setTimeout(() => done('ran'), ${CANARY_SETTLE_MS});
})();
</script>`;
}

/**
 * The canary's three listeners on loopback: the page, a TCP canary and a UDP
 * canary. `passed()` holds only when the page ran, neither canary was reached,
 * and the proxy itself saw and refused the TCP attempt (so it did not just
 * fail to happen).
 */
class Canary {
  constructor() {
    this.tcpHits = 0;
    this.udpHits = 0;
    this.ran = false;
    this.servers = [];
  }

  async start() {
    // Each listener is registered for close() as soon as it exists, so a
    // start that fails half way leaves nothing bound.
    const listen = (server, ...args) => new Promise((resolve, reject) => {
      this.servers.push(server);
      server.once('error', reject);
      server.listen(...args, () => resolve(server.address().port));
    });
    this.tcp = net.createServer((s) => { this.tcpHits += 1; s.destroy(); });
    this.tcpPort = await listen(this.tcp, 0, '127.0.0.1');
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', () => { this.udpHits += 1; });
    this.udpPort = await new Promise((resolve, reject) => {
      this.udp.once('error', reject);
      this.udp.bind(0, '127.0.0.1', () => resolve(this.udp.address().port));
    });
    let notify;
    this.ranPromise = new Promise((resolve) => { notify = resolve; });
    this.page = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/done') {
        this.ran = true;
        res.end('ok');
        notify();
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(canaryHtml(this.tcpPort, this.udpPort));
    });
    this.pagePort = await listen(this.page, 0, '127.0.0.1');
    return { url: `http://127.0.0.1:${this.pagePort}/`, origin: `127.0.0.1:${this.pagePort}`, tcpOrigin: `127.0.0.1:${this.tcpPort}` };
  }

  /** Resolves once the page reported, or after the timeout (a page that never ran fails the check). */
  wait(timeoutMs = CANARY_TIMEOUT_MS) {
    return Promise.race([this.ranPromise, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  passed(proxy) {
    return this.ran && this.tcpHits === 0 && this.udpHits === 0 && (proxy.denials.get(`127.0.0.1:${this.tcpPort}`) || 0) > 0;
  }

  close() {
    for (const s of this.servers) { try { s.close(); } catch { /* closed */ } }
    this.servers = [];
    if (this.udp) { try { this.udp.close(); } catch { /* closed */ } }
  }
}

// ── Box facts ───────────────────────────────────────────────────────────────

/**
 * Whether this box can run guest browsers: the launcher installed and the
 * agent user allowed to run it as termag-guest without a password. Asked once
 * at agent start; `{ ok, home, profilesRoot }` or `{ ok: false, reason }`.
 */
function guestEnvironment({ existsSync = fs.existsSync, run = execFileSync } = {}) {
  if (!existsSync(GUEST_LAUNCHER)) return { ok: false, reason: 'no launcher' };
  let home;
  try {
    home = run('getent', ['passwd', GUEST_USER], { encoding: 'utf8', timeout: 3000 }).split(':')[5];
  } catch { return { ok: false, reason: `no ${GUEST_USER} user` }; }
  if (!home) return { ok: false, reason: `no home for ${GUEST_USER}` };
  try {
    run('sudo', ['-n', '-u', GUEST_USER, GUEST_LAUNCHER, '--termag-list'], { stdio: 'ignore', timeout: 10_000 });
  } catch { return { ok: false, reason: `sudo -n -u ${GUEST_USER} refused` }; }
  return { ok: true, home, profilesRoot: path.join(home, 'snap', 'chromium', 'common', 'termag-browser-pane', 'profiles') };
}

/** Run the launcher as termag-guest for one of its maintenance modes; resolves its stdout, rejects on failure. */
function runLauncher(args, run = execFile) {
  return new Promise((resolve, reject) => {
    run('sudo', ['-n', '-u', GUEST_USER, GUEST_LAUNCHER, ...args], { encoding: 'utf8', timeout: 30_000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout || '');
    });
  });
}

/** MemAvailable from /proc/meminfo, in bytes; null when unreadable. */
function memAvailableBytes(readFileSync = fs.readFileSync) {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch { return null; }
}

/**
 * The workstream checkout as the guest's header shows it: `{ branch, head,
 * dirty }`, dirty being the count of changed paths. Null outside a checkout.
 * HMR pushes uncommitted edits straight into a guest's tab, so this says so.
 */
function checkoutState(cwd, run = execFile) {
  const git = (...args) => new Promise((resolve) => {
    run('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
  });
  if (typeof cwd !== 'string' || !cwd) return Promise.resolve(null);
  return Promise.all([git('rev-parse', '--abbrev-ref', 'HEAD'), git('rev-parse', 'HEAD'), git('status', '--porcelain')]).then(([branch, head, status]) => {
    if (head === null) return null;
    return {
      branch: (branch || '').trim(),
      head: head.trim(),
      dirty: status === null ? null : status.split('\n').filter(Boolean).length,
    };
  });
}

module.exports = {
  GUEST_USER,
  GUEST_LAUNCHER,
  PROXY_PORT_FIRST,
  PROXY_PORT_LAST,
  MAX_ORIGINS,
  MIN_MEM_AVAILABLE_BYTES,
  MAX_GUEST_PANES_CEILING,
  DEFAULT_MAX_GUEST_PANES,
  canonicalOrigin,
  originOfUrl,
  displayOrigin,
  safeAtPath,
  urlAt,
  connectOrigin,
  GuestProxy,
  readDevStackOverride,
  webappSlotOrigins,
  dockerPublisher,
  publisherWorkingDir,
  procAddress,
  listenersOn,
  insideDir,
  ownedOrigins,
  resolveRecipe,
  canaryHtml,
  Canary,
  guestEnvironment,
  runLauncher,
  memAvailableBytes,
  checkoutState,
};
