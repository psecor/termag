import { beforeEach, describe, expect, it, vi } from 'vitest';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-09T12:00:00Z').getTime();

const rows = new Map<string, Record<string, any>>();
const runnerSessions: Array<{ instanceId: string; endedAt: Date | null; startedAt?: Date }> = [];
/** Automations by the box their project lives on (the terminate pass asks for the enabled ones). */
const automations: Array<{ id: string; name: string; instanceId: string; enabled: boolean }> = [];
const hostSamples: Array<{ instanceId: string; at: Date; load1: number | null; cores: number | null }> = [];
const matches = (row: Record<string, any>, where: Record<string, any>): boolean => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return (v as Record<string, any>[]).some(w => matches(row, w));
  if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
  if (v && typeof v === 'object' && 'gte' in v) return row[k] != null && row[k] >= v.gte;
  if (v && typeof v === 'object' && 'gt' in v) return row[k] != null && row[k] > v.gt;
  if (v && typeof v === 'object' && 'startsWith' in v) return typeof row[k] === 'string' && row[k].startsWith(v.startsWith);
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
    user: { findUnique: async ({ where }: any) => ({ id: where.id, slackUserId: 'U1', googleEmail: 'z@example.com' }) },
    automation: {
      findMany: async ({ where }: any) => automations
        .filter(a => a.enabled === where.enabled && a.instanceId === where.project.instanceId)
        .map(a => ({ id: a.id, project: { name: a.name } })),
    },
    claudeRunnerSession: {
      findMany: async ({ where }: any) => runnerSessions.filter(s => where.instanceId.in.includes(s.instanceId) && s.endedAt === null
        && (s.startedAt ?? new Date()) >= where.startedAt.gte),
    },
    hostSample: {
      findMany: async ({ where }: any) => hostSamples
        .filter(h => where.instanceId.in.includes(h.instanceId) && h.at >= where.at.gte)
        .sort((a, b) => b.at.getTime() - a.at.getTime()),
    },
  },
}));

const flag = { on: true, hours: undefined as unknown, warnMinutes: undefined as unknown, asked: [] as string[] };
vi.mock('./featureFlags', () => ({
  boolVariation: async (key: string, _user: unknown, fallback: boolean, box: { id: string }) => {
    flag.asked.push(`${key}:${box.id}`);
    return flag.on ?? fallback;
  },
  numberVariation: async (key: string, _user: unknown, fallback: number, box: { id: string }) => {
    flag.asked.push(`${key}:${box.id}`);
    const value = key === 'box-idle-park-hours' ? flag.hours : flag.warnMinutes;
    return value === undefined ? fallback : value;
  },
}));
vi.mock('./boxProvisioner', () => ({ getBoxConfig: () => ({ region: 'us-east-2' }) }));

const statuses = new Map<string, { status: string; instanceId: string | null }>();
vi.mock('./status', () => ({ getAllStatuses: () => statuses }));

// `refuse` makes EC2 refuse a power change the way it does: not ready yet, unsupported, or for another reason.
const power = {
  calls: [] as Array<[string, string, any]>,
  refuse: false as false | 'not-ready' | 'unsupported' | 'other',
  beforeWrite: null as null | ((id: string) => void),
  requestedAt: new Map<string, number>(),
  afterWrite: null as null | ((id: string) => void),
};
const refusal = (kind: 'not-ready' | 'unsupported' | 'other') => (kind === 'not-ready'
  ? Object.assign(new Error('The instance is not ready to hibernate yet. Please try again in a few minutes.'), { name: 'UnsupportedOperation' })
  : kind === 'unsupported'
    ? Object.assign(new Error('Hibernation is not supported for this instance'), { name: 'UnsupportedHibernationConfiguration' })
    : Object.assign(new Error('Request limit exceeded.'), { name: 'RequestLimitExceeded' }));
const settle = { listener: null as null | ((box: any, status: 'stopped' | 'hibernated') => void) };
vi.mock('./boxPower', () => {
  class PowerRequestConflict extends Error {}
  return {
    PowerRequestConflict,
    onAutoParkSettled: (fn: any) => { settle.listener = fn; },
    powerRequestedAt: (id: string) => power.requestedAt.get(id) ?? null,
    requestPower: async (box: any, action: string, opts: any = {}) => {
      power.calls.push([box.id, action, opts]);
      power.beforeWrite?.(box.id);
      const row = rows.get(box.id)!;
      if (('expectLastActivityAt' in opts && row.lastActivityAt !== opts.expectLastActivityAt)
        || ('expectIdleHibernateHours' in opts && row.idleHibernateHours !== opts.expectIdleHibernateHours)
        || ('expectLastConnectedAt' in opts && (row.lastConnectedAt ?? null) !== (opts.expectLastConnectedAt ?? null))) {
        throw new PowerRequestConflict('The box changed state; reload and try again');
      }
      if (power.refuse) throw refusal(power.refuse);
      Object.assign(row, opts.andSet ?? {});
      row.status = action === 'stop' ? 'stopping' : 'hibernating';
      power.afterWrite?.(box.id);
      if (action === 'stop') return 'stopping';
      return 'hibernating';
    },
  };
});

const notices: Array<{ kind: string; box: string; message: any }> = [];
vi.mock('./boxIdleNotices', () => ({
  automationsSkippedWhileParked: async () => 0,
  warningMessage: (box: any, facts: any) => ({ text: `warn ${box.name} ${facts.action} ${facts.parkAt.toISOString()}`, blocks: [] }),
  parkedMessage: (box: any, result: string, limit: any) => ({ text: `parked ${box.name} ${result} ${limit.hours}${limit.source === 'default' ? ' default' : ''}`, blocks: [] }),
  stuckStartMessage: (box: any) => ({ text: `stuck ${box.name}`, blocks: [] }),
  stuckStartWarningMessage: (box: any) => ({ text: `stuck warning ${box.name}`, blocks: [] }),
  sendIdleNotice: async (kind: string, _owner: unknown, box: any, message: any) => { notices.push({ kind, box: box.id, message }); return true; },
}));
const events: Array<{ name: string; box: string; detail: any }> = [];
vi.mock('./productEvents', () => ({ recordProductEvent: (name: string, ctx: any, detail: any) => { events.push({ name, box: ctx.box, detail }); } }));

