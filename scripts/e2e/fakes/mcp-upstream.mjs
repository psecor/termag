// Stand-in for a remote MCP server (E2E_FAKE_MCP=1) behind the termag MCP
// broker: just enough Streamable HTTP for a client to connect and call a tool.
//
//   POST <base>   JSON-RPC: initialize (hands out an mcp-session-id),
//                 notifications/initialized, tools/list, tools/call. A call to
//                 the `slow` tool answers as an SSE stream (a progress
//                 notification, then the result after E2E_MCP_SLOW_MS), as a
//                 streaming server does.
//   GET  <base>   the long-lived SSE stream: a comment every second until the
//                 client goes away.
//   /.well-known/oauth-protected-resource…  RFC 9728 metadata naming an
//                 authorization server, which the broker must never let a box
//                 see.
//   /as/…         that authorization server, for the orchestrator's OAuth:
//                 RFC 8414 metadata at
//                 /.well-known/oauth-authorization-server/as, dynamic client
//                 registration, an authorize endpoint that approves at once
//                 (a 302 back to the redirect URI), a token endpoint that checks
//                 PKCE S256 and the resource and rotates refresh tokens (a reused
//                 one revokes its whole family), and revocation. An access token
//                 it issued is accepted on <base> like the E2E_MCP_REQUIRE
//                 credential. GET /_e2e/as shows its settings and counters (never
//                 a token); POST /_e2e/as with JSON changes the settings:
//                 { dcr, cimd, s256, ttl } (ttl: access-token seconds), and
//                 { revokeAll: true } revokes every grant, as a server-side
//                 revocation would.
//
// Every request must carry the credential in E2E_MCP_REQUIRE (`<header>=<value>`,
// e.g. `authorization=Bearer up-secret`); otherwise it answers 401 with a
// WWW-Authenticate naming its resource metadata, which is what makes a client
// start its own OAuth. GET /_e2e/calls lists each request with whether it
// carried that credential and whether any header held a box token (tmag_…),
// never a header value. POST /_e2e/require changes the credential at run time.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const port = Number(process.env.E2E_MCP_PORT ?? 4693);
const host = process.env.E2E_MCP_HOST ?? '127.0.0.1';
const base = process.env.E2E_MCP_BASE ?? '/mcp';
const slowMs = Number(process.env.E2E_MCP_SLOW_MS ?? 1500);
const cert = process.env.E2E_MCP_CERT;
const key = process.env.E2E_MCP_KEY;
let require = parseRequire(process.env.E2E_MCP_REQUIRE ?? '');
const calls = [];
const sessions = new Set();

function parseRequire(spec) {
  const i = spec.indexOf('=');
  return i > 0 ? { name: spec.slice(0, i).toLowerCase(), value: spec.slice(i + 1) } : null;
}

const asConfig = { dcr: true, cimd: false, s256: true, ttl: 3600 };
const asStats = { registered: 0, authorized: 0, codeGrants: 0, refreshes: 0, reuse: 0, revoked: 0, refused: [] };
const clients = new Map();
const codes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();
const revokedFamilies = new Set();

const record = (line) => { calls.push(line); console.log(new Date().toISOString(), JSON.stringify(line)); };
const sawBoxToken = (req) => Object.values(req.headers).some((v) => String(v).includes('tmag_'));
const origin = (req) => `${cert ? 'https' : 'http'}://${req.headers.host}`;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }

const tools = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'slow', description: 'Answer after a pause, streamed', inputSchema: { type: 'object', properties: {} } },
];

