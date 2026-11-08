/**
 * The box lifecycle against an automation that wakes its box, end to end
 * against a real Postgres: the scheduler (services/automations/scheduler.ts),
 * the power sweep (boxPower.ts) and the lifecycle sweep (boxLifecycle.ts) run
 * minute by minute on a fake clock, with EC2, the box's agent and the run's
 * turn faked at their edges. It replays what the orchestrator logged for the
 * PR babysitter on babysit-1027 on 2026-10-29/30: a box under a 6 h default
 * window with a 1 d terminate-after, an automation every 30 minutes with
 * Wake the box on, starts that fail for minutes on Insufficient capacity.
 *
 * Each scenario prints its timeline (the modules' own [AUTOMATION],
 * [LIFECYCLE] and [BOX] lines, stamped with the fake clock), so a run of this
 * file is the demo of the fix.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_autobox_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_autobox_${process.pid}$1`); });

/** EC2 as the boxes see it: one instance state per instance id, and starts that fail for capacity. */
const ec2 = vi.hoisted(() => ({
  state: new Map<string, string>(),
  capacityFailures: 0,
}));
vi.mock('@aws-sdk/client-ec2', () => {
  const command = (name: string) => class { constructor(public input: any) {} name = name; };
  return {
    StopInstancesCommand: command('StopInstances'),
    StartInstancesCommand: command('StartInstances'),
    DescribeInstancesCommand: command('DescribeInstances'),
    EC2Client: class {
      async send(cmd: { name: string; input: { InstanceIds: string[] } }) {
        const id = cmd.input.InstanceIds[0];
        if (cmd.name === 'StartInstances') {
          if (ec2.capacityFailures > 0) {
            ec2.capacityFailures--;
            throw Object.assign(new Error('Insufficient capacity.'), { name: 'InsufficientInstanceCapacity' });
          }
          ec2.state.set(id, 'running');
        } else if (cmd.name === 'StopInstances') {
          ec2.state.set(id, 'stopped');
        } else {
          return { Reservations: [{ Instances: [{ State: { Name: ec2.state.get(id) ?? 'stopped' } }] }] };
        }
        return {};
      }
    },
  };
});

/** The box's agent: connected while the box is up, with the chat runner and the unsaved-work scan. */
const agent = vi.hoisted(() => ({ connected: new Set<string>() }));
vi.mock('./agentRegistry', () => ({
  instanceAgentTransport: (id: string) => (agent.connected.has(id)
    ? { capabilities: ['chat-runner-v1', 'chat-auto-v1', 'unsaved-work-v1'] } : null),
  isInstanceAgentConnected: (id: string) => agent.connected.has(id),
  sendToInstanceAgent: async () => ({ scanned: 1, repos: [], errors: [], keptCheckouts: 0 }),
  sendForProject: async () => ({ ok: true }),
  dropInstanceAgent: () => {},
}));
vi.mock('./boxProvisioner', async importOriginal => ({
  ...(await importOriginal<typeof import('./boxProvisioner')>()),
  getBoxConfig: () => ({ region: 'us-east-2' }), awsClientConfig: () => ({ region: 'us-east-2' }),
}));
vi.mock('./productEvents', () => ({ recordProductEvent: () => {} }));
vi.mock('./status', () => ({ getAllStatuses: () => new Map() }));
// The flags as they were for one user: the default window on at 6 h, auto-lifecycle and automations on.
vi.mock('./featureFlags', () => ({
  boolVariation: async () => true,
  boolVariationForContext: async () => false,
  numberVariation: async (key: string, _u: unknown, fallback: number) => (key === 'box-idle-park-hours' ? 6 : fallback),
  jsonVariation: async () => null,
}));
// No other type of the box's shape has capacity either: the type walk (boxStartFallback.test.ts) rethrows the refusal.
vi.mock('./boxStartFallback', () => ({
  startOnFallbackType: async (_ec2: unknown, _instance: unknown, refusal: unknown) => { throw refusal; },
}));
const notices = vi.hoisted(() => [] as Array<{ kind: string; box: string; text: string }>);
vi.mock('./boxIdleNotices', async importOriginal => ({
  ...(await importOriginal<typeof import('./boxIdleNotices')>()),
  sendIdleNotice: async (kind: string, _owner: unknown, box: { name: string }, message: { text: string }) => {
    notices.push({ kind, box: box.name, text: message.text });
    return true;
  },
}));
// The run's turn: started on the box, finished by the test a minute later (as the relay would).
vi.mock('./automations/runner', () => ({
  startRun: async () => ({ kind: 'started', workstreamId: 'w', workstream: 'run', branch: 'automation/run' }),
}));
vi.mock('./automations/complete', () => ({
  reportRun: async () => {}, settleInterruptedRun: async () => {}, pushNotesForRun: async () => {},
  queueNotesPushForRun: async () => ({ done: Promise.resolve() }),
}));
vi.mock('../routes/workstreams', () => ({ removeWorkstreamFor: async () => ({ status: 200, body: {} }) }));

