/**
 * The GitHub broker's per-request decision, answered to Envoy's ext_authz
 * (routes/githubAuthz.ts). Envoy sends the box's method, path, Authorization
 * header and, for GraphQL and repository PATCH, the body. An allow carries the
 * owner's GitHub Authorization header, which Envoy puts in place of the box
 * token; a refusal's status and message go back to git or gh as they are.
 */

import {
  blockedApiReason,
  blockedGraphqlReason,
  boxTokenFrom,
  brokerTarget,
  ownerAuthorization,
} from './githubBroker';
import type { AuthzDecision, BoxForToken } from './gatewayAuthz';

export interface AuthzRequest {
  method: string;
  path: string;
  search: string;
  authorization: string | undefined;
  body: string;
}

export interface AuthzDeps {
  boxForToken: BoxForToken;
  ownerToken: (userId: string) => Promise<string | null>;
}

function deny(status: number, message: string, audit: string): AuthzDecision {
  return {
    allow: false, status, message, audit,
    ...(status === 401 ? { headers: { 'www-authenticate': 'Basic realm="termag GitHub broker"' } } : {}),
  };
}

export async function decideGithubRequest(req: AuthzRequest, deps: AuthzDeps): Promise<AuthzDecision> {
  const target = brokerTarget(req.method, req.path, req.search);
  if (!target) return deny(404, 'Not a path the termag GitHub broker forwards', 'not a brokered path');
  const token = boxTokenFrom(req.authorization);
  if (!token) return deny(401, "The termag GitHub broker needs this box's agent token", 'no box token');

  const box = await deps.boxForToken(token);
  if (!box) return deny(401, 'Unknown or revoked box token', 'unknown box token');
  if (!box.managed) return deny(403, 'Only a termag-managed box can use the GitHub broker', 'not a managed box');

  const who = `user=${box.userId} instance=${box.instanceId}`;
  const ownerToken = await deps.ownerToken(box.userId);
  if (!ownerToken) return deny(403, 'Connect GitHub on the termag Credentials page first', `${who} owner has no GitHub credential`);

  const m = req.method.toUpperCase();
  const blocked = target.kind === 'graphql'
    ? blockedGraphqlReason(req.body)
    : target.kind === 'api' ? blockedApiReason(m, target.logPath, req.body) : null;
  if (blocked) return deny(403, `Blocked by the termag GitHub broker: ${blocked}`, `${who} ${target.kind} ${m} ${target.logPath} blocked (${blocked})`);

  return {
    allow: true,
    audit: `${who} ${target.kind} ${m} ${target.logPath} allowed`,
    headers: {
      authorization: ownerAuthorization(target.kind, ownerToken),
      'x-termag-user': box.userId,
      'x-termag-instance': box.instanceId,
      'x-termag-target': `${target.kind} ${target.logPath}`,
    },
  };
}
