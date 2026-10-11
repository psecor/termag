import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db', () => ({ prisma: {} }));
import { parseMintBody, ADMIN_TOKEN_DEFAULT_DAYS } from './manage';

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
