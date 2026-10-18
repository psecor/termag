import { beforeEach, describe, expect, it, vi } from 'vitest';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-09T12:00:00Z').getTime();

const rows = new Map<string, Record<string, any>>();
const runnerSessions: Array<{ instanceId: string; endedAt: Date | null }> = [];
const matches = (row: Record<string, any>, where: Record<string, any>) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
  if (v && typeof v === 'object' && 'gte' in v) return row[k] != null && row[k] >= v.gte;
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
  return row[k] === v;
});
vi.mock('../db', () => ({
  prisma: {
    instance: {
      findMany: async ({ where }: any) => [...rows.values()].filter(r => matches(r, where)).map(r => ({ ...r, user: { id: r.userId, unixUsername: 'zane' } })),
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of rows.values()) if (matches(row, where)) { Object.assign(row, data); count++; }
        return { count };
      },
      update: async ({ where, data }: any) => Object.assign(rows.get(where.id)!, data),
      findUnique: async ({ where }: any) => rows.get(where.id) ?? null,
    },
    claudeRunnerSession: {
      findMany: async ({ where }: any) => runnerSessions.filter(s => where.instanceId.in.includes(s.instanceId) && s.endedAt === null),
    },
  },
}));

const flag = { on: true, asked: [] as string[] };
vi.mock('./featureFlags', () => ({
  boolVariation: async (key: string, _user: unknown, fallback: boolean, box: { id: string }) => {
    flag.asked.push(`${key}:${box.id}`);
    return flag.on ?? fallback;
  },
}));
vi.mock('./boxProvisioner', () => ({ getBoxConfig: () => ({ region: 'us-east-2' }) }));

const statuses = new Map<string, { status: string; instanceId: string | null }>();
vi.mock('./status', () => ({ getAllStatuses: () => statuses }));

const power = { calls: [] as Array<[string, string, any]>, refuse: false };
vi.mock('./boxPower', () => {
  class PowerRequestConflict extends Error {}
  return {
    PowerRequestConflict,
    requestPower: async (box: any, action: string, opts: any) => {
      power.calls.push([box.id, action, opts]);
      if (power.refuse) throw new Error('UnsupportedOperation: not ready to hibernate yet');
      rows.get(box.id)!.status = 'hibernating';
      return 'hibernating';
    },
  };
});

const agent = {
  capabilities: ['unsaved-work-v1'] as string[], connected: true, reply: null as unknown, fail: false, asked: [] as string[],
  duringScan: null as null | ((id: string) => void),
};
const CLEAN = { scanned: 1, repos: [], errors: [], keptCheckouts: 0 };
vi.mock('./agentRegistry', () => ({
  instanceAgentTransport: () => (agent.connected ? { capabilities: agent.capabilities } : null),
  sendToInstanceAgent: async (id: string, type: string) => {
    agent.asked.push(`${type}:${id}`);
    agent.duringScan?.(id);
    if (agent.fail) throw new Error('timed out');
    return agent.reply;
  },
}));

const { recentAutoTerminations, registerBoxBusyCheck, runLifecycleSweep, setBoxLifecycle } = await import('./boxLifecycle');

const terminated: string[] = [];
const terminator = async (_user: unknown, box: { id: string }) => {
  terminated.push(box.id);
  rows.get(box.id)!.status = 'terminated';
};
const DAY = 24 * HOUR;
function seedParked(id: string, extra: Record<string, any> = {}) {
  seed(id, {
    status: 'hibernated', parkedAt: new Date(NOW - 2 * DAY), hibernatedTerminateDays: 1,
    unsavedWork: CLEAN, unsavedWorkCheckedAt: new Date(NOW - 2 * DAY - HOUR), lastActivityAt: new Date(NOW - 3 * DAY),
    ...extra,
  });
}

