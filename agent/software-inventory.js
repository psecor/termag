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
    'probe() { n=$1; shift; p=$(command -v "$1" 2>/dev/null) || { printf \'@@%s\\t\\t\\n\' "$n"; return; }; o=$(timeout 10 "$@" 2>&1 </dev/null | head -n 1); printf \'@@%s\\t%s\\t%s\\n\' "$n" "$p" "$o"; }',
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
    const m = probe.re.exec(r.raw);
    return { name: probe.name, ok: !!m, version: m ? m[1] : null, raw: r.raw.slice(0, 200), path: r.path.slice(0, 300) };
  });
}

/** OS name and kernel from /etc/os-release and uname. */
function osEntries(osRelease, kernel) {
  const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease || '');
  const version = /^VERSION_ID="?([^"\n]*)"?/m.exec(osRelease || '');
  return [
    { name: 'os', ok: !!pretty, version: version ? version[1] : null, raw: pretty ? pretty[1] : null, path: null },
    { name: 'kernel', ok: !!kernel, version: kernel || null, raw: kernel || null, path: null },
  ];
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

/** A full inventory: tools, OS and kernel. */
async function collectInventory({ orchestrator = false, execFileImpl = execFile } = {}) {
  const probes = orchestrator ? [...PROBES, ...ORCHESTRATOR_PROBES] : PROBES;
  const started = Date.now();
  const entries = [...await runProbes(probes, execFileImpl), ...osEntries(readOsRelease(), os.release())];
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

module.exports = { CAPABILITIES, PROBES, ORCHESTRATOR_PROBES, probeScript, parseProbeOutput, osEntries, collectInventory, getInventory, warmInventory };

if (require.main === module && process.argv.includes('--json')) {
  collectInventory({ orchestrator: process.argv.includes('--orchestrator') })
    .then(inv => { process.stdout.write(JSON.stringify(inv)); })
    .catch(err => { process.stderr.write(String(err)); process.exit(1); });
}
