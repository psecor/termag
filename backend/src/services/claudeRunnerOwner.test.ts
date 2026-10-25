import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createOwnerFromAllowlist, flagIdentity, pendingOwnerContext, planAutoUser, slackRealName } from './claudeRunnerOwner';
import { parseAllowedUsers } from '../auth/allowedUsers';
import { prisma } from '../db';
import { findUserByEmail } from './userByEmail';

vi.mock('../db', () => ({ prisma: { user: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock('./userByEmail', () => ({ findUserByEmail: vi.fn() }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));

const allowed = parseAllowedUsers('@example.com,grace@example.org:gracie');
const unique = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

describe('planAutoUser', () => {
  it('derives the unix username the way sign-in does, keys the placeholder id on the account id, and names them by the local part', () => {
    expect(planAutoUser('Ada.Lovelace+cloud@example.com', 'user_01HXYZ', allowed)).toEqual({
      unixUsername: 'ada.lovelace', googleId: 'claude:user_01HXYZ', displayName: 'Ada.Lovelace+cloud',
    });
    // An exact mapping wins over the domain rule.
    expect(planAutoUser('grace@example.org', 'user_02', allowed)).toMatchObject({ unixUsername: 'gracie' });
  });

  it('prefers the name Slack knows when there is one', () => {
    expect(planAutoUser('ada@example.com', 'user_01', allowed, 'Ada Lovelace')).toMatchObject({ displayName: 'Ada Lovelace' });
    expect(planAutoUser('ada@example.com', 'user_01', allowed, '  ')).toMatchObject({ displayName: 'ada' });
  });

  it('refuses an email the allowlist does not admit', () => {
    expect(planAutoUser('mallory@evil.example', 'user_03', allowed)).toBeNull();
  });
});

describe('flagIdentity', () => {
  it('keys a placeholder user on the placeholder, and anyone else on their own id (Devin on #288)', () => {
    expect(flagIdentity({ id: 'ckxyz', googleId: 'claude:user_01HXYZ' }).id).toBe('claude:user_01HXYZ');
    expect(flagIdentity({ id: 'ckxyz', googleId: 'okta:sub' }).id).toBe('ckxyz');
    expect(flagIdentity({ id: 'ckxyz' }).id).toBe('ckxyz');
    // The same key the pre-row context uses.
    expect(flagIdentity({ id: 'ckxyz', googleId: 'claude:user_01HXYZ' }).id).toBe(pendingOwnerContext('user_01HXYZ', 'a@example.com').id);
  });
});

describe('pendingOwnerContext', () => {
  it('keys the flag context on the account id, never the email (U8)', () => {
    const ctx = pendingOwnerContext('user_01HXYZ', 'ada@example.com');
    expect(ctx.id).toBe('claude:user_01HXYZ');
    expect(ctx.googleEmail).toBe('ada@example.com');
    expect(ctx.unixUsername).toBe('');
  });

  it('carries the unix username the allowlist derives, so a rule on it reads the same before and after the row exists (Bugbot on #288)', () => {
    expect(pendingOwnerContext('user_01HXYZ', 'ada@example.com', 'ada').unixUsername).toBe('ada');
    expect(flagIdentity({ id: 'ckxyz', googleId: 'claude:user_01HXYZ', unixUsername: 'ada' })).toMatchObject({ id: 'claude:user_01HXYZ', unixUsername: 'ada' });
  });
});

describe('createOwnerFromAllowlist', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates the row from the plan', async () => {
    vi.mocked(prisma.user.create).mockResolvedValue({ id: 'u9', googleEmail: 'ada@example.com', unixUsername: 'ada' } as never);
    const out = await createOwnerFromAllowlist({ email: 'ada@example.com', accountId: 'user_01' }, allowed);
    expect(out).toMatchObject({ kind: 'created', user: { id: 'u9' } });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { googleId: 'claude:user_01', googleEmail: 'ada@example.com', unixUsername: 'ada', displayName: 'ada' },
    });
  });

  it('answers existing when a unique violation turns out to be the same person (a burst created them first)', async () => {
    vi.mocked(prisma.user.create).mockRejectedValue(unique());
    vi.mocked(findUserByEmail).mockResolvedValue({ id: 'u1', googleEmail: 'ada@example.com', unixUsername: 'ada' } as never);
    expect(await createOwnerFromAllowlist({ email: 'ada@example.com', accountId: 'user_01' }, allowed)).toMatchObject({ kind: 'existing', user: { id: 'u1' } });
  });

  it('refuses, and never rebinds, when the account id\'s placeholder row belongs to another email (Security Agent on #288)', async () => {
    vi.mocked(prisma.user.create).mockRejectedValue(unique());
    vi.mocked(findUserByEmail).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ unixUsername: 'ada.old' } as never);
    const out = await createOwnerFromAllowlist({ email: 'ada.new@example.com', accountId: 'user_01' }, allowed);
    expect(out).toEqual({ kind: 'account-bound', unixUsername: 'ada.old' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { googleId: 'claude:user_01' }, select: { unixUsername: true } });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('answers collision when the derived username belongs to another email, naming it', async () => {
    vi.mocked(prisma.user.create).mockRejectedValue(unique());
    vi.mocked(findUserByEmail).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    expect(await createOwnerFromAllowlist({ email: 'ada@example.com', accountId: 'user_01' }, allowed)).toEqual({ kind: 'collision', unixUsername: 'ada' });
  });

  it('answers not-allowed without touching the database', async () => {
    expect(await createOwnerFromAllowlist({ email: 'mallory@evil.example', accountId: 'user_03' }, allowed)).toEqual({ kind: 'not-allowed' });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rethrows anything that is not a unique violation', async () => {
    vi.mocked(prisma.user.create).mockRejectedValue(new Error('db down'));
    await expect(createOwnerFromAllowlist({ email: 'ada@example.com', accountId: 'user_01' }, allowed)).rejects.toThrow('db down');
  });
});

describe('slackRealName', () => {
  it('returns the real name Slack knows, null without a client, an unknown email or an error', async () => {
    const known = { users: { lookupByEmail: async () => ({ user: { real_name: 'Ada Lovelace' } }) } };
    const profileOnly = { users: { lookupByEmail: async () => ({ user: { profile: { real_name: 'Ada L.' } } }) } };
    const unknown = { users: { lookupByEmail: async () => { throw new Error('users_not_found'); } } };
    const blank = { users: { lookupByEmail: async () => ({ user: { real_name: ' ' } }) } };
    expect(await slackRealName('ada@example.com', known)).toBe('Ada Lovelace');
    expect(await slackRealName('ada@example.com', profileOnly)).toBe('Ada L.');
    expect(await slackRealName('ada@example.com', unknown)).toBeNull();
    expect(await slackRealName('ada@example.com', blank)).toBeNull();
    expect(await slackRealName('ada@example.com', null)).toBeNull();
    // The default client is the Slack app's, absent here.
    expect(await slackRealName('ada@example.com')).toBeNull();
  });
});