function seed(id: string, extra: Record<string, any> = {}) {
  rows.set(id, {
    id, name: id, userId: 'u1', kind: 'ec2', status: 'ready', ec2InstanceId: `i-${id}`,
    hibernationConfigured: true, rehibernatePending: false, idleHibernateHours: 1,
    lastActivityAt: new Date(NOW - 2 * HOUR), readyAt: new Date(NOW - 48 * HOUR), createdAt: new Date(NOW - 49 * HOUR),
    parkedAt: null, lifecycleNote: null, hibernatedTerminateDays: null,
    unsavedWork: null, unsavedWorkCheckedAt: null, autoTerminatedAt: null, ...extra,
  });
}

beforeEach(() => {
  rows.clear();
  runnerSessions.length = 0;
  statuses.clear();
  Object.assign(flag, { on: true, asked: [] });
  Object.assign(power, { calls: [], refuse: false });
  Object.assign(agent, { capabilities: ['unsaved-work-v1'], connected: true, reply: CLEAN, fail: false, asked: [], duringScan: null });
  terminated.length = 0;
  registerBoxBusyCheck('test', async () => new Set());
});

describe('runLifecycleSweep', () => {
  it('hibernates an idle box without the plain-stop fallback and leaves a note', async () => {
    seed('a');
    const [r] = await runLifecycleSweep(NOW);
    expect(r).toMatchObject({ box: 'a', decision: { hibernate: true }, outcome: 'hibernating' });
    expect(power.calls).toEqual([['a', 'hibernate', { onHibernateRefused: 'throw' }]]);
    expect(rows.get('a')!.lifecycleNote).toMatch(/Hibernated automatically after 1 h idle/);
  });

  it('only looks at boxes that can hibernate and have the setting on', async () => {
    seed('legacy', { hibernationConfigured: false });
    seed('off', { idleHibernateHours: null });
    seed('external', { kind: 'external' });
    seed('pool', { userId: null });
    seed('down', { status: 'hibernated' });
    expect(await runLifecycleSweep(NOW)).toEqual([]);
    expect(flag.asked).toEqual([]);
  });

  it('does nothing with the flag off', async () => {
    seed('a');
    flag.on = false;
    const [r] = await runLifecycleSweep(NOW);
    expect(r.decision).toEqual({ hibernate: false, reason: 'flag-off' });
    expect(power.calls).toEqual([]);
  });

  it('keeps up a box with a live cloud runner session or a working agent', async () => {
    seed('runner');
    seed('working');
    seed('waiting');
    runnerSessions.push({ instanceId: 'runner', endedAt: null });
    statuses.set('k1', { status: 'working', instanceId: 'working' });
    statuses.set('k2', { status: 'waiting', instanceId: 'waiting' });
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r.decision]));
    expect(out).toEqual({
      runner: { hibernate: false, reason: 'busy' },
      working: { hibernate: false, reason: 'working' },
      waiting: { hibernate: true },
    });
  });

  it('treats every box as busy when a busy check throws', async () => {
    seed('a');
    registerBoxBusyCheck('test', async () => { throw new Error('db down'); });
    const [r] = await runLifecycleSweep(NOW);
    expect(r.decision).toEqual({ hibernate: false, reason: 'busy' });
  });

  it('leaves the box ready when EC2 refuses, for the next sweep to retry', async () => {
    seed('a');
    power.refuse = true;
    const [r] = await runLifecycleSweep(NOW);
    expect(r.outcome).toBe('refused');
    expect(rows.get('a')!.status).toBe('ready');
    expect(rows.get('a')!.lifecycleNote).toBe(null);
  });

  it('waits out a box that saw activity inside its window', async () => {
    seed('a', { lastActivityAt: new Date(NOW - 30 * 60 * 1000) });
    const [r] = await runLifecycleSweep(NOW);
    expect(r.decision).toEqual({ hibernate: false, reason: 'not-idle' });
  });
});

