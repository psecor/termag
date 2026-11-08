import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * growOwnedBox: the owner grows their own box's disk (services/boxDisk.ts):
 * only the owner, grow only, capped at 300 GB, refused inside EBS's six hours
 * and while a resize holds the box, and EC2's own refusal said plainly.
 */

const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
}));
vi.mock('../db', () => ({
  prisma: { instance: {
    // A copy, as Prisma answers: later writes don't change what the route read.
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (db.rows.has(where.id) ? { ...db.rows.get(where.id)! } : null)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(db.rows.get(where.id)!, data)),
    // Guarded writes, as Postgres matches them (a Date by its time).
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = db.rows.get(where.id as string);
      const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null));
      if (!row || !Object.entries(where).every(([k, v]) => same(row[k], v))) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  } },
}));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('../services/boxProvisioner', () => ({ provisionBox: vi.fn(), terminateBox: vi.fn(), isBoxProvisioningConfigured: () => true }));
vi.mock('../services/warmPool', () => ({ poolSpecHashOrNull: vi.fn(), reconcileWarmPool: vi.fn() }));
const agent = vi.hoisted(() => ({ capabilities: ['disk-grow-v1'] as string[] | null }));
vi.mock('../services/agentRegistry', () => ({
  sendToInstanceAgent: vi.fn(), isInstanceAgentConnected: vi.fn(),
  instanceAgentTransport: () => (agent.capabilities ? { capabilities: agent.capabilities } : null),
}));
vi.mock('../services/warmPoolClaim', () => ({
  claimWarmBox: vi.fn(), isNameConflict: () => false, prismaClaimEffects: {},
}));
const resizeRow = vi.hoisted(() => ({ value: null as Record<string, unknown> | null, grow: null as Record<string, unknown> | null }));
vi.mock('../services/boxEvents', async orig => ({
  ...(await orig<typeof import('../services/boxEvents')>()),
  latestBoxEvent: vi.fn(async (_id: string, kind: string) => (kind === 'resize' ? resizeRow.value : resizeRow.grow)),
}));
const ec2 = vi.hoisted(() => ({
  volume: { volumeId: 'vol-1', sizeGb: 120, volumeType: 'gp3', modification: null } as Record<string, unknown>,
  refusal: null as Error | null,
  grows: [] as unknown[][],
}));
vi.mock('../services/boxDisk', async orig => {
  const real = await orig<typeof import('../services/boxDisk')>();
  return {
    ...real,
    describeRootVolume: vi.fn(async () => ec2.volume),
    startGrow: vi.fn(async (...args: unknown[]) => {
      ec2.grows.push(args);
      if (ec2.refusal) throw ec2.refusal;
      return { volumeId: 'vol-1', fromGb: 120, toGb: args[2], by: args[3], startedAt: '2026-11-03T12:00:00.000Z', state: 'modifying', detail: null, finishedAt: null };
    }),
  };
});

const { growOwnedBox } = await import('./instances');
const { growRunning, resetGrowsForTests } = await import('../services/boxDisk');
const { describeRootVolume } = await import('../services/boxDisk');

const ada = { id: 'u1', unixUsername: 'ada' } as unknown as Express.User;
const IDLE_SINCE = new Date('2026-11-03T08:00:00Z');
const box = { id: 'b1', userId: 'u1', name: 'olive', kind: 'ec2', status: 'ready', ec2InstanceId: 'i-1', region: null, diskGiB: 120, lastActivityAt: IDLE_SINCE, parkedAt: null, autoParkedAt: null, lifecycleNote: null };

