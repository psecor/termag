import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '@prisma/client';

// An in-memory Instance table with Prisma's updateMany/findMany semantics for
// the where shapes boxPower uses.
const rows = new Map<string, Record<string, any>>();
const matches = (row: Record<string, any>, where: Record<string, any>) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
  if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
  if (v && typeof v === 'object' && 'lte' in v) return row[k] instanceof Date && row[k] <= v.lte;
  return row[k] === v;
});
vi.mock('../db', () => ({
  prisma: {
    instance: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of rows.values()) if (matches(row, where)) { Object.assign(row, data); count++; }
        return { count };
      },
      findMany: async ({ where }: any) => [...rows.values()].filter(r => matches(r, where)).map(r => ({ ...r })),
      findUnique: async ({ where }: any) => (rows.has(where.id) ? { ...rows.get(where.id) } : null),
    },
  },
}));

const ec2 = {
  state: 'running' as string | undefined,
  reason: undefined as string | undefined,
  refuse: null as string | null,
  // Refuses only StopInstances with Hibernate, the way EC2 refuses a hibernate a plain stop would pass.
  refuseHibernate: null as { name: string; message: string } | null,
  sent: [] as string[],
};
vi.mock('@aws-sdk/client-ec2', () => {
  const command = (name: string) => class { constructor(public input: any) {} name = name; };
  return {
    StopInstancesCommand: command('StopInstances'),
    StartInstancesCommand: command('StartInstances'),
    DescribeInstancesCommand: command('DescribeInstances'),
    EC2Client: class {
      async send(cmd: { name: string; input: any }) {
        const hibernate = cmd.name === 'StopInstances' && cmd.input.Hibernate === true;
        ec2.sent.push(hibernate ? 'StopInstances(Hibernate)' : cmd.name);
        if (cmd.name === 'DescribeInstances') {
          return { Reservations: [{ Instances: [{
            State: ec2.state ? { Name: ec2.state } : undefined,
            StateReason: ec2.reason ? { Code: ec2.reason } : undefined,
          }] }] };
        }
        if (hibernate && ec2.refuseHibernate) {
          throw Object.assign(new Error(ec2.refuseHibernate.message), { name: ec2.refuseHibernate.name });
        }
        if (ec2.refuse) throw new Error(ec2.refuse);
        return {};
      }
    },
  };
});
const dropped: string[] = [];
vi.mock('./agentRegistry', () => ({
  dropInstanceAgent: (id: string, reason: string) => { dropped.push(`${id}: ${reason}`); return true; },
}));
vi.mock('./boxProvisioner', () => ({
  getBoxConfig: () => ({ region: 'us-east-2' }),
  awsClientConfig: () => ({ region: 'us-east-2' }),
}));

const { requestPower, sweepPowerStates, instanceStatus, PowerRequestConflict } = await import('./boxPower');

function seed(status: string, extra: Record<string, any> = {}): Instance {
  const row = {
    id: 'inst_1', name: 'box-1', userId: 'u1', kind: 'ec2', status, ec2InstanceId: 'i-0abc',
    region: null, provisioningError: null, hibernationConfigured: true, hibernatedAt: null,
    rehibernatePending: false, parkedAt: null, autoTerminatedAt: null, ...extra,
  };
  rows.set(row.id, row);
  return { ...row } as unknown as Instance;
}
const statusOf = () => rows.get('inst_1')!.status;

beforeEach(() => {
  rows.clear();
  dropped.length = 0;
  Object.assign(ec2, { state: 'running', reason: undefined, refuse: null, refuseHibernate: null, sent: [] });
  delete process.env.BOX_STOP_TIMEOUT_SECONDS;
  delete process.env.BOX_START_TIMEOUT_SECONDS;
  delete process.env.BOX_HIBERNATION_REFRESH_DAYS;
});