describe('overlapping sweeps', () => {
  it('a sweep that starts while one is still scanning does nothing', async () => {
    seed('a');
    let second: Promise<unknown> | null = null;
    agent.duringScan = () => { second ??= runLifecycleSweep(NOW); };
    const [first] = await runLifecycleSweep(NOW);
    expect(await second).toEqual([]);
    expect(first.outcome).toBe('hibernating');
    expect(agent.asked).toEqual(['unsaved-work:a']);
    expect(rows.get('a')!.unsavedWork).toEqual(CLEAN);
  });
});

describe('unsaved-work scan before an automatic hibernate', () => {
  it('stores the agent\'s answer, stamped with the scan\'s start', async () => {
    seed('a');
    agent.reply = { ...CLEAN, repos: [{ path: '/home/z/src/x', dirty: 2, unpushed: 0, stashes: 0 }] };
    const before = Date.now();
    await runLifecycleSweep(NOW, terminator);
    expect(agent.asked).toEqual(['unsaved-work:a']);
    expect(rows.get('a')!.unsavedWork).toEqual(agent.reply);
    expect(rows.get('a')!.unsavedWorkCheckedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(power.calls).toHaveLength(1);
  });

  it('stores an error for an old agent, a missing one or a failed scan, and still hibernates', async () => {
    seed('old');
    agent.capabilities = [];
    await runLifecycleSweep(NOW, terminator);
    expect(rows.get('old')!.unsavedWork).toEqual({ error: 'agent too old to scan for unsaved work' });
    expect(agent.asked).toEqual([]);

    seed('gone');
    agent.connected = false;
    await runLifecycleSweep(NOW, terminator);
    expect(rows.get('gone')!.unsavedWork).toEqual({ error: 'agent not connected' });

    seed('slow');
    Object.assign(agent, { connected: true, capabilities: ['unsaved-work-v1'], fail: true });
    await runLifecycleSweep(NOW, terminator);
    expect(rows.get('slow')!.unsavedWork).toEqual({ error: 'timed out' });
    expect(power.calls.map(c => c[0])).toEqual(['old', 'gone', 'slow']);
  });

  it('does not scan a box that is not going to hibernate', async () => {
    seed('a', { lastActivityAt: new Date(NOW - 10 * 60 * 1000) });
    await runLifecycleSweep(NOW, terminator);
    expect(agent.asked).toEqual([]);
  });
});

describe('activity during the unsaved-work scan', () => {
  it('keeps the box up when someone types, an agent starts working or a runner session starts mid-scan', async () => {
    seed('typed');
    seed('working');
    seed('runner');
    agent.duringScan = id => {
      if (id === 'typed') rows.get('typed')!.lastActivityAt = new Date(NOW);
      if (id === 'working') statuses.set('k', { status: 'working', instanceId: 'working' });
      if (id === 'runner') runnerSessions.push({ instanceId: 'runner', endedAt: null });
    };
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r]));
    expect(out.typed).toEqual({ box: 'typed', decision: { hibernate: false, reason: 'not-idle' } });
    expect(out.working).toEqual({ box: 'working', decision: { hibernate: false, reason: 'working' } });
    expect(out.runner).toEqual({ box: 'runner', decision: { hibernate: false, reason: 'busy' } });
    expect(power.calls).toEqual([]);
  });

  it('drops the scan when the hibernate does not happen, so a later manual hibernate is not taken as clean', async () => {
    seed('runner');
    seed('refused');
    agent.duringScan = id => {
      if (id === 'runner') runnerSessions.push({ instanceId: 'runner', endedAt: null });
      if (id === 'refused') power.refuse = true;
    };
    await runLifecycleSweep(NOW);
    for (const id of ['runner', 'refused']) {
      expect(rows.get(id)!.status).toBe('ready');
      expect(rows.get(id)!.unsavedWorkCheckedAt).toBe(null);
    }
  });
});