beforeEach(() => {
  db.rows.clear();
  db.rows.set('b1', { ...box });
  db.rows.set('b2', { ...box, id: 'b2', userId: 'u2' });
  agent.capabilities = ['disk-grow-v1'];
  resizeRow.value = null;
  resizeRow.grow = null;
  resetGrowsForTests();
  ec2.volume = { volumeId: 'vol-1', sizeGb: 120, volumeType: 'gp3', modification: null };
  ec2.refusal = null;
  ec2.grows = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('growOwnedBox', () => {
  it('grows the owner\'s box, writing the row as the owner, and answers 202 with the grow', async () => {
    const r = await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui');
    expect(r).toEqual({ status: 202, body: { grow: expect.objectContaining({ fromGb: 120, toGb: 200, state: 'modifying', running: true }) } });
    const [grown, volume, sizeGb, by, , actorId, role] = ec2.grows[0] as [Record<string, unknown>, unknown, number, string, unknown, string, string];
    expect(grown.id).toBe('b1');
    expect(volume).toBe(ec2.volume);
    expect({ sizeGb, by, actorId, role }).toEqual({ sizeGb: 200, by: 'ada', actorId: 'u1', role: 'owner' });
  });

  it('restarts the box\'s idle clock, as a resize does, so auto-park can\'t stop it mid-grow (Cursor on #1214)', async () => {
    const before = Date.now();
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).status).toBe(202);
    expect((db.rows.get('b1')!.lastActivityAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(db.rows.get('b1')).toMatchObject({ parkedAt: null, autoParkedAt: null });
  });

  it('a same-size request is a no-op: 200 "already", no grow, no row, no ModifyVolume and no activity, however often it comes (Cursor security on #1214)', async () => {
    // The CLI's POST /boxes/:id/disk, a box credential's included, lands here (cliLifecyclePrisma.growBoxDisk).
    for (let i = 0; i < 3; i++) {
      expect(await growOwnedBox(ada, 'b1', { sizeGb: 120 }, 'cli')).toEqual({ status: 200, body: { grow: null, alreadyGb: 120, message: 'The disk is already 120 GB' } });
    }
    expect(ec2.grows).toEqual([]);
    expect(db.rows.get('b1')!.lastActivityAt).toBe(IDLE_SINCE);
  });

  it('a same-size request after a grow that failed at the file system step finishes it, and still marks no activity', async () => {
    resizeRow.grow = { id: 'ev2', boxId: 'b1', kind: 'disk-grow', phase: 'failed', startedAt: new Date(Date.now() - 600_000), finishedAt: new Date(), error: 'growpart: FAILED', detail: { toGb: 120 } };
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 120 }, 'ui')).status).toBe(202);
    expect(ec2.grows).toHaveLength(1);
    expect(db.rows.get('b1')!.lastActivityAt).toBe(IDLE_SINCE);
  });

  it('marks the box in use before the grow starts, so a sweep that read the idle clock before the claim can\'t stop it (Devin on #1214)', async () => {
    let sweep: { count: number } | null = null;
    const { prisma } = await import('../db');
    const { startGrow } = await import('../services/boxDisk');
    vi.mocked(startGrow).mockImplementationOnce(async (...args: unknown[]) => {
      // The idle sweep, between the claim and the grow: its stop is guarded on the clock it read (boxLifecycle).
      sweep = await prisma.instance.updateMany({ where: { id: 'b1', status: 'ready', lastActivityAt: IDLE_SINCE }, data: { status: 'stopping' } });
      return { volumeId: 'vol-1', fromGb: 120, toGb: args[2] as number, by: 'ada', startedAt: new Date().toISOString(), state: 'modifying', detail: null, finishedAt: null };
    });
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).status).toBe(202);
    expect(sweep).toEqual({ count: 0 });
    expect(db.rows.get('b1')!.status).toBe('ready');
  });

  it('gives the idle clock back when EC2 refuses the modification: only an accepted grow is activity', async () => {
    ec2.refusal = Object.assign(new Error('You have reached the maximum modification rate per volume limit.'), { name: 'VolumeModificationRateExceeded' });
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'cli')).status).toBe(409);
    expect(db.rows.get('b1')).toMatchObject({ lastActivityAt: IDLE_SINCE, parkedAt: null });
  });

  it('keeps activity written during the request: the claim is on the clock it read, and a refusal restores the newest (Devin on #1214)', async () => {
    const LATER = new Date('2026-11-03T09:30:00Z');
    // The owner types on the box while the route reads the volume.
    vi.mocked(describeRootVolume).mockImplementationOnce(async () => { Object.assign(db.rows.get('b1')!, { lastActivityAt: LATER }); return ec2.volume as never; });
    ec2.refusal = Object.assign(new Error('You have reached the maximum modification rate per volume limit.'), { name: 'VolumeModificationRateExceeded' });
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).status).toBe(409);
    expect(db.rows.get('b1')!.lastActivityAt).toEqual(LATER);
  });

  it('answers 404 for another user\'s box and a missing one, as a resize does', async () => {
    expect((await growOwnedBox(ada, 'b2', { sizeGb: 200 }, 'ui')).status).toBe(404);
    expect((await growOwnedBox(ada, 'nope', { sizeGb: 200 }, 'ui')).status).toBe(404);
    expect(ec2.grows).toEqual([]);
  });

  it('refuses a shrink and more than 300 GB with 400 invalid_disk', async () => {
    expect(await growOwnedBox(ada, 'b1', { sizeGb: 100 }, 'ui')).toMatchObject({ status: 400, body: { code: 'invalid_disk', error: expect.stringMatching(/can't shrink/) } });
    expect(await growOwnedBox(ada, 'b1', { sizeGb: 400 }, 'ui')).toMatchObject({ status: 400, body: { code: 'invalid_disk', error: expect.stringMatching(/up to 300 GB/) } });
    expect(ec2.grows).toEqual([]);
  });

  it('refuses inside EBS\'s six hours before asking EC2, saying when it can grow again', async () => {
    ec2.volume = { ...ec2.volume, modification: { state: 'completed', progress: 100, targetSizeGb: 120, startedAt: new Date(Date.now() - 3_600_000).toISOString() } };
    const r = await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui');
    expect(r).toMatchObject({ status: 409, body: { code: 'disk_cooldown', error: expect.stringMatching(/one change to a disk every six hours.*can grow again after/) } });
    expect(ec2.grows).toEqual([]);
  });

  it('says EC2\'s own six-hour refusal plainly', async () => {
    ec2.refusal = Object.assign(new Error('You have reached the maximum modification rate per volume limit.'), { name: 'VolumeModificationRateExceeded' });
    expect(await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).toMatchObject({
      status: 409, body: { code: 'disk_cooldown', error: expect.stringMatching(/^EBS allows one change to a disk every six hours/) },
    });
  });

  it('refuses a stopped box and an old agent with boxDisk\'s reasons', async () => {
    db.rows.set('b1', { ...box, status: 'stopped' });
    expect(await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).toMatchObject({ status: 409, body: { code: 'disk_unavailable', error: expect.stringMatching(/start it first/) } });
    db.rows.set('b1', { ...box });
    agent.capabilities = ['host-sample-v1'];
    expect(await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/too old/) } });
  });

  it('holds the box as growing from before the volume is read, so a resize asked meanwhile waits for it (Devin on #1214)', async () => {
    let seen: boolean | null = null;
    vi.mocked(describeRootVolume).mockImplementationOnce(async () => { seen = growRunning('b1'); return ec2.volume as never; });
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).status).toBe(202);
    expect(seen).toBe(true);
  });

  it('lets the box go again when the request is refused', async () => {
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 100 }, 'ui')).status).toBe(400);
    ec2.refusal = new Error('boom');
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).status).toBe(409);
    resizeRow.value = { id: 'ev1', boxId: 'b1', kind: 'resize', phase: 'stopping', startedAt: new Date(), finishedAt: null, detail: {} };
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).status).toBe(409);
    expect(growRunning('b1')).toBe(false);
  });

  it('refuses while a fresh disk-grow row is open, a grow another process may be running (Cursor on #1214)', async () => {
    resizeRow.grow = { id: 'ev2', boxId: 'b1', kind: 'disk-grow', phase: 'filesystem', startedAt: new Date(Date.now() - 60_000), finishedAt: null, detail: { toGb: 120 } };
    expect(await growOwnedBox(ada, 'b1', { sizeGb: 120 }, 'ui')).toMatchObject({ status: 409, body: { code: 'disk_unavailable', error: 'a grow is already running on this box' } });
    expect(ec2.grows).toEqual([]);
    // Past the stale hour, the row was cut off: a same-size retry goes through.
    resizeRow.grow = { ...resizeRow.grow, startedAt: new Date(Date.now() - 2 * 3_600_000) };
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 120 }, 'ui')).status).toBe(202);
  });

  it('a grow this process has finished doesn\'t refuse the next while its row is still being closed (Bugbot on #1214)', async () => {
    const { recordGrowForTests } = await import('../services/boxDisk');
    recordGrowForTests('b1', { volumeId: 'vol-1', fromGb: 100, toGb: 120, by: 'ada', startedAt: new Date().toISOString(), state: 'done', detail: null, finishedAt: new Date().toISOString(), eventId: 'ev-done' });
    resizeRow.grow = { id: 'ev-done', boxId: 'b1', kind: 'disk-grow', phase: 'filesystem', startedAt: new Date(), finishedAt: null, detail: { toGb: 120 } };
    expect((await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).status).toBe(202);
  });

  it('refuses while a resize holds the box', async () => {
    resizeRow.value = { id: 'ev1', boxId: 'b1', kind: 'resize', phase: 'stopping', startedAt: new Date(), finishedAt: null, detail: {} };
    expect(await growOwnedBox(ada, 'b1', { sizeGb: 200 }, 'ui')).toMatchObject({ status: 409, body: { code: 'resize_running' } });
  });
});
