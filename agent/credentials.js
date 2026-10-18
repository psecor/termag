// Credential delivery on the box side.
//
// The logic lives in deploy/termag-credentials, which termag-reconcile keeps
// current on boot, because this agent has no hot reload and many boxes run old
// agent code. This module only spawns it with the payload on stdin. Payloads
// are never logged.

const { spawn } = require('child_process');
const path = require('path');

// telemetry-replay-v1: deploy/termag-credentials has `telemetry-launch`, so the
// orchestrator may type `claude --settings "$(termag-credentials telemetry-launch
// <replay id>)"` to file a browser-started session's spans under its replay.
// agent-telemetry-v1: the script takes the agent-telemetry provider (Codex,
// Cursor, Devin and pi) and termag-reconcile installs
// termag-agent-otel, so the orchestrator may type launches through it.
const CAPABILITIES = ['credentials-v1', 'github-broker-v1', 'telemetry-v1', 'telemetry-replay-v1', 'agent-telemetry-v1'];
const PROVIDERS = ['claude-gateway', 'github', 'telemetry', 'agent-telemetry'];

const DEFAULT_SCRIPT = path.join(__dirname, '..', 'deploy', 'termag-credentials');

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

// The orchestrator says why it removed a credential; the script records it for
// `termag-credentials status`.
function removeCredential(provider, script, reason) {
  if (!PROVIDERS.includes(provider)) return Promise.reject(new Error(`unknown credential provider: ${provider}`));
  return runCredentialsScript(['remove', provider], typeof reason === 'string' ? JSON.stringify({ reason }) : '', script);
}

module.exports = {
  CAPABILITIES,
  configure,
  PROVIDERS,
  applyCredential,
  removeCredential,
};
