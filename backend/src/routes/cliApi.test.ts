import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { CliBox, CliProject } from '../services/cliViews';

vi.mock('../db', () => ({ prisma: {} }));
const productEvents: Array<{ name: string; ctx: unknown; detail: unknown }> = [];
vi.mock('../services/productEvents', () => ({
  recordProductEvent: (name: string, ctx: unknown, detail: unknown) => { productEvents.push({ name, ctx, detail }); },
}));
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

  async createSession(input: { userId: string; deviceName: string; tokenHash: string; tokenPrefix: string; now: Date; issuedOnBoxId?: string | null }) {
    for (const s of this.sessions) {
      if (s.userId === input.userId && s.deviceName === input.deviceName && !s.revokedAt) s.revokedAt = input.now;
    }
    const row: CliSessionRecord = {
      id: `s${this.sessions.length + 1}`, userId: input.userId, user: this.users.get(input.userId)!,
      deviceName: input.deviceName, tokenPrefix: input.tokenPrefix, createdAt: input.now, lastUsedAt: input.now, revokedAt: null, issuedOnBoxId: input.issuedOnBoxId ?? null,
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
  admins = new Set<string>();
  async isAdmin(userId: string) { return this.admins.has(userId); }
}

let store: FakeStore;
let codes: InstanceType<typeof AuthCodeStore>;
let clock: number;
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', (req, res, next) => cliApiRouter({ store, codes, jwt: Promise.resolve(jwt), now: () => new Date(clock), features: u => featuresFor(u) })(req, res, next));
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

  // Where a sign-in is made (preview links' SR5): a CLI on a box sends the box's own credential with the exchange.
  it('records the box a sign-in was made on, from the box credential sent with the exchange', async () => {
    store.agentTokens.set('tmag_box', { user: alice, instanceId: 'i-devbox' });
    const exchange = async (extra: Record<string, unknown>) => {
      const code = codes.issue({ userId: 'alice', deviceName: `d${store.sessions.length}`, codeChallenge: pkceChallenge(VERIFIER) }, clock);
      return call('/api/cli/v1/token', { method: 'POST', body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, ...extra }) });
    };
    expect((await exchange({ box_token: 'tmag_box' })).status).toBe(201);
    expect((await exchange({})).status).toBe(201);
    // A credential that isn't one marks nothing; nor does anything that isn't a box token.
    expect((await exchange({ box_token: 'tmag_nope' })).status).toBe(201);
    expect((await exchange({ box_token: 'tmcli_x' })).status).toBe(201);
    expect(store.sessions.map(s => s.issuedOnBoxId)).toEqual(['i-devbox', null, null, null]);
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

// What termag turns on for the person, as whoami reports it (routes/cliFeatures.ts).
let featuresFor: (user: { id: string }) => Promise<{ automations: boolean }> = async () => ({ automations: false });

describe('access tokens', () => {
  it('authenticate as the device session they were minted from', async () => {
    const { accessToken } = await signIn();
    const res = await call('/api/cli/v1/whoami', { token: accessToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: 'alice@example.com' }, credential: { kind: 'device', deviceName: 'mbp' } });
  });

  it('say in whoami whether the user is an admin', async () => {
    store.admins.add('alice');
    const alice = await signIn();
    expect(await (await call('/api/cli/v1/whoami', { token: alice.accessToken })).json()).toMatchObject({ user: { email: 'alice@example.com', admin: true } });
    const bob = await signIn('bob');
    expect(await (await call('/api/cli/v1/whoami', { token: bob.accessToken })).json()).toMatchObject({ user: { email: 'bob@example.com', admin: false } });
  });

  it("say in whoami what termag turns on for the person, and off when the lookup fails", async () => {
    const alice = await signIn();
    featuresFor = async u => ({ automations: u.id === 'alice' });
    expect(await (await call('/api/cli/v1/whoami', { token: alice.accessToken })).json()).toMatchObject({ features: { automations: true } });
    const bob = await signIn('bob');
    expect(await (await call('/api/cli/v1/whoami', { token: bob.accessToken })).json()).toMatchObject({ features: { automations: false } });
    featuresFor = async () => { throw new Error('the flag source is down'); };
    const res = await call('/api/cli/v1/whoami', { token: alice.accessToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ features: { automations: false } });
    featuresFor = async () => ({ automations: false });
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
      user: { email: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice', admin: false },
      features: { automations: false },
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
      user: { email: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice', admin: false },
      features: { automations: false },
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

describe('/api/cli/v1/devices (the desktop)', () => {
  it("lists the caller's live sign-ins, marking its own", async () => {
    const desktop = await login('alice', 'mbp desktop');
    await login('alice', 'mbp');
    await login('bob', 'bobs-laptop');
    const res = await call('/api/cli/v1/devices', { token: desktop });
    expect(res.status).toBe(200);
    const { devices } = await res.json() as { devices: Array<{ deviceName: string; current: boolean; expiresAt: string }> };
    expect(devices.map(d => [d.deviceName, d.current])).toEqual([['mbp desktop', true], ['mbp', false]]);
    expect(devices[0].expiresAt).toBe(new Date(clock + 7 * DAY).toISOString());
  });

  it("signs out another of the caller's devices, or its own, never someone else's", async () => {
    const desktop = await login('alice', 'mbp desktop');
    const laptop = await login('alice', 'mbp');
    await login('bob', 'bobs-laptop');
    const laptopId = store.sessions.find(s => s.deviceName === 'mbp')!.id;
    const bobsId = store.sessions.find(s => s.userId === 'bob')!.id;

    const other = await call(`/api/cli/v1/devices/${bobsId}`, { method: 'DELETE', token: desktop });
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ code: 'device_not_found' });
    expect(store.sessions.find(s => s.id === bobsId)!.revokedAt).toBeNull();

    expect((await call(`/api/cli/v1/devices/${laptopId}`, { method: 'DELETE', token: desktop })).status).toBe(204);
    expect((await call('/api/cli/v1/whoami', { token: laptop })).status).toBe(401);
    expect((await call('/api/cli/v1/whoami', { token: desktop })).status).toBe(200);

    const ownId = store.sessions.find(s => s.deviceName === 'mbp desktop')!.id;
    expect((await call(`/api/cli/v1/devices/${ownId}`, { method: 'DELETE', token: desktop })).status).toBe(204);
    expect((await call('/api/cli/v1/whoami', { token: desktop })).status).toBe(401);
  });

  it("is a device sign-in's only: a box's own token neither lists nor signs out", async () => {
    await login('alice', 'mbp');
    store.agentTokens.set('tmag_box', { user: alice, instanceId: 'i-devbox' });
    const list = await call('/api/cli/v1/devices', { token: 'tmag_box' });
    expect(list.status).toBe(403);
    expect(await list.json()).toMatchObject({ code: 'box_credential' });
    const id = store.sessions[0].id;
    expect((await call(`/api/cli/v1/devices/${id}`, { method: 'DELETE', token: 'tmag_box' })).status).toBe(403);
    expect(store.sessions[0].revokedAt).toBeNull();
  });
});

describe('POST /usage', () => {
  beforeEach(() => { productEvents.length = 0; });

  it('records a device sign-in\'s run as cli.command, with no box', async () => {
    const token = await login();
    const res = await call('/api/cli/v1/usage', {
      method: 'POST', token, body: JSON.stringify({ command: 'box list', phase: 'finished', exitCode: 0, durationMs: 120, version: '0.4.1' }),
    });
    expect(res.status).toBe(204);
    expect(productEvents).toEqual([{
      name: 'cli.command',
      ctx: { user: 'alice', box: null },
      detail: expect.objectContaining({ command: 'box list', phase: 'finished', exitCode: 0, durationMs: 120, credential: 'device' }),
    }]);
  });

  it('records the box for the CLI on a box', async () => {
    store.agentTokens.set('tmag_box', { user: alice, instanceId: 'i-devbox' });
    const res = await call('/api/cli/v1/usage', { method: 'POST', token: 'tmag_box', body: JSON.stringify({ command: 'ask', phase: 'finished' }) });
    expect(res.status).toBe(204);
    expect(productEvents[0]).toMatchObject({ ctx: { user: 'alice', box: 'i-devbox' }, detail: { credential: 'box' } });
  });

  it('refuses a report that is not a command name, and records nothing', async () => {
    const token = await login();
    const res = await call('/api/cli/v1/usage', { method: 'POST', token, body: JSON.stringify({ command: 'ask "fix it"', phase: 'finished' }) });
    expect(res.status).toBe(400);
    expect(productEvents).toEqual([]);
  });

  it('needs a credential', async () => {
    expect((await call('/api/cli/v1/usage', { method: 'POST', body: JSON.stringify({ command: 'whoami', phase: 'finished' }) })).status).toBe(401);
    expect(productEvents).toEqual([]);
  });
});
