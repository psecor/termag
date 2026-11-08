'use strict';
// The port forward's box-side check (the native-forward contract, section 5):
// before the agent connects a forwarded TCP stream to a box port, it decides
// from the kernel's tables and Docker whether that port is the user's own.
//
// A connection to P is allowed only when what takes a connection to
// 127.0.0.1:P (or ::1:P) is:
//
//   * a socket of the agent's own uid on loopback (127.0.0.1, ::1), or
//   * a socket of the agent's own uid on a wildcard (0.0.0.0, ::): webapp's
//     Rspack binds `*:3002`, and its backend every interface on Linux, or
//   * a Docker publish (rootful Docker's docker-proxy: a root socket) of a
//     container whose compose working dir is inside the agent user's home:
//     webapp's varnish front door, its flag dev-server on 8765, its
//     databases. The same rule browser-guest.js applies to a dev stack.
//
// Everything else is refused with a reason: another uid's socket, a root one
// that no allowed container publishes, a listener only on another address
// (127.0.0.N for N ≥ 2 included, which v1 doesn't forward). Nothing listening
// at all is `port_closed`.
//
// "What takes the connection" is the kernel's rule (local-listeners.js
// takersOf): a socket bound to the address itself beats a wildcard one, so a
// 127.0.0.1 socket of someone else's beside a wildcard Docker publish is what
// gets the stream, and decides. Every socket of the winning kind must pass:
// the kernel may hand a stream to any of a SO_REUSEPORT group.
//
// Docker with `userland-proxy: false` publishes through DNAT alone, with no
// LISTEN row. So when nothing listens, Docker is asked too: a 127.0.0.1 or
// 0.0.0.0 publish of an allowed container is allowed (the dial reaches it
// only where the kernel's route_localnet lets DNAT rewrite loopback, which
// that setting turns on; else the connect fails and the caller answers
// port_closed), one of any other container refused. No row there can
// shadow a DNAT publish: the rewrite happens before any socket is looked up.
//
// Allowed and refused verdicts are cached per port for PORT_CHECK_TTL_MS:
// the check reads /proc and may ask Docker, and a browser opens many
// connections at once. port_closed never is: a server may be starting, and
// must be seen the moment it listens. (The caller clears a port's entry when
// a connect fails after an allowed verdict.)
//
// Preview links go further: checkPreviewPort
// is checkPort plus SR6. A debugger, shell or notebook is code execution on
// the box for whoever reaches it, and the relay's `Host: localhost:<port>`
// passes the Node inspector's and Chrome's DNS-rebinding check. So a listener
// is refused for a preview when the process holding it was started with one
// of SHELL_COMMANDS' marks on its command line (`--inspect`,
// `--remote-debugging-port`, jupyter, code-server, ttyd, debugpy, rdbg), or
// when it answers `GET /json/version` as the DevTools protocol does (a
// `webSocketDebuggerUrl`, `V8-Version` or `Protocol-Version`; Node 24's
// inspector answers only the last): the inspector however it was opened
// (NODE_OPTIONS, `inspector.open()`). The probe runs at publish and at every
// tunnel open; the publish dialog's list (checkPreviewListener) goes by the
// command line alone. Verdicts are cached as the guard's are. A tool missing from the list is SR6's residual: add it here.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { dockerGet, dockerBindings, dockerPublishers, listenRows, takersOf, insideDir, socketOwners } = require('./local-listeners');

const PORT_CHECK_TTL_MS = 5000;
// ::1 as /proc/net/tcp6 shows it (four little-endian words); procAddress
// reads it as 'other-v6'.
const LOOPBACK6_HEX = '00000000000000000000000001000000';
const DOCKER_SOCKET = '/var/run/docker.sock';

const defaultCache = new Map();
const defaultPreviewCache = new Map();
// The DevTools probe: a GET to the listener itself, bounded in time and size.
const PROBE_TIMEOUT_MS = 1000;
const PROBE_MAX_BYTES = 64 * 1024;

