import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Instance, User } from '@prisma/client';

// A warm box says hello while nobody owns it, so the hello-time credential
// delivery skips it; the claim rebinds the socket in place and must deliver.
const delivered: Array<[string, string]> = [];
const synced: string[] = [];
const settled: string[] = [];
const claimed: string[] = [];
let deliveryFails = false;
// A delivery still running, when a test holds it.
let deliveryHeld: Promise<void> | null = null;
let deliveriesDone = 0;
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
    if (deliveryHeld) await deliveryHeld;
    deliveriesDone++;
    if (deliveryFails) throw new Error('box script refused');
  },
}));

// The claim's update runs after the delivery, and the connection settles after the update (claimUpdate.ts).
const updates: string[] = [];
let releaseUpdate: (() => void) | null = null;
// A box with nothing to update ends its run at once, without waiting for the delivery (claimUpdate.ts).
let updateIgnoresDelivery = false;
vi.mock('./claimUpdate', () => ({
  startClaimUpdate: async (instance: { id: string }, _owner: unknown, before: Promise<unknown>) => {
    const updating = releaseUpdate !== null;
    const done = (async () => {
      if (!updateIgnoresDelivery) await before;
      updates.push(`${instance.id} after ${delivered.length} deliveries`);
      if (updating) await new Promise<void>(r => { releaseUpdate = r; });
      return { status: updating ? 'updated' : 'current' };
    })();
    return { updating, done };
  },
}));

const { prismaClaimEffects } = await import('./warmPoolClaim');

const owner = { id: 'user_1' } as User;
const box = (over: Partial<Instance>) => ({ id: 'box_1', kind: 'ec2', hostHome: '/home/termag', ...over }) as Instance;

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  delivered.length = 0; synced.length = 0; settled.length = 0; claimed.length = 0; updates.length = 0;
  deliveryFails = false; releaseUpdate = null; deliveryHeld = null; deliveriesDone = 0; updateIgnoresDelivery = false;
});

describe('welcomeOwner', () => {
  it('delivers the claimer\'s credentials and syncs SSH keys', async () => {
    expect(await prismaClaimEffects.welcomeOwner(box({}), owner)).toEqual({});
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
    await expect(prismaClaimEffects.welcomeOwner(box({}), owner)).resolves.toEqual({});
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

  it('updates the box after the delivery, and settles the connection only once the update is done', async () => {
    releaseUpdate = () => {};
    // The claim's answer says so, for the setup steps.
    expect(await prismaClaimEffects.welcomeOwner(box({}), owner)).toEqual({ claimUpdateStatus: 'updating', claimUpdateStartedAt: expect.any(Date) });
    await flush();
    expect(updates).toEqual(['box_1 after 1 deliveries']);
    // An ask queued for the box waits on this: it must not run under an update that restarts the agent.
    expect(settled).toEqual([]);
    releaseUpdate!();
    await flush();
    expect(settled).toEqual(['box_1 after 1 deliveries']);
  });

  // Bugbot on #1118: a current box's update ends before the delivery does, and
  // an ask reads the settled mark as "the credentials have landed".
  it('settles the connection only after the delivery, even when the update ends first', async () => {
    let deliver!: () => void;
    deliveryHeld = new Promise<void>(r => { deliver = r; });
    updateIgnoresDelivery = true;
    await prismaClaimEffects.welcomeOwner(box({}), owner);
    await flush();
    expect(updates).toEqual(['box_1 after 1 deliveries']);
    expect(settled).toEqual([]);
    deliver();
    await flush();
    expect(deliveriesDone).toBe(1);
    expect(settled).toEqual(['box_1 after 1 deliveries']);
  });
});
