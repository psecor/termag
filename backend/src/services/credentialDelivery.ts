/**
 * Getting a user's credentials onto their boxes.
 *
 * Copied credentials (the GitHub fallback), the Claude gateway settings and
 * the agents' telemetry settings are pushed with credentials-apply / credentials-remove on every connect and on
 * every change, so rotation and deletion reach boxes the same way a first
 * delivery does; the box script content-compares, so a repeat is a no-op.
 * Neither holds a credential: the gateway and the GitHub broker both take the
 * box's own agent token and check it with the orchestrator on each request.
 *
 * Delivery needs a managed (EC2, owned) box whose agent advertised
 * credentials-v1, however it connected: nothing delivered is a secret.
 * External boxes and older agents keep today's flow.
 */

import { prisma } from '../db';
import { otlpDestinationFromEnv, type OtlpDestination } from '../config/env';
import { connectedOwnedBoxIds, instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import { isManagedBox, type AgentConnection } from './instanceLifecycle';
import { getClaudeGatewayConfig, gatewaySettings } from './claudeGateway';
import { fireworksEnabledForBox } from './fireworksFlag';
import { FIREWORKS_CAPABILITY, fireworksDelivery, getFireworksGatewayConfig } from './fireworksGateway';
import { getCredentialStoreConfig, githubStoreDeps } from './credentialStore';
import { getGithubBrokerUrl } from './githubBroker';
import { AGENT_TELEMETRY_CAPABILITY } from './launchCommand';
import { listConnectors, mcpBrokerEnabledForBox } from './mcpConnectorStore';
import { getMcpBrokerUrl } from './mcpConnectors';

export const CREDENTIALS_CAPABILITY = 'credentials-v1';
// The box routes git and gh through the orchestrator's GitHub broker. An agent
// with only credentials-v1 would install a token and key, so it gets remove.
export const GITHUB_BROKER_CAPABILITY = 'github-broker-v1';
// The box merges Claude Code's OpenTelemetry settings into the owner's
// settings.json. An agent without it gets no telemetry step: its
// termag-credentials would refuse the provider.
export const TELEMETRY_CAPABILITY = 'telemetry-v1';
// AGENT_TELEMETRY_CAPABILITY: the box records the destination for Codex,
// Cursor, Devin and pi, installs Cursor's hook, and has termag-agent-otel for
// the launches. An agent without it gets no
// agent-telemetry step.
export { AGENT_TELEMETRY_CAPABILITY };
// The box writes one Claude Code mcpServers entry per connector, pointed at
// the MCP broker with termag-mcp-headers. An agent
// without it gets no mcp step.
export const MCP_BROKER_CAPABILITY = 'mcp-broker-v1';
// The box writes pi's Fireworks provider and the Claude Code settings
// `termag-credentials launch-settings` prints. An agent without
// it gets no fireworks step.
export { FIREWORKS_CAPABILITY };
export const PROVIDERS = ['claude-gateway', 'github', 'telemetry', 'agent-telemetry', 'mcp', 'fireworks'] as const;
export type Provider = typeof PROVIDERS[number];

const GATED: Partial<Record<Provider, string>> = {
  telemetry: TELEMETRY_CAPABILITY,
  'agent-telemetry': AGENT_TELEMETRY_CAPABILITY,
  mcp: MCP_BROKER_CAPABILITY,
  fireworks: FIREWORKS_CAPABILITY,
};

/** The providers an agent with these capabilities can be sent steps for. */
export function providersFor(capabilities: string[]): Provider[] {
  return PROVIDERS.filter(p => {
    const gate = GATED[p];
    return !gate || capabilities.includes(gate);
  });
}

// User and box ids go into OTEL_RESOURCE_ATTRIBUTES unescaped, so ids only.
const CONTEXT_KEY = /^[A-Za-z0-9_-]+$/;

// Settings env overrides only the variables it names, so whatever exporter
// setup the owner's shell exports would ride on our endpoint: a collector
// credential (headers, client key and certificate, generic or per signal) or
// a per-signal endpoint or protocol. Each is named here, empty, which Claude
// Code's exporter reads as unset (deploy/termag-credentials allows these keys
// only empty). The runner unsets the same variables instead.
const SIGNALS = ['METRICS', 'LOGS', 'TRACES'];
const CREDENTIAL_VARS = ['HEADERS', 'CLIENT_KEY', 'CLIENT_CERTIFICATE'];
const BLANKED = Object.fromEntries([
  ...CREDENTIAL_VARS.map(v => `OTEL_EXPORTER_OTLP_${v}`),
  ...SIGNALS.flatMap(s => [...CREDENTIAL_VARS, 'ENDPOINT', 'PROTOCOL'].map(v => `OTEL_EXPORTER_OTLP_${s}_${v}`)),
].map(k => [k, '']));

/**
 * Claude Code's OpenTelemetry for the interactive sessions on a box, as the
 * settings.json `env` keys termag-credentials merges in: the same export a
 * cloud runner session gets (deploy/termag-claude-runner), metrics, events and
 * traces to the configured project over OTLP/HTTP, with the owner's and the
 * box's ids. Metadata only: no OTEL_LOG_* gate is set, so spans and
 * events carry no prompt, response or tool content, and no exporter setup from
 * the owner's shell is left to ride on it (BLANKED). The box adds termag.box,
 * and the launch adds termag.project and termag.workstream
 * (termag-credentials telemetry-launch, services/launchCommand.ts).
 *
 * Every agent's resource carries the same four: termag.agent (claude here;
 * the other agents' pieces add theirs), termag.session.kind, termag.project
 * and termag.workstream, so one query shape covers them all.
 */
export function sessionTelemetrySettings(dest: OtlpDestination, keys: { user: string; box: string }): { env: Record<string, string> } {
  const attributes = interactiveResource(dest, keys, 'service.name=termag-claude-session,termag.agent=claude,');
  return {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_ENDPOINT: dest.endpoint,
      OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
      OTEL_RESOURCE_ATTRIBUTES: attributes,
      ...BLANKED,
    },
  };
}

