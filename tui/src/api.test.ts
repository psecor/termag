import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, TermagApi } from './api.js';

let server: Server;
let base: string;
let seen: Array<{ method?: string; url?: string; auth?: string; body: string }>;
let reply: (req: IncomingMessage) => { status: number; body?: unknown; headers?: Record<string, string> };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const r = reply(req);
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      res.end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  reply = () => ({ status: 200, body: {} });
});

describe('TermagApi', () => {
  it('calls the CLI API with the bearer token and unwraps lists', async () => {
    reply = (req) => req.url?.endsWith('/lobby')
      ? { status: 200, body: { projects: [{ id: 'p1' }] } }
      : { status: 200, body: { sessions: [{ projectId: 'p1' }] } };
    const api = new TermagApi(base, 'tmcli_tok');
    expect(await api.listProjects()).toEqual([{ id: 'p1' }]);
    expect(await api.listSessions()).toEqual([{ projectId: 'p1' }]);
    expect(seen.map(s => [s.method, s.url, s.auth])).toEqual([
      ['GET', '/termag/api/cli/v1/lobby', 'Bearer tmcli_tok'],
      ['GET', '/termag/api/cli/v1/sessions', 'Bearer tmcli_tok'],
    ]);
  });

  it('sends capture to the CLI API', async () => {
    const api = new TermagApi(base, 't');
    await api.capture('p 1', 'ctrl', 'feat', 5000, true);
    expect(seen[0].url).toBe('/termag/api/cli/v1/projects/p%201/sessions/ctrl/capture?lines=1000&workstream=feat&styled=1');
  });

  it('has no send-keys: the CLI API is read-only', () => {
    expect('sendKeys' in TermagApi.prototype).toBe(false);
  });

  it('surfaces the server\'s error, e.g. a lapsed sign-in', async () => {
    reply = () => ({ status: 401, body: { error: 'Sign-in expired; run `termag login`', code: 'auth_required' } });
    const err = await new TermagApi(base, 't').listProjects().catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: 'Sign-in expired; run `termag login`' });
  });

  it('renews an access token about to lapse with the device token, once for concurrent calls', async () => {
    reply = (req) => req.url?.endsWith('/token')
      ? { status: 200, body: { accessToken: 'eyJfresh', accessTokenExpiresIn: 3600 } }
      : { status: 200, body: { projects: [], sessions: [] } };
    const refresh = { refreshToken: 'tmcli_dev', expiresAt: Date.now() + 30_000 };
    const api = new TermagApi(base, 'eyJold', refresh);
    await Promise.all([api.listProjects(), api.listSessions()]);
    await api.listProjects();
    expect(seen.map(s => [s.method, s.url, s.auth])).toEqual([
      ['POST', '/termag/api/cli/v1/token', undefined],
      ['GET', '/termag/api/cli/v1/lobby', 'Bearer eyJfresh'],
      ['GET', '/termag/api/cli/v1/sessions', 'Bearer eyJfresh'],
      ['GET', '/termag/api/cli/v1/lobby', 'Bearer eyJfresh'],
    ]);
    expect(JSON.parse(seen[0].body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'tmcli_dev' });
    expect(refresh.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
  });

  it('keeps an access token with time left, and never renews a box token', async () => {
    reply = () => ({ status: 200, body: { projects: [] } });
    await new TermagApi(base, 'eyJok', { refreshToken: 'tmcli_dev', expiresAt: Date.now() + 600_000 }).listProjects();
    await new TermagApi(base, 'tmag_box').listProjects();
    expect(seen.map(s => s.auth)).toEqual(['Bearer eyJok', 'Bearer tmag_box']);
  });

  it('reads an HTML 401 from the edge as a credential to renew by signing in again', async () => {
    reply = () => ({ status: 401, headers: { 'content-type': 'text/html' } });
    const err = await new TermagApi(base, 'eyJx').listProjects().catch(e => e);
    expect(err).toMatchObject({ status: 401, message: expect.stringContaining('run `termag login`') });
  });

  it('explains an edge that redirects to a browser sign-in instead of following it', async () => {
    reply = () => ({ status: 302, headers: { location: 'https://okta.example/authorize' } });
    const err = await new TermagApi(base, 't').listSessions().catch(e => e);
    expect(err).toMatchObject({ status: 302, message: expect.stringContaining('browser sign-in') });
    expect(seen).toHaveLength(1);
  });
});
