import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliUser } from '../services/cliStore';

const instances = new Map<string, { id: string; name: string; kind: string; status: string; userId: string }>();
vi.mock('../db', () => ({
  prisma: {
    instance: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
        const row = instances.get(where.id);
        return row && row.userId === where.userId ? row : null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => instances.get(where.id) ?? null,
    },
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, googleEmail: 'a@x', displayName: 'A', unixUsername: 'a', defaultAgentProvider: 'claude' }) },
  },
}));
vi.mock('../services/agentRegistry', () => ({ instanceAgentTransport: () => null }));
vi.mock('../services/featureFlags', () => ({ boolVariation: async () => false }));

const { createPrismaForwardBoxes } = await import('./cliForwardPrisma');

const alice: CliUser = { id: 'alice', googleEmail: 'a@x', unixUsername: 'a', displayName: 'A' };

let flagOn: boolean;
let flagAsked: Array<[string, string]>;
let agent: { helloReceived: boolean; capabilities: string[] } | null;
const boxes = createPrismaForwardBoxes({
  flag: async (user, box) => { flagAsked.push([user.id, box.id]); return flagOn; },
  transport: () => agent as never,
});

beforeEach(() => {
  instances.clear();
  instances.set('box-1', { id: 'box-1', name: 'devbox', kind: 'ec2', status: 'ready', userId: 'alice' });
  instances.set('box-bob', { id: 'box-bob', name: 'bobs', kind: 'ec2', status: 'ready', userId: 'bob' });
  flagOn = true;
  flagAsked = [];
  agent = { helloReceived: true, capabilities: ['t3-v1', 'port-forward-v1'] };
});

const status = (s: string) => { instances.get('box-1')!.status = s; };

describe('forward access', () => {
  it("is the owner's, behind the flag for the owner and the box, for a ready box whose agent speaks port-forward-v1", async () => {
    expect(await boxes.access(alice, 'box-1')).toEqual({ ok: true });
    expect(flagAsked).toEqual([['alice', 'box-1']]);
  });

  it('answers not_found for another\'s box, a missing or terminated one, and the flag off', async () => {
    expect(await boxes.access(alice, 'box-bob')).toMatchObject({ status: 404, code: 'not_found' });
    expect(await boxes.access(alice, 'nope')).toMatchObject({ status: 404, code: 'not_found' });
    status('terminated');
    expect(await boxes.access(alice, 'box-1')).toMatchObject({ status: 404, code: 'not_found' });
    status('ready');
    flagOn = false;
    expect(await boxes.access(alice, 'box-1')).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('answers box_parked for every parked or parking state, after the flag', async () => {
    for (const s of ['stopping', 'stopped', 'starting', 'hibernating', 'hibernated']) {
      status(s);
      expect(await boxes.access(alice, 'box-1'), s).toMatchObject({ status: 409, code: 'box_parked' });
    }
    flagOn = false;
    expect(await boxes.access(alice, 'box-1')).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('answers box_not_ready without a ready box, an agent or its hello, and box_outdated without the capability', async () => {
    status('provisioning');
    expect(await boxes.access(alice, 'box-1')).toMatchObject({ status: 409, code: 'box_not_ready' });
    status('ready');
    agent = null;
    expect(await boxes.access(alice, 'box-1')).toMatchObject({ status: 409, code: 'box_not_ready' });
    agent = { helloReceived: false, capabilities: ['port-forward-v1'] };
    expect(await boxes.access(alice, 'box-1')).toMatchObject({ status: 409, code: 'box_not_ready' });
    agent = { helloReceived: true, capabilities: ['t3-v1'] };
    expect(await boxes.access(alice, 'box-1')).toMatchObject({ status: 501, code: 'box_outdated' });
  });

  it('says whether a box is parked or parking', async () => {
    expect(await boxes.parked('box-1')).toBe(false);
    status('hibernating');
    expect(await boxes.parked('box-1')).toBe(true);
    expect(await boxes.parked('nope')).toBe(false);
  });
});