// The interactive resource every agent on a box shares; the service name is
// each agent's own.
function interactiveResource(dest: OtlpDestination, keys: { user: string; box: string }, service = ''): string {
  let attributes = `telemetry.project_id=${dest.project},${service}termag.session.kind=interactive`;
  if (CONTEXT_KEY.test(keys.user) && CONTEXT_KEY.test(keys.box)) {
    attributes += `,termag.user.id=${keys.user},termag.box.id=${keys.box}`;
  }
  return attributes;
}

/**
 * The same destination and resource for the box's other agents (Codex,
 * Cursor, Devin, pi), which share no settings file with Claude Code: the box
 * records it and each agent's piece adds its own service.name and termag.agent.
 * Only an origin and attributes, so there is no
 * header or content switch to deliver.
 */
export function agentTelemetrySettings(dest: OtlpDestination, keys: { user: string; box: string }): { endpoint: string; resourceAttributes: string } {
  return { endpoint: dest.endpoint, resourceAttributes: interactiveResource(dest, keys) };
}

export type DeliveryStep =
  | { type: 'credentials-apply'; provider: Provider; payload: Record<string, unknown> }
  // The reason is shown on the box (termag-credentials status), so a box without a credential says why instead of failing quietly.
  | { type: 'credentials-remove'; provider: Provider; reason: string };

