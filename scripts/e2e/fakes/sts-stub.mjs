// STS stub for the e2e stack's Claude gateway (E2E_CLAUDE_GATEWAY): answers
// sts:GetCallerIdentity, the caller proof the gateway's GitHub listener sends
// the orchestrator and the orchestrator replays here. Unlike Floci it checks
// the SigV4 signature for real, with the key the harness gives Envoy, so the
// proof only passes if Envoy signed exactly the request the backend replays.
//
// Env: E2E_STS_PORT; E2E_STS_KEYS, "<access key>=<secret>=<role name>[,...]".
// GET /_e2e/calls lists what it answered (no signatures).

import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';

const port = Number(process.env.E2E_STS_PORT ?? 4691);
const keys = new Map((process.env.E2E_STS_KEYS ?? '').split(',').filter(Boolean).map(e => {
  const [id, secret, role] = e.split('=');
  return [id, { secret, role }];
}));
const ACCOUNT = '000000000000';
const MAX_SKEW_MS = 15 * 60_000;
const calls = [];

const sha256 = s => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

function verify(req, body) {
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return { error: 'IncompleteSignature' };
  const [, keyId, day, region, service, signedHeaders, signature] = m;
  const key = keys.get(keyId);
  if (!key) return { error: 'InvalidClientTokenId' };
  if (service !== 'sts') return { error: 'SignatureDoesNotMatch' };
  const date = req.headers['x-amz-date'] ?? '';
  const at = Date.parse(date.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
  if (!at || Math.abs(Date.now() - at) > MAX_SKEW_MS || !date.startsWith(day)) return { error: 'RequestExpired' };
  const names = signedHeaders.split(';');
  const canonicalHeaders = names.map(n => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const payloadHash = req.headers['x-amz-content-sha256'] ?? sha256(body);
  if (payloadHash !== sha256(body)) return { error: 'SignatureDoesNotMatch' };
  const [path, query = ''] = req.url.split('?');
  const canonical = [req.method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${key.secret}`, day), region), service), 'aws4_request');
  if (createHmac('sha256', signingKey).update(toSign).digest('hex') !== signature) return { error: 'SignatureDoesNotMatch' };
  return { keyId, role: key.role };
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/_e2e/calls') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(calls));
    return;
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method !== 'POST' || !/(^|&)Action=GetCallerIdentity(&|$)/.test(body)) {
      calls.push('not GetCallerIdentity -> 400');
      res.writeHead(400).end('<ErrorResponse><Error><Code>InvalidAction</Code></Error></ErrorResponse>');
      return;
    }
    const v = verify(req, body);
    if (v.error) {
      calls.push(`GetCallerIdentity -> 403 ${v.error}`);
      res.writeHead(403, { 'content-type': 'text/xml' }).end(`<ErrorResponse><Error><Code>${v.error}</Code></Error></ErrorResponse>`);
      return;
    }
    const arn = `arn:aws:sts::${ACCOUNT}:assumed-role/${v.role}/e2e-session`;
    calls.push(`GetCallerIdentity -> 200 ${arn}`);
    res.writeHead(200, { 'content-type': 'text/xml' }).end(
      `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${arn}</Arn><UserId>${v.keyId}:e2e-session</UserId><Account>${ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`,
    );
  });
}).listen(port, '127.0.0.1');
