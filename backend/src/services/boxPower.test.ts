import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '@prisma/client';

// An in-memory Instance table with Prisma's updateMany/findMany semantics for
// the where shapes boxPower uses.
const rows = new Map<string, Record<string, any>>();
// box_events rows, for the resize lock's relation filter (boxEvents: { none }).
const boxEventRows: Array<Record<string, any>> = [];
const matches = (row: Record<string, any>, where: Record<string, any>): boolean => Object.entries(where).every(([k, v]) => {
  if (k === 'boxEvents') return !boxEventRows.some(e => e.boxId === row.id && matches(e, v.none));
  if (k === 'OR') return (v as Record<string, any>[]).some(w => matches(row, w));
  if (k === 'NOT') return !matches(row, v);
  if (v && typeof v === 'object' && !(v instanceof Date) && 'lt' in v) return row[k] instanceof Date && row[k] < v.lt;
  if (v && typeof v === 'object' && !(v instanceof Date) && 'not' in v && v.not === null) return row[k] != null;
  if (v && typeof v === 'object' && 'gte' in v) return row[k] instanceof Date && row[k] >= v.gte;
  if (v === null) return row[k] == null;
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
      findMany: async ({ where, include }: any) => [...rows.values()].filter(r => matches(r, where))
        .map(r => (include?.user ? { ...r, user: { id: r.userId, unixUsername: 'zane' } } : { ...r })),
      findUnique: async ({ where }: any) => (rows.has(where.id) ? { ...rows.get(where.id) } : null),
      count: async ({ where }: any) => [...rows.values()].filter(r => matches(r, where)).length,
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

// The type walk is boxStartFallback.test.ts's; here it rethrows unless a test says it started.
const fallback = { calls: [] as Array<{ status: string; refusal: string }>, startsOn: null as string | null };
vi.mock('./boxStartFallback', () => ({
  startOnFallbackType: async (_ec2: unknown, instance: Instance, refusal: unknown) => {
    fallback.calls.push({ status: instance.status, refusal: (refusal as Error).message });
    if (!fallback.startsOn) throw refusal;
    return fallback.startsOn;
  },
}));

const events: Array<{ name: string; ctx: any; detail: any }> = [];
vi.mock('./productEvents', () => ({ recordProductEvent: (name: string, ctx: any, detail: any) => { events.push({ name, ctx, detail }); } }));

const { onAutoParkSettled, powerRequestedAt, requestPower, sweepPowerStates, instanceStatus, PowerRequestConflict } = await import('./boxPower');
const { boxStartWatchForTests, resetBoxStartsForTests } = await import('./boxStartLatency');
const { resetSleepWatchesForTests } = await import('./boxPowerEvents');
const { connectUpdate } = await import('./instanceLifecycle');

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
  resetBoxStartsForTests();
  resetSleepWatchesForTests();
  events.length = 0;
  Object.assign(ec2, { state: 'running', reason: undefined, refuse: null, refuseHibernate: null, sent: [] });
  Object.assign(fallback, { calls: [], startsOn: null });
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

  it('refuses to start a quarantined box, whoever asks, and leaves the row and EC2 alone', async () => {
    const box = seed('quarantined');
    await expect(requestPower(box, 'start', { markInUse: true })).rejects.toBeInstanceOf(PowerRequestConflict);
    expect(statusOf()).toBe('quarantined');
    expect(ec2.sent).toEqual([]);
  });

  it('writes starting and asks EC2 to start', async () => {
    await expect(requestPower(seed('stopped'), 'start')).resolves.toBe('starting');
    expect(statusOf()).toBe('starting');
    expect(ec2.sent).toEqual(['StartInstances']);
    expect(boxStartWatchForTests('inst_1')).toMatchObject({ from: 'stop', source: 'user', userId: 'u1' });
  });

  it("an owner's start restarts the idle clock and clears the parked state in the same write", async () => {
    const parkedAt = new Date('2026-10-01T00:00:00Z');
    const box = seed('hibernated', { parkedAt, lifecycleNote: 'Auto-parked', lastActivityAt: parkedAt });
    await expect(requestPower(box, 'start', { markInUse: true })).resolves.toBe('starting');
    expect(rows.get('inst_1')).toMatchObject({ status: 'starting', parkedAt: null, lifecycleNote: null });
    expect(rows.get('inst_1')!.lastActivityAt.getTime()).toBeGreaterThan(parkedAt.getTime());
  });

  it("a reviewer's wake restarts the idle clock, but keeps the box's terminate clock and its idle note", async () => {
    const parkedAt = new Date('2026-10-01T00:00:00Z');
    const box = seed('hibernated', { parkedAt, lifecycleNote: 'Hibernated automatically after 2 h idle.', lastActivityAt: parkedAt });
    await expect(requestPower(box, 'start', { guestWake: true })).resolves.toBe('starting');
    // The note stays too: a resume that doesn't take settles back still marked as the sweep's.
    expect(rows.get('inst_1')).toMatchObject({ status: 'starting', parkedAt, lifecycleNote: 'Hibernated automatically after 2 h idle.' });
    expect(rows.get('inst_1')!.lastActivityAt.getTime()).toBeGreaterThan(parkedAt.getTime());
  });

  it("the owner's own hibernate drops an idle note left from before; the sweep's and the refresh's keep it", async () => {
    const note = 'Hibernated automatically after 2 h idle.';
    await requestPower(seed('ready', { lifecycleNote: note }), 'hibernate', { byOwner: true });
    expect(rows.get('inst_1')!.lifecycleNote).toBeNull();
    await requestPower(seed('ready', { lifecycleNote: note }), 'hibernate', { onHibernateRefused: 'throw' });
    expect(rows.get('inst_1')!.lifecycleNote).toBe(note);
  });

  it("the lifecycle sweep's park moves only while the idle clock is the one it decided on", async () => {
    const decidedOn = new Date('2026-10-01T00:00:00Z');
    const box = seed('ready', { lastActivityAt: decidedOn });
    rows.get('inst_1')!.lastActivityAt = new Date('2026-10-01T00:05:00Z');
    await expect(requestPower(box, 'stop', { expectLastActivityAt: decidedOn })).rejects.toBeInstanceOf(PowerRequestConflict);
    expect(statusOf()).toBe('ready');
    expect(ec2.sent).toEqual([]);
    rows.get('inst_1')!.lastActivityAt = decidedOn;
    await expect(requestPower(box, 'stop', { expectLastActivityAt: decidedOn })).resolves.toBe('stopping');
  });

  it('keeps the age of a start when a stop of the starting box is refused', async () => {
    const box = seed('starting');
    await requestPower(seed('stopped'), 'start');
    const started = powerRequestedAt('inst_1');
    rows.get('inst_1')!.status = 'starting';
    ec2.refuse = 'RequestLimitExceeded';
    await expect(requestPower({ ...box, status: 'starting' } as Instance, 'stop')).rejects.toThrow();
    expect(powerRequestedAt('inst_1')).toBe(started);
    ec2.refuse = null;
  });

  it("writes the sweep's note and autoParkedAt with the status, and puts them back when EC2 refuses", async () => {
    const parkedAt = new Date('2026-10-01T00:00:00Z');
    const andSet = { lifecycleNote: 'Stopped automatically after 2 h idle.', autoParkedAt: parkedAt };
    await requestPower(seed('ready', { idleHibernateHours: null }), 'stop', { expectIdleHibernateHours: null, andSet });
    expect(rows.get('inst_1')).toMatchObject({ status: 'stopping', ...andSet });
    ec2.refuse = 'RequestLimitExceeded';
    await expect(requestPower(seed('ready', { idleHibernateHours: null, lifecycleNote: null, autoParkedAt: null }), 'stop', { andSet })).rejects.toThrow();
    expect(rows.get('inst_1')).toMatchObject({ status: 'ready', lifecycleNote: null, autoParkedAt: null });
    ec2.refuse = null;
    await expect(requestPower(seed('ready', { idleHibernateHours: 8 }), 'stop', { expectIdleHibernateHours: null, andSet }))
      .rejects.toBeInstanceOf(PowerRequestConflict);
  });

  it('every start clears a warning from before the box went down', async () => {
    const warning = { idleWarnedAt: new Date('2026-10-01T00:00:00Z'), idleParkAt: new Date('2026-10-01T01:00:00Z') };
    await requestPower(seed('stopped', warning), 'start', { startedBy: 'automation' });
    expect(rows.get('inst_1')).toMatchObject({ status: 'starting', idleWarnedAt: null, idleParkAt: null });
  });

  it("an owner's start clears the sweep's auto-park, and a refused one puts it back", async () => {
    const autoParkedAt = new Date('2026-10-01T00:00:00Z');
    await requestPower(seed('stopped', { autoParkedAt }), 'start', { markInUse: true });
    expect(rows.get('inst_1')!.autoParkedAt).toBe(null);
    ec2.refuse = 'InsufficientInstanceCapacity';
    await expect(requestPower(seed('stopped', { autoParkedAt }), 'start', { markInUse: true })).rejects.toThrow();
    expect(rows.get('inst_1')!.autoParkedAt).toEqual(autoParkedAt);
  });

  it('a refused start puts the parked state back with the status', async () => {
    const parkedAt = new Date('2026-10-01T00:00:00Z');
    ec2.refuse = 'InsufficientInstanceCapacity';
    await expect(requestPower(seed('stopped', { parkedAt, lifecycleNote: 'Auto-parked', lastActivityAt: parkedAt }), 'start', { markInUse: true }))
      .rejects.toThrow('InsufficientInstanceCapacity');
    expect(rows.get('inst_1')).toMatchObject({ status: 'stopped', parkedAt, lifecycleNote: 'Auto-parked', lastActivityAt: parkedAt });
    expect(boxStartWatchForTests('inst_1')).toBeUndefined();
  });

  it('a start EC2 refuses goes to the type fallback, and starting holds when that starts it', async () => {
    ec2.refuse = 'InsufficientInstanceCapacity';
    fallback.startsOn = 'm7g.2xlarge';
    await expect(requestPower(seed('stopped'), 'start', { markInUse: true })).resolves.toBe('starting');
    expect(fallback.calls).toEqual([{ status: 'stopped', refusal: 'InsufficientInstanceCapacity' }]);
    expect(statusOf()).toBe('starting');
    expect(boxStartWatchForTests('inst_1')).toBeDefined();
  });

  it("a resize's own start never goes to the type fallback: the resize walks its own types", async () => {
    ec2.refuse = 'InsufficientInstanceCapacity';
    fallback.startsOn = 'm7g.2xlarge';
    await expect(requestPower(seed('stopped'), 'start', { forResize: true })).rejects.toThrow('InsufficientInstanceCapacity');
    expect(fallback.calls).toEqual([]);
    expect(statusOf()).toBe('stopped');
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

  it('tells the lifecycle sweep when a box it parked settles, with what EC2 actually did', async () => {
    const settled: string[] = [];
    onAutoParkSettled((box, status) => { settled.push(`${box.id}:${status}`); });
    try {
      seed('stopping', { autoParkedAt: new Date() });
      ec2.state = 'stopped';
      await sweepPowerStates();
      expect(settled).toEqual(['inst_1:stopped']);
      // A stop nobody automatic asked for says nothing.
      seed('stopping');
      await sweepPowerStates();
      expect(settled).toEqual(['inst_1:stopped']);
    } finally {
      onAutoParkSettled(null);
    }
  });

  it("arms box.resumed with who the start is for: the caller's, else owner for markInUse and guest for guestWake", async () => {
    await requestPower(seed('stopped', { autoParkedAt: new Date(Date.now() - 90 * 60_000) }), 'start', { markInUse: true });
    expect(boxStartWatchForTests('inst_1')).toMatchObject({ by: 'owner', parkedMinutes: 90 });
    await requestPower(seed('stopped'), 'start', { startedBy: 'automation' });
    expect(boxStartWatchForTests('inst_1')).toMatchObject({ by: 'automation', parkedMinutes: null });
    await requestPower(seed('hibernated'), 'start', { guestWake: true });
    expect(boxStartWatchForTests('inst_1')).toMatchObject({ by: 'guest' });
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
    expect(boxStartWatchForTests('inst_1')).toMatchObject({ from: 'hibernate', source: 'user' });
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

  it("stamps parkedAt when the lifecycle sweep's stop settles, the terminate clock the sweep reads", async () => {
    await requestPower(seed('ready'), 'stop', { andSet: { autoParkedAt: new Date() } });
    ec2.state = 'stopped';
    const now = Date.now();
    await sweepPowerStates(now);
    expect(statusOf()).toBe('stopped');
    expect(rows.get('inst_1')!.parkedAt).toEqual(new Date(now));
  });
});

describe('60-day hibernation refresh', () => {
  const day = 24 * 60 * 60 * 1000;

  it('resumes a box hibernated past the refresh age, then stops it once it is ready, keeping its parked clock', async () => {
    const now = Date.now();
    const parkedAt = new Date(now - 56 * day);
    seed('hibernated', { hibernatedAt: parkedAt, parkedAt });
    ec2.state = 'stopped';
    await sweepPowerStates(now);
    expect(statusOf()).toBe('starting');
    expect(rows.get('inst_1')!.rehibernatePending).toBe(true);
    expect(ec2.sent).toContain('StartInstances');
    expect(boxStartWatchForTests('inst_1')).toMatchObject({ from: 'hibernate', source: 'sweep' });

    rows.get('inst_1')!.status = 'ready'; // the agent's connect
    ec2.state = 'running';
    ec2.sent = [];
    await sweepPowerStates(now + 10_000);
    expect(statusOf()).toBe('stopping');
    expect(rows.get('inst_1')!.rehibernatePending).toBe(false);
    expect(ec2.sent).toEqual(['StopInstances']);
    ec2.state = 'stopped';
    await sweepPowerStates(now + 20_000);
    expect(statusOf()).toBe('stopped');
    expect(rows.get('inst_1')).toMatchObject({ rehibernatePending: false, parkedAt });
  });

  it("drops the auto-hibernate note when the refresh stops the box, since its memory is gone (Bugbot on #766)", async () => {
    const now = Date.now();
    seed('ready', {
      rehibernatePending: true, hibernatedAt: new Date(now - 56 * day), parkedAt: new Date(now - 56 * day),
      lifecycleNote: 'Hibernated automatically after 1 h idle. Start it to resume where you left off.',
    });
    await sweepPowerStates(now);
    expect(statusOf()).toBe('stopping');
    expect(rows.get('inst_1')!.lifecycleNote).toMatch(/^Stopped by the 60-day hibernation refresh/);
    expect(rows.get('inst_1')!.lifecycleNote).not.toMatch(/resume where you left off/);
  });

  it("leaves the note of a box its owner hibernated by hand alone, so a reviewer can't take the refresh's stop for the sweep's", async () => {
    const now = Date.now();
    seed('ready', { rehibernatePending: true, hibernatedAt: new Date(now - 56 * day), parkedAt: new Date(now - 56 * day), lifecycleNote: null });
    await sweepPowerStates(now);
    expect(statusOf()).toBe('stopping');
    expect(rows.get('inst_1')!.lifecycleNote).toBe(null);
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

  it("forgets the sweep's auto-park when its stop times out back to ready: the box was never parked", async () => {
    process.env.BOX_STOP_TIMEOUT_SECONDS = '60';
    seed('stopping', { id: 'inst_1', autoParkedAt: new Date() });
    const t0 = Date.now() + 3_600_000;
    await sweepPowerStates(t0);
    await sweepPowerStates(t0 + 60_000);
    expect(rows.get('inst_1')).toMatchObject({ status: 'ready', autoParkedAt: null });
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

describe('box.sleep events', () => {
  const sleeps = () => events.filter(e => e.name.startsWith('box.sleep.')).map(e => [e.name, e.detail]);

  it("records the owner's stop with who asked and the box's dimensions, then its settle, timed from the request", async () => {
    const box = seed('ready', { region: 'us-east-2', imageId: 'ami-1', imageSource: 'published', claimedAt: new Date(), parentInstanceId: null });
    await requestPower(box, 'stop', { byOwner: true });
    ec2.state = 'stopped';
    const now = Date.now() + 42_000;
    await sweepPowerStates(now);
    expect(statusOf()).toBe('stopped');
    const dims = { boxKind: 'ec2', region: 'us-east-2', imageId: 'ami-1', imageSource: 'published', hibernationConfigured: true, fromPool: true, child: false };
    expect(sleeps()).toEqual([
      ['box.sleep.requested', { action: 'stop', fellBackToStop: false, by: 'owner', ...dims }],
      ['box.sleep.settled', { action: 'stop', outcome: 'stopped', by: 'owner', settleSec: expect.any(Number), ...dims }],
    ]);
    expect((sleeps()[1][1] as { settleSec: number }).settleSec).toBeGreaterThanOrEqual(41);
    expect((sleeps()[1][1] as { settleSec: number }).settleSec).toBeLessThanOrEqual(43);
    expect(events.find(e => e.name === 'box.sleep.settled')!.ctx).toEqual({ user: 'u1', box: 'inst_1' });
    // The down clock box.resumed reads.
    expect(rows.get('inst_1')!.downSince).toEqual(new Date(now));
  });

  it('says a hibernate EC2 refused fell back to a stop, and that it settled stopped', async () => {
    ec2.refuseHibernate = { name: 'UnsupportedHibernationConfiguration', message: 'not ready to hibernate' };
    await expect(requestPower(seed('ready'), 'hibernate', { sleepBy: 'idle' })).resolves.toBe('stopping');
    ec2.state = 'stopped';
    await sweepPowerStates(Date.now());
    expect(sleeps().map(([name, d]) => [name, (d as any).action, (d as any).fellBackToStop ?? (d as any).outcome, (d as any).by])).toEqual([
      ['box.sleep.requested', 'hibernate', true, 'idle'],
      ['box.sleep.settled', 'hibernate', 'stopped', 'idle'],
    ]);
  });

  it('records a stop or hibernate that timed out back to ready as failed, and stamps no down clock', async () => {
    process.env.BOX_STOP_TIMEOUT_SECONDS = '1';
    await requestPower(seed('ready'), 'hibernate', { sleepBy: 'idle' });
    ec2.state = 'running';
    await sweepPowerStates(Date.now() + 5_000);
    expect(statusOf()).toBe('ready');
    expect(sleeps().map(([name, d]) => [name, (d as any).outcome])).toEqual([['box.sleep.requested', undefined], ['box.sleep.settled', 'failed']]);
    expect(rows.get('inst_1')!.downSince ?? null).toBeNull();
  });

  it('settles a box whose request this process never saw, without who asked or a time', async () => {
    seed('hibernating');
    ec2.state = 'stopped';
    await sweepPowerStates(Date.now());
    expect(sleeps()).toEqual([['box.sleep.settled', expect.objectContaining({ action: 'hibernate', outcome: 'hibernated', by: null, settleSec: null })]]);
  });

  it('records nothing for a request EC2 refused, and a later settle has no stale clock', async () => {
    ec2.refuse = 'InsufficientInstanceCapacity';
    await expect(requestPower(seed('ready'), 'stop', { byOwner: true })).rejects.toThrow();
    expect(sleeps()).toEqual([]);
    rows.get('inst_1')!.status = 'stopping';
    ec2.state = 'stopped';
    await sweepPowerStates(Date.now());
    expect(sleeps()).toEqual([['box.sleep.settled', expect.objectContaining({ by: null, settleSec: null })]]);
  });

  it("keeps the down clock through the 60-day refresh's stop, and says the refresh asked", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const downSince = new Date(now - 56 * day);
    seed('hibernated', { hibernatedAt: downSince, downSince });
    ec2.state = 'stopped';
    await sweepPowerStates(now);
    rows.get('inst_1')!.status = 'ready'; // the agent's connect
    ec2.state = 'running';
    await sweepPowerStates(now + 10_000);
    expect(statusOf()).toBe('stopping');
    ec2.state = 'stopped';
    await sweepPowerStates(now + 20_000);
    expect(statusOf()).toBe('stopped');
    expect(rows.get('inst_1')!.downSince).toEqual(downSince);
    expect(sleeps().map(([name, d]) => [name, (d as any).by])).toEqual([['box.sleep.requested', 'refresh'], ['box.sleep.settled', 'refresh']]);
  });

  /** The 60-day refresh end to end: resume, the agent's connect (the real connectUpdate), its stop, settle. */
  async function refresh(now: number, between?: () => void) {
    ec2.state = 'stopped';
    await sweepPowerStates(now);
    expect(statusOf()).toBe('starting');
    connect();
    ec2.state = 'running';
    await sweepPowerStates(now + 10_000);
    expect(statusOf()).toBe('stopping');
    between?.();
    ec2.state = 'stopped';
    await sweepPowerStates(now + 20_000);
    expect(statusOf()).toBe('stopped');
  }
  function connect() {
    const { where, data } = connectUpdate(rows.get('inst_1') as Instance, new Date());
    const row = rows.get('inst_1')!;
    if (row.status === where.status) Object.assign(row, data);
  }

  it('keeps the original time down for a box hibernated before downSince existed, from hibernatedAt (Bugbot on #731)', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const hibernatedAt = new Date(now - 56 * day);
    seed('hibernated', { hibernatedAt, downSince: null });
    await refresh(now);
    expect(rows.get('inst_1')!.downSince).toEqual(hibernatedAt);
  });

  it('keeps the down clock when the refresh\'s stop settles in a process that never saw the request (Bugbot on #731)', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const downSince = new Date(now - 56 * day);
    seed('hibernated', { hibernatedAt: downSince, downSince });
    // A restart, or another orchestrator settling it: no in-memory request.
    await refresh(now, () => resetSleepWatchesForTests());
    expect(rows.get('inst_1')!.downSince).toEqual(downSince);
  });

  /** The refresh up to its stop request: resumed, its agent connected. */
  async function refreshUp(now: number, downSince: Date) {
    seed('hibernated', { hibernatedAt: downSince, downSince });
    ec2.state = 'stopped';
    await sweepPowerStates(now);
    connect();
    expect(rows.get('inst_1')).toMatchObject({ status: 'ready', rehibernatePending: true, downSince });
  }
  const day = 24 * 60 * 60 * 1000;
  /** The row as a caller reads it: a copy, as Prisma returns, not the live mock row. */
  const current = () => ({ ...rows.get('inst_1') }) as unknown as Instance;

  it('ends the down clock when the refresh\'s stop times out back to ready: the box is up for use (Bugbot on #731)', async () => {
    const now = Date.now();
    await refreshUp(now, new Date(now - 56 * day));
    ec2.state = 'running';
    await sweepPowerStates(now + 10_000);
    expect(statusOf()).toBe('stopping');
    process.env.BOX_STOP_TIMEOUT_SECONDS = '1';
    await sweepPowerStates(Date.now() + 5_000);
    expect(rows.get('inst_1')).toMatchObject({ status: 'ready', rehibernatePending: false, downSince: null });
    // The next stop starts a clock of its own.
    await requestPower(current(), 'stop', { byOwner: true });
    ec2.state = 'stopped';
    const later = Date.now() + 60_000;
    await sweepPowerStates(later);
    expect(rows.get('inst_1')!.downSince).toEqual(new Date(later));
  });

  it('keeps the down clock when the refresh\'s resume does not take, or its agent never comes and the box is stopped from starting', async () => {
    const now = Date.now();
    const downSince = new Date(now - 56 * day);
    seed('hibernated', { hibernatedAt: downSince, downSince });
    ec2.state = 'stopped';
    await sweepPowerStates(now);
    expect(statusOf()).toBe('starting');
    // EC2 still reports it stopped a while later: the start didn't take. (The
    // refresh is off for this sweep, or it would start the box again at once.)
    process.env.BOX_HIBERNATION_REFRESH_DAYS = '0';
    await sweepPowerStates(now + 5 * 60_000);
    expect(rows.get('inst_1')).toMatchObject({ status: 'hibernated', downSince });

    const box = seed('starting', { hibernatedAt: downSince, downSince, rehibernatePending: true });
    await requestPower(box, 'stop', { sleepBy: 'stuck-start' });
    await sweepPowerStates(Date.now() + 1_000);
    expect(rows.get('inst_1')).toMatchObject({ status: 'stopped', downSince });
  });

  it("ends the down clock when the owner stops a box during the refresh's up window, and puts it back if EC2 refuses", async () => {
    const now = Date.now();
    const downSince = new Date(now - 56 * day);
    await refreshUp(now, downSince);
    ec2.refuse = 'InsufficientInstanceCapacity';
    await expect(requestPower(current(), 'stop', { byOwner: true })).rejects.toThrow();
    expect(rows.get('inst_1')).toMatchObject({ status: 'ready', rehibernatePending: true, downSince });
    ec2.refuse = null;
    await requestPower(current(), 'stop', { byOwner: true });
    expect(rows.get('inst_1')).toMatchObject({ status: 'stopping', rehibernatePending: false, downSince: null });
    ec2.state = 'stopped';
    const later = Date.now() + 1_000;
    await sweepPowerStates(later);
    expect(rows.get('inst_1')!.downSince).toEqual(new Date(later));
  });

  it("ends the down clock when the owner used the box during the refresh's up window, even though the refresh stops it", async () => {
    const now = Date.now();
    await refreshUp(now, new Date(now - 56 * day));
    rows.get('inst_1')!.lastActivityAt = new Date(rows.get('inst_1')!.lastReadyAt.getTime() + 1_000);
    ec2.state = 'running';
    await sweepPowerStates(now + 10_000);
    expect(rows.get('inst_1')).toMatchObject({ status: 'stopping', downSince: null });
    ec2.state = 'stopped';
    const later = now + 20_000;
    await sweepPowerStates(later);
    expect(rows.get('inst_1')!.downSince).toEqual(new Date(later));
  });

  it('keeps the down clock across a restart in the refresh\'s up window', async () => {
    const now = Date.now();
    const downSince = new Date(now - 56 * day);
    await refreshUp(now, downSince);
    resetSleepWatchesForTests(); // a new process: nothing in memory, the row says the refresh is pending
    ec2.state = 'running';
    await sweepPowerStates(now + 10_000);
    ec2.state = 'stopped';
    await sweepPowerStates(now + 20_000);
    expect(rows.get('inst_1')).toMatchObject({ status: 'stopped', downSince });
  });

  it('starts a new down clock once the box has really come up and gone down again', async () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const box = seed('stopped', { downSince: old });
    await requestPower(box, 'start', { markInUse: true });
    connect();
    expect(rows.get('inst_1')).toMatchObject({ status: 'ready', downSince: null });
    await requestPower(current(), 'stop', { byOwner: true });
    ec2.state = 'stopped';
    const now = Date.now();
    await sweepPowerStates(now);
    expect(rows.get('inst_1')!.downSince).toEqual(new Date(now));
    // A later settle (a refused start's settle back, a second stop) doesn't move a running clock.
    rows.get('inst_1')!.status = 'stopping';
    await sweepPowerStates(now + 60_000);
    expect(rows.get('inst_1')!.downSince).toEqual(new Date(now));
  });
});

describe('requestPower while a resize holds the box (an open resize row in box_events)', () => {
  const resizeRow = (over: Record<string, any> = {}) => boxEventRows.push({ boxId: 'inst_1', kind: 'resize', startedAt: new Date(), finishedAt: null, ...over });
  beforeEach(() => { boxEventRows.length = 0; });

  it('refuses everyone but the resize itself, saying why, so nothing starts a box being retyped', async () => {
    const box = seed('stopped');
    resizeRow();
    await expect(requestPower(box, 'start', { markInUse: true })).rejects.toThrow('This box is being resized; try again once that is done');
    expect(ec2.sent).toEqual([]);
    await expect(requestPower(box, 'start', { forResize: true, startedBy: 'resize' })).resolves.toBe('starting');
    expect(ec2.sent).toEqual(['StartInstances']);
  });

  it('refuses in the write itself: a request that read the box before the resize locked it does not move it', async () => {
    const before = seed('stopped');
    resizeRow();
    await expect(requestPower(before, 'start', { markInUse: true })).rejects.toBeInstanceOf(PowerRequestConflict);
    expect(statusOf()).toBe('stopped');
    expect(ec2.sent).toEqual([]);
  });

  it('a stale row (a resize cut off by a restart), a finished one, or a disk grow holds nothing', async () => {
    resizeRow({ startedAt: new Date(Date.now() - 2 * 3_600_000) });
    resizeRow({ startedAt: new Date(Date.now() - 60_000), finishedAt: new Date() });
    resizeRow({ kind: 'disk-grow' });
    await expect(requestPower(seed('stopped'), 'start')).resolves.toBe('starting');
  });
});
