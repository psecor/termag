import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';

const prisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
}));
vi.mock('../db', () => ({ prisma }));

import { clearUserCache, isKnownMiss, resolveTermagUser } from './userMapping';

const alice = { id: 'u1', googleEmail: 'alice@example.com', slackUserId: 'U1' };
const usersInfo = vi.fn();
const client = { users: { info: usersInfo } } as unknown as WebClient;

describe('resolveTermagUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearUserCache();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValue(alice);
    usersInfo.mockResolvedValue({ user: { profile: { email: 'alice@example.com' } } });
  });

  it('links the Slack id by email and serves it from the cache after', async () => {
    prisma.user.findMany.mockResolvedValue([alice]);
    expect(await resolveTermagUser('U1', client)).toBe(alice);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { slackUserId: 'U1' } });
    vi.clearAllMocks();
    expect(await resolveTermagUser('U1', client)).toBe(alice);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('matches a Slack email that differs from the termag one only in casing', async () => {
    usersInfo.mockResolvedValue({ user: { profile: { email: 'Alice@Example.com' } } });
    prisma.user.findMany.mockResolvedValue([alice]);
    expect(await resolveTermagUser('U1', client)).toBe(alice);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { googleEmail: { equals: 'Alice@Example.com', mode: 'insensitive' } } }));
  });

  it('remembers a miss for five minutes, then looks again', async () => {
    const t0 = 1_000_000;
    expect(await resolveTermagUser('U1', client, t0)).toBeNull();
    expect(await resolveTermagUser('U1', client, t0 + 4 * 60_000)).toBeNull();
    expect(usersInfo).toHaveBeenCalledTimes(1);
    expect(isKnownMiss('U1', t0 + 4 * 60_000)).toBe(true);
    expect(isKnownMiss('U1', t0 + 5 * 60_000)).toBe(false);

    // Alice signs in to termag in the meantime.
    prisma.user.findMany.mockResolvedValue([alice]);
    expect(await resolveTermagUser('U1', client, t0 + 5 * 60_000)).toBe(alice);
  });

  it('does not count a failed Slack call or a call without a client as a miss', async () => {
    usersInfo.mockRejectedValueOnce(new Error('ratelimited'));
    expect(await resolveTermagUser('U1', client)).toBeNull();
    expect(await resolveTermagUser('U1')).toBeNull();
    expect(isKnownMiss('U1')).toBe(false);

    prisma.user.findMany.mockResolvedValue([alice]);
    expect(await resolveTermagUser('U1', client)).toBe(alice);
  });
});
