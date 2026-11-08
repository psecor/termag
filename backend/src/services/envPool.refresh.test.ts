// The environment pool's refresh, its side effects: taking an env-stopped row
// for a refresh, a refused start putting it back as it was, and only the refresh's own setup success stopping the box.
// The rules on which rows are due are envPoolPlanner.test.ts's.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string; status: string };
const rows = new Map<string, Row>();

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'in' in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
    if (v instanceof Date) return row[k] instanceof Date && (row[k] as Date).getTime() === v.getTime();
    return (row[k] ?? null) === v;
  });
}

const prisma = {
  instance: {
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const r of rows.values()) if (matches(r, where)) { Object.assign(r, data); count++; }
      return { count };
    }),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [...rows.values()].filter(r => matches(r, where)).length),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (rows.has(where.id) ? { ...rows.get(where.id)! } : null)),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};

const send = vi.fn();
const listeners = new Map<string, (ev: unknown) => void>();
const recordProductEvent = vi.fn();

vi.mock('../db', () => ({ prisma }));
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class { send = send; },
  StartInstancesCommand: class { constructor(public input: unknown) {} readonly kind = 'start'; },
  StopInstancesCommand: class { constructor(public input: unknown) {} readonly kind = 'stop'; },
  DescribeInstancesCommand: class { constructor(public input: unknown) {} readonly kind = 'describe'; },
}));
vi.mock('./boxProvisioner', () => ({
  getBoxConfig: () => ({ region: 'us-west-2', subnetId: 'subnet-a', fallbackSubnetIds: [] }),
  awsClientConfig: () => ({}),
  isCapacityRefusal: (err: unknown) => err instanceof Error && err.name === 'InsufficientInstanceCapacity',
  provisionEnvPoolBox: vi.fn(),
  terminateBox: vi.fn(),
}));
vi.mock('./agentRegistry', () => ({
  onPoolBoxFrame: vi.fn((type: string, fn: (ev: unknown) => void) => { listeners.set(type, fn); return () => listeners.delete(type); }),
  sendToInstanceAgent: vi.fn(),
  dropInstanceAgent: vi.fn(),
}));
vi.mock('./warmPool', () => ({ currentPoolSpecHash: vi.fn(async () => 'spec') }));
vi.mock('./productEvents', () => ({ recordProductEvent }));

const { refreshEnvPoolBox, refreshPrepareId, startEnvPool, prepareRequest } = await import('./envPool');
type Def = Parameters<typeof refreshEnvPoolBox>[1];
type PoolRow = Parameters<typeof refreshEnvPoolBox>[0];

const NOW = new Date('2026-11-06T12:00:00Z');
const OLD = { 'e2e-org/envdemo': 'a'.repeat(40) };
const NEW = { 'e2e-org/envdemo': 'b'.repeat(40) };
const POLICY = { maxInFlight: 2, refreshMs: 60 * 60_000, prepareTimeoutMs: 45 * 60_000, claimWaitMs: 120_000 };
const def = {
  environmentId: 'env1', name: 'envdemo', repos: [{ repo: 'e2e-org/envdemo', branch: 'main', name: 'envdemo' }], heads: NEW,
  setup: '"npm ci"', fileText: '{}', fileRepo: 'e2e-org/envdemo', filePath: '.termag/environment.json', size: null, diskGiB: 60,
  poolSpecHash: 'spec', setupHash: 'h1',
} as Def;

function stopped(id: string, over: Partial<Row> = {}): Row {
  return {
    id, status: 'env-stopped', userId: null, poolEnvironmentId: 'env1', poolSetupHash: 'h1', preparedCommit: OLD,
    preparedAt: new Date(NOW.getTime() - 2 * 60 * 60_000), createdAt: new Date(NOW.getTime() - 5 * 60 * 60_000), subnetId: 'subnet-a',
    ec2InstanceId: `i-${id}`, region: 'us-west-2', claimedAt: null, cleanedUpAt: null, refreshStartedAt: null, refreshCheckedAt: null,
    ...over,
  };
}
const asPoolRow = (r: Row) => ({ ...r }) as unknown as PoolRow;