export interface DeliveryInput {
  // The Claude gateway settings when the gateway is configured and the user hasn't
  // skipped it; null otherwise.
  claudeSettings: Record<string, unknown> | null;
  claudeOffReason: string;
  // Set when the owner has a GitHub credential and the broker has a URL.
  githubBroker: { url: string; login: string } | null;
  githubOffReason: string;
  // The stored GitHub row could not be read (KMS, a bad ciphertext). The box
  // gets no GitHub step, so a transient failure neither strips a working
  // broker nor holds up the other providers.
  githubUnknown?: boolean;
  // sessionTelemetrySettings when the orchestrator ships telemetry (otlpDestinationFromEnv).
  telemetry?: { env: Record<string, string> } | null;
  // agentTelemetrySettings, under the same condition.
  agentTelemetry?: { endpoint: string; resourceAttributes: string } | null;
  // The broker and the owner's connectors (ids and names only) when the broker
  // is configured and mcp-broker-enabled is on for the owner and box.
  mcp?: { broker: string; connectors: { id: string; name: string }[] } | null;
  mcpOffReason?: string;
  // The connectors could not be read: no mcp step, as for githubUnknown.
  mcpUnknown?: boolean;
  // fireworksDelivery when the orchestrator has a Fireworks config and
  // fireworks-enabled is on for the owner and box.
  fireworks?: Record<string, unknown> | null;
  fireworksOffReason?: string;
  // The flag could not be read: no fireworks step, as for githubUnknown.
  fireworksUnknown?: boolean;
}

export const REASONS = {
  notManaged: 'this is not a termag-managed box, so termag delivers no credentials to it',
  oldAgent: "this box's termag agent predates the GitHub broker; update it (termag-reconcile) to get GitHub through termag",
  noGateway: 'the orchestrator has no Claude gateway configured; log in to Claude on this box',
  gatewayOff: 'Claude through the termag gateway is turned off on the Credentials page',
  noStore: 'the orchestrator has no credential store configured',
  noBroker: "the orchestrator has no GitHub broker URL (GITHUB_BROKER_URL, the gateway's GitHub host)",
  notConnected: 'GitHub is not connected: paste `gh auth token` on the termag Credentials page',
  noTelemetry: 'the orchestrator ships no telemetry (OBSERVABILITY_OTLP_ENDPOINT and OBSERVABILITY_PROJECT), so Claude Code here exports none',
  noAgentTelemetry: 'the orchestrator ships no telemetry (OBSERVABILITY_OTLP_ENDPOINT and OBSERVABILITY_PROJECT), so Codex, Cursor, Devin and pi here export none',
  noMcpBroker: 'the orchestrator has no MCP broker (MCP_BROKER_URL), so termag adds no MCP servers here',
  mcpOff: 'MCP connectors through termag are not enabled for you (feature flag mcp-broker-enabled)',
  noFireworks: 'the orchestrator has no Fireworks gateway (FIREWORKS_GATEWAY_URL), so the Fireworks agents have no models here',
  fireworksOff: 'Fireworks through termag is not enabled for you (feature flag fireworks-enabled)',
};

/**
 * Every provider the agent supports (providersFor) gets exactly one step,
 * so a box converges on the stored state whatever it held before: what isn't
 * stored is removed.
 */
export function planDelivery(input: DeliveryInput, capabilities: string[]): DeliveryStep[] {
  const steps: DeliveryStep[] = [];
  steps.push(input.claudeSettings
    ? { type: 'credentials-apply', provider: 'claude-gateway', payload: input.claudeSettings }
    : { type: 'credentials-remove', provider: 'claude-gateway', reason: input.claudeOffReason });
  if (input.githubUnknown) {
    // Left as it was.
  } else if (!input.githubBroker) {
    steps.push({ type: 'credentials-remove', provider: 'github', reason: input.githubOffReason });
  } else if (!capabilities.includes(GITHUB_BROKER_CAPABILITY)) {
    steps.push({ type: 'credentials-remove', provider: 'github', reason: REASONS.oldAgent });
  } else {
    steps.push({
      type: 'credentials-apply',
      provider: 'github',
      payload: { broker: input.githubBroker.url, login: input.githubBroker.login },
    });
  }
  if (capabilities.includes(TELEMETRY_CAPABILITY)) {
    steps.push(input.telemetry
      ? { type: 'credentials-apply', provider: 'telemetry', payload: input.telemetry }
      : { type: 'credentials-remove', provider: 'telemetry', reason: REASONS.noTelemetry });
  }
  if (capabilities.includes(AGENT_TELEMETRY_CAPABILITY)) {
    steps.push(input.agentTelemetry
      ? { type: 'credentials-apply', provider: 'agent-telemetry', payload: input.agentTelemetry }
      : { type: 'credentials-remove', provider: 'agent-telemetry', reason: REASONS.noAgentTelemetry });
  }
  if (capabilities.includes(MCP_BROKER_CAPABILITY) && !input.mcpUnknown) {
    steps.push(input.mcp
      ? { type: 'credentials-apply', provider: 'mcp', payload: { broker: input.mcp.broker, connectors: input.mcp.connectors } }
      : { type: 'credentials-remove', provider: 'mcp', reason: input.mcpOffReason ?? REASONS.noMcpBroker });
  }
  if (capabilities.includes(FIREWORKS_CAPABILITY) && !input.fireworksUnknown) {
    steps.push(input.fireworks
      ? { type: 'credentials-apply', provider: 'fireworks', payload: input.fireworks }
      : { type: 'credentials-remove', provider: 'fireworks', reason: input.fireworksOffReason ?? REASONS.noFireworks });
  }
  return steps;
}

