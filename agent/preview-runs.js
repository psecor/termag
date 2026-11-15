'use strict';
// `termag preview run`, the agent's half
// . Ported from the prototype
// in #1108 (pl-L). The agent itself starts the confined app, and only its own
// starts count: the launcher (/usr/local/bin/termag-preview, preview-launcher/)
// applies Landlock and seccomp and execs the command, and this module records
// the root it spawned, so a tunnel-open for a `people` or `link` link can check
// that the listener descends from it.
//
//   * the run directory: ~/.local/state/termag-preview/<run>/{work,tmp}, 0700,
//     made fresh and removed when the run ends, whatever its exit
//   * the sync helper and the launcher, spawned with stdin, stdout and stderr
//     only and an empty environment: the launcher builds the app's from --env
//   * the app's PATH, resolved as nvm would without sourcing nvm.sh
//   * a cgroup per run under the agent's own (<agent>/preview/<run>), so
//     cgroup.kill ends a run's every process, double-forked ones included
//   * the registry of roots, and listenerConfined, the tunnel-open check:
//     every process holding every LISTEN socket on the port descends from a
//     root for that checkout, by parent chain and start time
//   * --allow: the TCP ports the app may connect to besides 443 (loopback is
//     denied otherwise, SR9), never 80 or a debugger's
//   * diagnose: the app's connects the sandbox refused, named for the owner
//
// The registry is in memory. An agent restart forgets it, so sweep() ends
// every run a previous agent left behind (the safe direction: the owner
// starts the app again).
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { allListenRows, dockerBindings, listenRows, socketOwners, takersOf } = require('./local-listeners');
const portGuard = require('./port-guard');
const { isWorkspaceDir } = require('./workspace');

const LAUNCHER = '/usr/local/bin/termag-preview';
const STATE_DIR = '.local/state/termag-preview';
const RUN_ID_RE = /^[0-9a-f]{12}$/;
const MAX_DEPTH = 128;
// Ended runs answer preview-status this long, so the CLI can say why one ended.
const ENDED_KEEP_MS = 60 * 60_000;
const ENDED_MAX = 50;
const MAX_ARGS = 256;
const MAX_ARG_LEN = 4096;
// How long the sync helper may take to make the first copy (node_modules copies included).
const SYNC_READY_MS = 120_000;

/** /proc/<pid>/stat: pid, ppid and start time (field 22). comm may hold spaces and parens. */
function parseStat(text) {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const rest = text.slice(close + 2).split(' ');
  // rest[0] is field 3 (state); ppid is field 4, starttime field 22.
  return { pid, ppid: Number(rest[1]), startTime: rest[19] };
}

function procStat(pid, read = fs.readFileSync) {
  try { return parseStat(read(`/proc/${pid}/stat`, 'utf8')); } catch { return null; }
}

/**
 * The root `pid` descends from (itself included), or null. A root counts only
 * with its recorded start time, so a reused pid doesn't match; a process that
 * double-forked away loses the ancestry, which refuses it.
 */
function rootOf(pid, roots, read = fs.readFileSync) {
  let cur = pid;
  for (let i = 0; i < MAX_DEPTH && cur > 1; i++) {
    const st = procStat(cur, read);
    if (!st) return null;
    for (const root of roots.values()) {
      if (root.pid === cur && root.startTime === st.startTime) return root;
    }
    cur = st.ppid;
  }
  return null;
}

/** An address as /proc/net/tcp's hex and Node's socket fields can both be compared: IPv4 dotted, IPv6 full groups. */
function tupleIp(ip) {
  if (typeof ip !== 'string') return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : canonIp(ip);
}

/** /proc/net/tcp's `ADDR:PORT` hex as `{ ip, port }`; the all-zero address stays itself (never an ESTABLISHED end). */
function procEnd(field) {
  const [hex, portHex] = field.split(':');
  if (!hex || !portHex) return null;
  const ip = /^0+$/.test(hex) ? (hex.length === 8 ? '0.0.0.0' : '0:0:0:0:0:0:0:0') : probeHost(hex);
  return ip ? { ip: tupleIp(ip), port: parseInt(portHex, 16) } : null;
}

/**
 * The ESTABLISHED socket that accepted one connection, by its whole 4-tuple from the accepting side: local
 * `host:port`, peer `peerHost:peerPort`, from /proc/net/tcp and tcp6. Ports alone can name another connection's
 * socket (two clients on one source port, from different addresses), so the addresses must match too
 * (Bugbot and Devin, #1667).
 */
function establishedRows({ host, port, peerHost, peerPort }, read = fs.readFileSync) {
  const want = { host: tupleIp(host), peerHost: tupleIp(peerHost) };
  if (!want.host || !want.peerHost) return [];
  const rows = [];
  for (const table of ['tcp', 'tcp6']) {
    let text = '';
    try { text = read(`/proc/net/${table}`, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== '01') continue; // 01: ESTABLISHED
      const local = procEnd(f[1]);
      const rem = procEnd(f[2]);
      if (!local || !rem) continue;
      if (local.port === port && rem.port === peerPort && local.ip === want.host && rem.ip === want.peerHost) rows.push({ table, inode: f[9] });
    }
  }
  return rows;
}

/** Every pid holding one of `inodes` (a listening socket can be shared by fork). */
function holdersOf(inodes, io = {}) {
  const readdir = io.readdirSync || fs.readdirSync;
  const readlink = io.readlinkSync || fs.readlinkSync;
  const holders = new Map([...inodes].map((i) => [i, []]));
  let pids = [];
  try { pids = readdir('/proc').filter((n) => /^\d+$/.test(n)); } catch { /* none */ }
  for (const pid of pids) {
    let fds;
    try { fds = readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = readlink(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && holders.has(m[1]) && !holders.get(m[1]).includes(Number(pid))) holders.get(m[1]).push(Number(pid));
    }
  }
  return holders;
}

/**
 * The tunnel-open check for a target with `confine`: every listening socket
 * on `port` (any address: with SO_REUSEPORT an unconfined listener beside a
 * confined one would get some of the connections) has holders, all of them
 * descending from a root this agent started for `checkout`. A name such as a
 * systemd scope proves nothing (any process of the user can make one), so
 * nothing but the registry is consulted. { ok: true } or { ok: false, reason }.
 */
function listenerConfined(port, checkout, roots, io = {}) {
  const read = io.readFileSync || fs.readFileSync;
  const rows = listenRows(port, read);
  return judge(port, rows, holdersOf(new Set(rows.map((r) => r.inode)), io), checkout, roots, read);
}

/**
 * Whether a run of `runCheckout` is a run of the workstream checkout `checkout` (both real paths): the same
 * directory, or, when `checkout` is a multi-repo workspace or workstream root, one of
 * the repositories directly in it. A multi-repo root isn't a git repository, so `termag preview run` there runs one
 * of its repositories, and the publish dialog and the tunnel ask about the root.
 */
function runOfCheckout(runCheckout, checkout) {
  if (runCheckout === checkout) return true;
  return typeof runCheckout === 'string' && path.dirname(runCheckout) === checkout && isWorkspaceDir(checkout);
}

/** listenerConfined of one port, from its rows and the holders of their sockets. */
function judge(port, rows, holders, checkout, roots, read, requireLoopback = true) {
  // `closed`: nothing to vouch for yet, which a viewer is told as the app not running (Bugbot, #1520).
  if (rows.length === 0) return { ok: false, closed: true, reason: `nothing listens on port ${port}` };
  for (const { inode } of rows) {
    const pids = holders.get(inode) || [];
    if (pids.length === 0) return { ok: false, reason: `a socket on port ${port} (inode ${inode}) has no holder this user can see` };
    for (const pid of pids) {
      const root = rootOf(pid, roots, read);
      if (!root) return { ok: false, reason: `pid ${pid} on port ${port} wasn't started by termag preview run` };
      if (!runOfCheckout(root.checkout, checkout)) return { ok: false, reason: `pid ${pid} on port ${port} runs another checkout (${root.checkout})` };
      // Judged by the launcher the run started under, as recorded then, not the one installed now: a run started
      // before a box update brought the loopback rule can still reach the owner's loopback ports (#1520).
      if (requireLoopback && !(root.launcher && Array.isArray(root.launcher.features) && root.launcher.features.includes('tcp-allowlist'))) {
        return { ok: false, reason: `pid ${pid} on port ${port} runs under a launcher that didn't refuse loopback connects when it started, so it can't be shared beyond the project` };
      }
    }
  }
  return { ok: true };
}