function addrOf(row) {
  return row.hex === LOOPBACK6_HEX ? '::1' : row.addr;
}

function shown(addr) {
  return addr === 'other-v6' ? 'a non-loopback IPv6 address' : addr && addr.includes(':') ? `[${addr}]` : String(addr);
}

const refuse = (reason) => ({ ok: false, code: 'port_refused', reason });

/**
 * Why Docker's publish of `port` on `ip` is not this user's, or null when it
 * is: every container publishing it there must have a compose working dir
 * inside `home`. `bindings` is dockerBindings' answer (null: Docker couldn't
 * be asked).
 */
function dockerRefusal(bindings, ip, port, d) {
  if (bindings === null) return `a root listener holds ${shown(ip)}:${port}, and Docker can't be asked whether it publishes it`;
  const here = bindings.filter((b) => b.ip === ip);
  if (here.length === 0) return `a root listener on ${shown(ip)}:${port} is not a Docker publish`;
  if (here.some((b) => !b.workingDir)) return `the container publishing ${shown(ip)}:${port} is not a compose project`;
  if (here.some((b) => !d.home || !insideDir(b.workingDir, d.home, d.realpathSync))) return `the container publishing ${shown(ip)}:${port} is from a compose project outside this user's home`;
  return null;
}

/**
 * Whether this host has the kernel tables the guard reads: `<procRoot>/net/tcp`
 * or `tcp6` readable (Linux). Without them (a self-managed macOS agent, say)
 * every port would look closed, and a Docker publish could not be checked for
 * a listener shadowing it, so the forward is not offered at all.
 */
function canCheckPorts({ procRoot = '/proc', accessSync = fs.accessSync } = {}) {
  return ['tcp', 'tcp6'].some((t) => {
    try { accessSync(`${procRoot}/net/${t}`, fs.constants.R_OK); return true; } catch { return false; }
  });
}

/**
 * Which of a port's LISTEN rows take the agent's connection, and the address
 * it dials. An IPv4 dial reaches a 127.0.0.1 socket, else a 0.0.0.0 one.
 * With neither, dial ::1: a lone `::` may be IPv6-only (the tables don't
 * say), and ::1 reaches it either way.
 */
function takersFor(rows) {
  const v4 = takersOf(rows.filter((r) => addrOf(r) !== '::'), '127.0.0.1', addrOf);
  const dialHost = v4.length > 0 ? '127.0.0.1' : '::1';
  return { dialHost, takers: v4.length > 0 ? v4 : takersOf(rows, '::1', addrOf) };
}

/** A port's LISTEN rows: from `d.allRows` (every row, read once by a caller checking many ports), else the kernel tables. */
function rowsFor(port, d) {
  return d.allRows ? d.allRows.filter((r) => r.port === port) : listenRows(port, d.readFileSync, d.procRoot);
}

async function verdict(port, d) {
  if (!canCheckPorts(d)) return refuse(`this host has no ${d.procRoot}/net/tcp to tell who listens on port ${port}`);
  const rows = rowsFor(port, d);
  const docker = (() => {
    let answer;
    return () => (answer ||= dockerBindings(port, (p) => d.dockerGet(p, d.dockerSocket)));
  })();

  const { dialHost, takers } = takersFor(rows);

  if (takers.length === 0) {
    const bindings = (await docker()) || [];
    const published = ['127.0.0.1', '0.0.0.0'].filter((ip) => bindings.some((b) => b.ip === ip));
    if (published.length > 0) {
      const why = published.map((ip) => dockerRefusal(bindings, ip, port, d)).find(Boolean);
      return why ? refuse(why) : { ok: true, dialHost: '127.0.0.1' };
    }
    if (rows.length === 0) return { ok: false, code: 'port_closed', reason: `nothing listens on port ${port}` };
    const where = [...new Set(rows.map((r) => shown(addrOf(r))))].join(', ');
    return refuse(`port ${port} listens only on ${where}; only 127.0.0.1, ::1 and the wildcards are forwarded`);
  }

  for (const row of takers) {
    const ip = addrOf(row);
    if (row.uid === d.uid) continue;
    if (row.uid === 0) {
      const why = dockerRefusal(await docker(), ip, port, d);
      if (why) return refuse(why);
      continue;
    }
    return refuse(`the listener on ${shown(ip)}:${port} belongs to uid ${row.uid}, not this user`);
  }
  return { ok: true, dialHost };
}

