'use strict';
/**
 * Software inventory: the versions of the tools
 * sessions on this host actually run, found the way a session finds them (the
 * user's nvm, ~/.local/bin, pyenv shims).
 *
 * The probe list is fixed here, in agent code. The orchestrator can only ask
 * for "your inventory" (the `software-inventory` RPC); it can never add a
 * command, so the inventory is not a remote-execution channel.
 *
 * One bash runs every probe in turn, each under `timeout 10`, and prints one
 * `@@name<TAB>path<TAB>first line` record per probe. The parser is pure and
 * tested. Results are cached for five minutes; the agent warms the cache
 * shortly after start.
 *
 * Also runnable as `node software-inventory.js --json [--orchestrator]`: the
 * backend uses that for the orchestrator host's own inventory.
 */
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const CAPABILITIES = ['software-inventory-v1'];
const CACHE_MS = 5 * 60_000;

/** name, command (fixed), and how to read the version from its first line. */
const PROBES = [
  { name: 'claude', cmd: 'claude --version', re: /(\d+\.\d+\.\d+)/ },
  { name: 'codex', cmd: 'codex --version', re: /(\d+\.\d+\.\d+)/ },
  { name: 'cursor-agent', cmd: 'cursor-agent --version', re: /(\d{4}\.\d{2}\.\d{2}(?:-[0-9a-f]+)?)/ },
  { name: 'devin', cmd: 'devin --version', re: /(\d+\.\d+\.\d+)/ },
  { name: 'pi', cmd: 'pi --version', re: /(\d+\.\d+\.\d+)/ },
  { name: 'node', cmd: 'node --version', re: /v?(\d+\.\d+\.\d+)/ },
  { name: 'npm', cmd: 'npm --version', re: /(\d+\.\d+\.\d+)/ },
  { name: 'gh', cmd: 'gh --version', re: /gh version (\d+\.\d+\.\d+)/ },
  { name: 'aws', cmd: 'aws --version', re: /aws-cli\/(\d+\.\d+\.\d+)/ },
  { name: 'tmux', cmd: 'tmux -V', re: /tmux (\S+)/ },
  { name: 'git', cmd: 'git --version', re: /git version (\d+\.\d+\.\d+)/ },
  { name: 'docker', cmd: 'docker --version', re: /Docker version (\d+\.\d+\.\d+)/ },
  { name: 'python', cmd: 'python3 --version', re: /Python (\d+\.\d+\.\d+)/ },
];

/** Only on the orchestrator host (`--orchestrator`). */
const ORCHESTRATOR_PROBES = [
  { name: 'nginx', cmd: 'nginx -v', re: /nginx\/(\d+\.\d+\.\d+)/, path: '/usr/sbin' },
  { name: 'envoy', cmd: 'envoy --version', re: /version: [0-9a-f]+\/(\d+\.\d+\.\d+)/ },
  { name: 'otelcol', cmd: 'otelcol-contrib --version', re: /version (\d+\.\d+\.\d+)/ },
];

const NAME_RE = /^[a-z0-9-]+$/;

/** The bash script for a probe list. Every word in it comes from the lists above. */
function probeScript(probes) {
  const lines = [
    '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1',
    'PATH="$HOME/.local/bin:$HOME/.pyenv/shims:$PATH:/usr/sbin:/usr/local/sbin"',
    // The first five lines of output, joined with \x1f (one record per probe): a
    // tool that prints a notice or a warning ahead of its version (a cursor-agent
    // update or migration notice, a Node warning on stderr) is still read.
    'probe() { n=$1; shift; p=$(command -v "$1" 2>/dev/null) || { printf \'@@%s\\t\\t\\n\' "$n"; return; }; o=$(timeout 10 "$@" 2>&1 </dev/null | head -n 5 | tr -d \'\\r\\t\' | tr \'\\n\' \'\\037\'); printf \'@@%s\\t%s\\t%s\\n\' "$n" "$p" "${o%$\'\\037\'}"; }',
  ];
  for (const p of probes) {
    if (!NAME_RE.test(p.name) || !/^[a-z0-9-]+( -?-?[A-Za-z]+)*$/.test(p.cmd)) throw new Error(`bad probe ${p.name}`);
    lines.push(`probe ${p.name} ${p.cmd}`);
  }
  return lines.join('\n');
}

