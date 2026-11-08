/**
 * The gateway's per-call decision for its Fireworks route, answered to
 * Envoy's ext_authz (routes/fireworksAuthz.ts). pi sends
 * the box's agent token as `Authorization: Bearer`; Claude Code's apiKeyHelper
 * value may come as `x-api-key` instead. The gateway's Lua filter has already
 * read the call's model from the body and passes it as
 * x-termag-fireworks-model. On an allow Envoy drops the token and puts the
 * shared inference key in its place.
 *
 * The check is who, not what: a managed box. Which models may run is Fireworks' account-level
 * governance, so any model id goes through and Fireworks answers for one it
 * does not serve or the account does not allow ("Model not found,
 * inaccessible, and/or not deployed", or its governance refusal), unchanged.
 * The fireworks-models flag is the pickers' and launches' list, not an
 * allowlist, and the check does not read it: with it off or empty, a managed
 * box still gets through. The model is only logged.
 *
 * An allow is remembered for ALLOW_TTL_MS per token, as the Claude check does,
 * so a session's calls cost one database read every few seconds. Refusals are
 * never remembered, so revoking a token or terminating its box takes effect
 * within ALLOW_TTL_MS.
 */

import { createHash } from 'crypto';
import { bearerFrom } from './claudeAuthz';
import type { AuthzBox, AuthzDecision, BoxForToken } from './gatewayAuthz';

export const ALLOW_TTL_MS = 15_000;

// The only calls the gateway forwards (its Envoy route matches the same two,
// POST only), plus the credentials check. Envoy never asks about any other
// path; the check refuses one anyway, so a widened route still forwards
// nothing new without a change here. Paths come without the query
// (routes/gatewayCheck.ts), so Claude Code's ?beta=true is fine.
export const FIREWORKS_PATHS: ReadonlySet<string> = new Set([
  '/fireworks/inference/v1/messages',
  '/fireworks/inference/v1/chat/completions',
  '/fireworks/auth-check',
]);

export interface FireworksAuthzRequest {
  path: string;
  authorization: string | undefined;
  apiKey: string | undefined;
  // The call's model as the gateway read it, for the audit line only; absent on auth-check.
  model: string | undefined;
}

export interface FireworksAuthzDeps {
  // The orchestrator has a Fireworks config (getFireworksGatewayConfig).
  configured: boolean;
  boxForToken: BoxForToken;
  now?: () => number;
}

const allowed = new Map<string, { box: AuthzBox; at: number }>();

function deny(status: number, message: string, audit: string): AuthzDecision {
  return {
    allow: false, status, message, audit,
    ...(status === 401 ? { headers: { 'www-authenticate': 'Bearer realm="termag Fireworks gateway"' } } : {}),
  };
}

function allow(box: AuthzBox, path: string, model: string | undefined, cached: boolean): AuthzDecision {
  return {
    allow: true,
    audit: `user=${box.userId} instance=${box.instanceId} ${path.slice(0, 200)}${model ? ` model=${model.slice(0, 120)}` : ''} allowed${cached ? ' (cached)' : ''}`,
    headers: {
      'x-termag-user': box.userId,
      'x-termag-instance': box.instanceId,
      ...(box.email ? { 'x-termag-email': box.email } : {}),
    },
  };
}

export async function decideFireworksRequest(req: FireworksAuthzRequest, deps: FireworksAuthzDeps): Promise<AuthzDecision> {
  const now = deps.now ?? Date.now;
  if (!deps.configured) return deny(403, 'The termag orchestrator has no Fireworks gateway configured', 'fireworks not configured');
  if (!FIREWORKS_PATHS.has(req.path)) return deny(404, 'The termag Fireworks gateway forwards only messages and chat completions', `${req.path.slice(0, 200)} not a forwarded path`);
  const apiKey = req.apiKey?.trim();
  const token = bearerFrom(req.authorization) ?? (apiKey && /^\S+$/.test(apiKey) ? apiKey : null);
  if (!token) return deny(401, "The termag Fireworks gateway needs this box's agent token", 'no box token');
  const model = req.model?.trim() || undefined;

  const key = createHash('sha256').update(token).digest('hex');
  const hit = allowed.get(key);
  if (hit && now() - hit.at < ALLOW_TTL_MS) return allow(hit.box, req.path, model, true);
  allowed.delete(key);

  const box = await deps.boxForToken(token);
  if (!box) return deny(401, 'Unknown or revoked box token', 'unknown box token');
  if (!box.managed) return deny(403, 'Only a termag-managed box can use the Fireworks gateway', `instance=${box.instanceId} not a managed box`);

  for (const [k, v] of allowed) if (now() - v.at >= ALLOW_TTL_MS) allowed.delete(k);
  allowed.set(key, { box, at: now() });
  return allow(box, req.path, model, false);
}
