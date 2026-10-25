import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

import { rememberUserKey, resetUserKeysForTests, userIdForUnixUsername } from './userKeys';

beforeEach(() => resetUserKeysForTests());

describe('userIdForUnixUsername', () => {
  it('looks a username up once and answers from the cache after', async () => {
    const lookup = vi.fn(async (u: string) => (u === 'ada' ? 'cmuser01' : null));
    expect(await userIdForUnixUsername('ada', lookup)).toBe('cmuser01');
    expect(await userIdForUnixUsername('ada', lookup)).toBe('cmuser01');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not cache a miss, and never throws', async () => {
    const lookup = vi.fn(async () => null);
    expect(await userIdForUnixUsername('nobody', lookup)).toBeNull();
    expect(await userIdForUnixUsername('nobody', lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(await userIdForUnixUsername('boom', async () => { throw new Error('db down'); })).toBeNull();
  });

  it('takes a seeded pair without a lookup', async () => {
    rememberUserKey('ada', 'cmuser01');
    const lookup = vi.fn(async () => 'other');
    expect(await userIdForUnixUsername('ada', lookup)).toBe('cmuser01');
    expect(lookup).not.toHaveBeenCalled();
  });
});
