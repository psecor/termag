'use strict';
// Who listens on a box port, from the kernel's tables and the Docker Engine
// API: shared by the browser pane's guest mode (browser-guest.js) and the
// port forward's guard (port-guard.js).
//
//   * listenRows / takersOf: /proc/net/tcp{,6}'s LISTEN sockets on a port, and
//     the ones that take a connection to a given address
//   * listenersOn: those, with the process holding each
//   * dockerGet / dockerBindings / dockerPublisher: the containers publishing a
//     port, and their compose working dir
//   * dockerServiceBindings: the ports a compose service's containers publish
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

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
 * Every host TCP binding of `port` that a running container publishes, as
 * `{ ip, workingDir }` (the address the publish is bound to, and the
 * container's `com.docker.compose.project.working_dir` label, '' without
 * one), container by container in Docker's order. Only `Type: 'tcp'` ones:
 * the publish filter returns a container's every binding, and a UDP publish
 * of the port says nothing about who holds its TCP socket. Null when Docker
 * can't be asked.
 */
async function dockerBindings(port, get = dockerGet) {
  const filters = encodeURIComponent(JSON.stringify({ publish: [String(port)] }));
  const list = await get(`/containers/json?filters=${filters}`);
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const c of list) {
    const workingDir = (c && c.Labels && c.Labels['com.docker.compose.project.working_dir']) || '';
    for (const p of (c && Array.isArray(c.Ports) ? c.Ports : [])) {
      if (p && p.PublicPort === port && p.Type === 'tcp' && typeof p.IP === 'string') out.push({ ip: p.IP, workingDir });
    }
  }
  return out;
}

/**
 * Every host TCP binding that a running container of compose service
 * `service` publishes, as `{ ip, port, workingDir }`, container by container
 * in Docker's order: what a checkout's stack actually runs on, whatever
 * environment it was started with. Null when Docker can't be asked.
 */
async function dockerServiceBindings(service, get = dockerGet) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.service=${service}`] }));
  const list = await get(`/containers/json?filters=${filters}`);
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const c of list) {
    const workingDir = (c && c.Labels && c.Labels['com.docker.compose.project.working_dir']) || '';
    for (const p of (c && Array.isArray(c.Ports) ? c.Ports : [])) {
      if (p && Number.isInteger(p.PublicPort) && p.Type === 'tcp' && typeof p.IP === 'string') out.push({ ip: p.IP, port: p.PublicPort, workingDir });
    }
  }
  return out;
}

/**
 * The container that publishes ip:port over TCP, as `{ workingDir, boundIp }`: its
 * `com.docker.compose.project.working_dir` label ('' without one) and the
 * address the publish is bound to, `ip` itself or 0.0.0.0. `{ workingDir: '',
 * boundIp: null }` when no container publishes it, null when Docker can't be
 * asked.
 */
async function dockerPublisher(ip, port, get = dockerGet) {
  const bindings = await dockerBindings(port, get);
  if (bindings === null) return null;
  const match = bindings.find((b) => b.ip === ip || b.ip === '0.0.0.0');
  return match ? { workingDir: match.workingDir, boundIp: match.ip } : { workingDir: '', boundIp: null };
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
 * The TCP sockets listening on `port`, from `<procRoot>/net/tcp` and `tcp6`,
 * as `{ table, hex, addr, uid, inode }`: `addr` is procAddress's reading of
 * `hex`, `uid` the socket's owner. A table that can't be read adds nothing.
 */
function listenRows(port, read = fs.readFileSync, procRoot = '/proc') {
  const rows = [];
  for (const table of ['tcp', 'tcp6']) {
    let text = '';
    try { text = read(`${procRoot}/net/${table}`, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== '0A') continue; // 0A: LISTEN
      const [addrHex = '', portHex = ''] = f[1].split(':');
      if (parseInt(portHex, 16) !== port) continue;
      rows.push({ table, hex: addrHex.toUpperCase(), addr: procAddress(addrHex), uid: Number(f[7]), inode: f[9] });
    }
  }
  return rows;
}

/**
 * Of `rows`, the ones the kernel hands a connection to `ip` to: the most
 * specific kind present. For an IPv4 address, sockets bound to it, else on
 * 0.0.0.0, else on a dual-stack `::`; for an IPv6 one, bound to it, else on
 * `::`. `addrOf` reads a row's address (default `row.addr`).
 */
function takersOf(rows, ip, addrOf = (r) => r.addr) {
  const kinds = net.isIPv6(ip) ? [ip, '::'] : [ip, '0.0.0.0', '::'];
  for (const kind of kinds) {
    const hit = rows.filter((r) => addrOf(r) === kind);
    if (hit.length > 0) return hit;
  }
  return [];
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
  const rows = listenRows(port, read);
  const inodes = new Set((exactOnly ? rows.filter((r) => r.addr === ip) : takersOf(rows, ip)).map((r) => r.inode));
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

module.exports = {
  dockerGet,
  dockerBindings,
  dockerServiceBindings,
  dockerPublisher,
  procAddress,
  listenRows,
  takersOf,
  listenersOn,
  insideDir,
};
