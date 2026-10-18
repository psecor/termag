import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { authenticateCliUpgrade, cliWsRoute, refusalResponse, QUERY_TOKEN_REFUSAL, recheckCliCredential, watchCliSocket, closeCliSocketsForSession } = await import('./cliWs');
const { EventEmitter } = await import('events');
const { sha256Hex } = await import('../services/cliAuth');
const { CliJwt, localCliJwtKey } = await import('../services/cliJwt');
const jwt = new CliJwt('https://termag.example.com/termag', [localCliJwtKey()]);

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const now = new Date('2026-10-07T00:00:00Z');
const session: CliSessionRecord = {
  id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_ddd',
  createdAt: now, lastUsedAt: now, revokedAt: null,
};
const revoked: CliSessionRecord = { ...session, id: 's2', revokedAt: now };

const store: CliStore = {
  async findSessionByHash(hash) { return hash === sha256Hex(DEVICE) ? session : null; },
  async findSessionById(id) { return id === session.id ? session : id === revoked.id ? revoked : null; },
  async validateAgentToken(raw) { return raw === 'tmag_box' ? { user: alice, instanceId: 'i-devbox' } : null; },
  createSession: async () => { throw new Error('unused'); },
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};
const deps = { store, jwt: Promise.resolve(jwt), now: () => now };
const url = (path: string) => new URL(path, 'http://localhost');

describe('cliWsRoute', () => {
  it('maps the two CLI socket paths under the base path and nothing else', () => {
    expect(cliWsRoute('/termag/api/cli/v1/ws/status', '/termag')).toBe('status');
    expect(cliWsRoute('/termag/api/cli/v1/ws/terminal', '/termag')).toBe('terminal');
    expect(cliWsRoute('/termag/ws/status', '/termag')).toBeNull();
    expect(cliWsRoute('/termag/api/cli/v1/ws/agent', '/termag')).toBeNull();
    expect(cliWsRoute('/termag/api/cli/v1/ws/', '/termag')).toBeNull();
    expect(cliWsRoute('/api/cli/v1/ws/status', '/termag')).toBeNull();
    expect(cliWsRoute('/api/cli/v1/ws/status', '')).toBe('status');
  });
});

describe('authenticateCliUpgrade', () => {
  it('accepts an access token, a device token and a box token from the Authorization header', async () => {
    const { token } = await jwt.issue('alice', session.id, now.getTime());
    for (const raw of [token, DEVICE, 'tmag_box']) {
      const r = await authenticateCliUpgrade(deps, { headers: { authorization: `Bearer ${raw}` } }, url('/termag/api/cli/v1/ws/status'));
      expect('auth' in r && r.auth.user.id).toBe('alice');
    }
  });
  it('refuses a missing header, a non-bearer header and an unknown token with 401', async () => {
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer tmcli_nope' }, { authorization: 'Bearer tmag_nope' }]) {
      const r = await authenticateCliUpgrade(deps, { headers }, url('/termag/api/cli/v1/ws/status'));
      expect('status' in r && r.status).toBe(401);
    }
  });
  it('refuses a revoked session on the same terms as the HTTP routes', async () => {
    const { token } = await jwt.issue('alice', revoked.id, now.getTime());
    const r = await authenticateCliUpgrade(deps, { headers: { authorization: `Bearer ${token}` } }, url('/termag/api/cli/v1/ws/status'));
    expect(r).toEqual({ status: 401, error: 'This device was signed out; run `termag login`' });
  });
  it('never takes a token from the URL, even beside a valid header', async () => {
    const r = await authenticateCliUpgrade(deps, { headers: { authorization: `Bearer ${DEVICE}` } }, url(`/termag/api/cli/v1/ws/status?token=${DEVICE}`));
    expect(r).toEqual({ status: 400, error: QUERY_TOKEN_REFUSAL });
  });
});

describe('refusalResponse', () => {
  it('is a complete HTTP response with the CLI API JSON body', () => {
    const r = refusalResponse({ status: 401, error: 'nope' });
    expect(r.startsWith('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\n')).toBe(true);
    expect(r).toContain('Connection: close\r\n\r\n{"error":"nope","code":"auth_required"}');
    expect(r).toContain(`Content-Length: ${Buffer.byteLength('{"error":"nope","code":"auth_required"}')}`);
    expect(refusalResponse({ status: 400, error: 'x' })).not.toContain('WWW-Authenticate');
  });
});

