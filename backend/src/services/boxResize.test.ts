import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory instances and box_events tables with the shapes boxResize uses.
const rows = new Map<string, Record<string, any>>();
const boxEvents: Array<Record<string, any>> = [];
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Record<string, any>[]).some(w => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date) && 'in' in v) return v.in.includes(row[k]);
    if (v && typeof v === 'object' && !(v instanceof Date) && 'not' in v) return (row[k] ?? null) !== v.not;
    if (v && typeof v === 'object' && !(v instanceof Date) && 'lt' in v) return row[k] instanceof Date && row[k] < v.lt;
    if (v && typeof v === 'object' && !(v instanceof Date) && 'gte' in v) return row[k] instanceof Date && row[k] >= v.gte;
    return (row[k] ?? null) === v;
  });
}
const newest = (list: Array<Record<string, any>>) => [...list].sort((a, b) => b.startedAt - a.startedAt);
let nextEvent = 0;
// One transaction at a time, as the box row's FOR UPDATE lines up two requests for one box.
let txChain: Promise<unknown> = Promise.resolve();
vi.mock('../db', () => {
  const instance = {
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of rows.values()) if (matches(row, where)) { Object.assign(row, data); count++; }
      return { count };
    },
    update: async ({ where, data }: any) => Object.assign(rows.get(where.id)!, data),
    findUnique: async ({ where }: any) => (rows.has(where.id) ? { ...rows.get(where.id) } : null),
    findUniqueOrThrow: async ({ where }: any) => ({ ...rows.get(where.id)! }),
  };
  const boxEvent = {
    create: async ({ data }: any) => { const r = { id: `ev${++nextEvent}`, startedAt: new Date(), finishedAt: null, error: null, ...data }; boxEvents.push(r); return { ...r }; },
    update: async ({ where, data }: any) => ({ ...Object.assign(boxEvents.find(e => e.id === where.id)!, data) }),
    findUniqueOrThrow: async ({ where }: any) => ({ ...boxEvents.find(e => e.id === where.id)! }),
    findFirst: async ({ where }: any) => newest(boxEvents.filter(e => matches(e, where)))[0] ?? null,
    findMany: async ({ where, distinct }: any) => {
      const found = newest(boxEvents.filter(e => matches(e, where)));
      return distinct ? found.filter((e, i) => found.findIndex(f => f.boxId === e.boxId) === i) : found;
    },
  };
  const tx = { instance, boxEvent, $queryRaw: async () => [] };
  return {
    prisma: {
      instance, boxEvent,
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => {
        const run = txChain.then(() => fn(tx));
        txChain = run.catch(() => {});
        return run;
      },
    },
  };
});

const ec2 = { dryRun: 'DryRunOperation', describeFails: false, sent: [] as string[] };
vi.mock('@aws-sdk/client-ec2', () => {
  const command = (name: string) => class { constructor(public input: any) {} name = name; };
  return {
    DescribeInstancesCommand: command('DescribeInstances'),
    DescribeInstanceTypeOfferingsCommand: command('DescribeInstanceTypeOfferings'),
    DescribeInstanceTypesCommand: command('DescribeInstanceTypes'),
    ModifyInstanceAttributeCommand: command('ModifyInstanceAttribute'),
    EC2Client: class {
      async send(cmd: { name: string; input: any }) {
        ec2.sent.push(cmd.input?.DryRun ? `${cmd.name}(DryRun)` : cmd.name);
        if (cmd.name === 'ModifyInstanceAttribute' && cmd.input.DryRun) {
          throw Object.assign(new Error(ec2.dryRun), { name: ec2.dryRun });
        }
        if (cmd.name === 'DescribeInstances' && ec2.describeFails) throw new Error('describe failed');
        return {};
      }
    },
  };
});
vi.mock('./boxProvisioner', async () => ({
  isCapacityRefusal: (err: unknown) => (err as Error).name === 'InsufficientInstanceCapacity',
  getBoxConfig: () => ({ region: 'us-east-2' }),
  awsClientConfig: () => ({ region: 'us-east-2' }),
  isBoxProvisioningConfigured: () => true,
}));
const power: string[] = [];
vi.mock('./boxPower', () => ({ requestPower: async (_box: unknown, action: string) => { power.push(action); return action; } }));
const busy = { checks: [] as string[], working: false };
vi.mock('./boxLifecycle', () => ({
  registerBoxBusyCheck: () => {},
  busyBoxes: async (ids: string[]) => new Map(ids.map(id => [id, busy.checks])),
  workingBoxes: () => new Set(busy.working ? ['b1'] : []),
}));
const events: Array<{ name: string; detail: any }> = [];
vi.mock('./productEvents', () => ({ recordProductEvent: (name: string, _ctx: unknown, detail: unknown) => { events.push({ name, detail }); } }));
vi.mock('./workspaceEvents', () => ({ notifyWorkspaceChange: () => {} }));

