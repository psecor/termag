'use strict';
// The `preview-listeners` RPC:
// the box's listening TCP ports, for the publish dialog, each with the
// process holding it and the preview guard's verdict: the forward's rules
// plus SR6's refusal of debuggers, shells and notebooks. For the list that is
// by command line alone (port-guard.js checkPreviewListener): probing every
// listener with /json/version would reach a Redis or a database, which log it
// as an attack. The port a publish names (`port`) gets the full check,
// probe included (checkPreviewPort), as every preview tunnel-open does. The
// dialog shows a refused port greyed out with the guard's reason; the
// orchestrator refuses to publish it.
//
//   { cwd?, port? } -> { listeners: [{ port, pid, command, verdict, inCheckout, confined }] }
//
// With `port`, the answer is that port's entry alone (none when nothing
// listens on it), for a publish.
//
// `command` is the holder's command line, cut to COMMAND_MAX characters;
// pid and command are null where the socket isn't this user's to look into
// (a Docker publish, another user's). `inCheckout`: the holder runs from
// `cwd` (the workstream's checkout) or under it. `confined`: every holder of
// the port descends from a `termag preview run` of `cwd`, which a `people` or
// `link` link needs (agent/preview-runs.js; the tunnel-open checks it again).
const fs = require('node:fs');
const { allListenRows, socketOwners, insideDir } = require('./local-listeners');
const portGuard = require('./port-guard');

const COMMAND_MAX = 80;
// Ports one answer lists, lowest first.
const MAX_PORTS = 200;
// Where a connection from the relay can land (port-guard's rule): loopback and the wildcards.
const REACHABLE = new Set(['127.0.0.1', '0.0.0.0', '::']);
const LOOPBACK6_HEX = '00000000000000000000000001000000';

function reachable(row) {
  return REACHABLE.has(row.addr) || row.hex === LOOPBACK6_HEX;
}

/** A process's command line, as `ps` shows it, cut to COMMAND_MAX; null where it can't be read. */
function commandOf(pid, { readFileSync, procRoot }) {
  try {
    const raw = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').replace(/\0+$/, '');
    const text = raw.split('\0').join(' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, COMMAND_MAX) : null;
  } catch { return null; }
}

/**
 * deps (for tests): procRoot ('/proc'), readFileSync, readdirSync,
 * readlinkSync, realpathSync, checkPreviewListener and checkPreviewPort
 * (port-guard's).
 */
async function previewListeners({ cwd, port: probed } = {}, deps = {}) {
  const d = {
    procRoot: '/proc',
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    readlinkSync: fs.readlinkSync,
    realpathSync: fs.realpathSync,
    checkPreviewListener: (port, seen) => portGuard.checkPreviewListener(port, seen),
    checkPreviewPort: (port) => portGuard.checkPreviewPort(port),
    // (ports, checkout) -> Set of confined ports: PreviewRuns#confinedPorts (vouched for a wider audience).
    confinedPorts: () => new Set(),
    // (ports, checkout) -> Set of ports a run of the checkout holds: PreviewRuns#runPorts (the checkout's app).
    runPorts: () => new Set(),
    ...deps,
  };
  const allRows = allListenRows(d.readFileSync, d.procRoot);
  const rows = allRows.filter(reachable);
  // A publish names its port: that one alone is checked, probe included, and
  // answered whatever the list's cap, so a refused listener can't slip past as
  // "not listening yet", and a box with many sockets doesn't make the publish wait.
  const ports = Number.isInteger(probed) && probed > 0
    ? [probed]
    : [...new Set(rows.map((r) => r.port))].sort((a, b) => a - b).slice(0, MAX_PORTS);
  const owners = socketOwners(rows.map((r) => r.inode), { readdirSync: d.readdirSync, readlinkSync: d.readlinkSync }, d.procRoot);
  const dir = typeof cwd === 'string' && cwd.startsWith('/') ? cwd : null;
  // One walk of /proc for both: the run ports, then which of them the agent may vouch for (Devin, #1520).
  const runs = dir ? d.runPorts(ports, dir) : new Set();
  const confined = dir ? d.confinedPorts(ports, dir, runs) : new Set();
  const listeners = [];
  for (const port of ports) {
    const holder = rows.filter((r) => r.port === port).map((r) => owners.get(r.inode)).find(Boolean) || null;
    // The list's checks reuse this one read of the tables and walk of /proc,
    // so a box with many listeners answers within the RPC's timeout.
    const v = port === probed ? await d.checkPreviewPort(port) : await d.checkPreviewListener(port, { allRows, owners });
    // Nothing listens on the publish's port yet: no entry, as the list would have none (U5).
    if (port === probed && v.code === 'port_closed') continue;
    listeners.push({
      port,
      pid: holder ? holder.pid : null,
      command: holder ? commandOf(holder.pid, d) : null,
      verdict: v.ok ? { ok: true } : { ok: false, code: v.code, reason: v.reason },
      // A confined run's holder works in its run directory's copy, so it counts as the checkout's.
      inCheckout: runs.has(port) || confined.has(port) || !!(holder && holder.cwd && dir && insideDir(holder.cwd, dir, d.realpathSync)),
      confined: confined.has(port),
    });
  }
  return { listeners };
}

module.exports = { COMMAND_MAX, MAX_PORTS, previewListeners };
