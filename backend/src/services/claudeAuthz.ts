/**
 * The Claude gateway's per-request decision, answered to Envoy's ext_authz
 * (routes/claudeAuthz.ts). Claude Code sends the box's agent token as
 * `Authorization: Bearer` (its apiKeyHelper prints it); Envoy asks this for
 * every Bedrock call and, on an allow, drops the token and signs the call with
 * the gateway's own role.
 *
 * An allow is remembered for ALLOW_TTL_MS per token, so a session's stream of
 * calls costs one database read every few seconds rather than one per call.
 * Refusals are never remembered. Revoking a token, terminating its box or
 * turning the gateway off therefore takes effect within ALLOW_TTL_MS.
 */

import { createHash } from 'crypto';
import type { AuthzDecision, AuthzBox, BoxForToken } from './gatewayAuthz';

export const ALLOW_TTL_MS = 15_000;

export interface ClaudeAuthzRequest {
  path: string;
  authorization: string | undefined;
}

export interface ClaudeAuthzDeps {
  // The orchestrator has a gateway config (getClaudeGatewayConfig).
  configured: boolean;
  boxForToken: BoxForToken;
  gatewayEnabled: (userId: string) => Promise<boolean>;
  now?: () => number;
}

const allowed = new Map<string, { box: AuthzBox; at: number }>();

function deny(status: number, message: string, audit: string): AuthzDecision {
  return {
    allow: false, status, message, audit,
    ...(status === 401 ? { headers: { 'www-authenticate': 'Bearer realm="termag Claude gateway"' } } : {}),
  };
}

export function bearerFrom(authorization: string | undefined): string | null {
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  return m ? m[1] : null;
}

function allow(box: AuthzBox, path: string, cached: boolean): AuthzDecision {
  return {
    allow: true,
    audit: `user=${box.userId} instance=${box.instanceId} ${path.slice(0, 200)} allowed${cached ? ' (cached)' : ''}`,
    headers: {
      'x-termag-user': box.userId,
      'x-termag-instance': box.instanceId,
      ...(box.email ? { 'x-termag-email': box.email } : {}),
    },
  };
}

export async function decideClaudeRequest(req: ClaudeAuthzRequest, deps: ClaudeAuthzDeps): Promise<AuthzDecision> {
  const now = deps.now ?? Date.now;
  if (!deps.configured) return deny(403, 'The termag orchestrator has no Claude gateway configured', 'gateway not configured');
  const token = bearerFrom(req.authorization);
  if (!token) return deny(401, "The termag Claude gateway needs this box's agent token", 'no box token');

  const key = createHash('sha256').update(token).digest('hex');
  const hit = allowed.get(key);
  if (hit && now() - hit.at < ALLOW_TTL_MS) return allow(hit.box, req.path, true);
  allowed.delete(key);

  const box = await deps.boxForToken(token);
  if (!box) return deny(401, 'Unknown or revoked box token', 'unknown box token');
  if (!box.managed) return deny(403, 'Only a termag-managed box can use the Claude gateway', `instance=${box.instanceId} not a managed box`);
  if (!await deps.gatewayEnabled(box.userId)) {
    return deny(403, 'Claude through the termag gateway is turned off on the Credentials page', `user=${box.userId} instance=${box.instanceId} gateway turned off`);
  }

  for (const [k, v] of allowed) if (now() - v.at >= ALLOW_TTL_MS) allowed.delete(k);
  allowed.set(key, { box, at: now() });
  return allow(box, req.path, false);
}