describe('after the upgrade', () => {
  const device = (id: string) => ({
    user: alice,
    credential: { kind: 'device' as const, sessionId: id, deviceName: 'mbp', expiresAt: now, maxExpiresAt: now },
  });
  const boxAuth = { user: alice, credential: { kind: 'box' as const, boxId: 'i-devbox' } };

  it('recheck: a live session passes; revoked, unknown and lapsed sessions fail', async () => {
    expect(await recheckCliCredential(deps, { auth: device('s1'), raw: DEVICE })).toBeNull();
    expect(await recheckCliCredential(deps, { auth: device('s2'), raw: DEVICE })).toMatchObject({ code: 1008, reason: expect.stringMatching(/signed out/) });
    expect(await recheckCliCredential(deps, { auth: device('gone'), raw: DEVICE })).toMatchObject({ code: 1008, reason: expect.stringMatching(/Unknown sign-in/) });
    const later = { ...deps, now: () => new Date(now.getTime() + 8 * 24 * 3600_000) };
    expect(await recheckCliCredential(later, { auth: device('s1'), raw: DEVICE })).toMatchObject({ code: 1008, reason: expect.stringMatching(/expired/) });
  });

  it('recheck: an access token is held to its expiry and key, and asks the client to re-dial', async () => {
    const { token } = await jwt.issue('alice', session.id, now.getTime());
    expect(await recheckCliCredential(deps, { auth: device('s1'), raw: token })).toBeNull();
    const pastHour = { ...deps, now: () => new Date(now.getTime() + 61 * 60_000) };
    expect(await recheckCliCredential(pastHour, { auth: device('s1'), raw: token })).toMatchObject({ code: 4401 });
    // a key that is no longer published (rotated out) fails the same way
    const rotated = { ...deps, jwt: Promise.resolve(new CliJwt('https://termag.example.com/termag', [localCliJwtKey()])) };
    expect(await recheckCliCredential(rotated, { auth: device('s1'), raw: token })).toMatchObject({ code: 4401 });
    // a revoked session is final even while its token is still in its hour
    const { token: t2 } = await jwt.issue('alice', revoked.id, now.getTime());
    expect(await recheckCliCredential(deps, { auth: device('s2'), raw: t2 })).toMatchObject({ code: 1008 });
  });

  it('recheck: a box token must still validate for the same user and box', async () => {
    expect(await recheckCliCredential(deps, { auth: boxAuth, raw: 'tmag_box' })).toBeNull();
    expect(await recheckCliCredential(deps, { auth: boxAuth, raw: 'tmag_revoked' })).toMatchObject({ code: 1008, reason: 'Box credential revoked' });
    const rebound = { auth: { ...boxAuth, credential: { kind: 'box' as const, boxId: 'i-other' } }, raw: 'tmag_box' };
    expect(await recheckCliCredential(deps, rebound)).toMatchObject({ code: 1008 });
  });

  class FakeWs extends EventEmitter {
    closed: [number, string] | null = null;
    close(code: number, reason: string) { this.closed = [code, reason]; this.emit('close'); }
    terminate() { this.emit('close'); }
  }
  afterEach(() => { vi.useRealTimers(); });

  it('closes every open socket of a device session at once on revoke, and forgets closed ones', () => {
    const a = new FakeWs(), b = new FakeWs(), other = new FakeWs();
    watchCliSocket(a as never, deps, { auth: device('s1'), raw: 'eyJ' });
    watchCliSocket(b as never, deps, { auth: device('s1'), raw: 'eyJ' });
    watchCliSocket(other as never, deps, { auth: device('s9'), raw: 'eyJ' });
    expect(closeCliSocketsForSession('s1')).toBe(2);
    expect(a.closed).toEqual([1008, 'This device was signed out; run `termag login`']);
    expect(b.closed?.[0]).toBe(1008);
    expect(other.closed).toBeNull();
    expect(closeCliSocketsForSession('s1')).toBe(0);
    other.close(1000, 'bye');
    expect(closeCliSocketsForSession('s9')).toBe(0);
  });

  it('closes a socket on the interval re-check once its credential lapses', async () => {
    vi.useFakeTimers();
    const ws = new FakeWs();
    watchCliSocket(ws as never, deps, { auth: device('s2'), raw: DEVICE }, 1000);
    expect(ws.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.closed?.[1]).toMatch(/signed out/);
  });

  it('closes with the re-dial code once the access token it opened with expires', async () => {
    vi.useFakeTimers({ now });
    const { token } = await jwt.issue('alice', session.id, now.getTime());
    let clock = now.getTime();
    const ticking = { ...deps, now: () => new Date(clock) };
    const ws = new FakeWs();
    watchCliSocket(ws as never, ticking, { auth: device('s1'), raw: token }, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.closed).toBeNull();
    clock += 61 * 60_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.closed?.[0]).toBe(4401);
  });
});