beforeEach(() => {
  rows.clear();
  send.mockReset();
  recordProductEvent.mockReset();
});

describe('refreshEnvPoolBox', () => {
  it('takes an env-stopped row to env-preparing at the heads it is going to, then starts it', async () => {
    rows.set('s1', stopped('s1'));
    send.mockResolvedValue({});
    expect(await refreshEnvPoolBox(asPoolRow(rows.get('s1')!), def, POLICY, NOW)).toBe('started');
    expect(rows.get('s1')).toMatchObject({ status: 'env-preparing', refreshStartedAt: NOW, refreshCheckedAt: NOW, preparedCommit: NEW });
    expect(send.mock.calls[0][0]).toMatchObject({ kind: 'start', input: { InstanceIds: ['i-s1'] } });
  });

  it('puts a row back exactly as it was when EC2 has no capacity, checked again at the next interval', async () => {
    rows.set('s1', stopped('s1'));
    send.mockRejectedValue(Object.assign(new Error('no room'), { name: 'InsufficientInstanceCapacity' }));
    expect(await refreshEnvPoolBox(asPoolRow(rows.get('s1')!), def, POLICY, NOW)).toBe('put-back');
    expect(rows.get('s1')).toMatchObject({ status: 'env-stopped', refreshStartedAt: null, refreshCheckedAt: NOW, preparedCommit: OLD });
  });

  it('puts it back the same way when the start fails otherwise: nothing is wrong with the box', async () => {
    rows.set('s1', stopped('s1'));
    send.mockRejectedValue(new Error('throttled'));
    expect(await refreshEnvPoolBox(asPoolRow(rows.get('s1')!), def, POLICY, NOW)).toBe('put-back');
    expect(rows.get('s1')).toMatchObject({ status: 'env-stopped', preparedCommit: OLD });
  });

  it('leaves a row a claim took meanwhile: it is somebody\'s box, never refreshed', async () => {
    const row = stopped('s1');
    rows.set('s1', { ...row, status: 'env-starting' });
    expect(await refreshEnvPoolBox(asPoolRow(row), def, POLICY, NOW)).toBe('taken');
    expect(rows.get('s1')!.status).toBe('env-starting');
    expect(send).not.toHaveBeenCalled();
  });

  it('counts prepares and refreshes together against ENV_POOL_MAX_INFLIGHT, and leaves the row stopped', async () => {
    rows.set('p1', stopped('p1', { status: 'env-preparing' }));
    rows.set('p2', stopped('p2', { status: 'env-preparing', poolEnvironmentId: 'env2' }));
    rows.set('s1', stopped('s1'));
    expect(await refreshEnvPoolBox(asPoolRow(rows.get('s1')!), def, POLICY, NOW)).toBe('capped');
    expect(rows.get('s1')).toMatchObject({ status: 'env-stopped', refreshCheckedAt: null, preparedCommit: OLD });
  });

  it('never refreshes a row prepared for another setup hash: that one is replaced', async () => {
    rows.set('s1', stopped('s1', { poolSetupHash: 'h0' }));
    expect(await refreshEnvPoolBox(asPoolRow(rows.get('s1')!), def, POLICY, NOW)).toBe('capped');
    expect(rows.get('s1')!.status).toBe('env-stopped');
  });
});

describe('a refresh is told it is one', () => {
  it('carries its prepareId in environment-prepare; a launch carries none', () => {
    expect(prepareRequest('s1', def, NOW)).toMatchObject({ prepareId: refreshPrepareId(NOW) });
    expect(prepareRequest('s1', def)).not.toHaveProperty('prepareId');
  });
});