const agent = {
  capabilities: ['unsaved-work-v1'] as string[], connected: true, reply: null as unknown, fail: false, asked: [] as string[],
  duringScan: null as null | ((id: string) => void),
  connectedIds: new Set<string>(),
};
const CLEAN = { scanned: 1, repos: [], errors: [], keptCheckouts: 0 };
vi.mock('./agentRegistry', () => ({
  instanceAgentTransport: () => (agent.connected ? { capabilities: agent.capabilities } : null),
  isInstanceAgentConnected: (id: string) => agent.connectedIds.has(id),
  sendToInstanceAgent: async (id: string, type: string) => {
    agent.asked.push(`${type}:${id}`);
    agent.duringScan?.(id);
    if (agent.fail) throw new Error('timed out');
    return agent.reply;
  },
}));

const { applyAskBoxPolicy, lifecycleViewFor, recentAutoTerminations, registerBoxBusyCheck, runLifecycleSweep, setBoxLifecycle, setLiveTunnels } = await import('./boxLifecycle');
const { AgentTunnels } = await import('./agentTunnels');
const { setWorkspaceChangeCallback } = await import('./workspaceEvents');

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
  automations.length = 0;
  hostSamples.length = 0;
  statuses.clear();
  Object.assign(flag, { on: true, hours: undefined, warnMinutes: undefined, asked: [] });
  Object.assign(power, { calls: [], refuse: false, beforeWrite: null, afterWrite: null, requestedAt: new Map() });
  agent.connectedIds = new Set();
  notices.length = 0;
  events.length = 0;
  Object.assign(agent, { capabilities: ['unsaved-work-v1'], connected: true, reply: CLEAN, fail: false, asked: [], duringScan: null });
  terminated.length = 0;
  registerBoxBusyCheck('test', async () => new Set());
});

