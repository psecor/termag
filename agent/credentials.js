// Credential delivery on the box side.
//
// The logic lives in deploy/termag-credentials, which termag-reconcile keeps
// current on boot, because this agent has no hot reload and many boxes run old
// agent code. This module only spawns it with the payload on stdin. Payloads
// are never logged.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// telemetry-replay-v1: deploy/termag-credentials has `telemetry-launch`, so the
// orchestrator may type `claude --settings "$(termag-credentials telemetry-launch
// <replay id>)"` to file a browser-started session's spans under its replay.
// agent-telemetry-v1: the script takes the agent-telemetry provider (Codex,
// Cursor, Devin and pi) and termag-reconcile installs
// termag-agent-otel, so the orchestrator may type launches through it.
// mcp-broker-v1: the script takes the mcp provider (Claude Code mcpServers
// entries pointed at the MCP broker) and termag-reconcile installs
// termag-mcp-headers.
// fireworks-v1: the script takes the fireworks provider (pi's provider and the
// Claude Code settings `launch-settings` hands it).
// bazel-cache-v2: the script takes the bazel-cache provider, the shared Bazel
// cache's block in /etc/bazel.bazelrc, rendered from the delivery's values
// (S3 read anonymously, no credential), and a bazel-cache remove passes its
// flushGeneration and seq on ("How the
// block reaches boxes"). Not -v1: the option-A drafts used that name for a
// token fetch.
const BASE_CAPABILITIES = ['credentials-v1', 'github-broker-v1', 'telemetry-v1', 'telemetry-replay-v1', 'agent-telemetry-v1', 'mcp-broker-v1', 'fireworks-v1', 'bazel-cache-v2'];
const PROVIDERS = ['claude-gateway', 'github', 'telemetry', 'agent-telemetry', 'mcp', 'fireworks', 'bazel-cache'];

const DEFAULT_SCRIPT = path.join(__dirname, '..', 'deploy', 'termag-credentials');
// Where a launch finds the scripts. A launch the orchestrator types into a
// pane (`termag-credentials launch-settings`, `termag-pi-fireworks`;
// services/launchCommand.ts) runs the copy the pane's PATH finds, not the
// checkout's. On a box that is the one termag-reconcile installs in
// ~/.local/bin (its table, `bin`), which the pane's shell puts first, and
// only a reconcile moves it forward: a checkout pulled by hand, or by a run
// whose reconcile failed, carries a marker that copy may not. A host without
// it runs whatever its PATH holds, so the agent's PATH comes next.
function installedDirs(env = process.env, home = os.homedir() || env.HOME || '/') {
  const fromPath = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  return [path.join(home, '.local', 'bin'), ...fromPath];
}

// mcp-broker-v2: the mcp provider also takes `agents`, the other agent CLIs
// to register the connectors with through termag-mcp-bridge (mcp-bridge.js).
// That half lives in the script, which
// can land on a box before or after this file, so it is advertised only when
// the script carries the marker, and read again at every hello: a script
// updated under a running agent is picked up at its next connect.
const MCP_AGENTS_CAPABILITY = 'mcp-broker-v2';
const MCP_AGENTS_MARKER = 'termag-credentials: mcp-broker-v2';

// fireworks-menu-v1: `launch-settings --models` takes the flag's model list
// for Claude Code's /model menu. Read from the script the
// same way: an older script would take `--models` for the replay id. The
// launch runs the installed copy, so both copies must carry the marker: a
// checkout pulled without a reconcile is ahead of it.
const FIREWORKS_MENU_CAPABILITY = 'fireworks-menu-v1';
const FIREWORKS_MENU_MARKER = 'termag-credentials: fireworks-menu-v1';

// fireworks-pi-menu-v1: `termag-pi-fireworks --models` hands the flag's
// model list to `termag-credentials pi-model`, which writes them all into
// pi's provider for its /model. Both scripts must carry
// their marker, in the installed copies as well as the checkout's: an older
// launcher would pass `--models` on to pi, and an older pi-model refuses it.
const FIREWORKS_PI_MENU_CAPABILITY = 'fireworks-pi-menu-v1';
const FIREWORKS_PI_MENU_MARKER = 'termag-credentials: fireworks-pi-menu-v1';
const FIREWORKS_PI_LAUNCHER_MARKER = 'termag-pi-fireworks: fireworks-pi-menu-v1';

function scriptHas(marker, script = DEFAULT_SCRIPT, readFile = fs.readFileSync) {
  try {
    return String(readFile(script, 'utf8')).includes(marker);
  } catch {
    return false;
  }
}