export interface RequestingAgent {
  conn: AgentConnection;
  capabilities: string[];
}

function isManagedBoxConnection(conn: AgentConnection): boolean {
  return conn.kind === 'owned-box' && isManagedBox(conn.instance);
}

/** Why an agent that speaks credentials-v1 gets none, or null if it gets them. */
export function refusalFor(agent: RequestingAgent): string | null {
  return isManagedBoxConnection(agent.conn) ? null : REASONS.notManaged;
}

async function deliveryInputFor(userId: string, instanceId: string): Promise<{ input: DeliveryInput; githubError: Error | null }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { claudeGatewayEnabled: true } });
  const gateway = getClaudeGatewayConfig();
  const store = getCredentialStoreConfig();
  const brokerUrl = getGithubBrokerUrl();
  let githubBroker: DeliveryInput['githubBroker'] = null;
  let githubOffReason = !store ? REASONS.noStore : !brokerUrl ? REASONS.noBroker : REASONS.notConnected;
  let githubError: Error | null = null;
  if (store) {
    try {
      const github = await githubStoreDeps(store, userId).read();
      if (github && brokerUrl) githubBroker = { url: brokerUrl, login: github.login };
      else if (!github) githubOffReason = REASONS.notConnected;
    } catch (err) {
      githubError = err as Error;
    }
  }
  const telemetry = otlpDestinationFromEnv(process.env);
  const mcp = await mcpInputFor(userId, instanceId);
  const fireworks = await fireworksInputFor(userId, instanceId);
  return {
    input: {
      claudeSettings: gateway && user?.claudeGatewayEnabled ? gatewaySettings(gateway) : null,
      claudeOffReason: !gateway ? REASONS.noGateway : REASONS.gatewayOff,
      githubBroker,
      githubOffReason,
      githubUnknown: githubError !== null,
      telemetry: telemetry && sessionTelemetrySettings(telemetry, { user: userId, box: instanceId }),
      agentTelemetry: telemetry && agentTelemetrySettings(telemetry, { user: userId, box: instanceId }),
      ...mcp,
      ...fireworks,
    },
    githubError,
  };
}

async function mcpInputFor(userId: string, instanceId: string): Promise<Pick<DeliveryInput, 'mcp' | 'mcpOffReason' | 'mcpUnknown'>> {
  const broker = getMcpBrokerUrl();
  if (!broker) return { mcp: null, mcpOffReason: REASONS.noMcpBroker };
  try {
    if (!await mcpBrokerEnabledForBox(userId, instanceId)) return { mcp: null, mcpOffReason: REASONS.mcpOff };
    const connectors = (await listConnectors(userId)).map(c => ({ id: c.id, name: c.name }));
    return { mcp: { broker, connectors } };
  } catch (err) {
    console.error(`[CRED] could not read MCP connectors for instance ${instanceId}:`, (err as Error).message);
    return { mcpUnknown: true };
  }
}

