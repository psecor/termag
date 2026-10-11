import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { cliAuthorizeRouter } from './cliAuthorize';
import { AuthCodeStore, pkceChallenge } from '../services/cliAuth';

const VERIFIER = 'v'.repeat(43);
const CHALLENGE = pkceChallenge(VERIFIER);
const PARAMS = {
  port: '53682', state: 'abcdefghijklmnop', code_challenge: CHALLENGE,
  code_challenge_method: 'S256', device_name: 'mbp',
};

let codes: AuthCodeStore;
let edgeEmail: string | null | Error;
let remember: ((req: unknown, url: string) => Promise<boolean>) | undefined;
let remembered: string[];
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  // Stand-in for the session stack: x-test-user signs the request in.
  app.use((req, _res, next) => {
    const email = req.get('x-test-user');
    if (email) (req as unknown as { user: object }).user = { id: `id:${email}`, googleEmail: email };
    next();
  });
  app.use('/termag/auth/cli', (req, res, next) => cliAuthorizeRouter({
    codes,
    basePath: '/termag',
    frontendUrl: 'http://ui.example',
    edgeIdentityEmail: async () => {
      if (edgeEmail instanceof Error) throw edgeEmail;
      return edgeEmail;
    },
    rememberReturnTo: remember,
  })(req, res, next));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  codes = new AuthCodeStore();
  edgeEmail = null;
  remember = undefined;
  remembered = [];
});

const authorizeUrl = (params: Record<string, string> = PARAMS) =>
  `${base}/termag/auth/cli/authorize?${new URLSearchParams(params)}`;

function approve(headers: Record<string, string>, decision = 'approve', params: Record<string, string> = PARAMS) {
  return fetch(`${base}/termag/auth/cli/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ ...params, decision }).toString(),
  });
}

describe('GET /auth/cli/authorize', () => {
  it('renders the approval page with the signed-in account and strict headers', async () => {
    const res = await fetch(authorizeUrl(), { headers: { 'x-test-user': 'alice@example.com' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self' http://127.0.0.1:53682");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const html = await res.text();
    expect(html).toContain('alice@example.com');
    expect(html).toContain('<strong>mbp</strong>');
    expect(html).toContain('action="/termag/auth/cli/authorize"');
  });

  it('asks an anonymous browser to sign in first', async () => {
    const res = await fetch(authorizeUrl());
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('href="/termag/auth/login"');
  });

  it('sends an anonymous browser to sign in and remembers where to come back to', async () => {
    remember = async (_req, url) => { remembered.push(url); return true; };
    const res = await fetch(authorizeUrl(), { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/termag/auth/login');
    expect(remembered).toEqual([`/termag/auth/cli/authorize?${new URLSearchParams(PARAMS)}`]);
  });

  it('falls back to asking when the return address cannot be remembered', async () => {
    remember = async () => false;
    const res = await fetch(authorizeUrl(), { redirect: 'manual' });
    expect(res.status).toBe(401);
  });

  it('does not remember a malformed request', async () => {
    remember = async (_req, url) => { remembered.push(url); return true; };
    const res = await fetch(authorizeUrl({ ...PARAMS, code_challenge_method: 'plain' }), { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(remembered).toEqual([]);
  });

  it('rejects a malformed request before anything else', async () => {
    const res = await fetch(authorizeUrl({ ...PARAMS, code_challenge_method: 'plain' }), { headers: { 'x-test-user': 'alice@example.com' } });
    expect(res.status).toBe(400);
  });

  it('refuses when the edge identity is someone else', async () => {
    edgeEmail = 'mallory@example.com';
    const res = await fetch(authorizeUrl(), { headers: { 'x-test-user': 'alice@example.com' } });
    expect(res.status).toBe(403);
  });
});

describe('POST /auth/cli/authorize', () => {
  const signedIn = { 'x-test-user': 'alice@example.com', 'sec-fetch-site': 'same-origin' };

  it('issues a code bound to the challenge and redirects to the loopback', async () => {
    const res = await approve(signedIn);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('http://127.0.0.1:53682');
    expect(location.pathname).toBe('/callback');
    expect(location.searchParams.get('state')).toBe(PARAMS.state);
    const code = location.searchParams.get('code')!;
    expect(codes.redeem(code, VERIFIER)).toEqual({ userId: 'id:alice@example.com', deviceName: 'mbp' });
  });

  it('accepts a matching Origin when Sec-Fetch-Site is absent', async () => {
    const res = await approve({ 'x-test-user': 'alice@example.com', origin: base });
    expect(res.status).toBe(303);
    const ui = await approve({ 'x-test-user': 'alice@example.com', origin: 'http://ui.example' });
    expect(ui.status).toBe(303);
  });

  it.each([
    ['a same-site page', { 'sec-fetch-site': 'same-site' }],
    ['a cross-site page', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['no provenance at all', {}],
  ])('refuses a post from %s', async (_label, headers) => {
    const res = await approve({ 'x-test-user': 'alice@example.com', ...headers });
    expect(res.status).toBe(403);
    expect(codes.size).toBe(0);
  });

  it('sends a cancel back to the CLI without a code', async () => {
    const res = await approve(signedIn, 'deny');
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.has('code')).toBe(false);
    expect(codes.size).toBe(0);
  });

  it('refuses an anonymous post', async () => {
    const res = await approve({ 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(401);
    expect(codes.size).toBe(0);
  });

  it('refuses on an edge identity mismatch or an unverifiable one', async () => {
    edgeEmail = 'mallory@example.com';
    expect((await approve(signedIn)).status).toBe(403);
    edgeEmail = new Error('bad signature');
    expect((await approve(signedIn)).status).toBe(403);
    edgeEmail = 'ALICE@example.com';
    expect((await approve(signedIn)).status).toBe(303);
  });
});

describe('the rest of /auth/cli', () => {
  it.each([
    ['GET', '/termag/auth/cli'],
    ['GET', '/termag/auth/cli/'],
    ['POST', '/termag/auth/cli/exchange'],
    ['GET', '/termag/auth/cli/anything?port=53682'],
  ])('%s %s is answered here, not passed on', async (method, path) => {
    const res = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: { 'x-test-user': 'alice@example.com' } });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('termag login');
    expect(codes.size).toBe(0);
  });
});