/**
 * Whether the agent may forward a connection to box port `port`:
 * `{ ok: true, dialHost: '127.0.0.1' | '::1' }`, the address to connect to,
 * or `{ ok: false, code: 'port_refused' | 'port_closed', reason }`. Allowed and
 * refused verdicts are cached per port for PORT_CHECK_TTL_MS, port_closed
 * never (concurrent checks share one look either way).
 *
 * `deps` (all optional, for tests): procRoot ('/proc'), uid
 * (process.getuid()), home (os.homedir()), dockerSocket
 * ('/var/run/docker.sock'), now (Date.now), cache (a Map; the module's own by
 * default), readFileSync, realpathSync, dockerGet.
 */
function checkPort(port, deps = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(refuse('not a TCP port'));
  const d = {
    procRoot: '/proc',
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    home: os.homedir(),
    dockerSocket: DOCKER_SOCKET,
    now: Date.now,
    cache: defaultCache,
    readFileSync: fs.readFileSync,
    accessSync: fs.accessSync,
    realpathSync: fs.realpathSync,
    dockerGet,
    ...deps,
  };
  const at = d.now();
  const hit = d.cache.get(port);
  if (hit && at - hit.at < PORT_CHECK_TTL_MS && at >= hit.at) return hit.answer;
  const entry = { at };
  // Concurrent checks still share one look; a port_closed answer leaves the
  // cache as soon as it is known.
  entry.answer = verdict(port, d)
    .catch((err) => refuse(`the port check failed: ${err && err.message}`))
    .then((v) => {
      if (v.code === 'port_closed' && d.cache.get(port) === entry) d.cache.delete(port);
      return v;
    });
  d.cache.set(port, entry);
  return entry.answer;
}

/**
 * Forget the cached verdict for `port`, or every port's without one (`cache`:
 * as checkPort's deps), and the preview verdict with it (`previewCache`: as
 * checkPreviewPort's).
 */
function clearPortCache(port, cache = defaultCache, previewCache = defaultPreviewCache) {
  for (const c of [cache, previewCache, defaultListenerCache]) {
    if (port === undefined) c.clear();
    else c.delete(port);
  }
}

// ── Preview links: debuggers, shells and notebooks (SR6) ─────────────────

/**
 * What marks a process as a debugger, shell or notebook from its command
 * line: `arg` tests every argument, `base` every argument's basename.
 */