describe('automatic terminate', () => {
  it('terminates a clean box parked past its limit and leaves a note', async () => {
    seedParked('a');
    const out = await runLifecycleSweep(NOW, terminator);
    expect(out).toEqual([{ box: 'a', decision: { terminate: true, days: 1 }, outcome: 'terminated' }]);
    expect(terminated).toEqual(['a']);
    expect(rows.get('a')!.autoTerminatedAt.getTime()).toBe(NOW);
    expect(rows.get('a')!.lifecycleNote).toBe('Terminated automatically after 1 day hibernated.');
  });

  it('keeps a box with unsaved work, an unknown scan or activity after the scan for the long limit', async () => {
    seedParked('unsaved', { unsavedWork: { ...CLEAN, keptCheckouts: 1 } });
    seedParked('unscanned', { unsavedWork: null, unsavedWorkCheckedAt: null });
    seedParked('stale', { lastActivityAt: new Date(NOW - 2 * DAY - 30 * 60 * 1000) });
    const out = await runLifecycleSweep(NOW, terminator);
    expect(out.map(r => r.decision)).toEqual([
      { terminate: false, reason: 'not-due' }, { terminate: false, reason: 'not-due' }, { terminate: false, reason: 'not-due' },
    ]);
    expect(terminated).toEqual([]);

    const late = await runLifecycleSweep(NOW + 89 * DAY, terminator);
    expect(late.map(r => r.outcome)).toEqual(['terminated', 'terminated', 'terminated']);
  });

  it('never terminates a box that is not hibernated, cannot hibernate, or has the setting off', async () => {
    seedParked('ready', { status: 'ready', idleHibernateHours: null });
    seedParked('stopped', { status: 'stopped' });
    seedParked('legacy', { hibernationConfigured: false });
    seedParked('off', { hibernatedTerminateDays: null });
    seedParked('unparked', { parkedAt: null });
    seedParked('refresh', { rehibernatePending: true });
    const out = await runLifecycleSweep(NOW + 400 * DAY, terminator);
    expect(terminated).toEqual([]);
    expect(out).toEqual([{ box: 'refresh', decision: { terminate: false, reason: 'not-parked' } }]);
  });

  it('does nothing with the flag off', async () => {
    seedParked('a');
    flag.on = false;
    const [r] = await runLifecycleSweep(NOW, terminator);
    expect(r.decision).toEqual({ terminate: false, reason: 'flag-off' });
    expect(terminated).toEqual([]);
  });

  it('loses to an owner\'s start between the decision and the claim', async () => {
    seedParked('a');
    const realUpdateMany = (await import('../db')).prisma.instance.updateMany;
    const db = (await import('../db')).prisma.instance as any;
    db.updateMany = async (args: any) => {
      Object.assign(rows.get('a')!, { status: 'starting', parkedAt: null });
      db.updateMany = realUpdateMany;
      return realUpdateMany(args);
    };
    const [r] = await runLifecycleSweep(NOW, terminator);
    expect(r.outcome).toBe('conflict');
    expect(terminated).toEqual([]);
    expect(rows.get('a')!.autoTerminatedAt).toBe(null);
  });

  it('retries next sweep when the terminate fails', async () => {
    seedParked('a');
    const [r] = await runLifecycleSweep(NOW, async () => { throw new Error('db down'); });
    expect(r.outcome).toBe('failed');
    expect(rows.get('a')!.status).toBe('hibernated');
    expect(rows.get('a')).toMatchObject({ autoTerminatedAt: null, lifecycleNote: null });
    const [again] = await runLifecycleSweep(NOW + 5 * 60 * 1000, terminator);
    expect(again.outcome).toBe('terminated');
  });

  it('releases the claim when the terminate fails, so a box no longer due can still be started', async () => {
    seedParked('a', { lifecycleNote: 'Hibernated automatically after 1 h idle.' });
    await runLifecycleSweep(NOW, async () => { throw new Error('db down'); });
    rows.get('a')!.hibernatedTerminateDays = null;
    expect(await runLifecycleSweep(NOW + 5 * 60 * 1000, terminator)).toEqual([]);
    expect(rows.get('a')).toMatchObject({
      status: 'hibernated', autoTerminatedAt: null, lifecycleNote: 'Hibernated automatically after 1 h idle.',
    });
    expect(terminated).toEqual([]);
  });

  it('lists the owner\'s boxes terminated automatically in the last week', async () => {
    seed('recent', { status: 'terminated', autoTerminatedAt: new Date(NOW - DAY) });
    seed('old', { status: 'terminated', autoTerminatedAt: new Date(NOW - 8 * DAY) });
    seed('manual', { status: 'terminated' });
    const db = (await import('../db')).prisma.instance as any;
    const real = db.findMany;
    db.findMany = async ({ where }: any) => [...rows.values()].filter(r => matches(r, where));
    try {
      expect((await recentAutoTerminations('u1', NOW)).map((r: any) => r.id)).toEqual(['recent']);
    } finally {
      db.findMany = real;
    }
  });
});