describe("a refreshing box's environment-status", () => {
  const frame = (status: Record<string, unknown>) => ({
    instance: { id: 's1' }, capabilities: [],
    msg: { type: 'environment-status', projectId: 'pool', status: { state: 'ready', setup: { state: 'succeeded' }, setupCommit: NEW, ...status } },
  });
  async function deliver(ev: unknown) {
    listeners.get('environment-status')!(ev);
    await vi.waitFor(() => expect(prisma.instance.findUnique).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 10));
  }

  beforeEach(() => {
    startEnvPool();
    prisma.instance.findUnique.mockClear();
    send.mockResolvedValue({});
  });

  it("ignores the last prepare's success, which the agent re-sends at its hello before the refresh has run", async () => {
    rows.set('s1', stopped('s1', { status: 'env-preparing', refreshStartedAt: NOW }));
    await deliver(frame({ setupCommit: OLD }));
    expect(rows.get('s1')!.status).toBe('env-preparing');
    expect(send).not.toHaveBeenCalled();
  });

  it("stops the box on the refresh's own success: prepared at the new commits, where: refresh, incremental", async () => {
    rows.set('s1', stopped('s1', { status: 'env-preparing', refreshStartedAt: NOW }));
    await deliver(frame({ prepareId: refreshPrepareId(NOW) }));
    expect(rows.get('s1')).toMatchObject({ status: 'env-stopping', preparedCommit: NEW, refreshStartedAt: null });
    expect(send.mock.calls[0][0]).toMatchObject({ kind: 'stop' });
    expect(recordProductEvent).toHaveBeenCalledWith('environment.setup', { user: null, box: 's1' }, expect.objectContaining({ outcome: 'succeeded', where: 'refresh', incremental: true }));
  });

  it('fails a refresh whose setup failed, as a prepare does, with where: refresh', async () => {
    rows.set('s1', stopped('s1', { status: 'env-preparing', refreshStartedAt: NOW }));
    await deliver(frame({ prepareId: refreshPrepareId(NOW), state: 'failed', setup: { state: 'failed', error: 'npm ci exited 1' }, log: 'npm ERR!' }));
    expect(rows.get('s1')).toMatchObject({ status: 'env-failed' });
    expect(String(rows.get('s1')!.poolLog)).toContain('npm ERR!');
    expect(recordProductEvent).toHaveBeenCalledWith('environment.setup', { user: null, box: 's1' }, expect.objectContaining({ outcome: 'failed', where: 'refresh', incremental: true }));
  });

  it("keeps a first prepare's success as it was: where: pool", async () => {
    rows.set('s1', stopped('s1', { status: 'env-preparing', preparedAt: null }));
    await deliver(frame({}));
    expect(rows.get('s1')!.status).toBe('env-stopping');
    expect(recordProductEvent).toHaveBeenCalledWith('environment.setup', expect.anything(), expect.objectContaining({ where: 'pool', incremental: false }));
  });
});