const SHELL_COMMANDS = [
  // --inspect-port and --inspect-publish-uid only configure an inspector that
  // isn't open (node --test passes both to every test process).
  { what: 'the Node inspector (--inspect)', arg: /^--inspect(-brk|-wait)?(=|$)/ },
  { what: 'a browser debugging port (--remote-debugging-port)', arg: /^--remote-debugging-port(=|$)/ },
  { what: 'Jupyter', base: /^(jupyter(-[a-z]+)?|jupyterlab|jupyter_server|ipykernel_launcher)(\.py)?$/ },
  // JupyterHub and its single-user server; the classic notebook as a module
  // (`python -m notebook`, or its __main__.py), not every argv naming "notebook".
  { what: 'JupyterHub', base: /^jupyterhub(-singleuser)?(\.py)?$/, module: /^jupyterhub(\.singleuser)?$/ },
  { what: 'Jupyter', module: /^(notebook|jupyterlab|jupyter_server|nbclassic)$/, arg: /(^|\/)notebook\/__main__\.py$/ },
  // An install, by its own entry points under its directory (`code-server`,
  // `.code-server`, or a release extract such as
  // `code-server-4.20.0-linux-amd64`, whose bundled node runs the server):
  // never any path that merely passes through such a directory, so a dev
  // server in a project named `code-server-2` isn't refused.
  { what: 'code-server', base: /^code-server$/, arg: /(^|\/)\.?code-server(-v?\d[^/]*)?\/(lib\/node|out\/node\/entry\.js|bin\/code-server)$|^\/.*\/code-server$/ },
  // Gitpod's openvscode-server, the same way: `.openvscode-server/node`,
  // `openvscode-server-v1.86.0-linux-x64/out/server-main.js`.
  { what: 'openvscode-server', base: /^openvscode-server$/, arg: /(^|\/)\.?openvscode-server(-v?\d[^/]*)?\/(node|out\/server-main\.js|bin\/openvscode-server)$/ },
  { what: 'ttyd', base: /^ttyd$/ },
  { what: 'debugpy', base: /^debugpy$/, arg: /(^|\/)debugpy(\/|$)/ },
  { what: 'rdbg', base: /^rdbg$/ },
];

/** Which shell or debugger an argv is, or null. */
function shellCommand(argv) {
  if (!Array.isArray(argv)) return null;
  for (const rule of SHELL_COMMANDS) {
    for (const [i, a] of argv.entries()) {
      if (typeof a !== 'string') continue;
      if (rule.arg && rule.arg.test(a)) return rule.what;
      if (rule.base && rule.base.test(path.basename(a))) return rule.what;
      // `-m <module>` (python's), or `-m<module>` in one argument.
      if (rule.module && ((argv[i - 1] === '-m' && rule.module.test(a)) || (/^-m./.test(a) && rule.module.test(a.slice(2))))) return rule.what;
    }
  }
  return null;
}

/** A process's argv from `<procRoot>/<pid>/cmdline`, or null where it can't be read. */
function readArgv(pid, d) {
  try {
    const raw = d.readFileSync(`${d.procRoot}/${pid}/cmdline`, 'utf8');
    return raw.split('\0').filter((a, i, all) => a !== '' || i < all.length - 1);
  } catch { return null; }
}

/**
 * Whether the listener on host:port answers `GET /json/version` as the
 * DevTools protocol does: Chrome with `webSocketDebuggerUrl` and
 * `V8-Version`, the Node inspector (24) with only `Browser` and
 * `Protocol-Version`, so the protocol's own `Protocol-Version` counts too.
 * Anything else, a timeout or an error included, is not one.
 */
function probeDevtools(host, port, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get({ host, port, path: '/json/version', headers: { host: `localhost:${port}` }, timeout: timeoutMs, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > PROBE_MAX_BYTES) { req.destroy(); done(false); }
      });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          done(!!j && typeof j === 'object' && !Array.isArray(j) && ('webSocketDebuggerUrl' in j || 'V8-Version' in j || typeof j['Protocol-Version'] === 'string'));
        } catch { done(false); }
      });
      res.on('error', () => done(false));
    });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
  });
}

/** Images that are a debugger, shell or notebook whatever command they run (Jupyter's docker-stacks, code-server, ttyd). */
const SHELL_IMAGES = /(^|\/)(jupyter|jupyterhub|code-server|ttyd|openvscode-server)(\/|:|-|$)|jupyter\/[a-z-]+-notebook/;

/** Which shell or debugger a Docker publish of `port` runs, from its containers' command and image; null for none. */
async function dockerShell(port, d) {
  const list = await dockerPublishers(port, (p) => d.dockerGet(p, d.dockerSocket));
  for (const c of list || []) {
    const what = shellCommand(c.command.split(/\s+/).filter(Boolean));
    if (what) return what;
    if (SHELL_IMAGES.test(c.image)) return `a ${c.image} container`;
  }
  return null;
}