const MIN = 60_000;
const HOUR = 60 * MIN;
const CLEAN = { scanned: 1, repos: [], errors: [], keptCheckouts: 0 };

describe.skipIf(!adminUrl)('a box an automation wakes, against Postgres', () => {
  let prisma: typeof import('../db').prisma;
  let lifecycle: typeof import('./boxLifecycle');
  let power: typeof import('./boxPower');
  let scheduler: typeof import('./automations/scheduler');
  let policy: typeof import('./boxLifecyclePolicy');
  let connectUpdate: typeof import('./instanceLifecycle').connectUpdate;
  let store: typeof import('./automations/store');
  let activity: Partial<typeof import('./boxActivity')>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = spawnSync(join(__dirname, '../../node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: join(__dirname, '../..'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);
    ({ prisma } = await import('../db'));
    lifecycle = await import('./boxLifecycle');
    power = await import('./boxPower');
    scheduler = await import('./automations/scheduler');
    policy = await import('./boxLifecyclePolicy');
    ({ connectUpdate } = await import('./instanceLifecycle'));
    store = await import('./automations/store');
    activity = await import('./boxActivity');
    await prisma.user.create({ data: { id: 'u1', googleId: 'g-u1', googleEmail: 'zmay@example.com', unixUsername: 'zmay', displayName: 'Zane' } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const terminated: string[] = [];
  const stops = () => timeline.filter(l => l.includes('[LIFECYCLE] babysit-1027') && /stopping|terminated/.test(l));
  /** The timeline: the modules' own log lines, stamped with the fake clock. */
  let timeline: string[] = [];
  let clock = 0;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    timeline = [];
    terminated.length = 0;
    notices.length = 0;
    agent.connected.clear();
    ec2.state.clear();
    ec2.capacityFailures = 0;
    const stamp = (...args: unknown[]) => {
      const line = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
      if (/^\[(AUTOMATION|LIFECYCLE|BOX)\]/.test(line)) timeline.push(`${new Date(clock).toISOString().slice(5, 19).replace('T', ' ')}  ${line}`);
    };
    vi.spyOn(console, 'log').mockImplementation(stamp);
    vi.spyOn(console, 'warn').mockImplementation(stamp);
    vi.spyOn(console, 'error').mockImplementation(stamp);
    await prisma.automationRun.deleteMany({});
    await prisma.automation.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.instance.deleteMany({});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.stdout.write(`\n  ── ${expect.getState().currentTestName}\n${timeline.map(l => `  ${l}`).join('\n')}\n`);
  });

  /** The terminate the sweep calls: the owner's terminate as far as the database goes (projects archived, box terminated). */
  const terminator = async (_user: unknown, box: { id: string; name: string }) => {
    terminated.push(box.name);
    await prisma.project.updateMany({ where: { instanceId: box.id, archived: false }, data: { archived: true } });
    await prisma.instance.update({ where: { id: box.id }, data: { status: 'terminated', terminatedAt: new Date(clock) } });
    console.log(`[BOX] Terminated box resources for ${box.name}`);
  };

  /**
   * babysit-1027 as the sweep left it on 10-29 at 00:58: stopped by the
   * default window after 6 h idle, parked since, its scan clean, so it is
   * terminated a day after that stop.
   */
  async function seedBox(over: Record<string, unknown> = {}) {
    const parkedAt = new Date('2026-10-29T00:58:00Z');
    const box = await prisma.instance.create({
      data: {
        userId: 'u1', name: 'babysit-1027', kind: 'ec2', status: 'stopped', region: 'us-east-2', ec2InstanceId: 'i-0fedcba9876543210',
        hostHome: '/home/zmay', idleHibernateHours: null, hibernatedTerminateDays: 1,
        lastActivityAt: new Date(parkedAt.getTime() - 6 * HOUR), readyAt: new Date('2026-10-27T10:00:00Z'),
        autoParkedAt: new Date(parkedAt.getTime() - MIN), parkedAt, lifecycleNote: policy.autoStopNote(6),
        unsavedWork: CLEAN, unsavedWorkCheckedAt: new Date(parkedAt.getTime() - MIN),
        ...over,
      },
    });
    ec2.state.set(box.ec2InstanceId!, box.status === 'ready' ? 'running' : 'stopped');
    return box;
  }

  async function seedAutomation(boxId: string, startAt: number, over: Record<string, unknown> = {}) {
    const project = await prisma.project.create({ data: { name: 'pr-babysitter', userId: 'u1', instanceId: boxId, kind: 'automation' } });
    return prisma.automation.create({
      data: {
        projectId: project.id, userId: 'u1', schedule: '*/30 * * * *', timezone: 'UTC', prompt: 'babysit the PRs',
        wakeBox: true, maxRunMinutes: 40, lastOccurrence: new Date(startAt - 30 * MIN), nextRunAt: new Date(startAt),
        ...over,
      },
    });
  }

  const box = () => prisma.instance.findFirstOrThrow({ where: { name: 'babysit-1027' } });

  /**
   * One minute of the orchestrator: the lifecycle sweep every five minutes
   * (at :x0:28 in the log, before the scheduler's tick at :x0:30), the
   * scheduler's tick, the power sweep, the box's agent connecting once EC2
   * runs it, and the relay finishing each turn `runMinutes` after it started.
   */
  async function minute(t: number, runMinutes: number) {
    clock = t;
    vi.setSystemTime(t);
    if (Math.round(t / MIN) % 5 === 0) await lifecycle.runLifecycleSweep(t, terminator);
    await scheduler.schedulerTick(new Date(t));
    await power.sweepPowerStates(t);
    const b = await box();
    if (b.status === 'starting' && ec2.state.get(b.ec2InstanceId!) === 'running' && !agent.connected.has(b.id)) {
      const { where, data } = connectUpdate(b, new Date(t));
      await prisma.instance.updateMany({ where, data });
      agent.connected.add(b.id);
    }
    if (b.status === 'stopping' || b.status === 'stopped' || b.status === 'terminated') agent.connected.delete(b.id);
    const done = await prisma.automationRun.findMany({ where: { state: 'running', startedAt: { lte: new Date(t - runMinutes * MIN) } } });
    for (const r of done) {
      await prisma.automationRun.update({ where: { id: r.id }, data: { state: 'done', finishedAt: new Date(t) } });
      // What complete.ts does once the row is finished (absent before the fix).
      await activity.noteAutomationRunActivity?.(r.instanceId, new Date(t));
      console.log(`[AUTOMATION] pr-babysitter ${r.scheduledFor.toISOString()} → done`);
    }
  }

  /** Run the orchestrator from `from` to `to`, a minute at a time; `capacity` says how many starts fail at each occurrence. */
  async function run(from: string, to: string, { runMinutes = 1, capacity = {} as Record<string, number> } = {}) {
    for (let t = Date.parse(from); t <= Date.parse(to); t += MIN) {
      const at = new Date(t).toISOString().slice(11, 16);
      if (capacity[at] !== undefined) ec2.capacityFailures = capacity[at];
      await minute(t, runMinutes);
    }
  }

  // Starts failed on capacity for minutes at these occurrences (the log's
  // retries), so the run starts at :36 and its box is up until about :55.
  const CAPACITY = { '23:30': 4, '00:00': 6, '00:30': 6 };

  it('replays 10-29 23:00 to 10-30 01:05: the box stays up for its automation and is never terminated', async () => {
    const b = await seedBox();
    const a = await seedAutomation(b.id, Date.parse('2026-10-29T23:00:00Z'));
    await run('2026-10-29T22:59:30Z', '2026-10-30T01:05:30Z', { capacity: CAPACITY });

    const after = await box();
    const automation = await prisma.automation.findUniqueOrThrow({ where: { id: a.id }, include: { project: true } });
    const runs = await prisma.automationRun.findMany({ where: { automationId: a.id }, orderBy: { scheduledFor: 'asc' } });
    // Every occurrence ran: 23:00 … 01:00.
    expect(runs.map(r => [r.scheduledFor.toISOString().slice(11, 16), r.state])).toEqual([
      ['23:00', 'done'], ['23:30', 'done'], ['00:00', 'done'], ['00:30', 'done'], ['01:00', 'done'],
    ]);
    // Each run restarted the idle clock, so the 6 h window never came round
    // and the sweep never stopped the box in between.
    expect(stops()).toEqual([]);
    expect(after.status).toBe('ready');
    expect(after.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-10-30T01:00:00Z'));
    // Not terminated, its automation still there and enabled.
    expect(terminated).toEqual([]);
    expect(automation.project.archived).toBe(false);
    expect(automation.enabled).toBe(true);
    expect(automation.pausedReason).toBeNull();
  }, 120_000);

  it('a live run holds the box past its window, and its end restarts the idle clock', async () => {
    // Up and idle 7 h, past its 6 h window, when a 30-minute run starts.
    const b = await seedBox({
      status: 'ready', parkedAt: null, autoParkedAt: null, lifecycleNote: null,
      lastActivityAt: new Date('2026-10-29T16:00:00Z'), lastReadyAt: new Date('2026-10-29T10:00:00Z'),
    });
    agent.connected.add(b.id);
    const a = await seedAutomation(b.id, Date.parse('2026-10-29T23:00:00Z'), { schedule: '0 23 * * *' });
    await run('2026-10-29T22:59:30Z', '2026-10-29T23:45:30Z', { runMinutes: 30 });

    const runs = await prisma.automationRun.findMany({ where: { automationId: a.id } });
    expect(runs.map(r => r.state)).toEqual(['done']);
    const after = await box();
    expect(after.status).toBe('ready');
    expect(stops()).toEqual([]);
    // The clock reads from the run's end, so the window counts from there.
    expect(after.lastActivityAt!.toISOString()).toBe('2026-10-29T23:30:30.000Z');
  }, 120_000);

  it('terminate-after counts from when the box last became stopped, not from its first auto-park', async () => {
    // Parked on 10-29 at 00:58; woken without its owner (a reviewer, an
    // automation that has since been disabled) on 10-29 at 22:00 and stopped
    // again by the sweep; on 10-30 at 01:05 that is not "stopped 1 d".
    const b = await seedBox();
    const t0 = Date.parse('2026-10-29T22:00:00Z');
    clock = t0; vi.setSystemTime(t0);
    await power.requestPower(b, 'start', { startedBy: 'automation' });
    const { where, data } = connectUpdate(await box(), new Date(t0 + MIN));
    await prisma.instance.updateMany({ where, data });
    agent.connected.add(b.id);
    await run('2026-10-29T22:05:00Z', '2026-10-30T01:05:30Z');

    const after = await box();
    expect(timeline.some(l => l.includes('[LIFECYCLE] babysit-1027') && l.includes('stopping'))).toBe(true);
    expect(after.status).toBe('stopped');
    expect(after.parkedAt!.getTime()).toBeGreaterThan(Date.parse('2026-10-29T22:00:00Z'));
    expect(terminated).toEqual([]);
  }, 120_000);

  it('never terminates a box that hosts an enabled automation; pauses nothing silently', async () => {
    // Parked 2 days, its terminate-after long up, and an automation that can't
    // wake it still enabled on it.
    const b = await seedBox({ parkedAt: new Date('2026-10-28T00:00:00Z') });
    const a = await seedAutomation(b.id, Date.parse('2026-10-31T00:00:00Z'), { wakeBox: false });
    clock = Date.parse('2026-10-30T01:00:00Z'); vi.setSystemTime(clock);
    const results = await lifecycle.runLifecycleSweep(clock, terminator);

    expect(terminated).toEqual([]);
    expect(results.find(r => r.box === 'babysit-1027')?.decision).toEqual({ terminate: false, reason: 'hosts-automation' });
    expect((await box()).status).toBe('stopped');
    expect((await prisma.project.findFirstOrThrow({ where: { id: a.projectId } })).archived).toBe(false);

    // Once the automation is disabled, the box goes as its settings say.
    await prisma.automation.update({ where: { id: a.id }, data: { enabled: false } });
    await lifecycle.runLifecycleSweep(clock, terminator);
    expect(terminated).toEqual(['babysit-1027']);
  }, 120_000);

  it('a terminate that goes ahead anyway pauses the automations on the box and tells the owner', async () => {
    const b = await seedBox();
    const a = await seedAutomation(b.id, Date.parse('2026-10-31T00:00:00Z'));
    clock = Date.parse('2026-10-30T01:00:00Z'); vi.setSystemTime(clock);
    const paused = await (lifecycle as any).pauseAutomationsForTerminate(b, 'lifecycle');

    expect(paused).toEqual(['pr-babysitter']);
    const after = await prisma.automation.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.pausedReason).toBe('box_gone');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'automation-paused', box: 'babysit-1027' });
    expect(notices[0].text).toContain('pr-babysitter');
  }, 120_000);

  it('starts that fail on capacity show on the automation, and a start that takes clears them', async () => {
    const b = await seedBox();
    const a = await seedAutomation(b.id, Date.parse('2026-10-30T00:00:00Z'));
    await run('2026-10-29T23:59:30Z', '2026-10-30T00:03:30Z', { capacity: { '00:00': 6 } });

    let view = await store.automationView(await prisma.automation.findUniqueOrThrow({ where: { id: a.id }, include: store.AUTOMATION_INCLUDE }), 'u1', new Date(clock));
    expect(view.boxStartFailures).toEqual({ count: 4, since: '2026-10-30T00:00:30.000Z', lastError: 'Insufficient capacity.' });

    await run('2026-10-30T00:04:30Z', '2026-10-30T00:08:30Z');
    view = await store.automationView(await prisma.automation.findUniqueOrThrow({ where: { id: a.id }, include: store.AUTOMATION_INCLUDE }), 'u1', new Date(clock));
    expect(view.boxStartFailures).toBeNull();
    expect((await prisma.automationRun.findFirstOrThrow({ where: { automationId: a.id } })).state).toBe('done');
  }, 120_000);

  it('an ask box (applyAskBoxPolicy) hosting an automation is held by its runs and never terminated', async () => {
    const b = await seedBox({ status: 'ready', parkedAt: null, autoParkedAt: null, lifecycleNote: null, lastReadyAt: new Date('2026-10-29T10:00:00Z') });
    await lifecycle.applyAskBoxPolicy(b.id);
    agent.connected.add(b.id);
    await seedAutomation(b.id, Date.parse('2026-10-29T23:00:00Z'));
    await run('2026-10-29T22:59:30Z', '2026-10-30T01:05:30Z');

    const after = await box();
    expect(after.createdFor).toBe('ask');
    expect(stops()).toEqual([]);
    expect(after.hibernatedTerminateDays).toBeNull();
    expect(after.status).toBe('ready');
    expect(terminated).toEqual([]);
  }, 120_000);
});