describe('setBoxLifecycle', () => {
  it('changing settings on a parked box leaves its clocks alone', async () => {
    seedParked('a', { idleHibernateHours: 1 });
    const { parkedAt, lastActivityAt } = rows.get('a')!;
    await setBoxLifecycle('a', { idleHibernateHours: 2, hibernatedTerminateDays: 7 });
    expect(rows.get('a')).toMatchObject({ idleHibernateHours: 2, hibernatedTerminateDays: 7, parkedAt, lastActivityAt });
  });

  it('turning it on starts the idle clock now; turning it off leaves the clock', async () => {
    seed('a', { idleHibernateHours: null, lastActivityAt: new Date(NOW - 100 * HOUR) });
    await setBoxLifecycle('a', { idleHibernateHours: 1 });
    expect(rows.get('a')!.idleHibernateHours).toBe(1);
    expect(Date.now() - rows.get('a')!.lastActivityAt.getTime()).toBeLessThan(5_000);

    const clock = rows.get('a')!.lastActivityAt;
    await setBoxLifecycle('a', { idleHibernateHours: null });
    expect(rows.get('a')!.idleHibernateHours).toBe(null);
    expect(rows.get('a')!.lastActivityAt).toBe(clock);
  });

  it('turning it on for a parked box leaves the clock, so its clean scan still counts', async () => {
    seedParked('a', { idleHibernateHours: null });
    const { lastActivityAt } = rows.get('a')!;
    await setBoxLifecycle('a', { idleHibernateHours: 1 });
    expect(rows.get('a')).toMatchObject({ idleHibernateHours: 1, lastActivityAt });
  });

  it('changing settings on a parked box leaves its parked state and clock alone', async () => {
    const parkedAt = new Date(NOW - HOUR);
    const lastActivityAt = new Date(NOW - 3 * HOUR);
    seed('a', { status: 'hibernated', parkedAt, lifecycleNote: 'Hibernated automatically', lastActivityAt });
    await setBoxLifecycle('a', { idleHibernateHours: 4 });
    expect(rows.get('a')).toMatchObject({ idleHibernateHours: 4, parkedAt, lifecycleNote: 'Hibernated automatically', lastActivityAt });
  });

  it('writes the setting and the restarted clock in one UPDATE', async () => {
    seed('a', { idleHibernateHours: null, lastActivityAt: new Date(NOW - 100 * HOUR) });
    const { prisma } = await import('../db');
    const update = vi.spyOn(prisma.instance, 'update');
    const updateMany = vi.spyOn(prisma.instance, 'updateMany');

    await setBoxLifecycle('a', { idleHibernateHours: 4 });

    expect(updateMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toEqual({ idleHibernateHours: 4, lastActivityAt: expect.any(Date) });
    update.mockRestore();
    updateMany.mockRestore();
  });
});