describe('runLifecycleSweep', () => {
  it('stops an idle box and leaves a note', async () => {
    seed('a');
    const [r] = await runLifecycleSweep(NOW);
    expect(r).toMatchObject({ box: 'a', decision: { stop: true }, outcome: 'stopping' });
    expect(power.calls).toEqual([['a', 'stop', {
      expectLastActivityAt: new Date(NOW - 2 * HOUR), expectIdleHibernateHours: 1,
      andSet: { lifecycleNote: expect.stringMatching(/^Stopped automatically after 1 h idle/), autoParkedAt: new Date(NOW), parkedAt: null },
      sleepBy: 'idle',
    }]]);
    expect(rows.get('a')!.lifecycleNote).toMatch(/Stopped automatically after 1 h idle/);
  });

  it('only looks at owned EC2 boxes that are up', async () => {
    seed('external', { kind: 'external' });
    seed('pool', { userId: null });
    seed('down', { status: 'hibernated' });
    expect(await runLifecycleSweep(NOW)).toEqual([]);
    expect(flag.asked).toEqual([]);
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
      runner: { hibernate: false, reason: 'busy', check: 'claude-runner' },
      working: { hibernate: false, reason: 'working' },
      waiting: { stop: true },
    });
  });

  it("lets go of a runner session left open past the runner's own 13 h", async () => {
    seed('fresh');
    seed('stale');
    runnerSessions.push({ instanceId: 'fresh', endedAt: null, startedAt: new Date(Date.now() - 12 * HOUR) });
    runnerSessions.push({ instanceId: 'stale', endedAt: null, startedAt: new Date(Date.now() - 14 * HOUR) });
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r.decision]));
    expect(out).toEqual({ fresh: { hibernate: false, reason: 'busy', check: 'claude-runner' }, stale: { stop: true } });
  });

  it('keeps up a box under sustained load, not one with a spike, and ignores samples with no core count', async () => {
    const MIN = 60 * 1000;
    const sample = (instanceId: string, minsAgo: number, load1: number | null, cores: number | null = 8) =>
      hostSamples.push({ instanceId, at: new Date(Date.now() - minsAgo * MIN), load1, cores });
    seed('busy');
    seed('spike');
    seed('nocores');
    seed('old');
    for (const [i, load] of [4, 0.1, 3, 0.1, 2.5, 0.1].entries()) sample('busy', 1 + i * 5, load);
    for (const [i, load] of [8, 8, 0.1, 0.1, 0.1, 0.1].entries()) sample('spike', 1 + i * 5, load);
    for (let i = 0; i < 6; i++) sample('nocores', 1 + i * 5, 8, null);
    // Three hot samples behind four with no core count still hold the box.
    seed('mixed');
    for (let i = 0; i < 4; i++) sample('mixed', 1 + i * 4, 8, null);
    for (let i = 0; i < 3; i++) sample('mixed', 18 + i * 4, 4);
    for (let i = 0; i < 6; i++) sample('old', 40 + i * 5, 8);
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r.decision]));
    expect(out).toEqual({
      busy: { hibernate: false, reason: 'busy', check: 'host-load' },
      mixed: { hibernate: false, reason: 'busy', check: 'host-load' },
      spike: { stop: true }, nocores: { stop: true }, old: { stop: true },
    });
  });

  it('keeps up a box with a box update in flight, until it reports or 20 minutes pass', async () => {
    const MIN = 60 * 1000;
    seed('updating', { updatePushedAt: new Date(Date.now() - 5 * MIN), lastUpdateAt: null });
    // The report clears updatePushedAt (boxUpdateReport.ts), whatever the box's clock says.
    seed('reported', { updatePushedAt: null, lastUpdateAt: new Date(Date.now() - 10 * MIN) });
    seed('silent', { updatePushedAt: new Date(Date.now() - 21 * MIN), lastUpdateAt: null });
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r.decision]));
    expect(out).toEqual({
      updating: { hibernate: false, reason: 'busy', check: 'box-update' },
      reported: { stop: true }, silent: { stop: true },
    });
  });

  it('keeps up a box with an SSH session open in a recent sample, and lets go after a week without activity', async () => {
    const MIN = 60 * 1000;
    seed('editor', { sshSessions: 1, hostSampledAt: new Date(Date.now() - 4 * MIN) });
    seed('closed', { sshSessions: 0, hostSampledAt: new Date(Date.now() - 4 * MIN) });
    seed('unsampled', { sshSessions: 1, hostSampledAt: new Date(Date.now() - 20 * MIN) });
    seed('forgotten', { sshSessions: 1, hostSampledAt: new Date(Date.now() - 4 * MIN), lastActivityAt: new Date(NOW - 8 * DAY) });
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r.decision]));
    expect(out).toEqual({
      editor: { hibernate: false, reason: 'busy', check: 'ssh' },
      closed: { stop: true }, unsampled: { stop: true }, forgotten: { stop: true },
    });
  });

  it('keeps up a box with a port forward open in a recent sample, and lets go after a week without activity', async () => {
    const MIN = 60 * 1000;
    seed('forwarding', { openTunnels: 2, hostSampledAt: new Date(Date.now() - 4 * MIN) });
    seed('forgotten', { openTunnels: 1, hostSampledAt: new Date(Date.now() - 4 * MIN), lastActivityAt: new Date(NOW - 8 * DAY) });
    seed('none', { openTunnels: 0, hostSampledAt: new Date(Date.now() - 4 * MIN) });
    seed('old-agent', { openTunnels: null, hostSampledAt: new Date(Date.now() - 4 * MIN) });
    seed('unsampled', { openTunnels: 1, hostSampledAt: new Date(Date.now() - 20 * MIN) });
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r.decision]));
    expect(out).toEqual({
      forwarding: { hibernate: false, reason: 'busy', check: 'tunnels' },
      none: { stop: true }, 'old-agent': { stop: true }, unsampled: { stop: true }, forgotten: { stop: true },
    });
  });

  it("doesn't hold a box for the desktop's t3 relay, in its sample or in this process", async () => {
    const MIN = 60 * 1000;
    // The agent's sample as the backend stores it: t3 left out.
    const { parseHostSample } = await import('./agentHello');
    seed('desktop', { openTunnels: parseHostSample({ tunnels: { t3: 1, port: 0 } })!.openTunnels, hostSampledAt: new Date(Date.now() - 4 * MIN) });
    const tunnels = new AgentTunnels({ send: () => new Promise(() => {}) });
    void tunnels.openSocket('desktop', 'u1', { kind: 't3' }).catch(() => {});
    setLiveTunnels(ids => tunnels.boxesWithTunnels(ids, 'port'));
    try {
      const [r] = await runLifecycleSweep(NOW);
      expect(r.decision).toEqual({ stop: true });
    } finally {
      setLiveTunnels(() => new Set());
    }
  });

  it('keeps up a box with a tunnel this process carries that its last sample predates', async () => {
    const MIN = 60 * 1000;
    seed('forwarding', { openTunnels: 0, hostSampledAt: new Date(Date.now() - 4 * MIN) });
    seed('none', { openTunnels: 0, hostSampledAt: new Date(Date.now() - 4 * MIN) });
    // The agent has not answered tunnel-open yet: opening counts too.
    const tunnels = new AgentTunnels({ send: () => new Promise(() => {}) });
    void tunnels.openSocket('forwarding', 'u1', { kind: 'port', port: 5173 }).catch(() => {});
    setLiveTunnels(ids => tunnels.boxesWithTunnels(ids, 'port'));
    try {
      const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r.decision]));
      expect(out).toEqual({ forwarding: { hibernate: false, reason: 'busy', check: 'tunnels' }, none: { stop: true } });
    } finally {
      setLiveTunnels(() => new Set());
    }
  });

  it('keeps up a box whose forward opened during the unsaved-work scan', async () => {
    seed('a', { openTunnels: 0, hostSampledAt: new Date(Date.now() - 60 * 1000) });
    const live = new Set<string>();
    setLiveTunnels(ids => new Set(ids.filter(id => live.has(id))));
    agent.duringScan = id => { live.add(id); };
    try {
      const [r] = await runLifecycleSweep(NOW);
      expect(r.decision).toEqual({ hibernate: false, reason: 'busy', check: 'tunnels' });
      expect(power.calls).toEqual([]);
    } finally {
      agent.duringScan = null;
      setLiveTunnels(() => new Set());
    }
  });

  it('leaves a box alone right after a start, whoever asked for it', async () => {
    seed('a', { lastReadyAt: new Date(NOW - 5 * 60 * 1000) });
    const [r] = await runLifecycleSweep(NOW);
    expect(r.decision).toEqual({ hibernate: false, reason: 'just-started' });
    expect(power.calls).toEqual([]);
  });

  it('treats every box as busy when a busy check throws', async () => {
    seed('a');
    registerBoxBusyCheck('test', async () => { throw new Error('db down'); });
    const [r] = await runLifecycleSweep(NOW);
    expect(r.decision).toEqual({ hibernate: false, reason: 'busy', check: 'test-failed' });
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

const MIN = 60 * 1000;
/** A warning sent half an hour ago that promised a stop now: the next pass stops a box idle 2 h or more. */
const standing = { idleWarnedAt: new Date(NOW - 30 * MIN), idleParkAt: new Date(NOW) };

describe('the default idle window', () => {
  it('with no setting, warns an hour ahead, then stops a box that can hibernate at 2 h, and not a minute sooner', async () => {
    flag.on = false;
    const last = NOW - HOUR + MIN;
    seed('unset', { idleHibernateHours: null, lastActivityAt: new Date(last) });
    expect((await runLifecycleSweep(NOW))[0].decision).toEqual({ hibernate: false, reason: 'not-idle' });

    // An hour ahead: half the window caps the two-hour default lead.
    const [warned] = await runLifecycleSweep(NOW + MIN);
    expect(warned).toEqual({ box: 'unset', decision: { warn: true, stopAt: new Date(last + 2 * HOUR) }, outcome: 'warned' });
    expect(rows.get('unset')).toMatchObject({ idleWarnedAt: new Date(NOW + MIN), idleParkAt: new Date(last + 2 * HOUR), status: 'ready' });
    expect((await runLifecycleSweep(last + 2 * HOUR - MIN))[0].decision).toEqual({ hibernate: false, reason: 'warned' });
    expect(power.calls).toEqual([]);
    expect(agent.asked).toEqual([]);

    const [r] = await runLifecycleSweep(last + 2 * HOUR);
    expect(r).toMatchObject({ box: 'unset', decision: { stop: true }, outcome: 'stopping' });
    expect(power.calls).toEqual([['unset', 'stop', {
      expectLastActivityAt: new Date(last), expectIdleHibernateHours: null,
      andSet: { lifecycleNote: expect.stringMatching(/^Stopped automatically after 2 h idle/), autoParkedAt: new Date(last + 2 * HOUR), parkedAt: null },
      sleepBy: 'idle',
    }]]);
    expect(rows.get('unset')).toMatchObject({ lifecycleNote: expect.stringMatching(/^Stopped automatically after 2 h idle/), autoParkedAt: new Date(last + 2 * HOUR) });
    expect(agent.asked).toEqual(['unsaved-work:unset']);
  });

  it('a box first seen past its window is warned and stopped a lead later, not on the first pass', async () => {
    seed('long', { idleHibernateHours: null, lastActivityAt: new Date(NOW - 10 * HOUR) });
    expect(await runLifecycleSweep(NOW)).toEqual([{ box: 'long', decision: { warn: true, stopAt: new Date(NOW + HOUR) }, outcome: 'warned' }]);
    expect(power.calls).toEqual([]);
    expect((await runLifecycleSweep(NOW + HOUR))[0]).toMatchObject({ decision: { stop: true }, outcome: 'stopping' });
  });

  it('takes the window from box-idle-park-hours and the lead from box-idle-park-warn-minutes', async () => {
    seed('unset', { idleHibernateHours: null, lastActivityAt: new Date(NOW - 7 * HOUR) });
    Object.assign(flag, { hours: 8, warnMinutes: 30 });
    expect((await runLifecycleSweep(NOW))[0].decision).toEqual({ hibernate: false, reason: 'not-idle' });
    expect((await runLifecycleSweep(NOW + 30 * MIN))[0].decision).toEqual({ warn: true, stopAt: new Date(NOW + HOUR) });
    const [r] = await runLifecycleSweep(NOW + HOUR);
    expect(r).toMatchObject({ decision: { stop: true }, outcome: 'stopping' });
    expect(rows.get('unset')!.lifecycleNote).toMatch(/^Stopped automatically after 8 h idle/);
    expect(flag.asked).toContain('box-idle-park-hours:unset');
    expect(flag.asked).toContain('box-idle-park-warn-minutes:unset');
  });

  it('warns again before any stop once the warning is stale: a keystroke since, or a longer window', async () => {
    // Typed after the warning: a new idle stretch, warned again an hour before its new due time.
    seed('typed', { idleHibernateHours: null, ...standing, lastActivityAt: new Date(NOW - 20 * MIN) });
    // Warned for a 2 h window that is now 8 h.
    seed('longer', { idleHibernateHours: null, ...standing, lastActivityAt: new Date(NOW - 2 * HOUR - MIN) });
    flag.hours = 8;
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r.decision]));
    expect(out).toEqual({ typed: { hibernate: false, reason: 'not-idle' }, longer: { hibernate: false, reason: 'not-idle' } });
    rows.delete('longer');
    flag.hours = 2;
    expect((await runLifecycleSweep(NOW + 40 * MIN)).find(r => r.box === 'typed')).toMatchObject({ decision: { warn: true }, outcome: 'warned' });
    expect(power.calls).toEqual([]);
  });

  it('of two passes warning a box at once (a deploy overlap), only the first warning lands', async () => {
    seed('raced', { idleHibernateHours: null, lastActivityAt: new Date(NOW - 10 * HOUR), idleWarnedAt: null, idleParkAt: null });
    // The other host's warning lands after this pass read the box and before it writes its own.
    const other = { idleWarnedAt: new Date(NOW - MIN), idleParkAt: new Date(NOW + 59 * MIN) };
    registerBoxBusyCheck('test', async () => { Object.assign(rows.get('raced')!, other); return new Set(); });
    expect(await runLifecycleSweep(NOW)).toEqual([
      { box: 'raced', decision: { warn: true, stopAt: new Date(NOW + HOUR) }, outcome: 'conflict' },
    ]);
    expect(rows.get('raced')).toMatchObject(other);
  });

  it('stops a box woken without its owner and untouched since its auto-stop again, with no warning, once its start grace is over', async () => {
    const woken = { idleHibernateHours: null, lastActivityAt: new Date(NOW - 10 * HOUR), autoParkedAt: new Date(NOW - HOUR) };
    seed('grace', { ...woken, lastReadyAt: new Date(NOW - 5 * MIN) });
    seed('woken', { ...woken, lastReadyAt: new Date(NOW - 20 * MIN) });
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r]));
    expect(out.grace).toEqual({ box: 'grace', decision: { hibernate: false, reason: 'just-started' } });
    expect(out.woken).toMatchObject({ decision: { stop: true, quiet: true }, outcome: 'stopping' });
    expect(rows.get('woken')!.idleWarnedAt).toBeUndefined();
  });

  it('with no setting, plainly stops a box that cannot hibernate, after the unsaved-work scan', async () => {
    seed('legacy', { hibernationConfigured: false, idleHibernateHours: null, lastActivityAt: new Date(NOW - 2 * HOUR), ...standing });
    const [r] = await runLifecycleSweep(NOW);
    expect(r).toEqual({ box: 'legacy', decision: { stop: true }, outcome: 'stopping' });
    expect(power.calls).toEqual([['legacy', 'stop', expect.objectContaining({ expectIdleHibernateHours: null })]]);
    expect(agent.asked).toEqual(['unsaved-work:legacy']);
    expect(rows.get('legacy')!.unsavedWork).toEqual(CLEAN);
    expect(rows.get('legacy')!.lifecycleNote).toMatch(/^Stopped automatically after 2 h idle/);
  });

  it('a box with its own setting keeps that timing and is not stopped at 2 h', async () => {
    seed('own', { idleHibernateHours: 4, lastActivityAt: new Date(NOW - 3 * HOUR) });
    expect(await runLifecycleSweep(NOW)).toEqual([{ box: 'own', decision: { hibernate: false, reason: 'not-idle' } }]);
    const [later] = await runLifecycleSweep(NOW + HOUR);
    expect(later).toMatchObject({ box: 'own', decision: { stop: true }, outcome: 'stopping' });
    expect(power.calls).toEqual([['own', 'stop', expect.objectContaining({ expectIdleHibernateHours: 4 })]]);
  });

  it('a working agent, a runner session, or typing since keeps the box up', async () => {
    const old = new Date(NOW - 10 * HOUR);
    seed('working', { hibernationConfigured: false, idleHibernateHours: null, lastActivityAt: old });
    seed('runner', { hibernationConfigured: false, idleHibernateHours: null, lastActivityAt: old });
    seed('typed', { hibernationConfigured: false, idleHibernateHours: null, lastActivityAt: new Date(NOW - 10 * 60 * 1000) });
    statuses.set('k', { status: 'working', instanceId: 'working' });
    runnerSessions.push({ instanceId: 'runner', endedAt: null });
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r.decision]));
    expect(out).toEqual({
      working: { hibernate: false, reason: 'working' },
      runner: { hibernate: false, reason: 'busy', check: 'claude-runner' },
      typed: { hibernate: false, reason: 'not-idle' },
    });
    expect(power.calls).toEqual([]);
  });

  it("an owner's start restarts the clock, so a box stopped for idle is not due again once it is back", async () => {
    seed('legacy', { hibernationConfigured: false, idleHibernateHours: null, lastActivityAt: new Date(NOW - 10 * HOUR), ...standing });
    await runLifecycleSweep(NOW);
    expect(rows.get('legacy')!.status).toBe('stopping');
    // What POST /:id/start writes with `starting` (requestPower markInUse), then the agent's connect makes it ready.
    const { boxInUseFields } = await import('./boxActivity');
    Object.assign(rows.get('legacy')!, boxInUseFields('legacy', NOW + 5 * 60 * 1000), { status: 'ready' });
    power.calls.length = 0;
    const [r] = await runLifecycleSweep(NOW + 10 * 60 * 1000);
    expect(r).toEqual({ box: 'legacy', decision: { hibernate: false, reason: 'not-idle' } });
    expect(power.calls).toEqual([]);
    expect(rows.get('legacy')).toMatchObject({ parkedAt: null, autoParkedAt: null, lifecycleNote: null });
  });

  it('with both flags on, no idle hours is a stop, so a terminate limit does not hibernate it', async () => {
    flag.on = true;
    seed('unset', {
      idleHibernateHours: null,
      hibernatedTerminateDays: 1,
      lastActivityAt: new Date(NOW - 2 * HOUR),
      ...standing,
    });
    const [stopped] = await runLifecycleSweep(NOW, terminator);
    expect(stopped).toMatchObject({ box: 'unset', decision: { stop: true }, outcome: 'stopping' });
    expect(power.calls).toEqual([['unset', 'stop', expect.objectContaining({ expectIdleHibernateHours: null })]]);
    expect(terminated).toEqual([]);
    expect(rows.get('unset')!.status).toBe('stopping');
  });

  it('the list warns of nothing on a box that cannot hibernate', async () => {
    seed('legacy', { hibernationConfigured: false, idleHibernateHours: null, hibernatedTerminateDays: 14 });
    const row = { ...rows.get('legacy')!, lifecycleNote: null };
    const user = { id: 'u1' } as never;
    expect((await lifecycleViewFor(user, row)).warning).toBeNull();
  });

  it("the box list promises an own-hours stop", async () => {
    seed('own', { idleHibernateHours: 4, lastActivityAt: new Date(NOW - HOUR) });
    const view = () => lifecycleViewFor({ id: 'u1' } as never, { ...rows.get('own')!, lifecycleNote: null } as never, NOW);
    expect(await view()).toMatchObject({ parkAt: new Date(NOW + 3 * HOUR).toISOString(), parkAction: 'stop', idleLimitHours: 4, idleLimitSource: 'own' });
    expect(flag.asked).toEqual([]);
  });

  it('the box list says when the default window stops the box, and that its owner was warned', async () => {
    seed('unset', { idleHibernateHours: null, lastActivityAt: new Date(NOW - 90 * MIN) });
    const user = { id: 'u1' } as never;
    const view = () => lifecycleViewFor(user, { ...rows.get('unset')!, lifecycleNote: null } as never, NOW);
    expect(await view()).toMatchObject({
      parkAction: 'stop', idleLimitHours: 2, idleLimitSource: 'default', warnedAt: null, parkAt: new Date(NOW + HOUR).toISOString(),
    });
    // Warned a full lead ahead, so the promise is an hour from the warning, not the due time half an hour away.
    await runLifecycleSweep(NOW);
    expect(await view()).toMatchObject({ warnedAt: new Date(NOW).toISOString(), parkAt: new Date(NOW + HOUR).toISOString() });
  });

  it('keeps the box up when work starts during the scan', async () => {
    seed('legacy', { hibernationConfigured: false, idleHibernateHours: null, lastActivityAt: new Date(NOW - 10 * HOUR), ...standing });
    agent.duringScan = () => { statuses.set('k', { status: 'working', instanceId: 'legacy' }); };
    const [r] = await runLifecycleSweep(NOW);
    expect(r).toEqual({ box: 'legacy', decision: { hibernate: false, reason: 'working' } });
    expect(power.calls).toEqual([]);
    expect(rows.get('legacy')!.unsavedWorkCheckedAt).toBe(null);
  });
});

