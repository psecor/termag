import { describe, it, expect, beforeEach } from 'vitest';
import {
  forgetVerifiedProofs,
  getCallerProofConfig,
  GET_CALLER_IDENTITY_BODY,
  proofHeaders,
  roleArnOf,
  verifyCallerProof,
  type Fetch,
} from './callerIdentity';

const GATEWAY = 'arn:aws:iam::111122223333:role/termag-claude-gateway-task';
const cfg = { allowedRoleArns: [GATEWAY], stsUrl: 'https://sts.us-east-2.amazonaws.com' };
const AUTH = 'AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE/20260930/us-east-2/sts/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=abc';

const proof = (over: Record<string, string> = {}) => ({
  'x-termag-caller-authorization': AUTH,
  'x-termag-caller-x-amz-date': '20260930T070000Z',
  'x-termag-caller-x-amz-security-token': 'session',
  'x-termag-caller-content-type': 'application/x-www-form-urlencoded; charset=utf-8',
  authorization: 'Basic Ym94',
  ...over,
});

function sts(arn: string | null, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f: Fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = arn ? `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${arn}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>` : '<Error/>';
    return new Response(body, { status });
  };
  return { f, calls };
}

beforeEach(() => forgetVerifiedProofs());

describe('getCallerProofConfig', () => {
  it('is off without an allowlist', () => {
    expect(getCallerProofConfig({ AWS_REGION: 'us-east-2' })).toBeNull();
    expect(getCallerProofConfig({ AWS_REGION: 'us-east-2', GATEWAY_AUTHZ_ALLOWED_CALLER_ARNS: ' , ' })).toBeNull();
  });

  it("takes the region's STS endpoint unless one is given", () => {
    expect(getCallerProofConfig({ AWS_REGION: 'us-east-2', GATEWAY_AUTHZ_ALLOWED_CALLER_ARNS: `${GATEWAY}, arn:x` }))
      .toEqual({ allowedRoleArns: [GATEWAY, 'arn:x'], stsUrl: 'https://sts.us-east-2.amazonaws.com' });
    expect(getCallerProofConfig({ GATEWAY_AUTHZ_ALLOWED_CALLER_ARNS: GATEWAY, GATEWAY_AUTHZ_STS_URL: 'http://127.0.0.1:4691/' })?.stsUrl)
      .toBe('http://127.0.0.1:4691');
  });
});

describe('roleArnOf', () => {
  it('names the role behind an assumed-role session', () => {
    expect(roleArnOf('arn:aws:sts::111122223333:assumed-role/termag-claude-gateway-task/abc123')).toBe(GATEWAY);
    expect(roleArnOf('arn:aws:iam::111122223333:user/eve')).toBe('arn:aws:iam::111122223333:user/eve');
  });
});

describe('proofHeaders', () => {
  it('takes the signed headers from x-termag-caller-*, and needs a SigV4 authorization', () => {
    expect(proofHeaders(proof({ 'x-termag-caller-host': 'sts', 'x-termag-caller-content-length': '43' }))).toEqual({
      authorization: AUTH,
      'x-amz-date': '20260930T070000Z',
      'x-amz-security-token': 'session',
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    });
    expect(proofHeaders({ authorization: 'Basic Ym94' })).toBeNull();
    expect(proofHeaders(proof({ 'x-termag-caller-authorization': 'Bearer x' }))).toBeNull();
  });
});

describe('verifyCallerProof', () => {
  it('replays the signed GetCallerIdentity to STS and accepts the gateway role', async () => {
    const { f, calls } = sts('arn:aws:sts::111122223333:assumed-role/termag-claude-gateway-task/s1');
    expect(await verifyCallerProof(proof(), cfg, f)).toBe(GATEWAY);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sts.us-east-2.amazonaws.com/');
    expect(calls[0].init.body).toBe(GET_CALLER_IDENTITY_BODY);
    const sent = calls[0].init.headers as Record<string, string>;
    expect(sent.authorization).toBe(AUTH);
    expect(sent['x-amz-security-token']).toBe('session');
    expect(JSON.stringify(sent)).not.toContain('Basic Ym94');
  });

  it('refuses any other role, including a box role', async () => {
    const { f } = sts('arn:aws:sts::111122223333:assumed-role/termag-box-alice/i-123');
    expect(await verifyCallerProof(proof(), cfg, f)).toBeNull();
  });

  it('refuses a proof STS rejects, and a request with no proof', async () => {
    const { f } = sts(null, 403);
    expect(await verifyCallerProof(proof(), cfg, f)).toBeNull();
    const none = sts(GATEWAY);
    expect(await verifyCallerProof({ authorization: 'Basic Ym94' }, cfg, none.f)).toBeNull();
    expect(none.calls).toHaveLength(0);
  });

  it('asks STS once for a proof it has verified, for five minutes', async () => {
    let now = 0;
    const { f, calls } = sts('arn:aws:sts::111122223333:assumed-role/termag-claude-gateway-task/s1');
    await verifyCallerProof(proof(), cfg, f, () => now);
    await verifyCallerProof(proof(), cfg, f, () => now);
    expect(calls).toHaveLength(1);
    now = 5 * 60_000;
    await verifyCallerProof(proof(), cfg, f, () => now);
    expect(calls).toHaveLength(2);
    await verifyCallerProof(proof({ 'x-termag-caller-x-amz-date': '20260930T070100Z' }), cfg, f, () => now);
    expect(calls).toHaveLength(3);
  });
});