/**
 * The ports of `ports` listenerConfined would pass, from one read of the
 * kernel's tables and one walk of /proc for them all (the publish dialog's
 * list has up to 200; Bugbot, #1520).
 */
function confinedAmong(ports, checkout, roots, io = {}) {
  const read = io.readFileSync || fs.readFileSync;
  const wanted = new Set(ports);
  const rows = allListenRows(read).filter((r) => wanted.has(r.port));
  const holders = holdersOf(new Set(rows.map((r) => r.inode)), io);
  // `out`: the checkout's runs, under any launcher; `out.vouched`: those whose run started under a launcher with the
  // loopback rule, which alone may be shared beyond the project (#1520). One walk of /proc for both.
  const out = new Set();
  out.vouched = new Set();
  for (const port of wanted) {
    const portRows = rows.filter((r) => r.port === port);
    if (judge(port, portRows, holders, checkout, roots, read, false).ok) out.add(port);
    if (judge(port, portRows, holders, checkout, roots, read, true).ok) out.vouched.add(port);
  }
  return out;
}

/** An installed nvm version for a .nvmrc or alias value, following alias files; null if none. */
function resolveNodeVersion(home, want, io = {}) {
  const readdir = io.readdirSync || fs.readdirSync;
  const read = io.readFileSync || fs.readFileSync;
  let installed = [];
  try { installed = readdir(path.join(home, '.nvm/versions/node')).filter((v) => /^v\d+\.\d+\.\d+$/.test(v)); } catch { return null; }
  const byVersion = (a, b) => {
    const pa = a.slice(1).split('.').map(Number); const pb = b.slice(1).split('.').map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  };
  installed.sort(byVersion);
  let v = nvmrcVersion(want);
  for (let hops = 0; hops < 8 && v; hops++) {
    // lts/* and lts/<name> are nvm's own aliases (~/.nvm/alias/lts/, written when it installs an LTS), read below:
    // the newest LTS, not the newest installed (Bugbot, #1520).
    if (v === 'node' || v === 'stable') return installed.at(-1) || null;
    const exact = /^v?(\d+(\.\d+){0,2})$/.exec(v);
    if (exact) {
      const prefix = `v${exact[1]}`;
      const match = installed.filter((i) => i === prefix || i.startsWith(`${prefix}.`));
      return match.at(-1) || null;
    }
    // An alias (default, lts/<name>): ~/.nvm/alias/<name>, read by the agent, never granted to the app. A name,
    // never a path: the checkout's .nvmrc can say anything, /dev/zero or a secret included (Bugbot, #1520).
    if (!/^[a-z0-9_*.-]+(\/[a-z0-9_*.-]+)*$/i.test(v) || v.includes('..')) return null;
    const aliasDir = path.join(home, '.nvm/alias');
    const file = path.join(aliasDir, v);
    if (!file.startsWith(`${aliasDir}/`)) return null;
    try { v = readSmall(file, io).trim(); } catch { return null; }
  }
  return null;
}

/**
 * The version a .nvmrc names, as nvm reads it: the first line that isn't blank or a comment, its first word, with a
 * trailing comment cut (Bugbot, #1520); null for none.
 */
function nvmrcVersion(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const word = line.replace(/#.*$/, '').trim().split(/\s+/)[0];
    if (word) return word;
  }
  return null;
}

/** The app's PATH: the run copy's node_modules/.bin, nvm's bin for the checkout's .nvmrc (else default), then the system's. */
/**
 * A version file's text: a regular file (no symlink, no device) of at most
 * SMALL_FILE bytes, else a throw. The checkout's .nvmrc is the checkout's to
 * make anything (Bugbot, #1520).
 */
const SMALL_FILE = 256;
/** How long a run lives without its CLI asking about it (PreviewRuns#sweepLeases). */
const LEASE_MS = 60_000;
/**
 * How long the post-connect check waits for a slow app to accept the relay's dial (a cold compile, a big rebuild),
 * at most: the relay passes what's left of its own open budget (port-tunnel.js, ACCEPT_BUDGET_MS), which is less.
 */
