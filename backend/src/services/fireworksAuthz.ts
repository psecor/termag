/**
 * The gateway's per-call decision for its Fireworks route, answered to
 * Envoy's ext_authz (routes/fireworksAuthz.ts). pi sends
 * the box's agent token as `Authorization: Bearer`; Claude Code's apiKeyHelper
 * value may come as `x-api-key` instead. The gateway's Lua filter has already
 * read the call's model from the body and passes it as
 * x-termag-fireworks-model. On an allow Envoy drops the token and puts a
 * Fireworks key in its place: the box owner's own (fireworksKey.ts), which
 * the allow carries as x-termag-fireworks-key, or the shared inference key
 * when the allow carries none.
 *
 * The owner's key decides as follows:
 * - a stored key that is valid: it goes in the allow, on the two inference
 *   paths only (auth-check forwards nothing);
 * - a stored key Fireworks rejected (401) or that has expired: refused with
 *   the reason, so the person replaces it rather than spending the shared key;
 * - no stored key: the shared key, or a refusal asking for one while
 *   fireworks-own-key-required-enabled is on for the owner and box.
 * An allow with a key of the owner's also starts a background re-check of it
 * (at most every few minutes), which is how a key Fireworks stops accepting
 * gets marked invalid.
 *
 * The check is who, not what: a managed box. Which models may run is Fireworks' account-level
 * governance, so any model id goes through and Fireworks answers for one it
 * does not serve or the account does not allow ("Model not found,
 * inaccessible, and/or not deployed", or its governance refusal), unchanged.
 * The fireworks-models flag is the pickers' and launches' list, not an
 * allowlist, and the check does not read it: with it off or empty, a managed
 * box still gets through. The model is only logged.
 *
 * An allow's box is remembered for ALLOW_TTL_MS per token, as the Claude check
 * does, so a session's calls cost one database read every few seconds; the
 * owner's key has its own per-user cache (readFireworksKey). Refusals are
 * never remembered, so revoking a token or terminating its box takes effect
 * within ALLOW_TTL_MS.
 */

import { createHash } from 'crypto';
import { bearerFrom } from './claudeAuthz';
import type { AuthzBox, AuthzDecision, BoxForToken } from './gatewayAuthz';
import type { OwnerKeyState } from './fireworksKey';

export const ALLOW_TTL_MS = 15_000;

// The only calls the gateway forwards (its Envoy route matches the same two,
// POST only), plus the credentials check. Envoy never asks about any other
// path; the check refuses one anyway, so a widened route still forwards
// nothing new without a change here. Paths come without the query
// (routes/gatewayCheck.ts), so Claude Code's ?beta=true is fine.
const AUTH_CHECK = '/fireworks/auth-check';
export const FIREWORKS_PATHS: ReadonlySet<string> = new Set([
  '/fireworks/inference/v1/messages',
  '/fireworks/inference/v1/chat/completions',
  AUTH_CHECK,
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
  // The owner's own Fireworks key; absent: none is ever stored. Throws on a decrypt failure (a 503).
  ownerKey?: (userId: string) => Promise<OwnerKeyState>;
  // fireworks-own-key-required-enabled for the owner and box; absent: off.
  keyRequired?: (box: AuthzBox) => Promise<boolean>;
  // Called after an allow that spends the owner's key (revalidateFireworksKey); never awaited.
  onOwnerKeyUsed?: (userId: string) => void;
  now?: () => number;
}

export const ADD_KEY_MESSAGE =
  'Add your Fireworks API key in termag Settings (Credentials on your boxes) to use Fireworks through the termag gateway.';
export const REJECTED_KEY_MESSAGE =
  'Fireworks rejected your Fireworks API key. Add a new one in termag Settings (Credentials on your boxes).';
export function expiredKeyMessage(at: string): string {
  return `Your Fireworks API key expired on ${at.slice(0, 10)}. Add a new one in termag Settings (Credentials on your boxes).`;
}

const allowed = new Map<string, { box: AuthzBox; at: number }>();

function deny(status: number, message: string, audit: string): AuthzDecision {
  return {
    allow: false, status, message, audit,
    ...(status === 401 ? { headers: { 'www-authenticate': 'Bearer realm="termag Fireworks gateway"' } } : {}),
  };
}

function who(box: AuthzBox, path: string, model: string | undefined): string {
  return `user=${box.userId} instance=${box.instanceId} ${path.slice(0, 200)}${model ? ` model=${model.slice(0, 120)}` : ''}`;
}

// `key`: the owner's Fireworks key for Envoy to send, or null for the shared one.
function allow(box: AuthzBox, path: string, model: string | undefined, cached: boolean, key: string | null, source: string): AuthzDecision {
  return {
    allow: true,
    audit: `${who(box, path, model)} key=${source} allowed${cached ? ' (cached)' : ''}`,
    headers: {
      'x-termag-user': box.userId,
      'x-termag-instance': box.instanceId,
      ...(box.email ? { 'x-termag-email': box.email } : {}),
      ...(key ? { 'x-termag-fireworks-key': `Bearer ${key}` } : {}),
    },
  };
}

async function decideForOwner(box: AuthzBox, req: FireworksAuthzRequest, model: string | undefined, cached: boolean, deps: FireworksAuthzDeps): Promise<AuthzDecision> {
  const owner = deps.ownerKey ? await deps.ownerKey(box.userId) : { state: 'none' as const };
  if (owner.state === 'invalid') {
    const message = owner.reason === 'expired' ? expiredKeyMessage(owner.at) : REJECTED_KEY_MESSAGE;
    return deny(403, message, `${who(box, req.path, model)} refused (own key ${owner.reason})`);
  }
  if (owner.state === 'valid') {
    // auth-check forwards nothing, so it carries no key.
    if (req.path === AUTH_CHECK) return allow(box, req.path, model, cached, null, 'own');
    deps.onOwnerKeyUsed?.(box.userId);
    return allow(box, req.path, model, cached, owner.key, 'own');
  }
  if (deps.keyRequired && await deps.keyRequired(box)) {
    return deny(403, ADD_KEY_MESSAGE, `${who(box, req.path, model)} refused (no own key, one is required)`);
  }
  return allow(box, req.path, model, cached, null, 'shared');
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
  if (hit && now() - hit.at < ALLOW_TTL_MS) return decideForOwner(hit.box, req, model, true, deps);
  allowed.delete(key);

  const box = await deps.boxForToken(token);
  if (!box) return deny(401, 'Unknown or revoked box token', 'unknown box token');
  if (!box.managed) return deny(403, 'Only a termag-managed box can use the Fireworks gateway', `instance=${box.instanceId} not a managed box`);

  for (const [k, v] of allowed) if (now() - v.at >= ALLOW_TTL_MS) allowed.delete(k);
  allowed.set(key, { box, at: now() });
  return decideForOwner(box, req, model, false, deps);
}
