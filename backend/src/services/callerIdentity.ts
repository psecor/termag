/**
 * Caller proof for the gateway's check endpoints (the GitHub broker's and the
 * Claude gateway's), as vega's git-proxy does it. One hands out an owner's
 * GitHub Authorization header and the other says which box tokens may spend
 * Bedrock, so only the gateway may call them. Envoy's caller-proof listener signs an
 * sts:GetCallerIdentity with the gateway's task role and passes the signed
 * headers as `x-termag-caller-*`; we send STS exactly that request and compare
 * the role it names with GATEWAY_AUTHZ_ALLOWED_CALLER_ARNS. Nothing here holds a
 * secret: only STS can check the signature.
 *
 * Off (the route is not registered) while the allowlist is empty.
 */

import { createHash } from 'crypto';

export const CALLER_HEADER_PREFIX = 'x-termag-caller-';
export const GET_CALLER_IDENTITY_BODY = 'Action=GetCallerIdentity&Version=2011-06-15';
const CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';
// Below STS's 15 minutes, so a cached proof never outlives the signature.
const VERIFIED_TTL_MS = 5 * 60_000;

export interface CallerProofConfig {
  allowedRoleArns: string[];
  stsUrl: string;
}

export function getCallerProofConfig(env: NodeJS.ProcessEnv = process.env): CallerProofConfig | null {
  const allowedRoleArns = (env.GATEWAY_AUTHZ_ALLOWED_CALLER_ARNS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowedRoleArns.length === 0) return null;
  const region = env.AWS_REGION?.trim();
  const stsUrl = env.GATEWAY_AUTHZ_STS_URL?.trim() || (region ? `https://sts.${region}.amazonaws.com` : '');
  if (!stsUrl) return null;
  return { allowedRoleArns, stsUrl: stsUrl.replace(/\/+$/, '') };
}

/**
 * `arn:aws:sts::<acct>:assumed-role/<name>/<session>` names the role
 * `arn:aws:iam::<acct>:role/<name>`; anything else is itself.
 */
export function roleArnOf(callerArn: string): string {
  const m = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\/.+$/.exec(callerArn);
  return m ? `arn:${m[1]}:iam::${m[2]}:role/${m[3]}` : callerArn;
}

type Headers = Record<string, string | string[] | undefined>;

/** The signed request's headers, from the x-termag-caller-* ones. */
export function proofHeaders(incoming: Headers): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!name.startsWith(CALLER_HEADER_PREFIX) || typeof value !== 'string') continue;
    const signed = name.slice(CALLER_HEADER_PREFIX.length);
    // fetch sets these from the URL and body, which match what was signed.
    if (signed === 'host' || signed === 'content-length') continue;
    out[signed] = value;
  }
  return out.authorization?.startsWith('AWS4-HMAC-SHA256 ') ? out : null;
}

export type Fetch = typeof fetch;

const verified = new Map<string, { roleArn: string; at: number }>();

/**
 * The caller's role ARN if STS accepts the proof and the role is allowed, else
 * null. Never throws for a bad proof; network errors propagate.
 */
export async function verifyCallerProof(
  incoming: Headers,
  cfg: CallerProofConfig,
  fetchImpl: Fetch = fetch,
  now = () => Date.now(),
): Promise<string | null> {
  const headers = proofHeaders(incoming);
  if (!headers) return null;
  const key = createHash('sha256').update(JSON.stringify(headers)).digest('hex');
  const hit = verified.get(key);
  if (hit && now() - hit.at < VERIFIED_TTL_MS) return hit.roleArn;

  const res = await fetchImpl(`${cfg.stsUrl}/`, {
    method: 'POST',
    headers: { ...headers, 'content-type': headers['content-type'] ?? CONTENT_TYPE },
    body: GET_CALLER_IDENTITY_BODY,
  });
  if (!res.ok) return null;
  const arn = /<Arn>([^<]+)<\/Arn>/.exec(await res.text())?.[1];
  if (!arn) return null;
  const roleArn = roleArnOf(arn);
  if (!cfg.allowedRoleArns.includes(roleArn)) return null;
  for (const [k, v] of verified) if (now() - v.at >= VERIFIED_TTL_MS) verified.delete(k);
  verified.set(key, { roleArn, at: now() });
  return roleArn;
}

export function forgetVerifiedProofs(): void {
  verified.clear();
}
