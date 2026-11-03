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
const fs = require('node:fs');
const os = require('node:os');
const { dockerGet, dockerBindings, listenRows, takersOf, insideDir } = require('./local-listeners');

const PORT_CHECK_TTL_MS = 5000;
// ::1 as /proc/net/tcp6 shows it (four little-endian words); procAddress
// reads it as 'other-v6'.
const LOOPBACK6_HEX = '00000000000000000000000001000000';
const DOCKER_SOCKET = '/var/run/docker.sock';

const defaultCache = new Map();

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

async function verdict(port, d) {
  if (!canCheckPorts(d)) return refuse(`this host has no ${d.procRoot}/net/tcp to tell who listens on port ${port}`);
  const rows = listenRows(port, d.readFileSync, d.procRoot);
  const docker = (() => {
    let answer;
    return () => (answer ||= dockerBindings(port, (p) => d.dockerGet(p, d.dockerSocket)));
  })();

  // An IPv4 dial reaches a 127.0.0.1 socket, else a 0.0.0.0 one. With
  // neither, dial ::1: a lone `::` may be IPv6-only (the tables don't say),
  // and ::1 reaches it either way.
  const v4 = takersOf(rows.filter((r) => addrOf(r) !== '::'), '127.0.0.1', addrOf);
  const dialHost = v4.length > 0 ? '127.0.0.1' : '::1';
  const takers = v4.length > 0 ? v4 : takersOf(rows, '::1', addrOf);

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

/** Forget the cached verdict for `port`, or every port's without one (`cache`: as checkPort's deps). */
function clearPortCache(port, cache = defaultCache) {
  if (port === undefined) cache.clear();
  else cache.delete(port);
}

module.exports = { PORT_CHECK_TTL_MS, canCheckPorts, checkPort, clearPortCache };