const ACCEPT_WAIT_MS = 10_000;
function readSmall(file, io = {}) {
  if (io.readFileSync) return String(io.readFileSync(file, 'utf8')).slice(0, SMALL_FILE);
  // One open, then fstat of what was opened: a check by name then a read by name could be swapped in between for
  // a FIFO (a read that hangs) or /dev/zero (one that never ends). O_NOFOLLOW refuses a symlink, O_NONBLOCK keeps
  // a FIFO's open from waiting, and the read is capped (#1520).
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > SMALL_FILE) throw new Error(`${file} is not a small regular file`);
    const buf = Buffer.alloc(SMALL_FILE);
    return buf.subarray(0, fs.readSync(fd, buf, 0, SMALL_FILE, 0)).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function appPath({ home, checkout, work }, io = {}) {
  let want = null;
  try { want = readSmall(path.join(checkout, '.nvmrc'), io); } catch { /* none, or not a version file */ }
  const version = (want && resolveNodeVersion(home, want, io)) || resolveNodeVersion(home, 'default', io);
  const dirs = [path.join(work, 'node_modules/.bin')];
  if (version) dirs.push(path.join(home, '.nvm/versions/node', version, 'bin'));
  dirs.push(path.join(home, '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin');
  return dirs.join(':');
}

/** The app's environment, as KEY=VALUE for the launcher's --env: the allowlist (preview-launcher/env.go), nothing inherited. */
function appEnv({ home, checkout, runDir, port }, io = {}) {
  const work = path.join(runDir, 'work');
  const tmp = path.join(runDir, 'tmp');
  const env = {
    PATH: appPath({ home, checkout, work }, io),
    HOME: home,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    TMPDIR: tmp,
    NODE_ENV: 'development',
    npm_config_logs_dir: path.join(tmp, 'npm-logs'),
    npm_config_update_notifier: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
    STORYBOOK_DISABLE_TELEMETRY: '1',
    BROWSER: 'none',
  };
  if (port) env.PORT = String(port);
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

// The launcher's line at every start (preview-launcher/net.go, TCPNotice):
// it names the ports the app may connect to.
const TCP_NOTICE = 'termag-preview: TCP connect is allowed only to ports ';
const IMDS_PORT = 80;
const HTTPS_PORT = 443;
const MAX_ALLOW = 32;
// The default debugging ports (Node's inspector, Chrome's DevTools): declared,
// they would hand the app code execution outside the sandbox, whatever listens
// there now (SR6, SR9). A listener port-guard classifies as a debugger, shell
// or notebook is refused on any port.
const DEBUG_PORTS = new Map([[9229, 'the Node inspector\'s default port'], [9222, 'the Chrome DevTools default port']]);

// How apps report a connect the port rule refused, as seen on a box: Node's
// net and fetch (`connect EACCES 172.66.147.243:80`, `connect EACCES ::1:5432`,
// also inside fetch's AggregateError) and curl (`Failed to connect to
// example.com port 80`, which doesn't say EACCES). Node's default print of
// fetch's error stops at `AggregateError [EACCES]`, without the address; in
// this sandbox a TCP connect gets EACCES only from the port rule, so that
// counts too, with the address unknown.
const CONNECT_PATTERNS = [
  /connect EACCES (\S+):(\d+)\b/,
  /Failed to connect to (\S+) port (\d+)\b/,
];
const UNNAMED = /AggregateError \[EACCES\]/;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|\[::1\]|localhost|0\.0\.0\.0|::ffff:127\.\d+\.\d+\.\d+)$/;

/**
 * What the run's log says the sandbox refused: a list of { code, port, targets,
 * message }, one per kind and port, empty when nothing. Only for logs whose
 * launcher printed its notice, so an EACCES elsewhere isn't blamed on the rule.
 *   port80_refused     port 80 (instance metadata), never allowed
 *   loopback_refused   a loopback port not declared with --allow
 *   port_refused       another host on a port not declared
 *   connect_refused    a connect whose address the output doesn't show
 */
function diagnose(log) {
  const notice = log.split('\n').find((l) => l.startsWith(TCP_NOTICE));
  if (!notice) return [];
  const allowed = (/^([\d, ]+)/.exec(notice.slice(TCP_NOTICE.length)) || ['', ''])[1].split(',').map((p) => Number(p.trim())).filter(Boolean);
  const byKey = new Map();
  let unnamed = false;
  for (const line of log.split('\n')) {
    for (const re of CONNECT_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const host = m[1].replace(/^\[|\]$/g, '');
      const port = Number(m[2]);
      if (allowed.includes(port) && port !== IMDS_PORT) continue; // not this rule's refusal
      const code = port === IMDS_PORT ? 'port80_refused' : LOOPBACK.test(host) ? 'loopback_refused' : 'port_refused';
      const key = `${code}:${port}`;
      if (!byKey.has(key)) byKey.set(key, { code, port, targets: [] });
      const e = byKey.get(key);
      if (!e.targets.includes(host)) e.targets.push(host);
    }
    if (UNNAMED.test(line)) unnamed = true;
  }
  const ports = allowed.join(', ');
  const found = [...byKey.values()].map((e) => {
    const where = e.targets.join(', ');
    if (e.code === 'port80_refused') {
      return { ...e, message: `The app's connection to port 80 (${where}) was refused: an app run with termag preview run `
        + 'cannot connect to port 80, which keeps instance metadata out of reach. Use https or another port.' };
    }
    // A debugger's default port can't be declared, on this box or another host (Bugbot, #1521).
    if (DEBUG_PORTS.has(e.port)) {
      const at = e.code === 'loopback_refused' ? `port ${e.port} on this box (${where})` : `${where} port ${e.port}`;
      return { ...e, message: `The app's connection to ${at} was refused: it is ${DEBUG_PORTS.get(e.port)}, `
        + 'and an app run with termag preview run never reaches a debugger outside its sandbox.' };
    }
    if (e.code === 'loopback_refused') {
      return { ...e, message: `The app's connection to port ${e.port} on this box (${where}) was refused: termag preview run reaches only `
        + `the loopback ports you declare (this run: ${ports}). If it's the app's own service, run it again with --allow ${e.port}; never a debugger's port.` };
    }
    return { ...e, message: `The app's connection to ${where} port ${e.port} was refused: termag preview run connects only to 443 `
      + `and the ports you declare (this run: ${ports}). If the app needs it, run it again with --allow ${e.port}.` };
  });
  // Reported beside named ones too: the unnamed connect may have been to another port (Devin, #1521).
  if (unnamed) {
    found.push({ code: 'connect_refused', port: null, targets: [], message: 'A TCP connection of the app\'s was refused (its output doesn\'t say where): '
      + `termag preview run connects only to ${ports}, and never to port 80. Run it again with --allow <port> for the app's own services.` });
  }
  return found;
}

/**
 * The address to probe for a LISTEN row, from its /proc hex: dotted IPv4, or
 * any IPv6 written out (::1 and other native binds included; Bugbot, #1521),
 * the wildcards as their loopback.
 */
function probeHost(hex) {
  if (hex.length === 8) {
    const v4 = [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.');
    return v4 === '0.0.0.0' ? '127.0.0.1' : v4;
  }
  if (hex.length !== 32) return null;
  if (/^0{32}$/.test(hex)) return '::1';
  // Four little-endian 32-bit words.
  const bytes = [];
  for (let w = 0; w < 4; w++) for (let i = 3; i >= 0; i--) bytes.push(hex.slice(w * 8 + i * 2, w * 8 + i * 2 + 2));
  if (bytes.slice(0, 10).every((b) => b === '00') && bytes[10].toUpperCase() === 'FF' && bytes[11].toUpperCase() === 'FF') {
    return bytes.slice(12).map((b) => parseInt(b, 16)).join('.');
  }
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(parseInt(bytes[i] + bytes[i + 1], 16).toString(16));
  return groups.join(':');
}

/**
 * Whether a debugger, shell or notebook listens on `port` on any address, for
 * --allow: the Landlock rule opens the port on every address, so port-guard's
 * forward rules (which stop at another uid's listener, or one bound only to
 * the box's private address) don't decide it (Bugbot, #1521). Every visible
 * holder's command line is classified, and every listening address gets the
 * DevTools probe, which sees a debugger whoever runs it. { ok } or
 * { ok: false, reason: 'debugger or shell: …' }.
 */
async function debuggerOnPort(port, d = {}) {
  const read = d.readFileSync || fs.readFileSync;
  const probe = d.probe || ((host, p) => portGuard.probeDevtools(host, p));
  const rows = listenRows(port, read);
  const owners = socketOwners(rows.map((r) => r.inode), d);
  for (const { pid } of owners.values()) {
    let argv = null;
    try { argv = read(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { /* gone */ }
    const what = portGuard.shellCommand(argv);
    if (what) return { ok: false, code: 'port_refused', reason: `debugger or shell: ${what} holds port ${port}` };
  }
  // A Docker publish sits behind root's proxy, or DNAT with no LISTEN row: the container's command and image say (Bugbot, #1521).
  // A listing that couldn't be had is not "no shell": with a Docker on the box, refused, whatever a later look says
  // (Bugbot, #1521). (d.dockerShell, a test's, answers outright.)
  const dockerHereFirst = (d.dockerSocketExists || (() => fs.existsSync('/var/run/docker.sock')))();
  const shell = d.dockerShell ? { ok: true, what: await d.dockerShell(port) } : await (d.dockerShellAnswer || ((p) => portGuard.dockerShellAnswerOn(p)))(port);
  if (shell.ok && shell.what) return { ok: false, code: 'port_refused', reason: `debugger or shell: ${shell.what} publishes port ${port}` };
  if (!shell.ok && dockerHereFirst) {
    return { ok: false, code: 'port_refused', reason: `Docker didn't answer, so termag can't tell what publishes port ${port}; try again once it does` };
  }
  let published = null;
  try { published = await (d.dockerBindings || ((p) => dockerBindings(p)))(port); } catch { published = null; }
  // Fail closed: with a Docker on the box that doesn't answer, the port could
  // be a published Jupyter, ttyd or code-server, which the probe wouldn't
  // recognise (Bugbot, #1521).
  const dockerHere = (d.dockerSocketExists || (() => fs.existsSync('/var/run/docker.sock')))();
  // Whatever the host shows: a DNAT publish (userland-proxy off) leaves no LISTEN row at all (Bugbot, #1521).
  if (published === null && dockerHere) {
    return { ok: false, code: 'port_refused', reason: `Docker didn't answer, so termag can't tell what publishes port ${port}; try again once it does` };
  }
  // A listener this user can't see the holder of (root's, another user's): every process of that uid is classified
  // instead, and none visible at all is refused (Bugbot, #1521). Only root's rows at an address Docker publishes the
  // port on are docker-proxy's and left to the Docker checks; a hidden shell on another bind of the port isn't
  // (Bugbot and Devin, #1521).
  const addrOf = (r) => (r.addr === '0.0.0.0' || r.addr === '::' ? r.addr : canonIp(probeHost(r.hex) || ''));
  // A publish's address as addrOf writes a row's: the wildcards as themselves (Bugbot, #1521), others written out.
  const publishAddr = (ip) => (ip === '' || ip === '0.0.0.0' ? '0.0.0.0' : ip === '::' ? '::' : canonIp(ip));
  // And only where a docker-proxy for it runs: a DNAT-only publish (userland-proxy off) has no proxy, so a root
  // listener on that address is someone else's, a notebook say (Devin, #1521).
  const proxies = (published && published.length) ? dockerProxyAddrs(port, d, publishAddr) : new Set();
  const proxied = (r) => r.uid === 0 && proxies.has(addrOf(r)) && (published || []).some((b) => publishAddr(b.ip) === addrOf(r));
  {
    for (const uid of new Set(rows.filter((r) => !owners.has(r.inode) && !proxied(r)).map((r) => r.uid))) {
      const seen = uidShell(uid, d);
      if (seen === null) return { ok: false, code: 'port_refused', reason: `port ${port} is held by a process termag can't see (uid ${uid}), so it can't tell it isn't a debugger or shell` };
      if (seen) return { ok: false, code: 'port_refused', reason: `debugger or shell: uid ${uid}, which holds port ${port}, runs ${seen}` };
    }
  }
  const own = (d.boxAddresses || boxAddresses)();
  // Each listening address, where the kernel hands it connections. A wildcard one is probed at every local address
  // it takes, not just loopback, which a more specific socket on the same port would answer instead; a wildcard one
  // that takes none of them can't be probed, so it's refused (Cursor Security Agent, #1521).
  const hosts = new Set();
  for (const r of rows) {
    if (r.addr !== '0.0.0.0' && r.addr !== '::') {
      const h = probeHost(r.hex);
      if (h) hosts.add(h);
      continue;
    }
    // An IPv6 wildcard only at IPv6 addresses: one with IPV6_V6ONLY set takes no IPv4, and /proc doesn't say which it
    // is, so an IPv4 address that reaches a dual-stack socket proves nothing about a v6-only one (Bugbot, #1521).
    const candidates = r.addr === '::' ? ['::1', ...own.v6] : ['127.0.0.1', ...own.v4];
    const takes = candidates.filter((ip) => takersOf(rows, canonIp(ip), addrOf).includes(r));
    if (!takes.length) {
      return { ok: false, code: 'port_refused', reason: `port ${port} listens on every address, but more specific listeners take each address termag can probe it at, so it can't check that one` };
    }
    takes.forEach((h) => hosts.add(h));
  }
  // A wildcard publish on loopback and on the box's own addresses: with userland-proxy off it is DNAT alone, which
  // Docker applies to the box's local addresses but not to loopback unless route_localnet is on, while the Landlock
  // rule opens the port on every address (Cursor Security Agent, #1521).
  const publishHosts = new Set();
  for (const b of published || []) {
    if (b.ip === '0.0.0.0' || b.ip === '') [['127.0.0.1'], own.v4].flat().forEach((h) => publishHosts.add(h));
    else if (b.ip === '::') [['::1'], own.v6].flat().forEach((h) => publishHosts.add(h));
    else publishHosts.add(b.ip);
  }
  for (const h of publishHosts) hosts.add(h);
  for (const host of hosts) {
    if (await probe(host, port)) return { ok: false, code: 'port_refused', reason: `debugger or shell: port ${port} answers the DevTools protocol (/json/version) on ${host}` };
  }
  // Fail closed: a Docker publish that no probed address reached went unchecked (Cursor Security Agent, #1521).
  if (publishHosts.size) {
    const reaches = d.reaches || tcpReaches;
    let reached = false;
    for (const h of publishHosts) if (await reaches(h, port)) { reached = true; break; }
    if (!reached) {
      return { ok: false, code: 'port_refused', reason: `termag couldn't reach what Docker publishes on port ${port} to check it isn't a debugger or shell, so it isn't allowed` };
    }
  }
  return { ok: true };
}

/**
 * Which debugger, shell or notebook a process of `uid` runs ('' for none), from every visible process's status and
 * command line; null when no process of that uid can be seen at all (hidepid, or it's gone), so nothing can be said.
 */
function uidShell(uid, d = {}) {
  const readdir = d.readdirSync || fs.readdirSync;
  const read = d.readFileSync || fs.readFileSync;
  let pids = [];
  try { pids = readdir('/proc').filter((n) => /^\d+$/.test(n)); } catch { return null; }
  let seen = false;
  for (const pid of pids) {
    let status;
    try { status = read(`/proc/${pid}/status`, 'utf8'); } catch { continue; }
    const m = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
    if (!m || (Number(m[1]) !== uid && Number(m[2]) !== uid)) continue;
    seen = true;
    let argv = null;
    try { argv = read(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    const what = portGuard.shellCommand(argv);
    if (what) return what;
  }
  return seen ? '' : null;
}

/**
 * The host addresses a visible docker-proxy listens on for TCP `port` (its argv's -host-ip, -host-port and -proto,
 * world-readable though it runs as root), each as `norm` writes it.
 */
function dockerProxyAddrs(port, d = {}, norm = (ip) => ip) {
  const readdir = d.readdirSync || fs.readdirSync;
  const read = d.readFileSync || fs.readFileSync;
  const stat = d.statSync || fs.statSync;
  const out = new Set();
  let pids = [];
  try { pids = readdir('/proc').filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const pid of pids) {
    let argv;
    try { argv = read(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    if (!argv.length || path.basename(argv[0]) !== 'docker-proxy') continue;
    // Anyone can name themselves docker-proxy and pass its flags (Cursor Security Agent, #1521): only a process
    // running as root (effective uid 0, which no other user can claim) from a root-owned binary nobody else can
    // write counts. /proc/<pid>/exe of root's process isn't readable here, so argv[0] is checked on disk.
    let status = '';
    try { status = read(`/proc/${pid}/status`, 'utf8'); } catch { continue; }
    const uid = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
    if (!uid || Number(uid[2]) !== 0) continue;
    if (!path.isAbsolute(argv[0])) continue;
    let st;
    try { st = stat(argv[0]); } catch { continue; }
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0) continue;
    const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    if (opt('-host-port') !== String(port) || (opt('-proto') || 'tcp') !== 'tcp') continue;
    const ip = opt('-host-ip');
    if (typeof ip === 'string') out.add(norm(ip));
  }
  return out;
}

/** An address as probeHost writes one: IPv6 with every group, no leading zeros. */
function canonIp(ip) {
  if (!net.isIPv6(ip)) return ip;
  const [head, tail] = ip.split('::');
  const a = head ? head.split(':') : [];
  const groups = tail === undefined ? a : [...a, ...Array(8 - a.length - (tail ? tail.split(':').length : 0)).fill('0'), ...(tail ? tail.split(':') : [])];
  return groups.map((g) => parseInt(g, 16).toString(16)).join(':');
}

/** The box's own addresses, loopback and link-local aside: where Docker's DNAT of a wildcard publish applies. */
function boxAddresses(ifaces = os.networkInterfaces()) {
  const v4 = [];
  const v6 = [];
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4' || a.family === 4) v4.push(a.address);
      else if ((a.family === 'IPv6' || a.family === 6) && !/^fe[89ab]/i.test(a.address)) v6.push(a.address);
    }
  }
  return { v4, v6 };
}

/** Whether a TCP connect to host:port succeeds within timeoutMs. */
function tcpReaches(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * --allow's ports, checked: each 1 to 65535, never 80 (instance metadata) or
 * a default debugging port, at most MAX_ALLOW, deduplicated and sorted. 443 is
 * always allowed and needn't be named. Throws with the reason.
 */
function validAllow(allow) {
  if (allow === undefined || allow === null) return [];
  if (!Array.isArray(allow) || allow.length > MAX_ALLOW) throw new Error(`--allow takes at most ${MAX_ALLOW} ports`);
  const out = new Set();
  for (const p of allow) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`--allow: ${String(p).slice(0, 20)} is not a port`);
    if (p === IMDS_PORT) throw new Error('--allow 80 is refused: instance metadata listens on port 80');
    if (DEBUG_PORTS.has(p)) throw new Error(`--allow ${p} is refused: it is ${DEBUG_PORTS.get(p)}, and a debugger outside the sandbox is code execution`);
    if (p !== HTTPS_PORT) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

/** The agent's own cgroup v2 directory. */
function ownCgroup(read = fs.readFileSync) {
  const line = read('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
  if (!line) throw new Error('no cgroup v2 for this process');
  return path.join('/sys/fs/cgroup', line.slice(3));
}

// What needsNodeModulesCopy can read for certain. Anything else (a shell,
// options it would have to interpret, a script that is more than one plain
// command) is unknown, and the dependencies decide.
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'corepack']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const PM_COMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'exec', 'dlx', 'x', 'create', 'test', 't', 'why', 'link']);
// Shell syntax that makes a script more than one plain command, quotes included.
const SHELL_SYNTAX = /[;&|<>()$`'"\\*?[\]{}~#!\n]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// The tools that need the copy (needsNodeModulesCopy).
const COPY_TOOLS = new Set(['storybook', 'sb', 'start-storybook', 'next']);
// Dev servers known to run from the symlink overlay: only these get it for
// certain. Any other tool, a wrapper among them (cross-env, nodemon, tsx, …),
// may start Storybook or Next.js, so the dependencies decide for it.
const OVERLAY_TOOLS = new Set(['vite', 'rspack', '@rspack/cli', 'rsbuild', '@rsbuild/core', 'webpack', 'webpack-cli',
  'webpack-dev-server', 'parcel', 'esbuild', 'astro', 'vitepress', 'react-scripts', 'serve', 'http-server']);
// node options whose value is the next word, and the ones that run inline code instead of a script.
const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C',
  '--conditions', '--env-file', '--env-file-if-exists', '--input-type', '--title', '--inspect-port', '--watch-path',
  '--test-reporter', '--test-reporter-destination', '--redirect-warnings', '--diagnostic-dir', '--report-dir']);
// node options that run something other than a script file: inline code, a package.json script, the test runner.
const NODE_INLINE = new Set(['-e', '--eval', '-p', '--print', '-', '--run', '--test']);

/** Whether a tool is one that needs the copy (Next.js only without --webpack; needsNodeModulesCopy checks that). */
function needsCopyTool(tool) {
  return COPY_TOOLS.has(tool) || tool.startsWith('@storybook/');
}

/** argv without its leading VAR=value words; empty when it is nothing else. */
function skipAssignments(argv) {
  const i = argv.findIndex((x) => !ASSIGNMENT.test(x));
  return i === -1 ? [] : argv.slice(i);
}

/**
 * argv without its leading VAR=value words, or `env` followed by nothing but
 * those; null for `env` with options (`env -S` splits a string as a shell
 * would) or with no command.
 */
function skipEnv(argv) {
  const words = skipAssignments(argv);
  if (path.basename(words[0] || '') !== 'env') return words;
  const rest = skipAssignments(words.slice(1));
  return rest.length && !rest[0].startsWith('-') ? rest : null;
}

/**
 * The tool one plain command runs, for needsNodeModulesCopy: the executable's
 * name, or for `node <script>` the package its script is in (node_modules/<pkg>/…)
 * or the script's own name, past node's options and their values. Leading
 * VAR=value words, and `env` with nothing but those, are skipped (skipEnv);
 * `npx <tool>`, `pnpm exec <tool>` and the like are read through when they
 * carry no options. null when it can't tell for certain: a shell or a package
 * manager as the command (`sh -c '…'`, a script running another), or node
 * running something other than a script file (`-e`, `--run`, `--test`).
 * Which tools then get the overlay is needsNodeModulesCopy's allowlist.
 */
function toolOf(argv) {
  let words = skipEnv(argv);
  if (!words) return null;
  const runner = path.basename(words[0] || '');
  if (['npx', 'pnpx', 'bunx'].includes(runner)) words = words.slice(1);
  else if (['pnpm', 'yarn', 'bun'].includes(runner) && ['exec', 'dlx', 'x'].includes(words[1])) words = words.slice(2);
  else if (runner === 'npm' && words[1] === 'exec' && words[2] === '--') words = words.slice(3);
  if (!words.length || words[0].startsWith('-')) return null;
  const exe = path.basename(words[0]);
  if (PACKAGE_MANAGERS.has(exe) || SHELLS.has(exe)) return null;
  let tool = exe;
  if (exe === 'node' || exe === 'nodejs') {
    let script = -1;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (NODE_INLINE.has(w)) return null;
      if (NODE_VALUE_OPTIONS.has(w)) { i++; continue; }
      if (!w.startsWith('-')) { script = i; break; }
    }
    if (script === -1) return null;
    // node_modules/.bin/<tool> is the tool's own link; elsewhere under node_modules, its package.
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(words[script]);
    tool = m && m[1] !== '.bin' ? m[1] : path.basename(words[script]).replace(/\.[cm]?js$/, '');
  }
  return { tool, words };
}

/**
 * The tool `command` runs, read through `npm run <s>`, `npm start`,
 * `pnpm [run] <s>`, `yarn [run] <s>` and `bun run <s>` to the package.json
 * script; null when it can't tell (see toolOf). A package-manager command
 * with options before the script (`--workspace`, `--filter`, `--dir`, …) is
 * unknown: they can pick another package's manifest. So is a script that
 * isn't one plain command.
 */
function commandTool(command, checkout, read = fs.readFileSync) {
  const words = skipEnv(command);
  if (!words) return null;
  const pm = path.basename(words[0] || '');
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(pm) || ['exec', 'dlx', 'x'].includes(words[1])) return toolOf(command);
  let rest = words.slice(1);
  if (rest[0] === 'run' || rest[0] === 'run-script') rest = rest.slice(1);
  else if (pm === 'npm' ? rest[0] !== 'start' : pm === 'bun') return null;
  const script = rest[0];
  if (!script || script.startsWith('-') || PM_COMMANDS.has(script)) return null;
  let scripts;
  try { scripts = JSON.parse(read(path.join(checkout, 'package.json'), 'utf8')).scripts || {}; } catch { return null; }
  const text = scripts[script];
  if (typeof text !== 'string' || SHELL_SYNTAX.test(text)) return null;
  return toolOf(text.trim().split(/\s+/));
}

/**
 * Whether the run copies node_modules instead of the symlink overlay, which
 * also drops the app's every right on the checkout. Next.js on Turbopack (its
 * dev default since 16) refuses a node_modules reached by symlinks leaving the
 * project root, and Storybook's esbuild reads package.json in each ancestor of
 * an importer, the checkout root's included, and fails on EACCES (pl-L).
 *
 * It goes by the tool the command runs (commandTool), read through
 * `npm run dev` and its kind to the package.json script, when that can be told
 * for certain: Storybook or Next.js copy, and the dev servers in OVERLAY_TOOLS
 * get the overlay. Anything else goes by the checkout's dependencies, so a
 * Storybook or Next.js behind a shell, a wrapper, a chain of scripts or a
 * workspace flag still gets its copy. A monorepo that merely depends on Storybook keeps
 * the overlay for its other dev servers: a copy of its node_modules can be
 * gigabytes (webapp's is 2.1 GB), more than the first sync's SYNC_READY_MS.
 */
function needsNodeModulesCopy(command, checkout, exists = fs.existsSync, read = fs.readFileSync) {
  const known = commandTool(command, checkout, read);
  if (known && needsCopyTool(known.tool)) {
    return known.tool !== 'next' || (!known.words.includes('--webpack') && !command.includes('--webpack'));
  }
  if (known && OVERLAY_TOOLS.has(known.tool)) return false;
  const has = (pkg) => exists(path.join(checkout, 'node_modules', pkg, 'package.json'));
  if (has('storybook')) return true;
  return has('next') && !command.includes('--webpack');
}

/**
 * The launcher, if this box can use it: root's, writable by nobody else (a
 * launcher the box user could replace could be one that doesn't confine), and
 * on a kernel with Landlock ABI 4 (the TCP port rule). { ok, reason }.
 */
/** What a box without the launcher says to every confined run (its image predates it). */
const LAUNCHER_MISSING = "This box's image predates the preview launcher. Update or recreate the box, then try again.";

/** Whether the launcher can confine a run here: { ok } or { ok: false, code, reason }. */
function launcherUsable(launcher = LAUNCHER, io = {}) {
  const stat = io.statSync || fs.statSync;
  const run = io.execFileSync || execFileSync;
  let st;
  try { st = stat(launcher); } catch {
    // Boxes get the launcher from a bake (packer/scripts/box-lib.sh, install_preview_launcher), not `box update`.
    return { ok: false, code: 'launcher_missing', reason: LAUNCHER_MISSING };
  }
  if (st.uid !== 0 || (st.mode & 0o022) !== 0) return { ok: false, code: 'launcher_unsafe', reason: `${launcher} must be root's and writable by no one else` };
  let abi = 0;
  try { abi = Number(String(run(launcher, ['abi'], { env: {}, timeout: 5000 })).trim()); } catch { /* none */ }
  if (!(abi >= 4)) return { ok: false, code: 'landlock_too_old', reason: `this kernel's Landlock (ABI ${abi || 'none'}) can't confine a run: it needs ABI 4` };
  // An image baked before the loopback rule has a launcher that allows every
  // port but 80, and ignores nothing it's told: refuse it rather than run an
  // app that can reach the owner's debuggers (Devin, #1521).
  let features = '';
  try { features = String(run(launcher, ['features'], { env: {}, timeout: 5000 })); } catch { /* an older launcher */ }
  if (!features.split(/\s+/).includes('tcp-allowlist')) {
    return { ok: false, code: 'launcher_outdated', reason: `This box's preview launcher (${launcher}) predates the loopback rule (TCP to 443 and --allow only). Update or recreate the box, then try again.` };
  }
  return { ok: true };
}

/**
 * The canonical checkout: project dirs may be symlinks (gotcha
 * project-dir-symlinks), so the path is resolved here, and the launcher then
 * opens the result with RESOLVE_NO_SYMLINKS. Resolving alone would let a
 * checkout that is a link to ~/.aws through, so the result must also be a git
 * work tree's root (a .git directory, or a worktree's .git file) under $HOME.
 */
function validateCheckout(checkout, home, io = {}) {
  const realpath = io.realpathSync || fs.realpathSync;
  const lstat = io.lstatSync || fs.lstatSync;
  if (typeof checkout !== 'string' || !path.isAbsolute(checkout)) throw new Error('the checkout must be an absolute path');
  let real;
  try { real = realpath(checkout); } catch { throw new Error(`no checkout at ${checkout}`); }
  const realHome = (() => { try { return realpath(home); } catch { return home; } })();
  if (!real.startsWith(`${realHome}/`)) throw new Error(`the checkout ${real} isn't under ${realHome}`);
  if (!lstat(real).isDirectory()) throw new Error(`the checkout ${real} isn't a directory`);
  let git;
  try { git = lstat(path.join(real, '.git')); } catch { throw new Error(`${real} isn't a git work tree's root`); }
  if (!git.isDirectory() && !git.isFile()) throw new Error(`${real}/.git is neither a directory nor a file`);
  return real;
}

/** A preview-run request's command: 1 to MAX_ARGS strings, none with a NUL. */
function validCommand(command) {
  return Array.isArray(command) && command.length > 0 && command.length <= MAX_ARGS
    && command.every((a) => typeof a === 'string' && a.length <= MAX_ARG_LEN && !a.includes('\0'))
    && command[0].length > 0;
}

class PreviewRuns {
  /**
   * opts: launcher (LAUNCHER), home, stateDir (~/.local/state/termag-preview),
   * features (the launcher's, for tests; else asked once), spawnImpl (tests),
   * cgroupParent (<own cgroup>/preview), log, now; usable (launcherUsable) and
   * classify (--allow's ports) for tests.
   */
  constructor({ launcher = LAUNCHER, home = os.homedir(), stateDir = null, cgroupParent = null, log = () => {}, now = () => Date.now(), usable = launcherUsable, classify = (port) => debuggerOnPort(port), features = null, spawnImpl = spawn, killImpl = (pid, sig) => process.kill(pid, sig), leaseMs = LEASE_MS } = {}) {
    this.spawn = spawnImpl;
    this.classify = classify;
    // What the launcher enforces (`termag-preview features`); null: ask it once (loopbackRule).
    this.features = features;
    this.kill = killImpl;
    // A run lives while its CLI polls it: one nobody has asked about for leaseMs is stopped (sweepLeases), so a CLI
    // killed outright (SIGKILL, the OOM killer) doesn't leave its run up, and vouched for, until the agent restarts
    // (#1520). The CLI polls every 250 ms.
    this.leaseMs = leaseMs;
    this.leaseTimer = null;
    this.launcher = launcher;
    this.home = home;
    // Tests use their own, so a sweep never touches the agent's runs.
    this.stateDirOpt = stateDir;
    this.cgroupParentOpt = cgroupParent;
    this.log = log;
    this.now = now;
    this.usable = usable;
    this.roots = new Map(); // run id -> record
    this.ended = new Map(); // run id -> { id, checkout, port, exit, endedAt, diagnosis }
  }

  get cgroupParent() {
    if (!this.cgroupParentOpt) this.cgroupParentOpt = path.join(ownCgroup(), 'preview');
    return this.cgroupParentOpt;
  }

  get stateDir() { return this.stateDirOpt || path.join(this.home, STATE_DIR); }

  /** Whether pid descends from any root: such a caller can't start or stop runs. */
  /**
   * Whether `pid` runs under a run of this agent's: a descendant of a run's root, or in a run's cgroup, which a
   * process can't leave (seccomp refuses clone3, Landlock makes cgroupfs read-only) as it can leave the ancestry by a
   * double fork (#1520). The socket's backup check; seccomp's AF_UNIX refusal is the real one.
   */
  isConfined(pid, read = fs.readFileSync) {
    if (rootOf(pid, this.roots, read) !== null) return true;
    let line;
    try { line = String(read(`/proc/${pid}/cgroup`, 'utf8')).split('\n').find((l) => l.startsWith('0::')); } catch { return false; }
    if (!line) return false;
    const dir = path.join('/sys/fs/cgroup', line.slice(3));
    let parent;
    try { parent = this.cgroupParent; } catch { return false; }
    return dir.startsWith(`${parent}/`);
  }

  /** The tunnel-open check (listenerConfined) against this agent's roots. */
  /**
   * Whether the launcher enforces the loopback rule (SR9: TCP only to 443 and
   * the declared ports). A run whose launcher allows every port but 80 could
   * reach the owner's unconfined debuggers, so no listener of it is vouched
   * for a wider audience (Cursor Security Agent, #1520). Read once.
   */
  loopbackRule() {
    return this.launcherFeatures().includes('tcp-allowlist');
  }

  /**
   * The installed launcher's features, asked now (a box update may replace it at any time), or the ones the
   * constructor was given (tests). A run records them as they were at its start (start, judge).
   */
  launcherFeatures() {
    if (Array.isArray(this.features)) return this.features;
    try { return String(execFileSync(this.launcher, ['features'], { env: {}, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })).split(/\s+/).filter(Boolean); } catch { return []; }
  }

  /** The launcher binary's identity: what a swap (a box update) changes. Null when it can't be read. */
  launcherIdentity() {
    try { const st = fs.statSync(this.launcher); return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; }
  }

  /**
   * After the relay's dial to `port` connected from local port `peerPort`: whether a process holding the socket that
   * accepted it (the ESTABLISHED row whose peer is ours) descends from a vouched run of `checkout`. The listener check
   * comes before the dial; between them the app could exit, or another process take the port by SO_REUSEPORT
   * (#1520). The accept may lag the handshake, so it's looked for briefly. { ok } or { ok: false, reason }.
   */
  async acceptedConfined(dial, checkout, io = {}) {
    const read = io.readFileSync || fs.readFileSync;
    const { port } = dial;
    let real;
    try { real = fs.realpathSync(checkout); } catch { return { ok: false, reason: `no checkout at ${checkout}` }; }
    const vouched = (pid) => {
      const root = rootOf(pid, this.roots, read);
      return !!(root && runOfCheckout(root.checkout, real) && root.launcher && Array.isArray(root.launcher.features) && root.launcher.features.includes('tcp-allowlist'));
    };
    // A dev server mid-compile can leave the dial in its accept queue for seconds; until it accepts, the row has no
    // socket (inode 0) and names no holder. Its queue can't be told from a stealing listener's (SO_REUSEPORT), so
    // the check waits for the accept, never vouching a holder it hasn't seen: bounded by what's left of the relay's
    // open budget (inside the orchestrator's 15 s wait for the dial back) and ACCEPT_WAIT_MS, with backoff (#1667). Nothing is relayed meanwhile.
    const now = io.now || Date.now;
    const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const waitMs = Math.min(io.waitMs ?? ACCEPT_WAIT_MS, ACCEPT_WAIT_MS);
    const deadline = now() + waitMs;
    for (let delay = 25; ; delay = Math.min(delay * 2, 1000)) {
      const rows = establishedRows(dial, read);
      const holders = holdersOf(new Set(rows.map((r) => r.inode)), io);
      const pids = rows.flatMap((r) => holders.get(r.inode) || []);
      if (pids.length) {
        // Every holder of the relay's own connection, not any: one passed to an unconfined process can read it too
        // (Bugbot and Devin, #1667).
        if (pids.every(vouched)) return { ok: true };
        return { ok: false, reason: `the connection to port ${port} was accepted by a process that isn't a vouched termag preview run of this checkout` };
      }
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(delay, left));
    }
    return { ok: false, slow: true, reason: `the app on port ${port} didn't accept the connection within ${Math.round(waitMs / 1000)} s` };
  }

  listenerConfined(port, checkout, io) {
    // No launcher, no confined run: nothing is vouched for beyond "only me" (Delivery row 5).
    // A look, not launcherUsable's exec: this runs at every tunnel-open.
    if (!fs.existsSync(this.launcher)) return { ok: false, reason: `${LAUNCHER_MISSING} No run on it can be shared beyond the project until then` };
    // The loopback rule is each run's own, recorded at its start (judge), not the binary's now (#1520).
    let real;
    try { real = fs.realpathSync(checkout); } catch { return { ok: false, reason: `no checkout at ${checkout}` }; }
    return listenerConfined(port, real, this.roots, io);
  }

  /** Whether each listener holder on `port` is confined to `checkout`, for preview-listeners. */
  /** `runs`: runPorts' answer for the same ports, when the caller has it already (one walk of /proc). */
  confinedPorts(ports, checkout, runs, io) {
    // Only the runs whose launcher had the loopback rule when they started (runPorts' .vouched; #1520).
    const all = runs instanceof Set && runs.vouched instanceof Set ? runs : this.runPorts(ports, checkout, io);
    return all.vouched instanceof Set ? all.vouched : new Set();
  }

  /**
   * The ports of `ports` a run of `checkout` holds, whether or not this
   * launcher lets the agent vouch for it: its app is the checkout's, though
   * its cwd is the run copy (Bugbot, #1520).
   */
  runPorts(ports, checkout, io) {
    if (this.roots.size === 0 || typeof checkout !== 'string') return new Set();
    let real;
    try { real = fs.realpathSync(checkout); } catch { return new Set(); }
    return confinedAmong(ports, real, this.roots, io);
  }

  /**
   * Start `command` confined to `checkout`. { id, pid, checkout, logPath } once
   * the launcher runs; throws with the reason otherwise.
   */
  async start({ checkout, command, port, allow, copyNodeModules } = {}) {
    const usable = this.usable(this.launcher);
    if (!usable.ok) throw Object.assign(new Error(usable.reason), { code: usable.code });
    checkout = validateCheckout(checkout, this.home);
    if (!validCommand(command)) throw new Error('name the command to run, after --');
    if (port !== undefined && port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error('bad port');
    allow = validAllow(allow);
    // A declared port a debugger, shell or notebook holds would undo the loopback rule (SR6, SR9).
    for (const p of allow) {
      const v = await this.classify(p);
      // Any refusal of the check counts (a debugger, or Docker down so it can't tell); only "nothing listens" doesn't
      // (Bugbot and Devin, #1521).
      if (v && !v.ok && v.code !== 'port_closed') throw new Error(`--allow ${p} is refused: ${v.reason}`);
    }
    const id = crypto.randomBytes(6).toString('hex');
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stateDir, 0o700);
    const runDir = path.join(this.stateDir, id);
    fs.mkdirSync(runDir, { mode: 0o700 }); // fresh: fails if it exists
    fs.mkdirSync(path.join(runDir, 'work'), { mode: 0o700 });
    fs.mkdirSync(path.join(runDir, 'tmp'), { mode: 0o700 });
    const logPath = path.join(this.stateDir, `${id}.log`);
    const logFd = fs.openSync(logPath, 'a', 0o600);
    const common = ['--home', this.home, '--checkout', checkout, '--run', runDir];
    const copy = copyNodeModules ?? needsNodeModulesCopy(command, checkout);
    const rec = { id, checkout, runDir, logPath, logFd, port: port || null, allow, command, cgroup: null, pid: null, startTime: null, startedAt: this.now() };

    // The run's cgroup first: the sync helper joins it too, so cgroup.kill
    // (a run's end, or the next agent's sweep after this one was killed)
    // ends the helper's watch with the app (Bugbot, #1520).
    try {
      fs.mkdirSync(this.cgroupParent, { recursive: true });
      rec.cgroup = path.join(this.cgroupParent, id);
      fs.mkdirSync(rec.cgroup);
    } catch (e) { this.cleanup(rec); throw e; }

    // The sync helper: copies, says "ready", then watches. Confined itself.
    const sync = this.spawn(this.launcher, ['sync', ...common, '--watch', ...(copy ? ['--copy-node-modules'] : [])],
      { stdio: ['ignore', logFd, 'pipe'], env: {}, detached: true });
    rec.sync = sync;
    // First of its exit listeners: once reaped, its pid (and group) may be another process's (cleanup).
    if (typeof sync.once === 'function') sync.once('exit', () => { rec.syncReaped = true; });
    // Before anything that can throw: a failed spawn's 'error' comes on the next tick (Bugbot, #1520).
    let syncFailed = null;
    sync.on('error', (e) => { syncFailed = e; });
    try {
      if (!sync.pid) {
        await new Promise((r) => setImmediate(r));
        throw new Error(`the copy of the checkout didn't start: ${(syncFailed && (syncFailed.code || syncFailed.message)) || 'no process'}`);
      }
      fs.writeFileSync(path.join(rec.cgroup, 'cgroup.procs'), String(sync.pid));
      await new Promise((resolve, reject) => {
        let seen = '';
        const timer = setTimeout(() => reject(new Error('the copy of the checkout took too long')), SYNC_READY_MS);
        sync.stderr.on('data', (b) => {
          if (!rec.cleaned) { try { fs.writeSync(logFd, b); } catch { /* closed */ } }
          if (seen !== null) {
            seen += b;
            if (seen.includes('sync: ready')) { seen = null; clearTimeout(timer); resolve(); }
          }
        });
        sync.on('error', (e) => { clearTimeout(timer); reject(e); });
        sync.on('exit', (code) => { if (seen !== null) { clearTimeout(timer); reject(new Error(`the copy of the checkout failed (${code}): ${seen.trim().slice(-500)}`)); } });
      });
    } catch (e) { this.cleanup(rec); throw e; }
    // From ready on, the sync helper stopping on its own leaves the app serving a copy that no longer follows the
    // checkout: end the run, and say why (Devin, #1520). Attached here, not after the launch, so no gap (Bugbot, #1520).
    sync.on('exit', (code, signal) => {
      if (rec.cleaned) return;
      rec.exit = `sync stopped (${signal || code})`;
      this.log(`[PREVIEW-RUN] id=${id}: the sync helper stopped (${signal || code}); ending the run`);
      this.cleanup(rec);
    });
    if (!rec.cleaned && (sync.exitCode !== null || sync.signalCode)) {
      rec.exit = `sync stopped (${sync.signalCode || sync.exitCode})`;
      this.cleanup(rec);
    }
    // With its exit, so the CLI says why: it gets no run id to ask about (Devin, #1520).
    if (rec.cleaned) throw new Error(`the copy of the checkout stopped before the app started (${rec.exit ?? 'stopped'})`);

    // The launcher this run starts under, as it is now: its identity, and the features it reports. Checked again
    // after the spawn; a swap in between leaves the run with none, so it is never vouched for (#1520).
    const launcherBefore = this.launcherIdentity();
    const launcherFeatures = this.launcherFeatures();
    const args = ['launch', ...common, '--cgroup', rec.cgroup, '--checkout-grant', copy ? 'none' : 'node-modules'];
    if (allow.length) args.push('--allow-tcp', allow.join(','));
    for (const kv of appEnv({ home: this.home, checkout, runDir, port })) args.push('--env', kv);
    args.push('--', ...command);
    const child = this.spawn(this.launcher, args, { stdio: ['ignore', logFd, logFd], env: {}, detached: true });
    // First of its exit listeners: once reaped, its pid (and group) may be another process's (cleanup).
    if (typeof child.once === 'function') child.once('exit', () => { rec.launcherReaped = true; });
    // A spawn that fails (EMFILE, EAGAIN, the launcher gone) emits 'error' on
    // the next tick: handled, it ends the run instead of the agent (Bugbot, #1520).
    child.on('error', (e) => {
      this.log(`[PREVIEW-RUN] id=${id}: the launcher didn't start: ${e.message}`);
      if (rec.cleaned) return;
      rec.exit = `launch failed (${e.code || e.message})`;
      this.cleanup(rec);
    });
    rec.pid = child.pid;
    if (!child.pid) {
      // No pid: the spawn itself failed, and says why on the next tick. The run's record and the caller get that reason (Devin, #1520).
      const e = await new Promise((resolve) => { child.once('error', resolve); setTimeout(() => resolve(null), 200); });
      rec.exit = `launch failed (${(e && (e.code || e.message)) || 'no process'})`;
      this.cleanup(rec);
      throw new Error(`the launcher didn't start: ${(e && (e.code || e.message)) || 'no process'}`);
    }
    const launcherAfter = this.launcherIdentity();
    const same = launcherBefore && launcherAfter && ['dev', 'ino', 'size', 'mtimeMs'].every((k) => launcherBefore[k] === launcherAfter[k]);
    rec.launcher = { path: this.launcher, ...(launcherAfter || {}), features: same ? launcherFeatures : [] };
    rec.startTime = procStat(child.pid)?.startTime ?? null;
    if (!rec.startTime) { this.cleanup(rec); throw new Error('the launcher exited at once'); }
    rec.lastSeen = this.now();
    this.roots.set(id, rec);
    if (!this.leaseTimer && this.leaseMs > 0) {
      this.leaseTimer = setInterval(() => this.sweepLeases(), Math.max(1000, Math.floor(this.leaseMs / 4)));
      if (typeof this.leaseTimer.unref === 'function') this.leaseTimer.unref();
    }
    child.on('exit', (code, signal) => {
      rec.exit = signal || code;
      this.cleanup(rec);
    });
    this.log(`[PREVIEW-RUN] start id=${id} pid=${rec.pid} checkout=${checkout} copy=${copy}`);
    return { id, pid: rec.pid, checkout, logPath, allowed: [HTTPS_PORT, ...allow].sort((a, b) => a - b) };
  }

  /** A run's state: running (with pid), or ended (with exit and the sandbox's refusals named); null if unknown. */
  /** Stops every run nobody has polled for leaseMs; started by start(), unref'd so it never keeps the agent alive. */
  sweepLeases() {
    const now = this.now();
    for (const rec of [...this.roots.values()]) {
      if (now - (rec.lastSeen ?? rec.startedAt) > this.leaseMs) {
        this.log(`[PREVIEW-RUN] ${rec.id} stopped: nobody has asked about it for ${Math.round(this.leaseMs / 1000)} s (its termag preview run went away)`);
        rec.exit = 'lease expired';
        this.cleanup(rec);
      }
    }
    if (this.roots.size === 0 && this.leaseTimer) { clearInterval(this.leaseTimer); this.leaseTimer = null; }
  }

  status(id) {
    if (!RUN_ID_RE.test(String(id))) return null;
    const rec = this.roots.get(id);
    if (rec) rec.lastSeen = this.now();
    // The diagnosis is read once, when the run ends: the CLI polls this several times a second (Bugbot, #1520).
    if (rec) return { id, state: 'running', pid: rec.pid, checkout: rec.checkout, logPath: rec.logPath, diagnosis: [] };
    const e = this.ended.get(id);
    return e ? { id, state: 'ended', exit: e.exit, checkout: e.checkout, logPath: e.logPath, diagnosis: e.diagnosis } : null;
  }

  /** The runs this agent is running. */
  list() {
    return [...this.roots.values()].map((r) => ({ id: r.id, pid: r.pid, checkout: r.checkout, command: r.command, startedAt: new Date(r.startedAt).toISOString() }));
  }

  diagnoseLog(logPath) {
    try { return diagnose(fs.readFileSync(logPath, 'utf8')); } catch { return []; }
  }

  /**
   * Runs a previous agent left behind: their apps would run on unregistered
   * (so unshareable), and their directories would never go. Kill each leftover
   * preview cgroup and clean each leftover run directory.
   */
  sweep() {
    let cgroups = [];
    try { cgroups = fs.readdirSync(this.cgroupParent); } catch { /* none yet */ }
    for (const id of cgroups) {
      const dir = path.join(this.cgroupParent, id);
      try { if (fs.statSync(dir).isDirectory()) fs.writeFileSync(path.join(dir, 'cgroup.kill'), '1'); } catch { /* not a cgroup */ }
    }
    let runs = [];
    try { runs = fs.readdirSync(this.stateDir, { withFileTypes: true }); } catch { return 0; }
    let n = 0;
    for (const e of runs) {
      if (!e.isDirectory() || !RUN_ID_RE.test(e.name) || this.roots.has(e.name)) continue;
      // clean reads only the run directory; the checkout is a placeholder its layout check accepts.
      this.cleanup({ id: e.name, runDir: path.join(this.stateDir, e.name), checkout: path.join(this.home, '.termag-preview-sweep'),
        cgroup: path.join(this.cgroupParent, e.name), sync: null, logFd: -1, swept: true });
      n++;
    }
    // Logs of runs no agent remembers: the ended list starts empty.
    for (const e of runs) {
      const m = /^([0-9a-f]{12})\.log$/.exec(e.name);
      if (e.isFile() && m && !this.roots.has(m[1]) && !this.ended.has(m[1])) { try { fs.unlinkSync(path.join(this.stateDir, e.name)); } catch { /* gone */ } }
    }
    return n;
  }

  stop(id) {
    const rec = this.roots.get(id);
    if (!rec) return false;
    rec.exit = 'stopped';
    this.cleanup(rec);
    return true;
  }

  /** End every run (the agent is stopping). */
  stopAll() { for (const id of [...this.roots.keys()]) this.stop(id); }

  /** End every process of the run, then remove its directory, whatever happened. */
  cleanup(rec) {
    if (rec.cleaned) return;
    rec.cleaned = true;
    this.roots.delete(rec.id);
    if (rec.cgroup) {
      try { fs.writeFileSync(path.join(rec.cgroup, 'cgroup.kill'), '1'); } catch { /* gone */ }
    }
    // Never kill(-0): that would signal this agent's own process group.
    // A group is signalled only while its leader is unreaped: after the exit event its pid, and so the group id,
    // may already be another process's (#1520). What's left of the run then is in its cgroup, killed above.
    if (rec.sync && rec.sync.pid > 0 && !rec.syncReaped) { try { this.kill(-rec.sync.pid, 'SIGKILL'); } catch { /* gone */ } }
    // The launcher's own group too: until it has joined the run's cgroup (right after it starts), cgroup.kill
    // doesn't reach it, and a stop then would leave the app running (Bugbot, #1520).
    if (rec.pid > 0 && !rec.launcherReaped) { try { this.kill(-rec.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (rec.logFd >= 0) { try { fs.closeSync(rec.logFd); } catch { /* closed */ } }
    if (!rec.swept) {
      const diagnosis = this.diagnoseLog(rec.logPath);
      this.ended.set(rec.id, { id: rec.id, checkout: rec.checkout, logPath: rec.logPath, exit: rec.exit ?? null, endedAt: this.now(), diagnosis });
      this.pruneEnded();
      this.log(`[PREVIEW-RUN] end id=${rec.id} exit=${rec.exit ?? 'unknown'}${diagnosis.map((d) => `: ${d.message}`).join('')}`);
    }
    const finish = (tries) => {
      if (rec.cgroup) {
        try { fs.rmdirSync(rec.cgroup); } catch (e) {
          if (e.code === 'EBUSY' && tries > 0) { setTimeout(() => finish(tries - 1), 100); return; }
        }
      }
      // The cleanup helper empties the run directory under its own ruleset,
      // following nothing; then the (empty) directory goes. Not synchronous:
      // a copied node_modules is hundreds of megabytes, and the agent's
      // terminals and tunnels mustn't wait for it (Bugbot, #1520). An agent
      // that exits first leaves it to the next one's sweep.
      let err = '';
      const clean = spawn(this.launcher, ['clean', '--home', this.home, '--checkout', rec.checkout, '--run', rec.runDir],
        { stdio: ['ignore', 'ignore', 'pipe'], env: {} });
      clean.stderr.on('data', (b) => { err += b; });
      clean.on('error', (e) => this.log(`[PREVIEW-RUN] cleanup id=${rec.id}: ${e.message}`));
      clean.on('exit', (code) => {
        if (code !== 0) { this.log(`[PREVIEW-RUN] cleanup id=${rec.id}: exit ${code} ${err.trim().slice(-300)}`); return; }
        try { fs.rmdirSync(rec.runDir); } catch (e) { this.log(`[PREVIEW-RUN] cleanup id=${rec.id}: ${e.message}`); }
      });
    };
    finish(20);
  }

  pruneEnded() {
    const cutoff = this.now() - ENDED_KEEP_MS;
    for (const [id, e] of this.ended) {
      if (e.endedAt < cutoff || this.ended.size > ENDED_MAX) {
        this.ended.delete(id);
        try { fs.unlinkSync(e.logPath); } catch { /* gone */ }
      }
    }
  }
}

module.exports = {
  LAUNCHER, LAUNCHER_MISSING, LEASE_MS, ACCEPT_WAIT_MS, establishedRows, STATE_DIR, parseStat, procStat, rootOf, holdersOf, listenerConfined, confinedAmong, resolveNodeVersion, nvmrcVersion, appPath, appEnv, diagnose, validAllow, debuggerOnPort, probeHost, boxAddresses, tcpReaches, uidShell, canonIp, dockerProxyAddrs, TCP_NOTICE, DEBUG_PORTS, needsNodeModulesCopy, commandTool, toolOf, launcherUsable, validateCheckout, validCommand, PreviewRuns, readSmall,
};
