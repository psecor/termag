import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurePassport, upsertAllowlistedUser, upsertUserByEmail } from './auth';
import { prisma } from '../db';
import passport from 'passport';

vi.mock('../db', () => {
  const prisma = { user: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), delete: vi.fn(), upsert: vi.fn() }, instance: { count: vi.fn(async () => 0) }, $transaction: vi.fn() };
  // The transaction hands back the same mocked client; the test asserts it was asked for.
  prisma.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) => fn(prisma)) as never);
  return { prisma };
});
vi.mock('../auth/albOidc', () => ({ verifyAlbIdentity: vi.fn(), albVerifierConfigFromEnv: vi.fn() }));
vi.mock('./agentTokens', () => ({ validateAgentToken: vi.fn() }));
vi.mock('../services/hostSetup', () => ({ ensureHostSetup: vi.fn() }));
// The Google strategy's verify callback, captured from passport.use so the
// sign-in rule can be driven without an OAuth round trip.
type Verify = (accessToken: string, refreshToken: string, profile: { id: string; displayName: string; emails?: { value: string }[] }, done: (err: Error | null, user?: unknown) => void) => Promise<void>;
let googleVerify: Verify | null = null;
vi.mock('passport-google-oauth20', () => ({
  Strategy: class { constructor(_opts: unknown, verify: Verify) { googleVerify = verify; } },
}));
vi.mock('passport', () => ({ default: { use: vi.fn(), serializeUser: vi.fn(), deserializeUser: vi.fn() } }));

const googleSignIn = (profile: { id: string; displayName: string; email: string }) => new Promise<unknown>((resolve, reject) => {
  vi.stubEnv('AUTH_MODE', 'google');
  configurePassport();
  expect(passport.use).toHaveBeenCalled();
  googleVerify!('t', 'r', { id: profile.id, displayName: profile.displayName, emails: [{ value: profile.email }] }, (err, user) => (err ? reject(err) : resolve(user)));
});

/**
 * A sign-in by an engineer whose row the cloud-session spawn route created:
 * the row is found by email and updated,
 * its `claude:` placeholder provider id replaced by the real one; a row that
 * already has a real id keeps it.
 */