async function handlePost(req, res, line) {
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch { msg = null; }
  if (!msg || typeof msg !== 'object') {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
    return;
  }
  line.rpc = msg.method;
  record(line);
  const reply = (status, body, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(body === undefined ? '' : JSON.stringify(body));
  if (msg.id === undefined) { reply(202); return; }
  switch (msg.method) {
    case 'initialize': {
      const sid = `sess-${sessions.size + 1}-${Date.now()}`;
      sessions.add(sid);
      reply(200, rpcResult(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'e2e-mcp-upstream', version: '1.0.0' },
      }), { 'mcp-session-id': sid });
      return;
    }
    case 'ping': reply(200, rpcResult(msg.id, {})); return;
    case 'tools/list': reply(200, rpcResult(msg.id, { tools })); return;
    case 'tools/call': {
      const name = msg.params?.name;
      if (name === 'echo') {
        reply(200, rpcResult(msg.id, { content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }] }));
        return;
      }
      if (name === 'slow') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: msg.id, progress: 1, total: 2 } })}\n\n`);
        setTimeout(() => {
          res.end(`event: message\ndata: ${JSON.stringify(rpcResult(msg.id, { content: [{ type: 'text', text: 'slow: done' }] }))}\n\n`);
        }, slowMs);
        return;
      }
      reply(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
      return;
    }
    default:
      reply(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}


const rand = () => randomBytes(18).toString('base64url');
const json = (res, status, body, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));

function asRefuse(res, status, error, why) {
  asStats.refused.push(`${error}: ${why}`);
  json(res, status, { error, error_description: why });
}

function issue(family, clientId, resource) {
  const access = `at-${rand()}`;
  const refresh = `rt-${rand()}`;
  accessTokens.set(access, { family, expiresAt: Date.now() + asConfig.ttl * 1000 });
  refreshTokens.set(refresh, { family, clientId, resource, used: false });
  return { access_token: access, token_type: 'Bearer', expires_in: asConfig.ttl, refresh_token: refresh };
}

function bearerOk(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const t = m && accessTokens.get(m[1]);
  return !!t && t.expiresAt > Date.now() && !revokedFamilies.has(t.family);
}

async function handleAs(req, res, url) {
  const o = origin(req);
  const issuer = `${o}/as`;
  if (url.pathname === '/.well-known/oauth-authorization-server/as') {
    json(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      ...(asConfig.dcr ? { registration_endpoint: `${issuer}/register` } : {}),
      revocation_endpoint: `${issuer}/revoke`,
      code_challenge_methods_supported: asConfig.s256 ? ['S256'] : ['plain'],
      client_id_metadata_document_supported: asConfig.cimd,
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    return;
  }
  if (url.pathname === '/as/register' && req.method === 'POST' && asConfig.dcr) {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = null; }
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (uris.length === 0) { asRefuse(res, 400, 'invalid_redirect_uri', 'redirect_uris is required'); return; }
    const id = `dcr-${clients.size + 1}`;
    clients.set(id, { redirectUris: uris });
    asStats.registered++;
    json(res, 201, { client_id: id, redirect_uris: uris, token_endpoint_auth_method: 'none' });
    return;
  }
  if (url.pathname === '/as/authorize' && req.method === 'GET') {
    const p = Object.fromEntries(url.searchParams);
    const client = clients.get(p.client_id);
    const cimd = asConfig.cimd && /^https:\/\//.test(p.client_id ?? '');
    if (!client && !cimd) { asRefuse(res, 400, 'invalid_client', 'unknown client_id'); return; }
    if (client && !client.redirectUris.includes(p.redirect_uri)) { asRefuse(res, 400, 'invalid_request', 'redirect_uri is not registered'); return; }
    if (p.response_type !== 'code') { asRefuse(res, 400, 'unsupported_response_type', 'code only'); return; }
    if (p.code_challenge_method !== 'S256' || !p.code_challenge) { asRefuse(res, 400, 'invalid_request', 'PKCE S256 is required'); return; }
    if (p.resource !== `${o}${base}`) { asRefuse(res, 400, 'invalid_target', 'resource is not this server'); return; }
    if (!p.state) { asRefuse(res, 400, 'invalid_request', 'state is required'); return; }
    const code = `code-${rand()}`;
    codes.set(code, { clientId: p.client_id, redirectUri: p.redirect_uri, challenge: p.code_challenge, resource: p.resource, used: false });
    asStats.authorized++;
    const back = new URL(p.redirect_uri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.state);
    back.searchParams.set('iss', issuer);
    res.writeHead(302, { location: back.toString() }).end();
    return;
  }
  if (url.pathname === '/as/token' && req.method === 'POST') {
    const f = Object.fromEntries(new URLSearchParams(await readBody(req)));
    if (f.grant_type === 'authorization_code') {
      const c = codes.get(f.code);
      if (!c || c.used) { asRefuse(res, 400, 'invalid_grant', 'unknown or used code'); return; }
      c.used = true;
      if (c.clientId !== f.client_id || c.redirectUri !== f.redirect_uri) { asRefuse(res, 400, 'invalid_grant', 'client or redirect_uri mismatch'); return; }
      if (createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) { asRefuse(res, 400, 'invalid_grant', 'PKCE verifier mismatch'); return; }
      if (f.resource !== c.resource) { asRefuse(res, 400, 'invalid_target', 'resource mismatch'); return; }
      asStats.codeGrants++;
      json(res, 200, issue(rand(), c.clientId, c.resource));
      return;
    }
    if (f.grant_type === 'refresh_token') {
      const r = refreshTokens.get(f.refresh_token);
      if (!r) { asRefuse(res, 400, 'invalid_grant', 'unknown refresh token'); return; }
      if (r.used) {
        asStats.reuse++;
        revokedFamilies.add(r.family);
        asRefuse(res, 400, 'invalid_grant', 'refresh token reused; family revoked');
        return;
      }
      if (revokedFamilies.has(r.family)) { asRefuse(res, 400, 'invalid_grant', 'revoked'); return; }
      if (r.clientId !== f.client_id) { asRefuse(res, 400, 'invalid_grant', 'client mismatch'); return; }
      if (f.resource !== r.resource) { asRefuse(res, 400, 'invalid_target', 'resource mismatch'); return; }
      r.used = true;
      asStats.refreshes++;
      json(res, 200, issue(r.family, r.clientId, r.resource));
      return;
    }
    asRefuse(res, 400, 'unsupported_grant_type', String(f.grant_type));
    return;
  }
  if (url.pathname === '/as/revoke' && req.method === 'POST') {
    const f = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const t = refreshTokens.get(f.token) ?? accessTokens.get(f.token);
    if (t) { revokedFamilies.add(t.family); asStats.revoked++; }
    res.writeHead(200).end();
    return;
  }
  json(res, 404, { error: 'not found' });
}

async function handler(req, res) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/_e2e/calls') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(calls));
    return;
  }
  if (url.pathname === '/_e2e/require' && req.method === 'POST') {
    require = parseRequire(await readBody(req));
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/_e2e/as') {
    if (req.method === 'POST') {
      let patch;
      try { patch = JSON.parse(await readBody(req)); } catch { patch = {}; }
      for (const k of Object.keys(asConfig)) if (patch[k] !== undefined) asConfig[k] = patch[k];
      if (patch.revokeAll) for (const t of [...accessTokens.values(), ...refreshTokens.values()]) revokedFamilies.add(t.family);
    }
    json(res, 200, { config: asConfig, stats: asStats, revokedFamilies: revokedFamilies.size });
    return;
  }
  if (url.pathname.startsWith('/as/') || url.pathname === '/.well-known/oauth-authorization-server/as') {
    record({ method: req.method, path: url.pathname, served: 'as' });
    await handleAs(req, res, url);
    return;
  }
  const authed = require === null || req.headers[require.name] === require.value || bearerOk(req);
  const line = { method: req.method, path: url.pathname, query: url.search, authed, boxToken: sawBoxToken(req), host: req.headers.host };
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    record({ ...line, served: 'prm' });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      resource: `${origin(req)}${base}`, authorization_servers: [`${origin(req)}/as`],
    }));
    return;
  }
  if (url.pathname !== base) {
    record({ ...line, status: 404 });
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }
  if (!authed) {
    record({ ...line, status: 401 });
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource${base}"`,
    }).end('{"error":"invalid_token"}');
    return;
  }
  if (req.method === 'POST') { await handlePost(req, res, line); return; }
  if (req.method === 'GET') {
    record({ ...line, stream: 'open' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': open\n\n');
    const t = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 1000);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (req.method === 'DELETE') { record({ ...line, status: 204 }); res.writeHead(204).end(); return; }
  record({ ...line, status: 405 });
  res.writeHead(405).end();
}

const server = cert && key
  ? createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, handler)
  : createHttp(handler);
server.listen(port, host, () => console.log(`MCP upstream stub on ${cert ? 'https' : 'http'}://${host}:${port}${base}`));
