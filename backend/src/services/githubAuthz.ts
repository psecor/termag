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
  pushRepo,
  ssoRequiredMessage,
  targetOwner,
  type BrokerTarget,
} from './githubBroker';
import type { OrgAccess } from './githubRepos';
import { recordProductEvent } from './productEvents';
import type { AuthzBox, AuthzDecision, BoxForToken } from './gatewayAuthz';
import { isEnvPoolStatus } from './instanceLifecycle';

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
  /** What the last connect or re-check found per org for the owner's token (credentialStore's githubOrgsSource). */
  ownerOrgs?: (userId: string) => Promise<Readonly<Record<string, OrgAccess>>>;
  /** Called when a request is refused for SSO, so the stored org state can be re-checked (it may be stale). */
  onSsoRequired?: (userId: string) => void;
  /** Records the `github.push` product event; recordProductEvent unless a test gives its own. */
  record?: typeof recordProductEvent;
  /** The environment pool's GitHub token (services/poolCredential.ts), null when none is stored. Absent: no pool box is ever answered. */
  poolToken?: () => Promise<string | null>;
  /**
   * The repositories (owner/name, lower case) of the environment a pool box
   * was launched for; null when there is no such environment, or it can't be
   * pooled (a personal one).
   */
  poolEnvironmentRepos?: (environmentId: string) => Promise<readonly string[] | null>;
}

/**
 * Runs `fn` for a user at most once per `intervalMs`: the broker's re-check
 * after an SSO refusal, so a box retrying in a loop costs GitHub one probe per
 * interval, not one per request.
 */
