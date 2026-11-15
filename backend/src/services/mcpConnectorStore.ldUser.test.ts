import { beforeEach, describe, expect, it, vi } from 'vitest';

// The flag context agent.mcp.used reads its flags for (routes/status.ts POST
// /mcp): the user row is cached, the flags are not.
const findUnique = vi.fn();
vi.mock('../db', () => ({ prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));
const jsonVariation = vi.fn();
vi.mock('./featureFlags', () => ({ jsonVariation: (...a: unknown[]) => jsonVariation(...a), boolVariation: vi.fn() }));

const { catalogNamesForUser, ldUserForId } = await import('./mcpConnectorStore');

const USER = { id: 'u1', googleEmail: 'a@b', displayName: 'A', unixUsername: 'a', defaultAgentProvider: null };

beforeEach(() => vi.clearAllMocks());

describe('ldUserForId', () => {
  it('reads the row once per five minutes, and nothing for no user', async () => {
    findUnique.mockResolvedValue(USER);
    expect(await ldUserForId(undefined)).toBeNull();
    expect(await ldUserForId('u1', 0)).toEqual(USER);
    expect(await ldUserForId('u1', 60_000)).toEqual(USER);
    expect(findUnique).toHaveBeenCalledTimes(1);
    await ldUserForId('u1', 5 * 60_000 + 1);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed lookup', async () => {
    findUnique.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(USER);
    expect(await ldUserForId('u2', 0)).toBeNull();
    expect(await ldUserForId('u2', 1)).toEqual(USER);
  });
});

describe('catalogNamesForUser', () => {
  it('reads the catalog on every call, so a late flag source start is not pinned', async () => {
    jsonVariation.mockResolvedValueOnce(null).mockResolvedValueOnce([{ name: 'acme-docs', upstream: 'https://mcp.acme.example/mcp' }]);
    expect(await catalogNamesForUser(USER)).toEqual([]);
    expect(await catalogNamesForUser(USER)).toEqual(['acme-docs']);
  });

  it('is empty when the read throws', async () => {
    jsonVariation.mockRejectedValueOnce(new Error('boom'));
    expect(await catalogNamesForUser(USER)).toEqual([]);
  });
});