const { prismaResizeEffects, runResize, startResize } = await import('./boxResize');
const { reserveGrow } = await import('./boxDisk');
const { resizePlan } = await import('./boxResizePolicy');
type Effects = import('./boxResize').ResizeEffects;

const capacity = () => Object.assign(new Error('We currently do not have sufficient capacity'), { name: 'InsufficientInstanceCapacity' });

/** Fake effects that log every step; `startFails` lists the types EC2 has no room for. */
function fakes(opts: { type?: string; offered?: string[]; startFails?: string[]; modifyFails?: boolean } = {}) {
  const log: string[] = [];
  let type = opts.type ?? 'm8g.large';
  const fx: Effects = {
    phase: async p => { log.push(`phase:${p}`); },
    describe: async () => ({ type, zone: 'us-east-2a' }),
    offered: async types => (opts.offered ? types.filter(t => opts.offered!.includes(t)) : types),
    resume: async () => { log.push('resume'); },
    stop: async () => { log.push('stop'); },
    modify: async t => { if (opts.modifyFails) throw new Error('IncorrectInstanceState'); log.push(`modify:${t}`); type = t; },
    start: async () => { log.push(`start:${type}`); if (opts.startFails?.includes(type)) throw capacity(); },
    waitReady: async () => { log.push('ready'); },
    stopIfUp: async () => { log.push('stopIfUp'); return true; },
  };
  return { fx, log };
}

const LARGE = ['m8g.2xlarge', 'm7g.2xlarge', 'r8g.2xlarge'];

describe('runResize', () => {
  it('a running box: stopping, resizing, starting, ready, on the size\'s first type', async () => {
    const { fx, log } = fakes();
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log).toEqual(['phase:stopping', 'stop', 'phase:resizing', 'modify:m8g.2xlarge', 'phase:starting', 'start:m8g.2xlarge', 'ready', 'phase:ready']);
    expect(out).toMatchObject({ outcome: 'ready', type: 'm8g.2xlarge', fromType: 'm8g.large', resized: true, fallback: false });
  });

  it('a hibernated box is resumed, then stopped plainly, then retyped, and stays stopped', async () => {
    const { fx, log } = fakes();
    const out = await runResize(resizePlan({ status: 'hibernated', size: 'small' }, 'large', LARGE), fx);
    expect(log).toEqual(['phase:resuming', 'resume', 'phase:stopping', 'stop', 'phase:resizing', 'modify:m8g.2xlarge', 'phase:stopped']);
    expect(out).toMatchObject({ outcome: 'stopped', resized: true });
  });

  it('a stopped box is retyped and left stopped: no stop, no start', async () => {
    const { fx, log } = fakes();
    const out = await runResize(resizePlan({ status: 'stopped', size: 'small' }, 'large', LARGE), fx);
    expect(log).toEqual(['phase:resizing', 'modify:m8g.2xlarge', 'phase:stopped']);
    expect(log.some(s => s.startsWith('start'))).toBe(false);
    expect(out).toMatchObject({ outcome: 'stopped', type: 'm8g.2xlarge' });
  });

  it('no capacity for the first type: the next type of the size', async () => {
    const { fx, log } = fakes({ startFails: ['m8g.2xlarge'] });
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log).toEqual([
      'phase:stopping', 'stop',
      'phase:resizing', 'modify:m8g.2xlarge', 'phase:starting', 'start:m8g.2xlarge',
      'phase:resizing', 'modify:m7g.2xlarge', 'phase:starting', 'start:m7g.2xlarge', 'ready', 'phase:ready',
    ]);
    expect(out).toMatchObject({ outcome: 'ready', type: 'm7g.2xlarge', fallback: true, resized: true });
  });

  it('a type the zone does not offer is skipped before anything is stopped', async () => {
    const { fx, log } = fakes({ offered: ['r8g.2xlarge'] });
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log).toContain('modify:r8g.2xlarge');
    expect(log).not.toContain('modify:m8g.2xlarge');
    expect(out).toMatchObject({ outcome: 'ready', fallback: true });
  });

  it('no type of the size offered at all: fails without stopping the box', async () => {
    const { fx, log } = fakes({ offered: [] });
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log).toEqual([]);
    expect(out).toMatchObject({ outcome: 'failed', resized: false, error: expect.stringMatching(/offered/) });
  });

  it('no capacity for any type: back on its old type and running', async () => {
    const { fx, log } = fakes({ startFails: LARGE });
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log.slice(-5)).toEqual(['modify:m8g.large', 'phase:starting', 'start:m8g.large', 'ready', 'phase:failed']);
    expect(out).toMatchObject({ outcome: 'failed', reverted: true, resized: false, type: 'm8g.large', error: expect.stringMatching(/no capacity.*back on m8g\.large/) });
  });

  it('a modify EC2 refuses: a box that was running is started again on its old type', async () => {
    const { fx, log } = fakes({ modifyFails: true });
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log).toEqual(['phase:stopping', 'stop', 'phase:resizing', 'start:m8g.large', 'ready', 'phase:failed']);
    expect(out).toMatchObject({ outcome: 'failed', resized: false, error: expect.stringMatching(/IncorrectInstanceState.*started again and is running, on m8g\.large/) });
  });
});