/** Parse the script's output into inventory entries, in probe order. */
function parseProbeOutput(text, probes) {
  const byName = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('@@')) continue;
    const [name, p = '', ...rest] = line.slice(2).split('\t');
    byName.set(name, { path: p, raw: rest.join('\t').trim() });
  }
  return probes.map(probe => {
    const r = byName.get(probe.name);
    if (!r || !r.path) return { name: probe.name, ok: false, version: null, raw: null, path: null };
    // The line that is the version alone (cursor-agent's), else the first of its lines the version reads
    // from; raw is that line, else the first. A notice that mentions a date or another build cannot win
    // over the version line itself (Bugbot on #1080).
    const lines = r.raw.split('\x1f').map(l => l.trim()).filter(Boolean);
    let m = null;
    let raw = lines[0] ?? '';
    for (const l of lines) { const x = probe.re.exec(l); if (x && x[0] === l) { m = x; raw = l; break; } }
    if (!m) for (const l of lines) { const x = probe.re.exec(l); if (x) { m = x; raw = l; break; } }
    return { name: probe.name, ok: !!m, version: m ? m[1] : null, raw: raw.slice(0, 200), path: r.path.slice(0, 300) };
  });
}

/** OS name and kernel from /etc/os-release and uname; kernelRaw is the line the tab shows on hover. */
function osEntries(osRelease, kernel, kernelRaw = kernel) {
  const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease || '');
  const version = /^VERSION_ID="?([^"\n]*)"?/m.exec(osRelease || '');
  return [
    { name: 'os', ok: !!pretty, version: version ? version[1] : null, raw: pretty ? pretty[1] : null, path: null },
    { name: 'kernel', ok: !!kernel, version: kernel || null, raw: (kernelRaw || kernel || '').slice(0, 200) || null, path: null },
  ];
}

// A kernel release as uname and /boot name it: 6.8.0-1067-aws, 7.0.0-1014-aws, 6.8.0-147-generic.
const RELEASE_RE = /^\d+\.\d+\.\d+-\d+(?:-[a-z0-9]+)*$/;
/** Order two kernel releases by their numbers (6.8.0-1067 < 6.8.0-1068 < 7.0.0-1014). */
function compareReleases(a, b) {
  const na = (a.match(/\d+/g) || []).map(Number); const nb = (b.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) { const d = (na[i] ?? 0) - (nb[i] ?? 0); if (d) return d; }
  return 0;
}
const iso = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

/**
 * Pure: the installed kernels and whether the host waits on a reboot, from what readKernelState found.
 *
 * - `kernel-installed`: the newest kernel in /boot, which is what the next boot runs (grub's default is the
 *   /boot/vmlinuz link to it). No kernel there (no /boot, or an empty one: a container) is missing.
 * - `reboot`: `pending` when /run/reboot-required exists (a package's postinst asked: a kernel, libc, systemd)
 *   or a newer kernel than the running one is installed, else `no`; `unknown` with no kernel in /boot. Its raw says since when (the oldest of the
 *   two signals, never before the boot) and why, which the tab shows as "pending 3 d".
 */
function kernelEntries({ running, bootedAt = null, installed = null, rebootRequired = null }) {
  const out = [];
  // No kernel in /boot (no /boot, or an empty one: a container's) is a fact, not a probe that failed: it is
  // written over what the host reported before (an ok:false row with a path is transient and would keep a
  // stale kernel and "pending", store.ts entriesToWrite). kernel-installed is missing, and reboot is
  // `unknown`, never "no", since nothing says what the next boot runs (Devin on #1218).
  const found = Array.isArray(installed) ? installed.filter(k => RELEASE_RE.test(k.release)).sort((a, b) => compareReleases(b.release, a.release)) : [];
  const releases = found.length ? found : null;
  const newest = releases && releases.length ? releases[0] : null;
  out.push(newest
    ? { name: 'kernel-installed', ok: true, version: newest.release, raw: releases.map(k => k.release).join(', ').slice(0, 200), path: '/boot' }
    : { name: 'kernel-installed', ok: false, version: null, raw: null, path: null });
  const newerKernel = newest && running && RELEASE_RE.test(running) && compareReleases(newest.release, running) > 0 ? newest : null;
  if (!rebootRequired && !newerKernel) {
    out.push(releases ? { name: 'reboot', ok: true, version: 'no', raw: bootedAt ? `booted ${iso(bootedAt)}` : null, path: null }
      : { name: 'reboot', ok: true, version: 'unknown', raw: 'no kernel in /boot', path: null });
    return out;
  }
  const since = Math.max(Math.min(...[rebootRequired?.at, newerKernel?.at].filter(t => Number.isFinite(t) && t > 0)), bootedAt ?? 0);
  const why = [
    newerKernel ? `kernel ${newerKernel.release} installed` : null,
    rebootRequired?.pkgs?.length ? `packages: ${[...new Set(rebootRequired.pkgs)].join(', ')}` : rebootRequired ? 'reboot-required' : null,
  ].filter(Boolean).join(' · ');
  out.push({ name: 'reboot', ok: true, version: 'pending', raw: [Number.isFinite(since) && since > 0 ? `since ${iso(since)}` : null, why].filter(Boolean).join(' · ').slice(0, 200), path: null });
  return out;
}

