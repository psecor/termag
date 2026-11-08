'use strict';
/**
 * Host pressure for the box agent:
 * disk used under $HOME's filesystem, memory used, the one-minute load, and
 * how many checkouts the Claude runner kept under ~/ccr/kept because their
 * work was not on GitHub, plus the box's size (cores, total memory) so load
 * and memory can be read against it, and how many
 * SSH and SSM sessions are open, which the orchestrator's idle sweep counts
 * as the box being in use, and how many tunnels
 * are open (`tunnels: { t3, port }`; an open port forward counts as busy (a preview link's tunnel doesn't)
 * too). Carried on the `hello` and answered by the
 * `host-sample` RPC. Linux's /proc and POSIX df; anything unreadable is null,
 * never a guess. The parsers are pure and tested.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CAPABILITIES = ['host-sample-v1'];

/** Percentage of memory in use from /proc/meminfo: (MemTotal - MemAvailable) / MemTotal. */
function parseMeminfo(text) {
  const kb = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text || '');
    return m ? Number(m[1]) : null;
  };
  const total = kb('MemTotal'), available = kb('MemAvailable');
  if (!total || available === null || available > total) return null;
  return Math.round(((total - available) / total) * 100);
}

/** Total memory in MB from /proc/meminfo, or null. */
function parseMemTotalMb(text) {
  const m = /^MemTotal:\s+(\d+)\s*kB/m.exec(text || '');
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

/** The one-minute load average from /proc/loadavg. */
function parseLoadavg(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s/.exec(text || '');
  return m ? Number(m[1]) : null;
}

/** Disk used percentage from `df -Pk <path>`: the Use% column of the one data row. */
function parseDf(text) {
  const lines = (text || '').trim().split('\n');
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity Mounted on
  const cap = cols.length >= 6 ? cols[cols.length - 2] : null;
  const m = cap && /^(\d+)%$/.exec(cap);
  return m ? Number(m[1]) : null;
}

/** Entries under <home>/ccr/kept, or 0 when the directory does not exist. */
function countKept(home) {
  try { return fs.readdirSync(path.join(home, 'ccr', 'kept')).length; } catch { return 0; }
}

/**
 * Whether a /proc/<pid>/cmdline is one open SSH or SSM session: the
 * per-connection sshd child, which retitles itself `sshd: <user>@<tty>` (or
 * `sshd-session: …` from OpenSSH 9.8; the root `[priv]` monitor beside it and
 * the listener don't match), or an SSM `ssm-session-worker`. `termag
 * ssh-config` reaches a box over SSM, so an editor's Remote-SSH session
 * shows as both; any count above zero means someone is connected.
 */
function isSessionProcess(cmdline) {
  const argv0 = String(cmdline || '').split('\0')[0].trim();
  if (/^sshd(?:-session)?: [^\s@\[]+@/.test(argv0)) return true;
  return path.basename(argv0.split(' ')[0]) === 'ssm-session-worker';
}

/** Open SSH and SSM sessions on the box, from /proc; null when /proc can't be listed. */
function countSshSessions(procDir = '/proc') {
  let pids;
  try { pids = fs.readdirSync(procDir).filter(name => /^\d+$/.test(name)); } catch { return null; }
  let n = 0;
  for (const pid of pids) {
    let cmdline;
    try { cmdline = fs.readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8'); } catch { continue; }
    if (isSessionProcess(cmdline)) n++;
  }
  return n;
}

/**
 * The sample, synchronous (the hello is sent synchronously); every field null
 * when unreadable. `tunnels`, the open t3 and port tunnels' counts as
 * `{ t3, port }`, is carried as given when given.
 */
function sampleHostSync(home, { tunnels } = {}) {
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  let df = null;
  try { df = execFileSync('df', ['-Pk', home], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { df = null; }
  const meminfo = read('/proc/meminfo');
  let cores = null;
  try { cores = os.cpus().length || null; } catch { cores = null; }
  return {
    diskUsedPct: parseDf(df),
    memUsedPct: parseMeminfo(meminfo),
    memTotalMb: parseMemTotalMb(meminfo),
    cores,
    load1: parseLoadavg(read('/proc/loadavg')),
    keptCheckouts: countKept(home),
    sshSessions: countSshSessions(),
    ...(tunnels ? { tunnels: { t3: tunnels.t3, port: tunnels.port } } : {}),
    sampledAt: new Date().toISOString(),
  };
}

module.exports = { CAPABILITIES, parseMeminfo, parseMemTotalMb, parseLoadavg, parseDf, countKept, isSessionProcess, countSshSessions, sampleHostSync };