// The copy of `name` a launch would run: the first in `dirs` there is.
function launchCopy(name, dirs, readFile) {
  for (const dir of dirs) {
    const file = path.join(dir, name);
    try {
      readFile(file, 'utf8');
      return file;
    } catch { /* not here */ }
  }
  return null;
}

// `script` is the checkout's termag-credentials, what applyCredential runs, and
// `dirs` is where a typed launch looks for its copies (installedDirs).
// mcp-broker-v2 is read from the checkout's script alone, since only
// applyCredential relies on it.
function capabilitiesFor(script = DEFAULT_SCRIPT, readFile = fs.readFileSync, dirs = installedDirs()) {
  const launcher = path.join(path.dirname(script), 'termag-pi-fireworks');
  const searched = Array.isArray(dirs) ? dirs : [dirs];
  // The checkout's copy and the one a launch would run.
  const bothHave = (marker, checkoutCopy, name) => {
    if (!scriptHas(marker, checkoutCopy, readFile)) return false;
    const copy = launchCopy(name, searched, readFile);
    return copy !== null && scriptHas(marker, copy, readFile);
  };
  return [
    ...BASE_CAPABILITIES,
    ...(scriptHas(MCP_AGENTS_MARKER, script, readFile) ? [MCP_AGENTS_CAPABILITY] : []),
    ...(bothHave(FIREWORKS_MENU_MARKER, script, 'termag-credentials') ? [FIREWORKS_MENU_CAPABILITY] : []),
    ...(bothHave(FIREWORKS_PI_MENU_MARKER, script, 'termag-credentials')
      && bothHave(FIREWORKS_PI_LAUNCHER_MARKER, launcher, 'termag-pi-fireworks')
      ? [FIREWORKS_PI_MENU_CAPABILITY] : []),
  ];
}

// The git credential helper and Claude Code's apiKeyHelper, both configured by
// termag-credentials, read the box token from here, so the token itself is
// never copied into git's config or Claude Code's settings.
let agentConfigPath = null;
function configure({ agentConfig }) { agentConfigPath = agentConfig; }

function runCredentialsScript(args, stdin, script = DEFAULT_SCRIPT) {
  return new Promise((resolve, reject) => {
    const env = agentConfigPath ? { ...process.env, TERMAG_AGENT_CONFIG: agentConfigPath } : process.env;
    const child = spawn(script, args, { stdio: ['pipe', 'ignore', 'pipe'], env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`termag-credentials ${args.join(' ')} exited ${code}: ${stderr.trim().split('\n').pop() || ''}`));
    });
    child.stdin.end(stdin ?? '');
  });
}

function applyCredential(provider, payload, script) {
  if (!PROVIDERS.includes(provider)) return Promise.reject(new Error(`unknown credential provider: ${provider}`));
  if (!payload || typeof payload !== 'object') return Promise.reject(new Error('credentials-apply needs a payload'));
  return runCredentialsScript(['apply', provider], JSON.stringify(payload), script);
}

// What a credentials-remove frame carries besides its reason. Only bazel-cache's
// has more: flushGeneration (so a raised flush reaches a box whose block is
// off) and seq (so a remove older than the last apply is refused). The script
// validates them; this only passes on what is there.
function removeExtras(msg) {
  if (!msg || msg.provider !== 'bazel-cache') return {};
  const extras = {};
  for (const key of ['flushGeneration', 'seq']) if (msg[key] !== undefined) extras[key] = msg[key];
  return extras;
}

// The orchestrator says why it removed a credential; the script records it for
// `termag-credentials status`.
function removeCredential(provider, script, reason, extras = {}) {
  if (!PROVIDERS.includes(provider)) return Promise.reject(new Error(`unknown credential provider: ${provider}`));
  const body = { ...(typeof reason === 'string' ? { reason } : {}), ...extras };
  return runCredentialsScript(['remove', provider], Object.keys(body).length ? JSON.stringify(body) : '', script);
}

module.exports = {
  get CAPABILITIES() { return capabilitiesFor(); },
  capabilitiesFor,
  installedDirs,
  MCP_AGENTS_CAPABILITY,
  MCP_AGENTS_MARKER,
  FIREWORKS_MENU_CAPABILITY,
  FIREWORKS_MENU_MARKER,
  FIREWORKS_PI_MENU_CAPABILITY,
  FIREWORKS_PI_MENU_MARKER,
  FIREWORKS_PI_LAUNCHER_MARKER,
  configure,
  PROVIDERS,
  applyCredential,
  removeCredential,
  removeExtras,
};