describe('requestPower', () => {
  it('writes stopping before asking EC2 to stop, and clears an old error', async () => {
    const box = seed('ready', { provisioningError: 'Stop did not complete' });
    await expect(requestPower(box, 'stop')).resolves.toBe('stopping');
    expect(statusOf()).toBe('stopping');
    expect(rows.get('inst_1')!.provisioningError).toBe(null);
    expect(ec2.sent).toEqual(['StopInstances']);
  });

  it('writes starting and asks EC2 to start', async () => {
    await expect(requestPower(seed('stopped'), 'start')).resolves.toBe('starting');
    expect(statusOf()).toBe('starting');
    expect(ec2.sent).toEqual(['StartInstances']);
  });

  it("an owner's start restarts the idle clock and clears the parked state in the same write", async () => {
    const parkedAt = new Date('2026-10-01T00:00:00Z');
    const box = seed('hibernated', { parkedAt, lifecycleNote: 'Auto-parked', lastActivityAt: parkedAt });
    await expect(requestPower(box, 'start', { markInUse: true })).resolves.toBe('starting');
    expect(rows.get('inst_1')).toMatchObject({ status: 'starting', parkedAt: null, lifecycleNote: null });
    expect(rows.get('inst_1')!.lastActivityAt.getTime()).toBeGreaterThan(parkedAt.getTime());
  });

  it('a refused start puts the parked state back with the status', async () => {
    const parkedAt = new Date('2026-10-01T00:00:00Z');
    ec2.refuse = 'InsufficientInstanceCapacity';
    await expect(requestPower(seed('stopped', { parkedAt, lifecycleNote: 'Auto-parked', lastActivityAt: parkedAt }), 'start', { markInUse: true }))
      .rejects.toThrow('InsufficientInstanceCapacity');
    expect(rows.get('inst_1')).toMatchObject({ status: 'stopped', parkedAt, lifecycleNote: 'Auto-parked', lastActivityAt: parkedAt });
  });

  it('refuses a start on a box the lifecycle sweep has claimed for terminate', async () => {
    const box = seed('hibernated');
    rows.get('inst_1')!.autoTerminatedAt = new Date();
    await expect(requestPower(box, 'start', { markInUse: true })).rejects.toBeInstanceOf(PowerRequestConflict);
    expect(statusOf()).toBe('hibernated');
    expect(ec2.sent).toEqual([]);
  });

  it('puts the status back when EC2 refuses', async () => {
    ec2.refuse = 'IncorrectInstanceState';
    await expect(requestPower(seed('ready'), 'stop')).rejects.toThrow('IncorrectInstanceState');
    expect(statusOf()).toBe('ready');
  });

  it('does nothing when the row moved since it was read (e.g. terminated meanwhile)', async () => {
    const stale = seed('ready');
    rows.get('inst_1')!.status = 'terminated';
    await expect(requestPower(stale, 'stop')).rejects.toBeInstanceOf(PowerRequestConflict);
    expect(statusOf()).toBe('terminated');
    expect(ec2.sent).toEqual([]);
  });
});