describe('overlapping sweeps', () => {
  it('a sweep that starts while one is still scanning does nothing', async () => {
    seed('a');
    let second: Promise<unknown> | null = null;
    agent.duringScan = () => { second ??= runLifecycleSweep(NOW); };
    const [first] = await runLifecycleSweep(NOW);
    expect(await second).toEqual([]);
    expect(first.outcome).toBe('stopping');
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
    expect(out.runner).toEqual({ box: 'runner', decision: { hibernate: false, reason: 'busy', check: 'claude-runner' } });
    expect(power.calls).toEqual([]);
  });

  it('drops the scan when the stop does not happen, so a later park is not taken as clean', async () => {
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
    expect(rows.get('a')!.lifecycleNote).toBe('Terminated automatically after 1 day parked.');
  });

  it('keeps a box that hosts an enabled automation, and terminates it once that is disabled (babysit-1027)', async () => {
    seedParked('a');
    automations.push({ id: 'auto1', name: 'pr-babysitter', instanceId: 'a', enabled: true });
    const out = await runLifecycleSweep(NOW, terminator);
    expect(out).toEqual([{ box: 'a', decision: { terminate: false, reason: 'hosts-automation' } }]);
    expect(terminated).toEqual([]);
    expect(rows.get('a')!.autoTerminatedAt ?? null).toBeNull();
    // The box list shows no terminate date for it meanwhile.
    expect((await lifecycleViewFor({ id: 'u1' } as any, rows.get('a') as any, NOW)).terminateDueAt).toBeNull();

    automations[0].enabled = false;
    expect((await runLifecycleSweep(NOW, terminator))[0]).toMatchObject({ outcome: 'terminated' });
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

  it('never terminates a box that is not parked, cannot hibernate, or has the setting off', async () => {
    seedParked('ready', { status: 'ready', idleHibernateHours: null });
    seedParked('legacy', { hibernationConfigured: false });
    seedParked('off', { hibernatedTerminateDays: null });
    seedParked('unparked', { parkedAt: null });
    seedParked('refresh', { rehibernatePending: true });
    const out = await runLifecycleSweep(NOW + 400 * DAY, terminator);
    expect(terminated).toEqual([]);
    expect(out.filter(r => 'terminate' in r.decision)).toEqual([{ box: 'refresh', decision: { terminate: false, reason: 'not-parked' } }]);
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

describe('applyAskBoxPolicy: a box made for an ask', () => {
  it('records it, and gives it no hours of its own and no terminate, so the default window stops it and nothing hibernates it', async () => {
    seed('a', { idleHibernateHours: 1, hibernatedTerminateDays: 1, lastActivityAt: new Date(NOW - 3 * HOUR) });
    await applyAskBoxPolicy('a');
    expect(rows.get('a')).toMatchObject({ createdFor: 'ask', idleHibernateHours: null, hibernatedTerminateDays: null });
    // Past the default window: the sweep warns, then stops it; it never hibernates.
    const [swept] = await runLifecycleSweep(NOW);
    expect(swept).toMatchObject({ box: 'a', outcome: 'warned' });
    expect(power.calls.filter(c => /hibernate/.test(String(c)))).toEqual([]);
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

  it("turning its own hours off forgets the sweep's hibernate, so the default window warns before stopping the box", async () => {
    seedParked('a', { idleHibernateHours: 4, autoParkedAt: new Date(NOW - 2 * DAY) });
    await setBoxLifecycle('a', { idleHibernateHours: 8 });
    expect(rows.get('a')!.autoParkedAt).toEqual(new Date(NOW - 2 * DAY));
    await setBoxLifecycle('a', { idleHibernateHours: null });
    expect(rows.get('a')!.autoParkedAt).toBe(null);
    // An automation's wake: up, with no markInUse, past its start grace.
    Object.assign(rows.get('a')!, { status: 'ready', parkedAt: null, lastReadyAt: new Date(NOW - 20 * MIN) });
    expect(await runLifecycleSweep(NOW)).toEqual([{ box: 'a', decision: { warn: true, stopAt: new Date(NOW + HOUR) }, outcome: 'warned' }]);
    expect(power.calls).toEqual([]);
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

describe('telling the owner', () => {
  const settleAll = async () => {
    for (const row of rows.values()) {
      if (row.status === 'hibernating' || row.status === 'stopping') settle.listener!({ ...row }, row.status === 'stopping' ? 'stopped' : 'hibernated');
    }
    await new Promise(r => setTimeout(r, 0));
  };

  it("tells the owner's open tabs to reload the box list when it warns and when it parks", async () => {
    const changes: string[] = [];
    setWorkspaceChangeCallback((owner, what) => { changes.push(`${owner}:${what}`); });
    try {
      seed('w', { idleHibernateHours: null });
      await runLifecycleSweep(NOW);
      await runLifecycleSweep(NOW + HOUR);
      expect(rows.get('w')!.status).toBe('stopping');
      expect(changes).toEqual(['u1:boxes', 'u1:boxes']);
    } finally {
      setWorkspaceChangeCallback(null);
    }
  });

  it('DMs the warning once, from the pass whose write took', async () => {
    seed('w', { idleHibernateHours: null, hibernationConfigured: false });
    await runLifecycleSweep(NOW);
    await runLifecycleSweep(NOW + 5 * 60 * 1000);
    expect(notices).toEqual([{ kind: 'warning', box: 'w', message: { text: `warn w stop ${new Date(NOW + HOUR).toISOString()}`, blocks: [] } }]);
    expect(events.filter(e => e.name === 'box.idle.warned').map(e => e.detail)).toEqual([{ limitHours: 2, leadMinutes: 60 }]);
  });

  /** A box under the default window, warned, whose promised stop is now. */
  const seedDue = (id: string, extra: Record<string, any> = {}) =>
    seed(id, { idleHibernateHours: null, lastActivityAt: new Date(NOW - 3 * HOUR), idleWarnedAt: new Date(NOW - HOUR), idleParkAt: new Date(NOW), ...extra });

  it("DMs what the default window's stop did once it settles; nothing for a quiet re-park or a box's own hours", async () => {
    seedDue('d');
    seed('own');
    seed('woken', { idleHibernateHours: null, autoParkedAt: new Date(NOW - 20 * 60 * 1000), lastActivityAt: new Date(NOW - 10 * HOUR) });
    await runLifecycleSweep(NOW);
    expect(notices).toEqual([]);
    await settleAll();
    expect(notices.map(n => n.message.text)).toEqual(['parked d stopped 2 default']);
    // Parked side by side, so in no set order.
    expect(events.filter(e => e.name === 'box.parked').map(e => [e.box, e.detail.action, e.detail.limitSource, e.detail.quiet, e.detail.cause]).sort())
      .toEqual([['d', 'stop', 'default', false, 'idle'], ['own', 'stop', 'own', false, 'idle'], ['woken', 'stop', 'default', true, 'idle']]);
  });

  it('still tells the owner when the box settles before the power request has returned', async () => {
    seedDue('fast');
    power.afterWrite = id => { settle.listener!({ ...rows.get(id)! }, 'stopped'); };
    await runLifecycleSweep(NOW);
    await new Promise(r => setTimeout(r, 0));
    expect(notices.map(n => [n.kind, n.box])).toEqual([['parked', 'fast']]);
  });

  it('forgets a park that did not happen, so a later stop by hand sends nothing', async () => {
    seedDue('a');
    await runLifecycleSweep(NOW);
    rows.get('a')!.status = 'ready';
    rows.get('a')!.lastActivityAt = new Date(NOW);
    await runLifecycleSweep(NOW + 60 * 1000);
    rows.get('a')!.status = 'stopping';
    await settleAll();
    expect(notices).toEqual([]);
  });

  it('tells the owner about the stop that finally takes after one timed out back to ready', async () => {
    seedDue('slow');
    await runLifecycleSweep(NOW);
    // What the power sweep writes when EC2 never stopped it: ready again, and no auto-park (boxPower).
    Object.assign(rows.get('slow')!, { status: 'ready', autoParkedAt: null });
    const [again] = (await runLifecycleSweep(NOW + 20 * 60 * 1000)).filter(r => r.box === 'slow');
    expect(again).toMatchObject({ decision: { stop: true }, outcome: 'stopping' });
    expect('quiet' in again.decision && again.decision.quiet).toBeFalsy();
    await settleAll();
    expect(notices.map(n => [n.kind, n.box])).toEqual([['parked', 'slow']]);
  });

  it('records what held a box up once per busy stretch', async () => {
    seed('a');
    runnerSessions.push({ instanceId: 'a', endedAt: null });
    await runLifecycleSweep(NOW);
    await runLifecycleSweep(NOW + 5 * 60 * 1000);
    expect(events.filter(e => e.name === 'box.park.deferred').map(e => e.detail)).toEqual([{ check: 'claude-runner' }]);
    runnerSessions.length = 0;
    rows.get('a')!.lastActivityAt = new Date(NOW);
    await runLifecycleSweep(NOW + 10 * 60 * 1000);
    runnerSessions.push({ instanceId: 'a', endedAt: null });
    await runLifecycleSweep(NOW + 15 * 60 * 1000);
    expect(events.filter(e => e.name === 'box.park.deferred')).toHaveLength(2);
  });
});

describe('boxes stuck starting', () => {
  const MIN = 60 * 1000;
  // Two start timeouts (2 × 15 min by default) into starting, with no agent.
  const stuck = (id: string, minsAgo: number, extra: Record<string, any> = {}) => {
    seed(id, { status: 'starting', idleWarnedAt: null, idleParkAt: null, ...extra });
    power.requestedAt.set(id, NOW - minsAgo * MIN);
  };

  it('warns the owner first, then stops the box once the warned time is up, and tells them when it has stopped', async () => {
    stuck('dead', 31);
    const [warned] = (await runLifecycleSweep(NOW)).filter(r => r.box === 'dead');
    expect(warned).toMatchObject({ decision: { act: 'warn', stopAt: new Date(NOW + 2 * 60 * MIN) }, outcome: 'warned' });
    expect(power.calls).toEqual([]);
    expect(notices.map(n => [n.kind, n.box])).toEqual([['warning', 'dead']]);
    await runLifecycleSweep(NOW + 60 * MIN);
    expect(power.calls).toEqual([]);
    const [stopped] = (await runLifecycleSweep(NOW + 120 * MIN)).filter(r => r.box === 'dead');
    expect(stopped).toMatchObject({ decision: { act: 'stop' }, outcome: 'stopping' });
    expect(rows.get('dead')!.lifecycleNote).toMatch(/^Stopped automatically: it was started at .* and its agent never connected\./);
    expect(events.find(e => e.name === 'box.parked')?.detail).toMatchObject({ cause: 'stuck-start' });
    settle.listener!({ ...rows.get('dead')! }, 'stopped');
    await new Promise(r => setTimeout(r, 0));
    expect(notices.map(n => n.kind)).toEqual(['warning', 'parked']);
  });

  // What the power sweep leaves when a stuck-start stop times out: ready, no
  // agent, no autoParkedAt, the note and the warning still on it, and the
  // idle clock from the start, long past any window.
  const timedOutStop = {
    idleHibernateHours: null, autoParkedAt: null, lastActivityAt: new Date(NOW - 3 * 60 * MIN),
    idleWarnedAt: new Date(NOW - 2 * 60 * MIN), idleParkAt: new Date(NOW - 20 * MIN),
    lifecycleNote: 'Stopped automatically: it was started at 2026-10-09 09:00 UTC and its agent never connected.',
  };
  it('stops again a box whose stuck-start stop timed out back to ready, and none whose agent is back', async () => {
    seed('timedout', timedOutStop);
    seed('cameback', timedOutStop);
    agent.connectedIds.add('cameback');
    const results = await runLifecycleSweep(NOW);
    // The retry takes it, not the default window's idle stop (Bugbot on #623).
    expect(results.filter(r => r.box === 'timedout')).toEqual([{ box: 'timedout', decision: { act: 'stop' }, outcome: 'stopping' }]);
    expect(results.filter(r => r.box === 'cameback')).toEqual([]);
    expect(rows.get('timedout')!.lifecycleNote).toBe(timedOutStop.lifecycleNote);
    expect(events.filter(e => e.name === 'box.parked').map(e => [e.box, e.detail.cause])).toEqual([['timedout', 'stuck-start']]);
    settle.listener!({ ...rows.get('timedout')! }, 'stopped');
    await new Promise(r => setTimeout(r, 0));
    expect(notices.map(n => [n.kind, n.box, n.message.text])).toEqual([['parked', 'timedout', 'stuck timedout']]);
  });

  it("doesn't retry a box whose agent connected since the warning, even if that connect's write left the note", async () => {
    seed('raced', { ...timedOutStop, lastConnectedAt: new Date(NOW - 10 * MIN) });
    const raced = (await runLifecycleSweep(NOW)).filter(r => r.box === 'raced');
    expect(raced.some(r => 'act' in r.decision && r.decision.act === 'stop')).toBe(false);
    expect(events.filter(e => e.name === 'box.parked' && e.detail.cause === 'stuck-start')).toEqual([]);
  });

  it('leaves a box alone once its agent connects after a stuck-start stop timed out back to ready', async () => {
    const { connectUpdate } = await import('./instanceLifecycle');
    seed('late', {
      idleHibernateHours: null, autoParkedAt: new Date(NOW - 20 * MIN), lastConnectedAt: new Date(NOW - 4 * 60 * MIN),
      lastActivityAt: new Date(NOW - 5 * 60 * MIN),
      lifecycleNote: 'Stopped automatically: it was started at 2026-10-09 09:00 UTC and its agent never connected.',
    });
    // The owner restarted the agent, as the warning said: this connect is the box's start.
    Object.assign(rows.get('late')!, connectUpdate(rows.get('late') as never, new Date(NOW - MIN)).data);
    agent.connectedIds.add('late');
    const late = (await runLifecycleSweep(NOW)).find(r => r.box === 'late');
    expect(late?.decision).toEqual({ hibernate: false, reason: 'just-started' });
    expect(power.calls).toEqual([]);
    // Past its start grace it is an ordinary idle box: warned before any stop, never quietly re-parked.
    expect((await runLifecycleSweep(NOW + 20 * MIN)).find(r => r.box === 'late')).toMatchObject({ decision: { warn: true }, outcome: 'warned' });
    expect(power.calls).toEqual([]);
  });

  it('the box list counts a stuck box down to its stop', async () => {
    stuck('dead', 31);
    await runLifecycleSweep(NOW);
    const view = await lifecycleViewFor({ id: 'u1' } as never, { ...rows.get('dead')!, lifecycleNote: null } as never, NOW);
    expect(view).toMatchObject({ parkAction: 'stop', parkAt: new Date(NOW + 2 * 60 * MIN).toISOString(), warnedAt: new Date(NOW).toISOString() });
  });

  it('lets an agent that connects, or Keep running, during the retry win', async () => {
    const note = 'Stopped automatically: it was started at 2026-10-09 09:00 UTC and its agent never connected.';
    seed('racing', { ...timedOutStop, lastConnectedAt: new Date(NOW - 4 * 60 * MIN), lifecycleNote: note });
    power.beforeWrite = id => { rows.get(id)!.lastConnectedAt = new Date(NOW); };
    await runLifecycleSweep(NOW);
    expect(rows.get('racing')!.status).toBe('ready');
    seed('kept', { ...timedOutStop, lastConnectedAt: new Date(NOW - 4 * 60 * MIN), lifecycleNote: note });
    power.beforeWrite = id => { rows.get(id)!.lastActivityAt = new Date(NOW); };
    await runLifecycleSweep(NOW);
    expect(rows.get('kept')!.status).toBe('ready');
  });

  it('leaves a box that is only slow, one whose agent is back, and one a busy check holds', async () => {
    stuck('slow', 29);
    stuck('back', 40);
    agent.connectedIds.add('back');
    stuck('held', 40);
    registerBoxBusyCheck('test', async ids => new Set(ids.filter(id => id === 'held')));
    const out = Object.fromEntries((await runLifecycleSweep(NOW)).map(r => [r.box, r]));
    expect(out.held?.decision).toEqual({ act: 'none', reason: 'busy', check: 'test' });
    expect(Object.keys(out)).not.toContain('slow');
    expect(Object.keys(out)).not.toContain('back');
    expect(power.calls).toEqual([]);
    expect(notices).toEqual([]);
  });

});

describe('parking by a stop', () => {
  const settleAll = async () => {
    for (const row of rows.values()) if (row.status === 'stopping') settle.listener!({ ...row }, 'stopped');
    await new Promise(r => setTimeout(r, 0));
  };

  it('stops a box on its own hours, with no warning and no DM, whether or not it can hibernate', async () => {
    const last = NOW - HOUR;
    seed('own', { idleHibernateHours: 1, lastActivityAt: new Date(last + MIN) });
    seed('legacy', { idleHibernateHours: 1, hibernationConfigured: false, lastActivityAt: new Date(last + MIN) });
    // A minute short of its hour: nothing, and no warning either.
    const early = await runLifecycleSweep(NOW);
    expect(early.map(r => [r.box, r.decision])).toEqual(expect.arrayContaining([
      ['own', { hibernate: false, reason: 'not-idle' }], ['legacy', { hibernate: false, reason: 'not-idle' }],
    ]));
    expect(rows.get('own')!.idleWarnedAt ?? null).toBe(null);

    const stopped = await runLifecycleSweep(NOW + MIN);
    expect(stopped.map(r => [r.box, r.outcome]).sort()).toEqual([['legacy', 'stopping'], ['own', 'stopping']]);
    expect(power.calls.map(([id, action]) => [id, action]).sort()).toEqual([['legacy', 'stop'], ['own', 'stop']]);
    expect(rows.get('own')!.lifecycleNote).toMatch(/^Stopped automatically after 1 h idle/);
    expect(agent.asked.sort()).toEqual(['unsaved-work:legacy', 'unsaved-work:own']);
    await settleAll();
    expect(notices).toEqual([]);
    expect(events.filter(e => e.name === 'box.idle.warned')).toEqual([]);
  });

  it('the default window still warns and tells its owner', async () => {
    seed('unset', { idleHibernateHours: null, lastActivityAt: new Date(NOW - 3 * HOUR), idleWarnedAt: new Date(NOW - HOUR), idleParkAt: new Date(NOW) });
    seed('fresh', { idleHibernateHours: null, lastActivityAt: new Date(NOW - 10 * HOUR) });
    await runLifecycleSweep(NOW);
    expect(notices.map(n => [n.kind, n.box])).toEqual([['warning', 'fresh']]);
    await settleAll();
    expect(notices.map(n => [n.kind, n.box]).sort()).toEqual([['parked', 'unset'], ['warning', 'fresh']]);
  });

  it('drops a warning an own-hours box was left with, since own hours never warn', async () => {
    seed('own', { lastActivityAt: new Date(NOW - 10 * MIN), idleWarnedAt: new Date(NOW - 10 * MIN), idleParkAt: new Date(NOW + 20 * MIN) });
    await runLifecycleSweep(NOW);
    expect(rows.get('own')).toMatchObject({ idleWarnedAt: null, idleParkAt: null });
  });

  it('terminates a box auto-park stopped once its terminate-after is up, clean at its own limit, else at 90 days', async () => {
    seedParked('clean', { status: 'stopped' });
    seedParked('unpushed', { status: 'stopped', hibernationConfigured: false, unsavedWork: { ...CLEAN, keptCheckouts: 1 } });
    seedParked('byhand', { status: 'stopped', parkedAt: null });
    const out = await runLifecycleSweep(NOW, terminator);
    expect(terminated).toEqual(['clean']);
    expect(rows.get('clean')!.lifecycleNote).toBe('Terminated automatically after 1 day parked.');
    expect(out.find(r => r.box === 'unpushed')!.decision).toEqual({ terminate: false, reason: 'not-due' });
    await runLifecycleSweep(NOW + 89 * DAY, terminator);
    expect(terminated).toEqual(['clean', 'unpushed']);
  });

  it('never terminates a box auto-park stopped when it has no terminate-after (--terminate-after off)', async () => {
    seedParked('stuck', { status: 'stopped', hibernatedTerminateDays: null, lifecycleNote: 'Stopped automatically: it was started at … and its agent never connected.' });
    seedParked('idle', { status: 'stopped', hibernatedTerminateDays: null, idleHibernateHours: 1 });
    seedParked('window', { status: 'stopped', hibernatedTerminateDays: null, idleHibernateHours: null });
    expect(await runLifecycleSweep(NOW + 400 * DAY, terminator)).toEqual([]);
    expect(terminated).toEqual([]);
  });

  it('the box list says stop and dates the terminate of a stopped box', async () => {
    seed('own', { idleHibernateHours: 4, hibernationConfigured: false, lastActivityAt: new Date(NOW - HOUR) });
    const view = await lifecycleViewFor({ id: 'u1' } as never, { ...rows.get('own')!, lifecycleNote: null } as never, NOW);
    expect(view).toMatchObject({ parkStop: true, parkAction: 'stop', warning: null, idleLimitHours: 4, parkAt: new Date(NOW + 3 * HOUR).toISOString() });
    seedParked('down', { status: 'stopped' });
    const down = await lifecycleViewFor({ id: 'u1' } as never, { ...rows.get('down')!, lifecycleNote: null } as never, NOW);
    expect(down).toMatchObject({ parkStop: true, terminateDueAt: new Date(NOW - DAY).toISOString(), unsavedWork: 'clean' });
  });
});