describe('runResize of a box whose disk is growing', () => {
  it('waits for the grow before it stops the box, so the agent\'s file system step is not cut off', async () => {
    const { fx, log } = fakes();
    fx.diskGrowing = () => true;
    fx.waitDiskGrow = async () => { log.push('waitDisk'); };
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log.slice(0, 4)).toEqual(['phase:disk', 'waitDisk', 'phase:stopping', 'stop']);
    expect(out).toMatchObject({ outcome: 'ready', resized: true });
  });

  it('a grow still running at the wait\'s limit fails the resize before anything is stopped (Bugbot on #1214)', async () => {
    const { fx, log } = fakes();
    fx.diskGrowing = () => true;
    fx.waitDiskGrow = async () => { throw new Error('The disk is still growing after 30 minutes; the box was not stopped. Resize again once it has grown.'); };
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log).toEqual(['phase:disk', 'phase:failed']);
    expect(out).toMatchObject({ outcome: 'failed', resized: false, error: expect.stringMatching(/still growing.*not stopped/) });
  });

  it('skips the wait when no grow runs', async () => {
    const { fx, log } = fakes();
    fx.diskGrowing = () => false;
    fx.waitDiskGrow = async () => { log.push('waitDisk'); };
    await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log).not.toContain('phase:disk');
    expect(log).not.toContain('waitDisk');
  });
});

describe('runResize of a hibernated box that fails after its resume', () => {
  const HIB = () => resizePlan({ status: 'hibernated', size: 'small' }, 'large', LARGE);

  it('a stop that never finishes: the resumed box is stopped again, not left up', async () => {
    const { fx, log } = fakes();
    fx.stop = async () => { log.push('stop'); throw new Error('The stop did not finish within 12 minutes (the box is stopping)'); };
    const out = await runResize(HIB(), fx);
    expect(log).toEqual(['phase:resuming', 'resume', 'phase:stopping', 'stop', 'stopIfUp', 'phase:failed']);
    expect(out).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/did not finish.*It was resumed for the resize, and stopped again\./) });
  });

  it('a resume that comes up late: stopped too, since the box was down when asked', async () => {
    const { fx, log } = fakes();
    fx.resume = async () => { log.push('resume'); throw new Error('The resume did not finish within 15 minutes (the box is starting)'); };
    await runResize(HIB(), fx);
    expect(log).toContain('stopIfUp');
    expect(log).not.toContain('stop');
  });

  it('says so when stopping it again fails', async () => {
    const { fx } = fakes();
    fx.stop = async () => { throw new Error('stop timed out'); };
    fx.stopIfUp = async () => { throw new Error('EC2 refused the stop'); };
    expect((await runResize(HIB(), fx)).error).toMatch(/It may still be running \(stopping it again failed: EC2 refused the stop\)/);
  });

  it('a stopped box that fails is never woken or stopped again', async () => {
    const { fx, log } = fakes({ modifyFails: true });
    await runResize(resizePlan({ status: 'stopped', size: 'small' }, 'large', LARGE), fx);
    expect(log.some(l => l.startsWith('start') || l === 'stopIfUp')).toBe(false);
  });
});

describe('runResize after the type changed', () => {
  it('a start that fails after the modify still reports the new size, so it is recorded', async () => {
    const { fx, log } = fakes();
    let starts = 0;
    fx.start = async () => { starts++; log.push('start'); if (starts === 1) throw new Error('IncorrectInstanceState'); };
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(log).toContain('modify:m8g.2xlarge');
    expect(out).toMatchObject({ outcome: 'failed', type: 'm8g.2xlarge', resized: true });
  });

  it('an agent that never reconnects after the start: failed, but resized', async () => {
    const { fx } = fakes();
    fx.waitReady = async () => { throw new Error('The start did not finish within 15 minutes'); };
    const out = await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx);
    expect(out).toMatchObject({ outcome: 'failed', type: 'm8g.2xlarge', resized: true });
  });

  it('a modify that fails leaves it unresized', async () => {
    const { fx } = fakes({ modifyFails: true });
    expect(await runResize(resizePlan({ status: 'ready', size: 'small' }, 'large', LARGE), fx)).toMatchObject({ resized: false, type: 'm8g.large' });
  });
});

