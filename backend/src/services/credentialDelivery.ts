/**
 * Getting a user's credentials onto their boxes.
 *
 * Copied credentials (the GitHub fallback) and the Claude gateway settings are
 * pushed with credentials-apply / credentials-remove on every connect and on
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
import { connectedOwnedBoxIds, instanceAgentTransport, sendToInstanceAgent } from './agentRegistry';
import { isManagedBox, type AgentConnection } from './instanceLifecycle';
import { getClaudeGatewayConfig, gatewaySettings } from './claudeGateway';
import { getCredentialStoreConfig, githubStoreDeps } from './credentialStore';
import { getGithubBrokerUrl } from './githubBroker';

export const CREDENTIALS_CAPABILITY = 'credentials-v1';
// The box routes git and gh through the orchestrator's GitHub broker. An agent
// with only credentials-v1 would install a token and key, so it gets remove.
export const GITHUB_BROKER_CAPABILITY = 'github-broker-v1';
export const PROVIDERS = ['claude-gateway', 'github'] as const;
export type Provider = typeof PROVIDERS[number];

/** The providers an agent with these capabilities can be sent steps for. */
export function providersFor(_capabilities: string[]): Provider[] {
  return [...PROVIDERS];
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
}

export const REASONS = {
  notManaged: 'this is not a termag-managed box, so termag delivers no credentials to it',
  oldAgent: "this box's termag agent predates the GitHub broker; update it (termag-reconcile) to get GitHub through termag",
  noGateway: 'the orchestrator has no Claude gateway configured; log in to Claude on this box',
  gatewayOff: 'Claude through the termag gateway is turned off on the Credentials page',
  noStore: 'the orchestrator has no credential store configured',
  noBroker: "the orchestrator has no GitHub broker URL (GITHUB_BROKER_URL, the gateway's GitHub host)",
  notConnected: 'GitHub is not connected: paste `gh auth token` on the termag Credentials page',
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

async function deliveryInputFor(userId: string): Promise<{ input: DeliveryInput; githubError: Error | null }> {
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
  return {
    input: {
      claudeSettings: gateway && user?.claudeGatewayEnabled ? gatewaySettings(gateway) : null,
      claudeOffReason: !gateway ? REASONS.noGateway : REASONS.gatewayOff,
      githubBroker,
      githubOffReason,
      githubUnknown: githubError !== null,
    },
    githubError,
  };
}

export async function deliverToInstance(instanceId: string, userId: string): Promise<void> {
  const agent = instanceAgentTransport(instanceId);
  if (!agent || !agent.capabilities.includes(CREDENTIALS_CAPABILITY)) return;
  // A box that gets nothing is still told why.
  const refusal = refusalFor(agent);
  let firstError: Error | null = null;
  let steps: DeliveryStep[];
  if (refusal) {
    steps = providersFor(agent.capabilities).map(provider => ({ type: 'credentials-remove', provider, reason: refusal }));
  } else {
    const { input, githubError } = await deliveryInputFor(userId);
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