async function previewVerdict(port, d) {
  const v = await checkPort(port, d);
  if (!v.ok) return v;
  // The processes behind the sockets that take the connection, where this
  // user can see them.
  const { takers } = takersFor(rowsFor(port, d));
  // `d.owners` (inode -> owner, from one walk of /proc for many ports) saves
  // walking every process's fds again for each.
  const owners = d.owners
    ? new Map(takers.filter((r) => d.owners.has(r.inode)).map((r) => [r.inode, d.owners.get(r.inode)]))
    : socketOwners(takers.map((r) => r.inode), { readdirSync: d.readdirSync, readlinkSync: d.readlinkSync }, d.procRoot);
  for (const { pid } of owners.values()) {
    const what = shellCommand(readArgv(pid, d));
    if (what) return refuse(`debugger or shell: ${what} holds port ${port}`);
  }
  // A Docker publish's process sits behind root's proxy (or DNAT, with no
  // LISTEN row at all), out of /proc's reach: the container's own command and
  // image say instead.
  if (takers.length === 0 || takers.some((r) => r.uid === 0)) {
    const what = await dockerShell(port, d);
    if (what) return refuse(`debugger or shell: ${what} publishes port ${port}`);
  }
  if (d.probe && await d.probe(v.dialHost, port)) return refuse(`debugger or shell: port ${port} answers the DevTools protocol (/json/version)`);
  return v;
}

/**
 * Whether a preview link may reach box port `port`: checkPort's verdict, then
 * SR6's refusal of a debugger, shell or notebook (`port_refused`, reason
 * "debugger or shell: …"). Cached per port as checkPort's are (`previewCache`;
 * port_closed never), on top of checkPort's own cache.
 *
 * `deps`: checkPort's, plus previewCache, readdirSync, readlinkSync and probe
 * (probeDevtools).
 */
function checkPreviewPort(port, deps = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(refuse('not a TCP port'));
  const d = {
    procRoot: '/proc',
    now: Date.now,
    previewCache: defaultPreviewCache,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    readlinkSync: fs.readlinkSync,
    probe: probeDevtools,
    dockerGet,
    dockerSocket: DOCKER_SOCKET,
    ...deps,
  };
  const at = d.now();
  const hit = d.previewCache.get(port);
  if (hit && at - hit.at < PORT_CHECK_TTL_MS && at >= hit.at) return hit.answer;
  const entry = { at };
  entry.answer = previewVerdict(port, d)
    .catch((err) => refuse(`the port check failed: ${err && err.message}`))
    .then((v) => {
      if (v.code === 'port_closed' && d.previewCache.get(port) === entry) d.previewCache.delete(port);
      return v;
    });
  d.previewCache.set(port, entry);
  return entry.answer;
}

const defaultListenerCache = new Map();

/**
 * checkPreviewPort for the publish dialog's list (preview-listeners.js): the
 * forward's verdict and the command-line marks only, never the
 * /json/version probe, which would reach every listener of the user (a
 * Redis logs each one as a possible attack). A list of many ports passes
 * `allRows` (allListenRows) and `owners` (socketOwners over them), read
 * once, so no port reads the tables or walks /proc again. The probe stays where it
 * protects: at publish (preview-listeners with `port`) and at every tunnel
 * open. Cached as checkPreviewPort is, in a map of its own
 * (`previewCache`), so a list's verdict never stands in for a probed one.
 */
function checkPreviewListener(port, deps = {}) {
  return checkPreviewPort(port, { previewCache: defaultListenerCache, ...deps, probe: null });
}

module.exports = { PORT_CHECK_TTL_MS, SHELL_COMMANDS, canCheckPorts, checkPort, checkPreviewListener, checkPreviewPort, clearPortCache, probeDevtools, shellCommand };