describe('requestPower hibernate', () => {
  const notReady = { name: 'UnsupportedOperation', message: 'Instance is not ready to hibernate yet, please try again later.' };

  it('writes hibernating and asks EC2 to stop with Hibernate', async () => {
    await expect(requestPower(seed('ready'), 'hibernate')).resolves.toBe('hibernating');
    expect(statusOf()).toBe('hibernating');
    expect(ec2.sent).toEqual(['StopInstances(Hibernate)']);
  });

  it('falls back to a plain stop when EC2 refuses the hibernate, and says so on the row', async () => {
    ec2.refuseHibernate = notReady;
    await expect(requestPower(seed('ready'), 'hibernate')).resolves.toBe('stopping');
    expect(statusOf()).toBe('stopping');
    expect(ec2.sent).toEqual(['StopInstances(Hibernate)', 'StopInstances']);
    expect(rows.get('inst_1')!.provisioningError).toMatch(/would not hibernate this box \(Instance is not ready to hibernate yet/);
    ec2.state = 'stopped';
    await sweepPowerStates();
    expect(statusOf()).toBe('stopped');
    expect(rows.get('inst_1')!.provisioningError).toMatch(/stopped instead/);
  });

  it('can put the status back instead of falling back, for the refresh to retry', async () => {
    ec2.refuseHibernate = notReady;
    await expect(requestPower(seed('ready', { rehibernatePending: true }), 'hibernate', { onHibernateRefused: 'throw' }))
      .rejects.toThrow(/not ready to hibernate/);
    expect(statusOf()).toBe('ready');
    expect(rows.get('inst_1')!.rehibernatePending).toBe(true);
    expect(ec2.sent).toEqual(['StopInstances(Hibernate)']);
  });

  it('does not fall back on a failure that would also stop a plain stop', async () => {
    ec2.refuse = 'UnauthorizedOperation';
    await expect(requestPower(seed('ready'), 'hibernate')).rejects.toThrow('UnauthorizedOperation');
    expect(statusOf()).toBe('ready');
  });

  it('settles hibernating to hibernated and stamps when, then resumes it with a start', async () => {
    await requestPower(seed('ready'), 'hibernate');
    ec2.state = 'stopped';
    ec2.reason = 'Client.UserInitiatedHibernate';
    const now = Date.now();
    await sweepPowerStates(now);
    expect(statusOf()).toBe('hibernated');
    expect(rows.get('inst_1')!.hibernatedAt).toEqual(new Date(now));
    // The frozen agent's socket can outlive the hibernate; only a redial after
    // the resume makes the box ready, so it is dropped on both sides of it.
    expect(dropped).toEqual(['inst_1: hibernated']);
    await expect(requestPower({ ...rows.get('inst_1') } as Instance, 'start')).resolves.toBe('starting');
    expect(dropped).toEqual(['inst_1: hibernated', 'inst_1: resuming from hibernation']);
    expect(ec2.sent.at(-1)).toBe('StartInstances');
    // Kept until the box is powered down again, so a resume that doesn't take
    // goes back to hibernated rather than stopped.
    expect(rows.get('inst_1')!.hibernatedAt).toEqual(new Date(now));
    await sweepPowerStates(now + 120_000);
    expect(statusOf()).toBe('hibernated');
  });
});

describe('parked clock', () => {
  it('stamps parkedAt on the first settle to hibernated and keeps it through a later one', async () => {
    await requestPower(seed('ready'), 'hibernate');
    ec2.state = 'stopped';
    ec2.reason = 'Client.UserInitiatedHibernate';
    const now = Date.now();
    await sweepPowerStates(now);
    expect(rows.get('inst_1')!.parkedAt).toEqual(new Date(now));

    // The 60-day refresh resumes and re-hibernates: hibernatedAt restarts, parkedAt does not.
    rows.get('inst_1')!.status = 'ready';
    await requestPower({ ...rows.get('inst_1') } as Instance, 'hibernate');
    await sweepPowerStates(now + 60_000);
    expect(rows.get('inst_1')!.hibernatedAt).toEqual(new Date(now + 60_000));
    expect(rows.get('inst_1')!.parkedAt).toEqual(new Date(now));
  });

  it('leaves parkedAt alone on a plain stop', async () => {
    await requestPower(seed('ready'), 'stop');
    ec2.state = 'stopped';
    await sweepPowerStates();
    expect(statusOf()).toBe('stopped');
    expect(rows.get('inst_1')!.parkedAt).toBe(null);
  });
});

describe('60-day hibernation refresh', () => {
  const day = 24 * 60 * 60 * 1000;

  it('resumes a box hibernated past the refresh age, then hibernates it again once it is ready', async () => {
    const now = Date.now();
    seed('hibernated', { hibernatedAt: new Date(now - 56 * day) });
    ec2.state = 'stopped';
    await sweepPowerStates(now);
    expect(statusOf()).toBe('starting');
    expect(rows.get('inst_1')!.rehibernatePending).toBe(true);
    expect(ec2.sent).toContain('StartInstances');

    rows.get('inst_1')!.status = 'ready'; // the agent's connect
    ec2.state = 'running';
    ec2.sent = [];
    await sweepPowerStates(now + 10_000);
    expect(statusOf()).toBe('hibernating');
    expect(rows.get('inst_1')!.rehibernatePending).toBe(false);
    expect(ec2.sent).toEqual(['StopInstances(Hibernate)']);
  });

  it('leaves a younger hibernation alone, and does nothing when the refresh is off', async () => {
    const now = Date.now();
    seed('hibernated', { hibernatedAt: new Date(now - 54 * day) });
    await sweepPowerStates(now);
    expect(statusOf()).toBe('hibernated');
    process.env.BOX_HIBERNATION_REFRESH_DAYS = '0';
    rows.get('inst_1')!.hibernatedAt = new Date(now - 80 * day);
    await sweepPowerStates(now);
    expect(statusOf()).toBe('hibernated');
    expect(ec2.sent).toEqual([]);
  });

  it('retries a re-hibernate EC2 is not ready for, without stopping the box', async () => {
    seed('ready', { rehibernatePending: true });
    ec2.refuseHibernate = { name: 'UnsupportedOperation', message: 'Instance is not ready to hibernate yet' };
    await sweepPowerStates();
    await sweepPowerStates();
    expect(statusOf()).toBe('ready');
    expect(rows.get('inst_1')!.rehibernatePending).toBe(true);
    expect(ec2.sent).toEqual(['StopInstances(Hibernate)', 'StopInstances(Hibernate)']);
    ec2.refuseHibernate = null;
    await sweepPowerStates();
    expect(statusOf()).toBe('hibernating');
  });

  it("a user's own stop cancels the pending re-hibernate", async () => {
    const box = seed('ready', { rehibernatePending: true });
    await requestPower(box, 'stop');
    expect(rows.get('inst_1')!.rehibernatePending).toBe(false);
  });
});

describe('sweepPowerStates', () => {
  it('settles a stop once EC2 reports stopped', async () => {
    await requestPower(seed('ready'), 'stop');
    ec2.state = 'stopping';
    await sweepPowerStates();
    expect(statusOf()).toBe('stopping');
    ec2.state = 'stopped';
    await sweepPowerStates();
    expect(statusOf()).toBe('stopped');
  });

  // The request time is in memory, so a box found mid-stop after an
  // orchestrator restart still settles to stopped straight away...
  it('settles a stopping box it has no request time for', async () => {
    seed('stopping');
    ec2.state = 'stopped';
    await sweepPowerStates();
    expect(statusOf()).toBe('stopped');
  });

  // ...and only its timeout starts over.
  it('times a stop out from when the sweep first saw it', async () => {
    process.env.BOX_STOP_TIMEOUT_SECONDS = '60';
    seed('stopping', { id: 'inst_1' });
    const t0 = Date.now() + 3_600_000;
    await sweepPowerStates(t0);
    expect(statusOf()).toBe('stopping');
    await sweepPowerStates(t0 + 60_000);
    expect(statusOf()).toBe('ready');
    expect(rows.get('inst_1')!.provisioningError).toMatch(/Stop did not complete/);
  });

  it('reports a start whose agent never connects, keeping the box stoppable', async () => {
    process.env.BOX_START_TIMEOUT_SECONDS = '120';
    await requestPower(seed('stopped'), 'start');
    await sweepPowerStates(Date.now() + 119_000);
    expect(rows.get('inst_1')!.provisioningError).toBe(null);
    await sweepPowerStates(Date.now() + 121_000);
    expect(statusOf()).toBe('starting');
    expect(rows.get('inst_1')!.provisioningError).toMatch(/agent has not connected after 2 minutes/);
    await expect(requestPower({ ...rows.get('inst_1') } as Instance, 'stop')).resolves.toBe('stopping');
  });

  it('does not write over a box whose agent connected during the describe', async () => {
    await requestPower(seed('stopped'), 'start');
    ec2.state = 'stopped';
    const describe = sweepPowerStates(Date.now() + 120_000);
    rows.get('inst_1')!.status = 'ready';
    await describe;
    expect(statusOf()).toBe('ready');
  });

  it('leaves settled boxes alone', async () => {
    seed('ready');
    await sweepPowerStates();
    expect(ec2.sent).toEqual([]);
  });
});

describe('instanceStatus', () => {
  it("reads the box's status, and null with no box or no row", async () => {
    seed('stopping');
    await expect(instanceStatus('inst_1')).resolves.toBe('stopping');
    await expect(instanceStatus('inst_missing')).resolves.toBe(null);
    await expect(instanceStatus(null)).resolves.toBe(null);
  });
});