describe('sign-in adopts an auto-created user', () => {
  type Row = { id: string; googleId: string; googleEmail: string; unixUsername: string; displayName: string };
  let rows: Row[];
  beforeEach(() => {
    vi.stubEnv('ALLOWED_USERS', '@example.com');
    rows = [
      { id: 'u-ada', googleId: 'claude:user_01HXYZ', googleEmail: 'ada@example.com', unixUsername: 'ada', displayName: 'ada' },
      { id: 'u-bob', googleId: 'okta:sub-bob', googleEmail: 'bob@example.com', unixUsername: 'bob', displayName: 'Bob' },
    ];
    vi.mocked(prisma.user.findMany).mockImplementation((async (args: { where: { googleEmail: { equals: string } } }) =>
      rows.filter(u => u.googleEmail.toLowerCase() === args.where.googleEmail.equals.toLowerCase())) as never);
    vi.mocked(prisma.user.update).mockImplementation((async (args: { where: { id: string }; data: Partial<Row> }) =>
      Object.assign(rows.find(u => u.id === args.where.id)!, args.data)) as never);
    vi.mocked(prisma.user.create).mockImplementation((async () => { throw new Error('must not create'); }) as never);
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { where: { googleId?: string } }) =>
      rows.find(u => u.googleId === args.where.googleId) ?? null) as never);
    vi.mocked(prisma.user.delete).mockImplementation((async (args: { where: { id: string } }) => {
      const i = rows.findIndex(u => u.id === args.where.id);
      return rows.splice(i, 1)[0];
    }) as never);
    vi.mocked(prisma.instance.count).mockResolvedValue(0);
    // Main's upsert by subject, as the database would run it: update the row with that googleId, else create.
    vi.mocked(prisma.user.upsert).mockImplementation((async (args: { where: { googleId: string }; update: Partial<Row>; create: Row }) => {
      const row = rows.find(u => u.googleId === args.where.googleId);
      if (row) return Object.assign(row, args.update);
      if (rows.some(u => u.googleEmail.toLowerCase() === args.create.googleEmail.toLowerCase() || u.unixUsername === args.create.unixUsername)) throw new Error('Unique constraint failed');
      const created = { id: `u-${args.create.unixUsername}`, ...args.create };
      rows.push(created);
      return created;
    }) as never);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('Google: without a placeholder, sign-in is main\'s upsert by subject: a returning user keeps their stored address, a new subject gets a row', async () => {
    rows.push({ id: 'u-cat', googleId: '424242', googleEmail: 'cat@example.com', unixUsername: 'cat', displayName: 'Cat' });
    const renamed = await googleSignIn({ id: '424242', displayName: 'Catherine', email: 'catherine@example.com' });
    expect(renamed).toMatchObject({ id: 'u-cat', googleId: '424242', googleEmail: 'cat@example.com', displayName: 'Catherine' });
    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { googleId: '424242' },
      update: { displayName: 'Catherine' },
      create: { googleId: '424242', googleEmail: 'catherine@example.com', unixUsername: 'catherine', displayName: 'Catherine' },
    });
    const fresh = await googleSignIn({ id: '999', displayName: 'Eve', email: 'eve@example.com' });
    expect(fresh).toMatchObject({ googleId: '999', googleEmail: 'eve@example.com', unixUsername: 'eve' });
    // An address that belongs to a row with a real provider id: the create fails on the unique index, as on main.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(googleSignIn({ id: '777', displayName: 'Mallory', email: 'bob@example.com' })).rejects.toThrow('Unique constraint');
    expect(rows.find(u => u.id === 'u-bob')).toMatchObject({ googleId: 'okta:sub-bob', displayName: 'Bob' });
    expect(prisma.user.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u-bob' } }));
  });

  it('Google: a new subject adopts the placeholder for its address instead of making a second row', async () => {
    const adopted = await googleSignIn({ id: '1234567890', displayName: 'Ada G', email: 'ada@example.com' });
    expect(adopted).toMatchObject({ id: 'u-ada', googleId: '1234567890', displayName: 'Ada G' });
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
  });

  it('Google: a returning user whose new address a placeholder holds takes it, removing a placeholder with no box and leaving one with a box (Bugbot on #288)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Catherine was renamed; a cloud session for the new address made a placeholder before she signed in again.
    rows.push({ id: 'u-cat', googleId: '424242', googleEmail: 'cat@example.com', unixUsername: 'cat', displayName: 'Cat' });
    rows.push({ id: 'u-ph', googleId: 'claude:user_01CAT', googleEmail: 'catherine@example.com', unixUsername: 'catherine', displayName: 'catherine' });
    const cat = await googleSignIn({ id: '424242', displayName: 'Catherine', email: 'catherine@example.com' });
    expect(cat).toMatchObject({ id: 'u-cat', googleId: '424242', googleEmail: 'catherine@example.com' });
    expect(rows.find(u => u.id === 'u-ph')).toBeUndefined();
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u-ph' } });
    // Count, delete and the address move in one serializable transaction, and every box row counts, terminated too.
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(prisma.instance.count).toHaveBeenCalledWith({ where: { userId: 'u-ph' } });
    // A placeholder that already owns a box is not touched; the row keeps its address and an operator merges.
    rows.push({ id: 'u-ph2', googleId: 'claude:user_01DAN', googleEmail: 'daniel@example.com', unixUsername: 'daniel', displayName: 'daniel' });
    rows.push({ id: 'u-dan', googleId: '515151', googleEmail: 'dan@example.com', unixUsername: 'dan', displayName: 'Dan' });
    vi.mocked(prisma.instance.count).mockResolvedValueOnce(1);
    const dan = await googleSignIn({ id: '515151', displayName: 'Daniel', email: 'daniel@example.com' });
    expect(dan).toMatchObject({ id: 'u-dan', googleEmail: 'dan@example.com', displayName: 'Daniel' });
    expect(rows.find(u => u.id === 'u-ph2')).toBeDefined();
    const warned = vi.mocked(console.warn).mock.calls.map(c => String(c[0])).join('\n');
    expect(warned).toContain('placeholder user daniel');
    expect(warned).not.toContain('@example.com');
  });

  it('Google: a first sign-in that loses the race with the spawn\'s placeholder insert adopts the row instead of failing (Bugbot on #288)', async () => {
    rows.splice(rows.findIndex(u => u.id === 'u-ada'), 1);
    // The spawn route inserts ada's placeholder between the sign-in's lookup and its create.
    vi.mocked(prisma.user.upsert).mockImplementationOnce((async () => {
      rows.push({ id: 'u-ada', googleId: 'claude:user_01HXYZ', googleEmail: 'ada@example.com', unixUsername: 'ada', displayName: 'ada' });
      throw Object.assign(new Error('Unique constraint failed on the fields: (`unixUsername`)'), { code: 'P2002' });
    }) as never);
    const user = await googleSignIn({ id: '1234567890', displayName: 'Ada G', email: 'ada@example.com' });
    expect(user).toMatchObject({ id: 'u-ada', googleId: '1234567890', displayName: 'Ada G', unixUsername: 'ada' });
    expect(rows).toHaveLength(2);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('Google: any other unique violation on a first sign-in still fails it', async () => {
    rows.splice(rows.findIndex(u => u.id === 'u-ada'), 1);
    vi.mocked(prisma.user.upsert).mockImplementationOnce((async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }) as never);
    await expect(googleSignIn({ id: '1234567890', displayName: 'Ada G', email: 'ada@example.com' })).rejects.toThrow('Unique constraint failed');
  });

  it('Okta: the email upsert\'s create loses the same race and adopts the placeholder (Bugbot on #288)', async () => {
    rows.splice(rows.findIndex(u => u.id === 'u-ada'), 1);
    vi.mocked(prisma.user.create).mockImplementationOnce((async () => {
      rows.push({ id: 'u-ada', googleId: 'claude:user_01HXYZ', googleEmail: 'ada@example.com', unixUsername: 'ada', displayName: 'ada' });
      throw Object.assign(new Error('Unique constraint failed on the fields: (`googleEmail`)'), { code: 'P2002' });
    }) as never);
    const user = await upsertAllowlistedUser({ email: 'ada@example.com', sub: 'sub-ada', name: 'Ada Lovelace' }, 'okta');
    expect(user).toMatchObject({ id: 'u-ada', googleId: 'okta:sub-ada', displayName: 'Ada Lovelace' });
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
  });

  it('Okta: replaces the placeholder id and the name, never creates a second row', async () => {
    const user = await upsertAllowlistedUser({ email: 'ada@example.com', sub: 'sub-ada', name: 'Ada Lovelace' }, 'okta');
    expect(user).toMatchObject({ id: 'u-ada', googleId: 'okta:sub-ada', displayName: 'Ada Lovelace', unixUsername: 'ada' });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
  });

  it('OIDC: the same', async () => {
    const user = await upsertAllowlistedUser({ email: 'Ada@Example.com', sub: 'sub-ada', name: 'Ada' }, 'oidc');
    expect(user).toMatchObject({ id: 'u-ada', googleId: 'oidc:sub-ada', googleEmail: 'ada@example.com' });
  });

  it('Google (the email upsert the strategy now uses): adopts the placeholder too', async () => {
    const user = await upsertUserByEmail('ada@example.com',
      { displayName: 'Ada G', unixUsername: 'ada' },
      { googleId: '1234567890', googleEmail: 'ada@example.com', unixUsername: 'ada', displayName: 'Ada G' });
    expect(user).toMatchObject({ id: 'u-ada', googleId: '1234567890', displayName: 'Ada G' });
  });

  it('leaves a real provider id alone on an existing row', async () => {
    const user = await upsertAllowlistedUser({ email: 'bob@example.com', sub: 'sub-bob-2', name: 'Robert' }, 'okta');
    expect(user).toMatchObject({ id: 'u-bob', googleId: 'okta:sub-bob', displayName: 'Robert' });
    const viaGoogle = await upsertUserByEmail('bob@example.com', { displayName: 'Bobby', unixUsername: 'bob' },
      { googleId: '999', googleEmail: 'bob@example.com', unixUsername: 'bob', displayName: 'Bobby' });
    expect(viaGoogle).toMatchObject({ googleId: 'okta:sub-bob', displayName: 'Bobby' });
  });
});
