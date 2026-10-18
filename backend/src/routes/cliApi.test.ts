import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { CliBox, CliProject } from '../services/cliViews';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = req.get('x-test-user');
    if (!id) { res.status(401).json({ error: 'Unauthorized' }); return; }
    (req as unknown as { user: { id: string } }).user = { id };
    next();
  },
}));

const { cliApiRouter, cliDevicesRouter } = await import('./cliApi');
const { AuthCodeStore, pkceChallenge, sha256Hex } = await import('../services/cliAuth');
const { CliJwt, localCliJwtKey } = await import('../services/cliJwt');

const ISSUER = 'https://termag.example.com/termag';
const jwt = new CliJwt(ISSUER, [localCliJwtKey()]);

const DAY = 24 * 60 * 60 * 1000;
const VERIFIER = 'v'.repeat(43);
const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const bob: CliUser = { id: 'bob', googleEmail: 'bob@example.com', unixUsername: 'bob', displayName: 'Bob' };

function box(name: string): CliBox {
  return {
    id: `i-${name}`, name, addressable: true, kind: 'ec2', state: 'running', status: 'ready', agentConnected: true,
    error: null, ec2InstanceId: null, region: null, hostUnixUser: null, createdAt: '', readyAt: null, projects: [],
  };
}

class FakeStore implements CliStore {
  sessions: CliSessionRecord[] = [];
  touches = 0;
  agentTokens = new Map<string, { user: CliUser; instanceId: string | null } | null>();
  boxes = new Map<string, CliBox[]>([['alice', [box('devbox')]], ['bob', [box('bobbox')]]]);
  projects = new Map<string, CliProject[]>();
  private users = new Map([['alice', alice], ['bob', bob]]);

  async createSession(input: { userId: string; deviceName: string; tokenHash: string; tokenPrefix: string; now: Date }) {
    for (const s of this.sessions) {
      if (s.userId === input.userId && s.deviceName === input.deviceName && !s.revokedAt) s.revokedAt = input.now;
    }
    const row: CliSessionRecord = {
      id: `s${this.sessions.length + 1}`, userId: input.userId, user: this.users.get(input.userId)!,
      deviceName: input.deviceName, tokenPrefix: input.tokenPrefix, createdAt: input.now, lastUsedAt: input.now, revokedAt: null,
      ...{ tokenHash: input.tokenHash },
    };
    this.sessions.push(row);
    return row;
  }
  async findSessionByHash(tokenHash: string) {
    return this.sessions.find(s => (s as unknown as { tokenHash: string }).tokenHash === tokenHash) ?? null;
  }
  async findSessionById(id: string) {
    return this.sessions.find(s => s.id === id) ?? null;
  }
  async touchSession(id: string, now: Date) {
    this.touches++;
    this.sessions.find(s => s.id === id)!.lastUsedAt = now;
  }
  async revokeSession(id: string, now: Date) {
    const s = this.sessions.find(x => x.id === id);
    if (s && !s.revokedAt) s.revokedAt = now;
  }
  async validateAgentToken(raw: string) { return this.agentTokens.get(raw) ?? null; }
  async listBoxes(userId: string) { return this.boxes.get(userId) ?? []; }
  async listProjects(userId: string) { return this.projects.get(userId) ?? []; }
  async listDevices(userId: string) { return this.sessions.filter(s => s.userId === userId && !s.revokedAt); }
  async revokeDevice(userId: string, id: string, now: Date) {
    const s = this.sessions.find(x => x.id === id && x.userId === userId && !x.revokedAt);
    if (!s) return false;
    s.revokedAt = now;
    return true;
  }
}

let store: FakeStore;
let codes: InstanceType<typeof AuthCodeStore>;
let clock: number;
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', (req, res, next) => cliApiRouter({ store, codes, jwt: Promise.resolve(jwt), now: () => new Date(clock) })(req, res, next));
  app.use('/api/cli-devices', (req, res, next) => cliDevicesRouter({ store, now: () => new Date(clock) })(req, res, next));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  store = new FakeStore();
  codes = new AuthCodeStore();
  clock = Date.parse('2026-10-02T00:00:00Z');
});

function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.body) headers.set('content-type', 'application/json');
  return fetch(`${base}${path}`, { ...init, headers });
}

async function signIn(userId = 'alice', deviceName = 'mbp'): Promise<{ token: string; accessToken: string }> {
  const code = codes.issue({ userId, deviceName, codeChallenge: pkceChallenge(VERIFIER) }, clock);
  const res = await call('/api/cli/v1/token', {
    method: 'POST',
    body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: VERIFIER }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; accessToken: string };
}

async function login(userId = 'alice', deviceName = 'mbp'): Promise<string> {
  return (await signIn(userId, deviceName)).token;
}

