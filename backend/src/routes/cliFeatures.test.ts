// whoami's `features` (routes/cliFeatures.ts): each is its flag for the person,
// and a person termag doesn't know has every feature off.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ users: ['alice'], on: new Set<string>() }));
vi.mock('../db', () => ({
  prisma: { user: { findUnique: async ({ where }: { where: { id: string } }) => (h.users.includes(where.id) ? { id: where.id } : null) } },
}));
vi.mock('../services/featureFlags', () => ({ boolVariation: async (flag: string) => h.on.has(flag) }));
vi.mock('../services/automations/scheduler', () => ({ AUTOMATIONS_FLAG: 'automations-enabled' }));

const { cliFeaturesFor } = await import('./cliFeatures');
const user = (id: string) => ({ id, googleEmail: `${id}@x`, unixUsername: id, displayName: id });

beforeEach(() => { h.on = new Set(); });

describe('cliFeaturesFor', () => {
  it('says each feature where its flag is on for the person', async () => {
    expect(await cliFeaturesFor(user('alice'))).toEqual({ automations: false, liveChat: false });
    h.on = new Set(['desktop-live-chat-enabled']);
    expect(await cliFeaturesFor(user('alice'))).toEqual({ automations: false, liveChat: true });
    h.on = new Set(['automations-enabled']);
    expect(await cliFeaturesFor(user('alice'))).toEqual({ automations: true, liveChat: false });
  });


  it('has everything off for a person termag has no row for', async () => {
    h.on = new Set(['desktop-live-chat-enabled', 'automations-enabled']);
    expect(await cliFeaturesFor(user('ghost'))).toEqual({ automations: false, liveChat: false });
  });
});