export function oncePerUser(fn: (userId: string) => void, intervalMs: number, now = () => Date.now()): (userId: string) => void {
  const last = new Map<string, number>();
  return userId => {
    const at = last.get(userId);
    if (at !== undefined && now() - at < intervalMs) return;
    last.set(userId, now());
    fn(userId);
  };
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
  if (!box.managed && box.pool && (isEnvPoolStatus(box.pool.status) || box.pool.environmentId)) {
    return decidePoolRequest(req, target, { instanceId: box.instanceId, ...box.pool }, deps);
  }
  if (!box.managed) return deny(403, 'Only a termag-managed box can use the GitHub broker', 'not a managed box');

  const who = `user=${box.userId} instance=${box.instanceId}`;
  const ownerToken = await deps.ownerToken(box.userId);
  if (!ownerToken) return deny(403, 'Connect GitHub on the termag Credentials page first', `${who} owner has no GitHub credential`);

  const m = req.method.toUpperCase();
  const blocked = target.kind === 'graphql'
    ? blockedGraphqlReason(req.body)
    : target.kind === 'api' ? blockedApiReason(m, target.logPath, req.body) : null;
  if (blocked) return deny(403, `Blocked by the termag GitHub broker: ${blocked}`, `${who} ${target.kind} ${m} ${target.logPath} blocked (${blocked})`);

  // An org whose SAML SSO has not authorized the token: GitHub would 403 with a
  // message about a "Personal Access token" the box has never seen; say which
  // token and how to authorize it. The state is the last probe's, so a refusal
  // also asks for a re-check, which lets the next request through once fixed.
  const owner = targetOwner(target);
  if (owner && deps.ownerOrgs) {
    const orgs = await deps.ownerOrgs(box.userId);
    const entry = Object.entries(orgs).find(([org]) => org.toLowerCase() === owner);
    if (entry && entry[1].status === 'sso-required') {
      deps.onSsoRequired?.(box.userId);
      return deny(403, ssoRequiredMessage(entry[0], entry[1].ssoUrl), `${who} ${target.kind} ${m} ${target.logPath} refused (token not SSO-authorized for ${entry[0]})`);
    }
  }

  // A push from this box: who, which box and which repository, never refs or commits (the broker never sees the pack).
  const pushed = pushRepo(m, target);
  if (pushed) (deps.record ?? recordProductEvent)('github.push', { user: box.userId, box: box.instanceId }, { repo: pushed });

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

/**
 * The repository a git fetch reads, as owner/name in lower case, or why the
 * request is not one: `info/refs?service=git-upload-pack` and a POST to
 * `git-upload-pack`. A push (git-receive-pack, its ref advertisement included),
 * REST and GraphQL are never fetches.
 */
export function poolFetchRepo(method: string, target: { kind: string; logPath: string }): { repo: string } | { refused: string } {
  if (target.kind === 'api') return { refused: 'a pool box may only fetch with git, not call the REST API' };
  if (target.kind === 'graphql') return { refused: 'a pool box may only fetch with git, not call GraphQL' };
  const m = /^\/([^/]+)\/([^/]+)\/(info\/refs\?service=git-upload-pack|git-upload-pack|info\/refs\?service=git-receive-pack|git-receive-pack)$/.exec(target.logPath);
  if (!m) return { refused: 'a pool box may only fetch with git' };
  if (m[3].endsWith('git-receive-pack')) return { refused: 'a pool box may not push' };
  if (m[3] === 'git-upload-pack' && method.toUpperCase() !== 'POST') return { refused: 'a pool box may only fetch with git' };
  return { repo: `${m[1]}/${m[2].replace(/\.git$/i, '')}`.toLowerCase() };
}

/**
 * The environment pool's rule ("The pool's GitHub
 * credential, through the broker"). An ownerless pool box gets the pool
 * credential only while its row is env-preparing, only for git fetches, and
 * only of its environment's repositories; anything else is a 403 that names
 * the rule that refused it. The box never sees the credential: Envoy swaps it
 * in for the box token, as for an owner's.
 */
async function decidePoolRequest(
  req: AuthzRequest,
  target: BrokerTarget,
  box: Pick<AuthzBox, 'instanceId'> & NonNullable<AuthzBox['pool']>,
  deps: AuthzDeps,
): Promise<AuthzDecision> {
  const m = req.method.toUpperCase();
  const who = `pool instance=${box.instanceId} environment=${box.environmentId ?? '-'} status=${box.status}`;
  const what = `${target.kind} ${m} ${target.logPath}`;
  const refuse = (rule: string, message: string) => deny(403, `Refused by the termag GitHub broker's pool rule (${rule}): ${message}`, `${who} ${what} refused (pool rule: ${rule})`);

  if (box.status !== 'env-preparing') {
    return refuse('preparing only', `this pool box is ${box.status}; only a box preparing its environment (env-preparing) gets the pool credential`);
  }
  const fetch = poolFetchRepo(m, target);
  if ('refused' in fetch) return refuse('fetch only', fetch.refused);
  if (!box.environmentId) return refuse('its environment', 'this pool box names no environment');
  // The credential first: resolving the environment reads GitHub with it, and without one that read sees too little.
  const poolToken = deps.poolToken ? await deps.poolToken() : null;
  if (!poolToken) return refuse('pool credential', 'no pool GitHub credential is set (an admin sets it: PUT /api/admin/pool-credential/github)');
  // The repositories the row was launched to prepare (envPool.ts records them), else the environment resolved now.
  const repos = box.repos?.length ? box.repos : deps.poolEnvironmentRepos ? await deps.poolEnvironmentRepos(box.environmentId) : null;
  if (!repos) return refuse('its environment', `environment ${box.environmentId} is not one a pool can prepare`);
  if (!repos.includes(fetch.repo)) return refuse('its environment', `${fetch.repo} is not one of this pool box's environment's repositories`);

  return {
    allow: true,
    audit: `${who} ${what} allowed (pool credential)`,
    headers: {
      authorization: ownerAuthorization(target.kind, poolToken),
      'x-termag-user': 'pool',
      'x-termag-instance': box.instanceId,
      'x-termag-target': `${target.kind} ${target.logPath}`,
    },
  };
}