function refresh(refreshToken: string) {
  return call('/api/cli/v1/token', {
    method: 'POST', body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
}

describe('POST /api/cli/v1/token', () => {
  it('trades a code for a device token and stores only its hash', async () => {
    const code = codes.issue({ userId: 'alice', deviceName: 'mbp', codeChallenge: pkceChallenge(VERIFIER) }, clock);
    const res = await call('/api/cli/v1/token', {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: VERIFIER }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      deviceName: 'mbp',
      user: { email: 'alice@example.com', unixUsername: 'alice' },
      expiresAt: new Date(clock + 7 * DAY).toISOString(),
      maxExpiresAt: new Date(clock + 30 * DAY).toISOString(),
    });
    expect(body.token).toMatch(/^tmcli_/);
    expect(body.accessTokenExpiresIn).toBe(3600);
    expect(jwt.verify(body.accessToken as string, clock)).toEqual({
      sub: 'alice', jti: store.sessions[0].id, exp: clock / 1000 + 3600,
    });
    expect(JSON.stringify(store.sessions)).not.toContain(body.token as string);
    expect(JSON.stringify(store.sessions)).toContain(sha256Hex(body.token as string));
  });

  it('refuses a reused code, a wrong verifier and other grant types', async () => {
    const code = codes.issue({ userId: 'alice', deviceName: 'mbp', codeChallenge: pkceChallenge(VERIFIER) }, clock);
    const exchange = (verifier: string, grant = 'authorization_code') => call('/api/cli/v1/token', {
      method: 'POST', body: JSON.stringify({ grant_type: grant, code, code_verifier: verifier }),
    });
    expect((await exchange(VERIFIER, 'password')).status).toBe(400);
    expect(await (await exchange('w'.repeat(43))).json()).toMatchObject({ code: 'invalid_grant' });
    expect((await exchange(VERIFIER)).status).toBe(400);
    expect(store.sessions).toHaveLength(0);
  });

  it('revokes the earlier sign-in on the same device only', async () => {
    const first = await login('alice', 'mbp');
    const other = await login('alice', 'desktop');
    const second = await login('alice', 'mbp');
    expect((await call('/api/cli/v1/whoami', { token: first })).status).toBe(401);
    expect((await call('/api/cli/v1/whoami', { token: other })).status).toBe(200);
    expect((await call('/api/cli/v1/whoami', { token: second })).status).toBe(200);
  });
});

describe('access tokens', () => {
  it('authenticate as the device session they were minted from', async () => {
    const { accessToken } = await signIn();
    const res = await call('/api/cli/v1/whoami', { token: accessToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: 'alice@example.com' }, credential: { kind: 'device', deviceName: 'mbp' } });
  });

  it('stop at once when the session is revoked, and lapse after an hour', async () => {
    const { accessToken } = await signIn();
    expect((await call('/api/cli/v1/token', { method: 'DELETE', token: accessToken })).status).toBe(204);
    expect((await call('/api/cli/v1/whoami', { token: accessToken })).status).toBe(401);

    const other = await signIn('bob');
    clock += 3600_000;
    expect((await call('/api/cli/v1/whoami', { token: other.accessToken })).status).toBe(401);
  });

  it('refuse a token whose subject is not the session owner', async () => {
    await signIn('alice');
    const forged = await jwt.issue('bob', store.sessions[0].id, clock);
    expect((await call('/api/cli/v1/whoami', { token: forged.token })).status).toBe(401);
  });

  it('refresh with the device token, which slides the idle window', async () => {
    const { token } = await signIn();
    clock += 6 * DAY;
    const res = await refresh(token);
    expect(res.status).toBe(200);
    const body = await res.json() as { accessToken: string; accessTokenExpiresIn: number; expiresAt: string };
    expect(body.accessTokenExpiresIn).toBe(3600);
    expect(body.expiresAt).toBe(new Date(clock + 7 * DAY).toISOString());
    expect((await call('/api/cli/v1/whoami', { token: body.accessToken })).status).toBe(200);
    expect(store.sessions[0].lastUsedAt.getTime()).toBe(clock);
  });

  it('refuse a refresh for a revoked, idle or unknown device token', async () => {
    const { token, accessToken } = await signIn();
    await call('/api/cli/v1/token', { method: 'DELETE', token: accessToken });
    expect(await (await refresh(token)).json()).toMatchObject({ code: 'auth_required', error: expect.stringContaining('signed out') });

    const idle = await login('bob');
    clock += 7 * DAY;
    expect((await refresh(idle)).status).toBe(401);
    expect((await refresh('tmcli_' + '0'.repeat(64))).status).toBe(401);
    expect((await refresh(accessToken)).status).toBe(401);
  });

  it('publish their keys at /jwks.json for the ALB', async () => {
    const res = await call('/api/cli/v1/jwks.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await res.json()).toEqual(jwt.jwks());
  });
});

describe('bearer auth', () => {
  it('refuses requests without a bearer token, whatever else they carry', async () => {
    for (const headers of [{}, { cookie: 'termag.sid=s%3Aabc' }, { 'x-amzn-oidc-data': 'eyJ.eyJ.sig' }]) {
      const res = await call('/api/cli/v1/whoami', { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toMatchObject({ code: 'auth_required' });
    }
  });

  it('refuses unknown and malformed tokens', async () => {
    expect((await call('/api/cli/v1/whoami', { token: 'tmcli_' + '0'.repeat(64) })).status).toBe(401);
    expect((await call('/api/cli/v1/whoami', { token: 'something-else' })).status).toBe(401);
  });

  it('expires after 7 idle days, slides with use, and stops at 30 days', async () => {
    const token = await login();
    for (let day = 6; day <= 24; day += 6) {
      clock += 6 * DAY;
      expect((await call('/api/cli/v1/whoami', { token })).status).toBe(200);
    }
    clock += 6 * DAY;
    const res = await call('/api/cli/v1/whoami', { token });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('expired') });

    const idle = await login('bob');
    clock += 7 * DAY;
    expect((await call('/api/cli/v1/whoami', { token: idle })).status).toBe(401);
  });

  it('writes lastUsedAt at most once a minute', async () => {
    const token = await login();
    await call('/api/cli/v1/whoami', { token });
    await call('/api/cli/v1/whoami', { token });
    expect(store.touches).toBe(0);
    clock += 61_000;
    await call('/api/cli/v1/whoami', { token });
    expect(store.touches).toBe(1);
  });

  it('accepts an owner-bound box token and refuses an ownerless one', async () => {
    store.agentTokens.set('tmag_box', { user: alice, instanceId: 'i-devbox' });
    store.agentTokens.set('tmag_warm', null);
    const ok = await call('/api/cli/v1/whoami', { token: 'tmag_box' });
    expect(await ok.json()).toEqual({
      user: { email: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' },
      credential: { kind: 'box', boxId: 'i-devbox' },
    });
    expect((await call('/api/cli/v1/whoami', { token: 'tmag_warm' })).status).toBe(401);
  });
});

describe('DELETE /api/cli/v1/token', () => {
  it('revokes the presented token', async () => {
    const token = await login();
    expect((await call('/api/cli/v1/token', { method: 'DELETE', token })).status).toBe(204);
    const after = await call('/api/cli/v1/whoami', { token });
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ error: expect.stringContaining('signed out') });
  });

  it('does not log out box credentials', async () => {
    store.agentTokens.set('tmag_box', { user: alice, instanceId: 'i-devbox' });
    const res = await call('/api/cli/v1/token', { method: 'DELETE', token: 'tmag_box' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'box_credential' });
  });
});

