import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { albSessionBridge, upgradeUserId } from './auth';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { verifyAlbIdentity } from '../auth/albOidc';
import { validateAgentToken } from './agentTokens';
import { prisma } from '../db';

vi.mock('../db', () => ({ prisma: { user: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() } } }));
vi.mock('../auth/albOidc', () => ({ verifyAlbIdentity: vi.fn(), albVerifierConfigFromEnv: vi.fn() }));
vi.mock('./agentTokens', () => ({ validateAgentToken: vi.fn() }));
vi.mock('../services/hostSetup', () => ({ ensureHostSetup: vi.fn() }));

const victim = { id: 'u-victim', googleEmail: 'victim@example.com', unixUsername: 'victim' } as Express.User;
const attacker = { id: 'u-attacker', googleEmail: 'attacker@example.com', unixUsername: 'attacker' } as Express.User;
const identityOf = (u: Express.User) => ({ email: u.googleEmail, sub: `sub-${u.id}`, name: u.unixUsername });

/**
 * An in-memory users table behind the mocked prisma. findMany matches the way
 * Postgres ILIKE does (case-insensitive, `_` and `%` as wildcards); create
 * enforces the googleEmail and unixUsername unique constraints.
 */
function useUsers(seed: Express.User[]) {
  const rows = seed.map(u => ({ ...u }));
  const ilike = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/_/g, '.').replace(/%/g, '.*')}$`, 'i');
  vi.mocked(prisma.user.findMany).mockImplementation((async (args: { where: { googleEmail: { equals: string } } }) =>
    rows.filter(u => ilike(args.where.googleEmail.equals).test(u.googleEmail))) as never);
  vi.mocked(prisma.user.update).mockImplementation((async (args: { where: { id: string }; data: object }) =>
    Object.assign(rows.find(u => u.id === args.where.id)!, args.data)) as never);
  vi.mocked(prisma.user.create).mockImplementation((async (args: { data: Express.User }) => {
    if (rows.some(u => u.googleEmail === args.data.googleEmail || u.unixUsername === args.data.unixUsername)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    const row = { ...args.data, id: `u-${rows.length}` };
    rows.push(row);
    return row;
  }) as never);
  return rows;
}

function fakeReq(sessionUser?: Express.User, headers: Record<string, string> = {}) {
  const store = { generate: vi.fn(), destroy: vi.fn() };
  const req = {
    headers,
    user: sessionUser,
    session: sessionUser ? { passport: { user: sessionUser.id } } : {},
    sessionStore: store,
    login: vi.fn((user: Express.User, cb: (err?: Error) => void) => {
      // passport's logIn regenerates: it destroys whatever session id is current.
      store.destroy(req.sessionID);
      req.user = user;
      cb();
    }),
    sessionID: sessionUser ? `sid-${sessionUser.id}` : 'sid-new',
  };
  store.generate.mockImplementation(() => { req.sessionID = 'sid-fresh'; });
  return req;
}

function fakeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
}

async function bridge(req: ReturnType<typeof fakeReq>) {
  const res = fakeRes();
  const next = vi.fn();
  await albSessionBridge(req as unknown as Request, res as unknown as Response, next);
  return { res, next };
}

describe('albSessionBridge in okta mode', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'okta');
    vi.stubEnv('ALLOWED_USERS', 'victim@example.com:victim,attacker@example.com:attacker');
    useUsers([victim, attacker]);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('drops a session cookie that arrives without the ALB header, leaving the session row alone', async () => {
    vi.mocked(verifyAlbIdentity).mockResolvedValue(null);
    const req = fakeReq(victim);
    const { next } = await bridge(req);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeUndefined();
    expect(req.login).not.toHaveBeenCalled();
    expect(req.sessionStore.destroy).not.toHaveBeenCalled();
  });

  it('keeps the session when the header names the same user', async () => {
    vi.mocked(verifyAlbIdentity).mockResolvedValue({ ...identityOf(victim), email: 'Victim@Example.com' });
    const req = fakeReq(victim);
    const { next } = await bridge(req);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBe(victim);
    expect(req.login).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("re-bridges a tossed cookie to the header's user without destroying the cookie's session", async () => {
    vi.mocked(verifyAlbIdentity).mockResolvedValue(identityOf(victim));
    const req = fakeReq(attacker);
    const { next } = await bridge(req);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: victim.id });
    expect(req.login).toHaveBeenCalledOnce();
    expect(req.sessionStore.generate).toHaveBeenCalledOnce();
    expect(req.sessionStore.destroy).not.toHaveBeenCalledWith('sid-u-attacker');
  });

  it('fails closed on an invalid header even with a session', async () => {
    vi.mocked(verifyAlbIdentity).mockRejectedValue(new Error('ALB JWT expired'));
    const req = fakeReq(victim);
    const { res, next } = await bridge(req);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('logs in from the header when there is no session yet', async () => {
    vi.mocked(verifyAlbIdentity).mockResolvedValue(identityOf(victim));
    const req = fakeReq();
    await bridge(req);
    expect(req.user).toMatchObject({ id: victim.id });
    expect(req.sessionStore.generate).not.toHaveBeenCalled();
  });

  it('re-bridges to a user stored in another email casing instead of failing on the unique constraint', async () => {
    const rows = useUsers([{ ...victim, googleEmail: 'Victim@Example.com' }, attacker]);
    vi.mocked(verifyAlbIdentity).mockResolvedValue(identityOf(victim));
    const req = fakeReq(attacker);
    const { next } = await bridge(req);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ id: victim.id, googleEmail: 'Victim@Example.com' });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
  });

  it('logs in a user stored in another email casing when there is no session yet', async () => {
    useUsers([{ ...victim, googleEmail: 'victim@example.com' }]);
    vi.mocked(verifyAlbIdentity).mockResolvedValue({ ...identityOf(victim), email: 'VICTIM@example.COM' });
    const req = fakeReq();
    const { next } = await bridge(req);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ id: victim.id });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('does not treat `_` in the header email as a wildcard', async () => {
    vi.stubEnv('ALLOWED_USERS', '@example.com');
    const rows = useUsers([{ id: 'u-axb', googleEmail: 'axb@example.com', unixUsername: 'axb' } as Express.User]);
    vi.mocked(verifyAlbIdentity).mockResolvedValue({ email: 'a_b@example.com', sub: 's-a_b' });
    const req = fakeReq();
    await bridge(req);
    expect(req.user).toMatchObject({ googleEmail: 'a_b@example.com', unixUsername: 'a_b' });
    expect(req.user).not.toMatchObject({ id: 'u-axb' });
    expect(rows.find(u => u.id === 'u-axb')).toMatchObject({ googleEmail: 'axb@example.com', unixUsername: 'axb' });
  });

  it('rejects a header identity that is not allowlisted', async () => {
    vi.mocked(verifyAlbIdentity).mockResolvedValue({ email: 'nobody@example.com', sub: 's' });
    const req = fakeReq(victim);
    const { res } = await bridge(req);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(req.login).not.toHaveBeenCalled();
  });

  it('still lets a bearer token through when a header-less request also carries a cookie', async () => {
    vi.mocked(verifyAlbIdentity).mockResolvedValue(null);
    vi.mocked(validateAgentToken).mockResolvedValue({
      user: attacker, instance: { id: 'box-1' }, token: { scope: 'agent' },
    } as never);
    const req = fakeReq(victim, { authorization: 'Bearer tmag_x' });
    await bridge(req);
    const next = vi.fn();
    await requireAuthOrAgentToken(req as unknown as Request, fakeRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBe(attacker);
  });
});

describe('albSessionBridge outside okta mode', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it.each(['google', 'oidc', 'local'])('leaves the %s session as it is and ignores the header', async (mode) => {
    vi.stubEnv('AUTH_MODE', mode);
    const req = fakeReq(victim, { 'x-amzn-oidc-data': 'x' });
    const { next } = await bridge(req);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBe(victim);
    expect(verifyAlbIdentity).not.toHaveBeenCalled();
  });
});

describe('upgradeUserId', () => {
  beforeEach(() => {
    vi.stubEnv('ALLOWED_USERS', 'victim@example.com:victim,attacker@example.com:attacker');
    useUsers([victim, attacker]);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  const upgrade = (req: ReturnType<typeof fakeReq>) => upgradeUserId(req as unknown as Request);

  it('uses the session user outside okta mode', async () => {
    vi.stubEnv('AUTH_MODE', 'local');
    expect(await upgrade(fakeReq(victim))).toBe(victim.id);
    expect(await upgrade(fakeReq())).toBeNull();
  });

  it('refuses a session cookie without the ALB header in okta mode', async () => {
    vi.stubEnv('AUTH_MODE', 'okta');
    vi.mocked(verifyAlbIdentity).mockResolvedValue(null);
    expect(await upgrade(fakeReq(victim))).toBeNull();
  });

  it("acts as the header's user, not the cookie's, in okta mode", async () => {
    vi.stubEnv('AUTH_MODE', 'okta');
    vi.mocked(verifyAlbIdentity).mockResolvedValue(identityOf(victim));
    expect(await upgrade(fakeReq(attacker))).toBe(victim.id);
  });

  it('refuses an invalid or non-allowlisted header in okta mode', async () => {
    vi.stubEnv('AUTH_MODE', 'okta');
    vi.mocked(verifyAlbIdentity).mockRejectedValueOnce(new Error('bad signature'));
    expect(await upgrade(fakeReq(victim))).toBeNull();
    vi.mocked(verifyAlbIdentity).mockResolvedValueOnce({ email: 'nobody@example.com', sub: 's' });
    expect(await upgrade(fakeReq(victim))).toBeNull();
  });

  it('matches the header email to the stored user case-insensitively, as the HTTP bridge does', async () => {
    vi.stubEnv('AUTH_MODE', 'okta');
    vi.mocked(verifyAlbIdentity).mockResolvedValue({ ...identityOf(victim), email: 'Victim@Example.COM' });
    expect(await upgrade(fakeReq(victim))).toBe(victim.id);

    useUsers([{ ...victim, googleEmail: 'Victim@Example.com' }, attacker]);
    vi.mocked(verifyAlbIdentity).mockResolvedValue(identityOf(victim));
    expect(await upgrade(fakeReq(victim))).toBe(victim.id);
  });

  it('acts as the same user on HTTP and on the upgrade when the header casing differs from the stored email', async () => {
    vi.stubEnv('AUTH_MODE', 'okta');
    useUsers([{ ...victim, googleEmail: 'Victim@Example.com' }, attacker]);
    vi.mocked(verifyAlbIdentity).mockResolvedValue({ ...identityOf(victim), email: 'victim@EXAMPLE.com' });
    const req = fakeReq(attacker);
    await bridge(req);
    expect(req.user).toMatchObject({ id: victim.id });
    expect(await upgrade(req)).toBe(victim.id);
  });

  it('does not treat `_` in the header email as a wildcard', async () => {
    vi.stubEnv('AUTH_MODE', 'okta');
    vi.stubEnv('ALLOWED_USERS', '@example.com');
    useUsers([{ id: 'u-axb', googleEmail: 'axb@example.com', unixUsername: 'axb' } as Express.User]);
    vi.mocked(verifyAlbIdentity).mockResolvedValue({ email: 'a_b@example.com', sub: 's' });
    expect(await upgrade(fakeReq())).toBeNull();
  });
});
