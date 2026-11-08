import { describe, expect, it, vi } from 'vitest';

// api-broker-enabled alone decides the API broker, for a user and for a box.
const flags = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('../db', () => ({
  prisma: {
    user: { findUnique: async () => ({ id: 'u1', googleEmail: 'pat@example.com', displayName: 'Pat', unixUsername: 'pat', defaultAgentProvider: null }) },
    instance: { findUnique: async () => ({ id: 'i1', name: 'box', kind: 'ec2' }) },
  },
}));
vi.mock('./featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./featureFlags')>()),
  boolVariation: async (key: string) => flags.on.has(key),
}));

const { apiBrokerEnabledForBox, apiBrokerEnabledForUser } = await import('./mcpConnectorStore');

describe('api-broker-enabled', () => {
  it('follows api-broker-enabled for a user and a box', async () => {
    const user = { id: 'u1', googleEmail: 'pat@example.com', unixUsername: 'pat' };
    for (const [on, want] of [[[], false], [['api-broker-enabled'], true]] as const) {
      flags.on = new Set(on);
      expect(await apiBrokerEnabledForUser(user)).toBe(want);
      expect(await apiBrokerEnabledForBox('u1', 'i1')).toBe(want);
    }
  });
});
