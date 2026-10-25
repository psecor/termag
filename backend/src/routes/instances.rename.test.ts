import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * renameOwnedBox: owner only, behind box-rename-enabled, unique among the
 * owner's live boxes, and the box token's label follows the name.
 */

const flagOn = vi.hoisted(() => ({ value: true }));
vi.mock('../services/featureFlags', () => ({
  boolVariation: vi.fn(async (key: string, _user: unknown, fallback: boolean) => key === 'box-rename-enabled' ? flagOn.value : fallback),
  boolVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: boolean) => fallback),
  stringVariation: vi.fn(async (_key: string, _user: unknown, fallback: string) => fallback),
}));

const db = vi.hoisted(() => {
  const rows: Array<{ id: string; userId: string; name: string; status: string }> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== (v as { not: unknown }).not;
    return row[k] === v;
  });
  const conflict = { error: null as unknown };
  const tokenUpdates: unknown[] = [];
  return {
    rows, conflict, tokenUpdates,
    prisma: {
      instance: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find(r => matches(r, where)) ?? null),
        update: vi.fn((args: { where: { id: string }; data: { name: string } }) => ({ op: 'instance.update', args })),
      },
      agentToken: {
        updateMany: vi.fn((args: unknown) => ({ op: 'agentToken.updateMany', args })),
      },
      $transaction: vi.fn(async (ops: Array<{ op: string; args: { where: { id: string }; data: { name: string } } }>) => {
        if (conflict.error) throw conflict.error;
        return ops.map(({ op, args }) => {
          if (op === 'agentToken.updateMany') { tokenUpdates.push(args); return { count: 1 }; }
          const row = rows.find(r => r.id === args.where.id)!;
          row.name = args.data.name;
          return { ...row };
        });
      }),
    },
  };
});

vi.mock('../db', () => ({ prisma: db.prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/boxProvisioner', () => ({ provisionBox: vi.fn(), terminateBox: vi.fn(), isBoxProvisioningConfigured: () => true }));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(), reconcileWarmPool: vi.fn() }));
vi.mock('../services/agentRegistry', () => ({ sendToInstanceAgent: vi.fn(), isInstanceAgentConnected: vi.fn() }));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox: vi.fn(),
  isNameConflict: (err: unknown) => (err as { code?: string })?.code === 'P2002',
  prismaClaimEffects: {},
  WARM_POOL_ENABLED_FLAG: 'warm-pool-enabled',
}));

const { renameOwnedBox } = await import('./instances');

const alice = { id: 'u1', unixUsername: 'alice' } as unknown as Express.User;

beforeEach(() => {
  flagOn.value = true;
  db.conflict.error = null;
  db.tokenUpdates.length = 0;
  db.rows.splice(0, db.rows.length,
    { id: 'b1', userId: 'u1', name: 'devbox', status: 'ready' },
    { id: 'b2', userId: 'u1', name: 'heavy', status: 'stopped' },
    { id: 'b3', userId: 'u1', name: 'old', status: 'terminated' },
    { id: 'b4', userId: 'u2', name: 'bobs', status: 'ready' },
  );
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('renameOwnedBox', () => {
  it('renames the box and relabels its token', async () => {
    const result = await renameOwnedBox(alice, 'b1', ' laptop ');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ instance: expect.objectContaining({ id: 'b1', name: 'laptop' }) });
    expect(db.tokenUpdates).toEqual([{ where: { instanceId: 'b1', name: 'box: devbox' }, data: { name: 'box: laptop' } }]);
  });

  it('renames a stopped box', async () => {
    expect((await renameOwnedBox(alice, 'b2', 'parked')).status).toBe(200);
  });

  it('may take a name a terminated box left behind', async () => {
    expect((await renameOwnedBox(alice, 'b1', 'old')).status).toBe(200);
  });

  it('refuses a name another of the owner\'s live boxes has', async () => {
    const result = await renameOwnedBox(alice, 'b1', 'heavy');

    expect(result).toEqual({ status: 409, body: { error: 'A box named "heavy" already exists' } });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers a race into the unique index as the same conflict', async () => {
    db.conflict.error = Object.assign(new Error('unique'), { code: 'P2002' });

    expect(await renameOwnedBox(alice, 'b1', 'laptop')).toEqual({ status: 409, body: { error: 'A box named "laptop" already exists' } });
  });

  it('writes nothing when the name is unchanged', async () => {
    const result = await renameOwnedBox(alice, 'b1', 'devbox');

    expect(result.status).toBe(200);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers another user\'s box, and a terminated one, as not found', async () => {
    expect((await renameOwnedBox(alice, 'b4', 'mine')).status).toBe(404);
    expect((await renameOwnedBox(alice, 'b3', 'back')).status).toBe(404);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an invalid name', async () => {
    expect((await renameOwnedBox(alice, 'b1', 'my box')).status).toBe(400);
  });

  it('refuses while box-rename-enabled is off for the user', async () => {
    flagOn.value = false;

    expect(await renameOwnedBox(alice, 'b1', 'laptop')).toEqual({
      status: 403, body: { error: 'Renaming boxes is not enabled for you', code: 'rename_disabled' },
    });
    expect(db.prisma.instance.findFirst).not.toHaveBeenCalled();
  });
});
