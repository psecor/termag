import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db', () => ({ prisma: {} }));
import { parseMintBody, resolveUserKey, ADMIN_TOKEN_DEFAULT_DAYS } from './manage';

describe('parseMintBody', () => {
  it('defaults expiry to 90 days and allows explicit null', () => {
    expect(parseMintBody({ name: ' laptop ' })).toEqual({ name: 'laptop', expiresDays: ADMIN_TOKEN_DEFAULT_DAYS });
    expect(parseMintBody({ name: 'ci', expiresDays: null })).toEqual({ name: 'ci', expiresDays: null });
    expect(parseMintBody({ name: 'ci', expiresDays: 30 })).toEqual({ name: 'ci', expiresDays: 30 });
  });
  it('rejects bad names and expiries', () => {
    expect(parseMintBody({})).toHaveProperty('error');
    expect(parseMintBody({ name: '' })).toHaveProperty('error');
    expect(parseMintBody({ name: 'x', expiresDays: 0 })).toHaveProperty('error');
    expect(parseMintBody({ name: 'x', expiresDays: 1.5 })).toHaveProperty('error');
    expect(parseMintBody({ name: 'x', expiresDays: 9999 })).toHaveProperty('error');
    expect(parseMintBody(null)).toHaveProperty('error');
  });
});

describe('resolveUserKey', () => {
  const lookups = () => ({
    byEmail: vi.fn(async (e: string) => ({ via: 'email', e })),
    byIdOrUsername: vi.fn(async (k: string) => ({ via: 'idOrUsername', k })),
  });
  it('sends anything with an @ to the exact email lookup, trimmed', async () => {
    const l = lookups();
    expect(await resolveUserKey(' ada_smith@example.com ', l)).toEqual({ via: 'email', e: 'ada_smith@example.com' });
    expect(l.byIdOrUsername).not.toHaveBeenCalled();
  });
  it('sends anything else to the id or username lookup', async () => {
    const l = lookups();
    expect(await resolveUserKey('jdanger', l)).toEqual({ via: 'idOrUsername', k: 'jdanger' });
    expect(l.byEmail).not.toHaveBeenCalled();
  });
  it('returns null for a blank key without a query', async () => {
    const l = lookups();
    expect(await resolveUserKey('   ', l)).toBeNull();
    expect(l.byEmail).not.toHaveBeenCalled();
    expect(l.byIdOrUsername).not.toHaveBeenCalled();
  });
});