async function fireworksInputFor(userId: string, instanceId: string): Promise<Pick<DeliveryInput, 'fireworks' | 'fireworksOffReason' | 'fireworksUnknown'>> {
  const cfg = getFireworksGatewayConfig();
  if (!cfg) return { fireworks: null, fireworksOffReason: REASONS.noFireworks };
  try {
    if (!await fireworksEnabledForBox(userId, instanceId)) return { fireworks: null, fireworksOffReason: REASONS.fireworksOff };
    return { fireworks: fireworksDelivery(cfg) };
  } catch (err) {
    console.error(`[CRED] could not read fireworks-enabled for instance ${instanceId}:`, (err as Error).message);
    return { fireworksUnknown: true };
  }
}

/**
 * Whether this orchestrator ever delivers GitHub to a box: only through the
 * broker, so it needs the credential store and a broker URL (deliveryInputFor).
 * Without them a box's `githubDeliveredAt` is never stamped.
 */
export function deliversGithub(env: NodeJS.ProcessEnv = process.env): boolean {
  return getCredentialStoreConfig(env) !== null && getGithubBrokerUrl(env) !== null;
}

// Deliveries still running, by box. A warm claim starts one without waiting
// (warmPoolClaim.ts, welcomeOwner); a caller about to use the box, such as
// the spawn route placing a runner on a box it just claimed , can
// wait for it here instead of racing the box's settings writes.
const inFlight = new Map<string, Set<Promise<void>>>();

/**
 * A promise for every delivery to this box still running (a claim's and, say,
 * the owner's credential change, which can overlap), or null when none is.
 * Settles once all of them have, however they ended; their errors are their
 * starters' to log.
 */
export function deliveryInFlight(instanceId: string): Promise<void> | null {
  const running = inFlight.get(instanceId);
  if (!running || running.size === 0) return null;
  return Promise.all([...running].map(p => p.then(() => undefined, () => undefined))).then(() => undefined);
}

export function deliverToInstance(instanceId: string, userId: string): Promise<void> {
  const run = deliverToInstanceNow(instanceId, userId);
  const running = inFlight.get(instanceId) ?? new Set<Promise<void>>();
  running.add(run);
  inFlight.set(instanceId, running);
  run.finally(() => {
    running.delete(run);
    if (running.size === 0 && inFlight.get(instanceId) === running) inFlight.delete(instanceId);
  }).catch(() => undefined);
  return run;
}

async function deliverToInstanceNow(instanceId: string, userId: string): Promise<void> {
  const agent = instanceAgentTransport(instanceId);
  if (!agent || !agent.capabilities.includes(CREDENTIALS_CAPABILITY)) return;
  // A box that gets nothing is still told why.
  const refusal = refusalFor(agent);
  let firstError: Error | null = null;
  let steps: DeliveryStep[];
  if (refusal) {
    steps = providersFor(agent.capabilities).map(provider => ({ type: 'credentials-remove', provider, reason: refusal }));
  } else {
    const { input, githubError } = await deliveryInputFor(userId, instanceId);
    firstError = githubError;
    steps = planDelivery(input, agent.capabilities);
  }
  for (const step of steps) {
    const { type, provider } = step;
    const payload = step.type === 'credentials-apply' ? { payload: step.payload } : { reason: step.reason };
    // The payload is never logged; sendOnAgent logs nothing, and errors carry
    // only the box script's own message.
    try {
      await sendToInstanceAgent(instanceId, type, { provider, ...payload }, 30_000);
      console.log(`[CRED] ${type === 'credentials-apply' ? 'applied' : 'removed'} ${provider} on instance ${instanceId}`);
      if (provider === 'github') {
        await prisma.instance.update({
          where: { id: instanceId },
          data: { githubDeliveredAt: type === 'credentials-apply' ? new Date() : null },
        });
      }
    } catch (err) {
      firstError ??= err as Error;
    }
  }
  if (firstError) throw firstError;
}

export async function deliverToUserBoxes(userId: string): Promise<void> {
  await Promise.all(connectedOwnedBoxIds(userId).map(id =>
    deliverToInstance(id, userId).catch(err => {
      console.error(`[CRED] delivery to instance ${id} failed:`, err.message);
    })));
}
