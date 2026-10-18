import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Instance, User } from '@prisma/client';

// A warm box says hello while nobody owns it, so the hello-time credential
// delivery skips it; the claim rebinds the socket in place and must deliver.
const delivered: Array<[string, string]> = [];
const synced: string[] = [];
const settled: string[] = [];
const claimed: string[] = [];
let deliveryFails = false;
vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({
  connectedInstanceIds: () => [],
  rebindInstanceOwner: () => null,
  sendToInstanceAgent: async () => ({ ok: true }),
  disownInstanceAgent: () => {},
  notifyInstanceClaimed: (id: string) => { claimed.push(id); },
  settleClaimedOwner: (instance: { id: string }) => { settled.push(`${instance.id} after ${delivered.length} deliveries`); },
}));
vi.mock('./sshKeySync', () => ({ syncBoxAuthorizedKeys: async (id: string) => { synced.push(id); } }));
vi.mock('./credentialDelivery', () => ({
  deliverToInstance: async (instanceId: string, userId: string) => {
    delivered.push([instanceId, userId]);
    if (deliveryFails) throw new Error('box script refused');
  },
}));

const { prismaClaimEffects } = await import('./warmPoolClaim');

const owner = { id: 'user_1' } as User;
const box = (over: Partial<Instance>) => ({ id: 'box_1', kind: 'ec2', hostHome: '/home/termag', ...over }) as Instance;

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => { delivered.length = 0; synced.length = 0; settled.length = 0; claimed.length = 0; deliveryFails = false; });

describe('welcomeOwner', () => {
  it('delivers the claimer\'s credentials and syncs SSH keys', async () => {
    await prismaClaimEffects.welcomeOwner(box({}), owner);
    expect(delivered).toEqual([['box_1', 'user_1']]);
    expect(synced).toEqual(['box_1']);
    expect(claimed).toEqual(['box_1']);
  });

  it('delivers even where there are no SSH keys to sync', async () => {
    await prismaClaimEffects.welcomeOwner(box({ hostHome: null }), owner);
    expect(delivered).toEqual([['box_1', 'user_1']]);
    expect(synced).toEqual([]);
  });

  it('never fails the claim on a delivery error', async () => {
    deliveryFails = true;
    await expect(prismaClaimEffects.welcomeOwner(box({}), owner)).resolves.toBeUndefined();
    expect(synced).toEqual(['box_1']);
  });

  // No hello follows a claim, so without this the owner's queued ask never
  // finds the box ready and waits out its 15 minutes.
  it('settles the rebound connection once delivery has finished, as a hello would', async () => {
    await prismaClaimEffects.welcomeOwner(box({}), owner);
    await flush();
    expect(settled).toEqual(['box_1 after 1 deliveries']);
  });

  it('settles it when delivery fails too', async () => {
    deliveryFails = true;
    await prismaClaimEffects.welcomeOwner(box({}), owner);
    await flush();
    expect(settled).toEqual(['box_1 after 1 deliveries']);
  });
});
