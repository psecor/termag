/**
 * The gateway's per-call decision for its Fireworks route, answered to
 * Envoy's ext_authz (routes/fireworksAuthz.ts). pi sends
 * the box's agent token as `Authorization: Bearer`; Claude Code's apiKeyHelper
 * value may come as `x-api-key` instead. The gateway's Lua filter has already
 * read the call's model from the body and passes it as
 * x-termag-fireworks-model. On an allow Envoy drops the token and puts the
 * shared inference key in its place.
 *
 * The model must be on the fireworks-models flag for the box's owner and the
 * box (null there = Fireworks is off for them). /fireworks/auth-check carries
 * no model and needs only that Fireworks is on.
 *
 * An allow is remembered for ALLOW_TTL_MS per token and model, as the Claude
 * check does, so a session's calls cost one database read and two flag
 * evaluations every few seconds. Refusals are never remembered, so revoking a
 * token, terminating its box, turning the flag off or dropping a model takes
 * effect within ALLOW_TTL_MS.
 */

import { createHash } from 'crypto';
import { bearerFrom } from './claudeAuthz';
import type { FireworksModels } from './fireworksGateway';
import type { AuthzBox, AuthzDecision, BoxForToken } from './gatewayAuthz';

export const ALLOW_TTL_MS = 15_000;

export interface FireworksAuthzRequest {
  path: string;
  authorization: string | undefined;
  apiKey: string | undefined;
  // The call's model as the gateway read it; absent on auth-check.
  model: string | undefined;
}

export interface FireworksAuthzDeps {
  // The orchestrator has a Fireworks config (getFireworksGatewayConfig).
  configured: boolean;
  boxForToken: BoxForToken;
  // fireworks-enabled and fireworks-models for the box's owner and the box;
  // null when Fireworks is off for them.
  modelsFor: (box: AuthzBox) => Promise<FireworksModels | null>;
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
  const apiKey = req.apiKey?.trim();
  const token = bearerFrom(req.authorization) ?? (apiKey && /^\S+$/.test(apiKey) ? apiKey : null);
  if (!token) return deny(401, "The termag Fireworks gateway needs this box's agent token", 'no box token');
  const authCheck = req.path.endsWith('/auth-check');
  const model = req.model?.trim() || undefined;
  if (!authCheck && !model) return deny(400, 'The termag Fireworks gateway could not read the call\'s model', 'no model');

  const key = createHash('sha256').update(`${token}\n${authCheck ? '' : model}`).digest('hex');
  const hit = allowed.get(key);
  if (hit && now() - hit.at < ALLOW_TTL_MS) return allow(hit.box, req.path, model, true);
  allowed.delete(key);

  const box = await deps.boxForToken(token);
  if (!box) return deny(401, 'Unknown or revoked box token', 'unknown box token');
  if (!box.managed) return deny(403, 'Only a termag-managed box can use the Fireworks gateway', `instance=${box.instanceId} not a managed box`);
  const fireworks = await deps.modelsFor(box);
  if (!fireworks) {
    return deny(403, 'Fireworks through termag is not on for you (feature flag fireworks-enabled and fireworks-models)', `user=${box.userId} instance=${box.instanceId} flag off`);
  }
  if (!authCheck && !fireworks.models.some(m => m.id === model)) {
    return deny(403, `The termag Fireworks gateway does not allow this model for you. Allowed: ${fireworks.models.map(m => m.id).join(', ')}`,
      `user=${box.userId} instance=${box.instanceId} model=${model!.slice(0, 120)} not allowed`);
  }

  for (const [k, v] of allowed) if (now() - v.at >= ALLOW_TTL_MS) allowed.delete(k);
  allowed.set(key, { box, at: now() });
  return allow(box, req.path, model, false);
}