/** When a file came to be: its birth time where the filesystem keeps one (ext4, tmpfs), else its ctime. */
function bornAt(st) { return st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs; }

/** What kernelEntries reads: /boot's kernels, /run/reboot-required(.pkgs) and the boot time. Never throws. */
function readKernelState(fsImpl = fs) {
  let bootedAt = null;
  try { const m = /^btime (\d+)$/m.exec(fsImpl.readFileSync('/proc/stat', 'utf8')); if (m) bootedAt = Number(m[1]) * 1000; } catch { /* not Linux */ }
  let installed = null;
  try {
    installed = fsImpl.readdirSync('/boot').filter(n => n.startsWith('vmlinuz-')).map(n => {
      let at = null; try { at = bornAt(fsImpl.statSync(`/boot/${n}`)); } catch { /* raced a removal */ }
      return { release: n.slice('vmlinuz-'.length), at };
    });
  } catch { /* no /boot (a container) */ }
  let rebootRequired = null;
  try {
    const st = fsImpl.statSync('/run/reboot-required');
    let pkgs = []; let at = st.mtimeMs;
    try {
      pkgs = fsImpl.readFileSync('/run/reboot-required.pkgs', 'utf8').split('\n').map(l => l.trim()).filter(l => /^[a-z0-9][a-z0-9+.-]*$/.test(l)).slice(0, 20);
      at = Math.min(at, bornAt(fsImpl.statSync('/run/reboot-required.pkgs')));
    } catch { /* no package list */ }
    rebootRequired = { at, pkgs };
  } catch { /* no reboot asked for */ }
  return { bootedAt, installed, rebootRequired };
}

function readOsRelease() {
  try { return fs.readFileSync('/etc/os-release', 'utf8'); } catch { return ''; }
}

function runProbes(probes, execFileImpl = execFile) {
  return new Promise(resolve => {
    execFileImpl('bash', ['-c', probeScript(probes)], { timeout: 120_000, maxBuffer: 256 * 1024, env: { ...process.env, HOME: os.homedir() } },
      (_err, stdout) => resolve(parseProbeOutput(stdout, probes)));
  });
}

/** A full inventory: tools, OS, the running and installed kernels, and whether a reboot is pending. */
async function collectInventory({ orchestrator = false, execFileImpl = execFile } = {}) {
  const probes = orchestrator ? [...PROBES, ...ORCHESTRATOR_PROBES] : PROBES;
  const started = Date.now();
  const kernel = readKernelState();
  const running = os.release();
  const kernelRaw = [running, typeof os.version === 'function' ? os.version() : null, kernel.bootedAt ? `booted ${iso(kernel.bootedAt)}` : null].filter(Boolean).join(' · ');
  const entries = [...await runProbes(probes, execFileImpl), ...osEntries(readOsRelease(), running, kernelRaw), ...kernelEntries({ running, ...kernel })];
  return { schema: 1, collectedAt: new Date().toISOString(), tookMs: Date.now() - started, entries };
}

let cached = null;
let inFlight = null;

/** The cached inventory when fresh, else a new run (one at a time). */
function getInventory(now = Date.now()) {
  if (cached && now - Date.parse(cached.collectedAt) < CACHE_MS) return Promise.resolve(cached);
  if (!inFlight) inFlight = collectInventory().then(inv => { cached = inv; return inv; }).finally(() => { inFlight = null; });
  return inFlight;
}

/** Warm the cache a little after start, so the first request is instant. */
function warmInventory(delayMs = 30_000) {
  const t = setTimeout(() => { getInventory().catch(() => {}); }, delayMs);
  t.unref?.();
}

module.exports = { CAPABILITIES, PROBES, ORCHESTRATOR_PROBES, probeScript, parseProbeOutput, osEntries, kernelEntries, readKernelState, compareReleases, collectInventory, getInventory, warmInventory };

if (require.main === module && process.argv.includes('--json')) {
  collectInventory({ orchestrator: process.argv.includes('--orchestrator') })
    .then(inv => { process.stdout.write(JSON.stringify(inv)); })
    .catch(err => { process.stderr.write(String(err)); process.exit(1); });
}