describe('reads', () => {
  it('whoami describes the device sign-in', async () => {
    const token = await login();
    expect(await (await call('/api/cli/v1/whoami', { token })).json()).toEqual({
      user: { email: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' },
      credential: {
        kind: 'device', deviceName: 'mbp',
        expiresAt: new Date(clock + 7 * DAY).toISOString(), maxExpiresAt: new Date(clock + 30 * DAY).toISOString(),
      },
    });
  });

  it('lists only the caller\'s boxes and projects', async () => {
    const token = await login('alice');
    store.projects.set('alice', [{
      id: 'p1', name: 'fix', ref: 'devbox/fix', box: { id: 'i-devbox', name: 'devbox' }, provider: 'claude',
      status: 'idle', waitingReason: null, rateLimited: null, workstreams: ['main'], lastActiveAt: '',
    }]);
    expect(await (await call('/api/cli/v1/boxes', { token })).json()).toEqual({ boxes: [box('devbox')] });
    expect(((await (await call('/api/cli/v1/projects', { token })).json()) as { projects: CliProject[] }).projects.map(p => p.ref))
      .toEqual(['devbox/fix']);
  });

  it('answers unknown CLI paths with JSON 404', async () => {
    const res = await call('/api/cli/v1/nope', { token: await login() });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
  });
});

describe('/api/cli-devices (web UI)', () => {
  it('lists and revokes the caller\'s devices only', async () => {
    const token = await login('alice', 'mbp');
    await login('bob', 'bobs-laptop');
    const list = await (await call('/api/cli-devices', { headers: { 'x-test-user': 'alice' } })).json() as Array<{ id: string; deviceName: string }>;
    expect(list.map(d => d.deviceName)).toEqual(['mbp']);
    const bobsId = store.sessions.find(s => s.userId === 'bob')!.id;
    expect((await call(`/api/cli-devices/${bobsId}`, { method: 'DELETE', headers: { 'x-test-user': 'alice' } })).status).toBe(404);
    expect((await call(`/api/cli-devices/${list[0].id}`, { method: 'DELETE', headers: { 'x-test-user': 'alice' } })).status).toBe(200);
    expect((await call('/api/cli/v1/whoami', { token })).status).toBe(401);
  });

  it('needs a browser session', async () => {
    expect((await call('/api/cli-devices')).status).toBe(401);
  });
});
