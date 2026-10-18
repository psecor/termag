import { beforeEach, describe, expect, it, vi } from 'vitest';

// abandonBox against a mocked Postgres: what it writes, and whether it takes
// the owner off the live agent, depends on whether the row was still the
// claim's to revert.
let readyRows = 1;
const writes: Array<{ table: string; where: any; data: any }> = [];
vi.mock('../db', () => {
  const tx = {
    instance: { updateMany: async (a: any) => { writes.push({ table: 'instance', ...a }); return { count: readyRows }; } },
    agentToken: { updateMany: async (a: any) => { writes.push({ table: 'agentToken', ...a }); return { count: 1 }; } },
  };
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});
const disowned: string[] = [];
vi.mock('./agentRegistry', () => ({
  connectedInstanceIds: () => [],
  rebindInstanceOwner: () => null,
  sendToInstanceAgent: async () => ({ ok: true }),
  disownInstanceAgent: (id: string) => { disowned.push(id); },
}));
vi.mock('./sshKeySync', () => ({ syncBoxAuthorizedKeys: async () => {} }));

const { prismaClaimEffects } = await import('./warmPoolClaim');

beforeEach(() => { writes.length = 0; disowned.length = 0; });

describe('abandonBox', () => {
  it('reverts the row and the token, then disowns the live agent', async () => {
    readyRows = 1;
    await prismaClaimEffects.abandonBox('box_1', 'claim RPC failed');
    expect(writes.map(w => w.table)).toEqual(['instance', 'agentToken']);
    expect(disowned).toEqual(['box_1']);
  });

  it('leaves the agent alone when the row is no longer the claim\'s to revert', async () => {
    readyRows = 0;
    await prismaClaimEffects.abandonBox('box_2', 'claim RPC failed');
    expect(writes.map(w => w.table)).toEqual(['instance']);
    expect(disowned).toEqual([]);
  });
});