function seed(over: Record<string, any> = {}) {
  const row = {
    id: 'b1', name: 'olive', userId: 'u1', kind: 'ec2', status: 'ready', ec2InstanceId: 'i-0abc', region: null,
    size: 'small', instanceType: 'm8g.large', hibernationConfigured: false, autoTerminatedAt: null,
    onClaimStatus: null, claimedAt: null, ...over,
  };
  rows.set(row.id, row);
  return { ...row } as any;
}
const owner = { userId: 'u1', role: 'owner' as const, via: 'ui' as const };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('startResize', () => {
  beforeEach(() => {
    rows.clear();
    boxEvents.length = 0;
    power.length = 0;
    events.length = 0;
    Object.assign(ec2, { dryRun: 'DryRunOperation', describeFails: true, sent: [] });
    Object.assign(busy, { checks: [], working: false });
  });

  it('waits for a grow another process runs, seen as its open disk-grow row (Bugbot on #1214)', async () => {
    boxEvents.push({ id: 'g1', boxId: 'b1', kind: 'disk-grow', phase: 'filesystem', startedAt: new Date(), finishedAt: null, detail: { toGb: 200 } });
    const res = await startResize(seed(), 'large', owner);
    expect(res).toMatchObject({ ok: true, resize: { phase: 'disk' } });
    const fx = prismaResizeEffects(rows.get('b1') as never, 'u1', 'ev-x', { pollMs: 1 });
    expect(await fx.diskGrowing!()).toBe(true);
    let waited = false;
    const wait = fx.waitDiskGrow!().then(() => { waited = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(waited).toBe(false);
    boxEvents.find(e => e.id === 'g1')!.finishedAt = new Date();
    await wait;
    expect(await fx.diskGrowing!()).toBe(false);
    await settle();
  });

  it('a resize asked while the disk grows starts on waiting for it, and records that (Cursor on #1214)', async () => {
    const release = reserveGrow('b1');
    try {
      const res = await startResize(seed(), 'large', owner);
      expect(res).toMatchObject({ ok: true, resize: { phase: 'disk', running: true } });
      expect(boxEvents[0].detail).toMatchObject({ withDisk: true });
    } finally { release(); }
    await settle();
  });

  it('takes the lock and answers 202 with the resize as it starts', async () => {
    const res = await startResize(seed(), 'large', owner);
    expect(res).toMatchObject({ ok: true, status: 202, resize: { to: 'large', from: 'small', fromStatus: 'ready', phase: 'stopping', running: true, byAdmin: false } });
    await settle();
    // describeFails: the job ends at once, failed, without touching power, and its row says why.
    expect(rows.get('b1')).toMatchObject({ size: 'small' });
    expect(boxEvents).toEqual([expect.objectContaining({
      boxId: 'b1', boxName: 'olive', kind: 'resize', actorId: 'u1', actorRole: 'owner', from: 'small', to: 'large',
      phase: 'failed', finishedAt: expect.any(Date), error: expect.stringContaining('describe failed'),
      detail: expect.objectContaining({ fromStatus: 'ready', fromType: 'm8g.large', end: 'failed' }),
    })]);
    // No resize columns on the box: the row in box_events is the record.
    expect(Object.keys(rows.get('b1')!).some(k => k.startsWith('resize'))).toBe(false);
    expect(power).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ name: 'box.resize', detail: expect.objectContaining({ from: 'small', to: 'large', actor: 'owner', outcome: 'failed' }) })]);
  });

  it('a second resize while one runs is 409, even when both read the box free', async () => {
    const stale = seed();
    const [a, b] = await Promise.all([startResize(stale, 'large', owner), startResize({ ...stale }, 'medium', owner)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    const refused = (a.ok ? b : a) as { body: { code: string } };
    expect(refused.body.code).toBe('resize_running');
  });

  it('the 409 comes from the open row in box_events', async () => {
    boxEvents.push({ id: 'open1', boxId: 'b1', kind: 'resize', to: 'medium', phase: 'stopping', startedAt: new Date(Date.now() - 60_000), finishedAt: null });
    expect(await startResize(seed(), 'large', owner)).toMatchObject({ ok: false, status: 409, body: { code: 'resize_running', error: expect.stringContaining('to medium') } });
    // A finished one, or one cut off over an hour ago, holds nothing.
    boxEvents[0].finishedAt = new Date();
    expect(await startResize(seed(), 'large', owner)).toMatchObject({ ok: true });
    await settle();
    boxEvents.length = 0;
    boxEvents.push({ id: 'old1', boxId: 'b1', kind: 'resize', to: 'medium', phase: 'stopping', startedAt: new Date(Date.now() - 2 * 3_600_000), finishedAt: null });
    expect(await startResize(seed(), 'large', owner)).toMatchObject({ ok: true });
  });

  it('two resizes keep two rows, newest first in the views', async () => {
    expect(await startResize(seed(), 'large', owner)).toMatchObject({ ok: true });
    await settle();
    expect(await startResize(seed(), 'medium', { userId: 'admin', role: 'admin', via: 'admin', reason: 'cost' })).toMatchObject({ ok: true });
    await settle();
    expect(boxEvents.map(e => [e.to, e.actorRole, e.phase])).toEqual([['large', 'owner', 'failed'], ['medium', 'admin', 'failed']]);
  });

  it('a resize advances its row through the phases', async () => {
    seed();
    const ev = await prismaResizeEffects(rows.get('b1') as any, 'u1', (await (await import('./boxEvents')).createBoxEvent({
      box: { id: 'b1', name: 'olive' }, kind: 'resize', actorId: 'u1', actorRole: 'owner', from: 'small', to: 'large', detail: { fromStatus: 'ready' },
    })).id);
    expect(boxEvents[0].phase).toBe('requested');
    await ev.phase('stopping');
    expect(boxEvents[0].phase).toBe('stopping');
    await ev.phase('resizing');
    expect(boxEvents[0].phase).toBe('resizing');
    // The end is finishResize's, with the outcome: a terminal phase leaves the row as it was.
    await ev.phase('ready');
    expect(boxEvents[0]).toMatchObject({ phase: 'resizing', finishedAt: null });
  });

  it('refuses a busy box, saying what blocks it; force goes ahead', async () => {
    busy.working = true;
    busy.checks = ['claude-runner'];
    const refused = await startResize(seed(), 'large', owner);
    expect(refused).toMatchObject({ ok: false, status: 409, body: { code: 'box_busy', forceable: true } });
    expect((refused as any).body.blockers.map((b: { check: string }) => b.check)).toEqual(['working', 'claude-runner']);
    expect(boxEvents).toEqual([]);
    expect(await startResize(seed(), 'large', owner, { force: true })).toMatchObject({ ok: true });
  });

  it('without ec2:ModifyInstanceAttribute: a clear 503 before the box is touched', async () => {
    ec2.dryRun = 'UnauthorizedOperation';
    const res = await startResize(seed(), 'large', owner);
    expect(res).toMatchObject({ ok: false, status: 503, body: { code: 'resize_not_permitted', error: expect.stringMatching(/not allowed to change instance types/) } });
    expect(ec2.sent).toEqual(['ModifyInstanceAttribute(DryRun)']);
    expect(boxEvents).toEqual([]);
    expect(power).toEqual([]);
  });

  it("an owner's resize of a running box restarts its idle clock, so the sweep doesn't park it right after", async () => {
    const old = new Date(Date.now() - 5 * 3_600_000);
    await startResize(seed({ lastActivityAt: old }), 'large', owner);
    expect(rows.get('b1')!.lastActivityAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it("an admin's resize, or one of a box that stays down, leaves the idle clock alone", async () => {
    const old = new Date(Date.now() - 5 * 3_600_000);
    await startResize(seed({ lastActivityAt: old }), 'large', { userId: 'admin', role: 'admin', via: 'admin', reason: 'cost' });
    expect(rows.get('b1')!.lastActivityAt).toEqual(old);
    await settle();
    rows.clear();
    await startResize(seed({ status: 'stopped', lastActivityAt: old }), 'large', owner);
    expect(rows.get('b1')!.lastActivityAt).toEqual(old);
  });

  it('records an admin\'s reason on the row, for the owner to see', async () => {
    const res = await startResize(seed(), 'large', { userId: 'admin', role: 'admin', via: 'admin', reason: 'build OOMs at 8 GB' });
    expect(res).toMatchObject({ ok: true, resize: { byAdmin: true, reason: 'build OOMs at 8 GB' } });
    expect(boxEvents[0]).toMatchObject({ actorId: 'admin', actorRole: 'admin', reason: 'build OOMs at 8 GB' });
  });
});