describe("#1453's Bugbot fixes, on a refresh", () => {
  const frame = (status: Record<string, unknown>) => ({
    instance: { id: 's1' }, capabilities: [],
    msg: { type: 'environment-status', projectId: 'pool', status: { state: 'ready', ...status } },
  });
  async function deliver(ev: unknown) {
    listeners.get('environment-status')!(ev);
    await vi.waitFor(() => expect(prisma.instance.findUnique).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 10));
  }
  beforeEach(() => {
    startEnvPool();
    prisma.instance.findUnique.mockClear();
    send.mockResolvedValue({});
  });

  it('finishes the refresh of an environment with no setup, at the commits the chain recorded', async () => {
    rows.set('s1', stopped('s1', { status: 'env-preparing', refreshStartedAt: NOW, preparedCommit: NEW }));
    // The last prepare's own "no setup, ready" state, re-sent at the hello: not this refresh's.
    await deliver(frame({ setup: { state: 'none' }, setupCommit: OLD }));
    expect(rows.get('s1')!.status).toBe('env-preparing');
    prisma.instance.findUnique.mockClear();
    await deliver(frame({ setup: { state: 'none' }, setupCommit: NEW, prepareId: refreshPrepareId(NOW) }));
    expect(rows.get('s1')).toMatchObject({ status: 'env-stopping', preparedCommit: NEW, refreshStartedAt: null });
    expect(recordProductEvent).toHaveBeenCalledWith('environment.setup', expect.anything(), expect.objectContaining({ where: 'refresh', outcome: 'succeeded' }));
  });

  it("finishes it on an older agent that records no setupCommit for an empty setup: the heads the refresh started at", async () => {
    rows.set('s1', stopped('s1', { status: 'env-preparing', refreshStartedAt: NOW, preparedCommit: NEW }));
    await deliver(frame({ setup: { state: 'none' }, prepareId: refreshPrepareId(NOW) }));
    expect(rows.get('s1')).toMatchObject({ status: 'env-stopping', preparedCommit: NEW });
  });

  it('marks a refresh whose setup ran and exited poolSetupFailed, at the hash and heads it started at', async () => {
    rows.set('s1', stopped('s1'));
    send.mockResolvedValue({});
    expect(await refreshEnvPoolBox(asPoolRow(rows.get('s1')!), def, POLICY, NOW)).toBe('started');
    await deliver(frame({ state: 'failed', setup: { state: 'failed', error: 'exited 1', exitCode: 1 }, prepareId: refreshPrepareId(NOW) }));
    expect(rows.get('s1')).toMatchObject({ status: 'env-failed', poolSetupFailed: true, poolSetupHash: def.setupHash, preparedCommit: NEW });
  });

  it('records a refresh that failed before setup ran (its fetch) at the same hash and heads, not poolSetupFailed', async () => {
    rows.set('s1', stopped('s1'));
    send.mockResolvedValue({});
    expect(await refreshEnvPoolBox(asPoolRow(rows.get('s1')!), def, POLICY, NOW)).toBe('started');
    await deliver(frame({ state: 'failed', setup: { state: 'failed', error: 'fetch e2e-org/envdemo: fatal: 403' }, prepareId: refreshPrepareId(NOW) }));
    expect(rows.get('s1')).toMatchObject({ status: 'env-failed', poolSetupFailed: false, poolSetupHash: def.setupHash, preparedCommit: NEW });
  });
});

describe("a refresh's pending state (Bugbot and Devin on #1455)", () => {
  const frame = (status: Record<string, unknown>) => ({
    instance: { id: 's1' }, capabilities: [],
    msg: { type: 'environment-status', projectId: 'pool', status },
  });
  async function deliver(ev: unknown) {
    listeners.get('environment-status')!(ev);
    await vi.waitFor(() => expect(prisma.instance.findUnique).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 10));
  }
  beforeEach(() => {
    startEnvPool();
    prisma.instance.findUnique.mockClear();
    send.mockResolvedValue({});
  });

  it("never takes the last prepare's success carried into the refresh's pending state, with the new prepareId", async () => {
    rows.set('s1', stopped('s1', { status: 'env-preparing', refreshStartedAt: NOW, preparedCommit: NEW }));
    // What startChain writes for the refresh, before its chain runs setup: the earlier setup's result is still there.
    await deliver(frame({ state: 'pending', setup: { state: 'succeeded' }, setupCommit: OLD, prepareId: refreshPrepareId(NOW) }));
    expect(rows.get('s1')!.status).toBe('env-preparing');
    expect(send).not.toHaveBeenCalled();
    // And while its setup runs.
    prisma.instance.findUnique.mockClear();
    await deliver(frame({ state: 'setup', setup: { state: 'running' }, setupCommit: OLD, prepareId: refreshPrepareId(NOW) }));
    expect(rows.get('s1')!.status).toBe('env-preparing');
    // Its chain settles: prepared at what it ran at.
    prisma.instance.findUnique.mockClear();
    await deliver(frame({ state: 'ready', setup: { state: 'succeeded' }, setupCommit: NEW, prepareId: refreshPrepareId(NOW) }));
    expect(rows.get('s1')).toMatchObject({ status: 'env-stopping', preparedCommit: NEW });
  });
});
