import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../db';
import { instanceAgentTransport, isInstanceAgentConnected, onBoxAgentHello, sendToInstanceAgent } from '../agentRegistry';
import { boolVariation, jsonVariation } from '../featureFlags';
import { AUTO_UPDATE, autoUpdateSummary, resetAutoUpdateForTests, runAutoUpdateSweep, startToolAutoUpdateSweep, stopToolAutoUpdateSweep, type PassEntry } from './autoRuns';
import { pumpFleet, queueAutoRun } from './runs';
import { TOOL_REGISTRY } from './components';
import { PI_PINNED_LATEST } from '../piUpdatePolicy';

// A made-up fleet: every name here is invented. No fake timers (they fake Intl, which the night reads).
const H = 3600_000;
const NOW = Date.parse('2026-11-02T02:00:00Z'); // 03:00 in Berlin, 21:00 in New York
const ago = (h: number) => new Date(NOW - h * H);

const runs = new Map<string, Record<string, any>>();
const states = new Map<string, Record<string, any>>();
const boxes = new Map<string, Record<string, any>>();
const inventory = new Map<string, string>();
let nextId = 0;
const newId = () => `auto${String(++nextId).padStart(22, '0')}`;
const matches = (r: Record<string, any>, where: Record<string, any>): boolean => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return (v as Array<Record<string, any>>).some(w => matches(r, w));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(r[k]);
    if ('notIn' in v) return !v.notIn.includes(r[k]);
    if ('lt' in v) return r[k] < v.lt;
    if ('gte' in v) return r[k] >= v.gte;
    if ('not' in v) return v.not === null ? r[k] != null : r[k] !== v.not;
  }
  return v instanceof Date ? r[k]?.getTime?.() === v.getTime() : r[k] === v;
});

vi.mock('../../db', () => {
  const prisma: any = {
    softwareUpdateRun: {
      create: vi.fn(async ({ data }: any) => { const r = { id: newId(), requestedAt: new Date(NOW), startedAt: null, finishedAt: null, ...data }; runs.set(r.id, r); return r; }),
      findMany: vi.fn(async ({ where, distinct }: any) => {
        let out = [...runs.values()].filter(r => matches(r, where ?? {})).sort((a, b) => b.requestedAt - a.requestedAt);
        if (distinct) { const seen = new Set(); out = out.filter(r => !seen.has(r.hostKey) && seen.add(r.hostKey)); }
        return out;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => { const hit = [...runs.values()].filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; }),
    },
    toolAutoUpdateState: {
      findUnique: vi.fn(async ({ where }: any) => { const r = states.get(`${where.hostKey_component.hostKey}:${where.hostKey_component.component}`); return r ? { ...r } : null; }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const k = `${where.hostKey_component.hostKey}:${where.hostKey_component.component}`;
        if (!states.has(k)) states.set(k, { breachFloor: null, breachSince: null, ...create });
        else Object.assign(states.get(k)!, update);
        return { ...states.get(k) };
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(states.get(`${where.hostKey_component.hostKey}:${where.hostKey_component.component}`)!, data)),
    },
    instance: {
      findMany: vi.fn(async ({ where }: any) => [...boxes.values()].filter(b => b.status === where.status && (!where.id || b.id === where.id)).sort((a, b) => a.name.localeCompare(b.name))),
      updateMany: vi.fn(async ({ where, data }: any) => { const hit = [...boxes.values()].filter(b => matches(b, where)); hit.forEach(b => Object.assign(b, data)); return { count: hit.length }; }),
    },
    hostSoftware: { findMany: vi.fn(async ({ where }: any) => { const inv = where.component === 'codex' ? codexInventory : where.component === 'cursor-agent' ? cursorInventory : where.component === 'devin' ? devinInventory : where.component === 'pi' ? piInventory : where.component === 'gh' ? ghInventory : where.component === 'aws' ? awsInventory : where.component === 'node' ? nodeInventory : where.component === 'python' ? pythonInventory : where.component === 'docker' ? dockerInventory : inventory; return (where.hostKey ? where.hostKey.in.filter((k: string) => inv.has(k)) : [...inv.keys()]).map((k: string) => ({ hostKey: k, version: inv.get(k), ok: true })); }) },
  };
  prisma.$transaction = vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn({ ...prisma, $executeRaw: async () => {} }));
  return { prisma };
});
vi.mock('../agentRegistry', () => {
  class AgentReplyError extends Error {}
  class AgentNotConnectedError extends Error {}
  return {
    AgentReplyError, AgentNotConnectedError,
    inventoryHosts: vi.fn(() => []),
    instanceAgentTransport: vi.fn(),
    isInstanceAgentConnected: vi.fn(),
    sendToInstanceAgent: vi.fn(async () => ({ started: true })),
    onBoxAgentHello: vi.fn(() => () => {}),
  };
});
vi.mock('../agentRuntime', () => ({ ensureAgentSessionsAndLaunch: vi.fn() }));
vi.mock('../agentSpawnStore', () => ({ isParkedSpawn: vi.fn(async () => false) }));
/**
 * The flag source: `ld.raw` is what a flag serves, and each tool's policy flag
 * gets the mode its sets below say (`ld.modeOf`) unless the value names one,
 * so a case that serves its own policy keys keeps its tool's mode.
 */
const ld = vi.hoisted(() => ({
  raw: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  modeOf: null as null | ((key: string, boxId: string) => string | undefined),
}));
vi.mock('../featureFlags', () => ({
  boolVariation: vi.fn(async () => false),
  jsonVariation: vi.fn(async (key: string, user: unknown, fallback: unknown, box?: { id: string }) => {
    const v = await ld.raw(key, user, fallback, box);
    const mode = box && ld.modeOf ? ld.modeOf(key, box.id) : undefined;
    if (mode === undefined) return v;
    const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    return 'mode' in o ? o : { ...o, mode };
  }),
}));
vi.mock('../software/collector', () => ({ refreshHostInventory: vi.fn() }));
vi.mock('../status', () => ({ getStatus: vi.fn(() => ({ status: 'not_running' })) }));

const user = (id: string, unixUsername: string, timeZone: string | null) => ({ id, unixUsername, timeZone, googleEmail: `${unixUsername}@example.test`, displayName: unixUsername, defaultAgentProvider: 'claude' });
const robin = user('u-robin', 'robin', 'Europe/Berlin');
const sasha = user('u-sasha', 'sasha', 'America/New_York');
const kim = user('u-kim', 'kim', null);

interface Seed { owner?: ReturnType<typeof user>; coldStartH?: number; firstBoot?: boolean; version?: string; connected?: boolean; capable?: boolean; activity?: number | null; resumed?: boolean; lastRunH?: number | null; breachH?: number; autoOff?: boolean; updateOff?: boolean; inFlight?: boolean }
const offline = new Set<string>(), incapable = new Set<string>(), autoOff = new Set<string>(), updateOff = new Set<string>();
// Codex: its flags and its capability are each box's own, off unless a case turns them on.
const codexAuto = new Set<string>(), codexUpdate = new Set<string>(), codexCapable = new Set<string>();
const codexInventory = new Map<string, string>();
// The Cursor agent, the same way.
const cursorAuto = new Set<string>(), cursorUpdate = new Set<string>(), cursorCapable = new Set<string>();
const cursorInventory = new Map<string, string>();
// The Devin CLI, the same way.
const devinAuto = new Set<string>(), devinUpdate = new Set<string>(), devinCapable = new Set<string>();
const devinInventory = new Map<string, string>();
// pi, the same way.
const piAuto = new Set<string>(), piUpdate = new Set<string>(), piCapable = new Set<string>();
const piInventory = new Map<string, string>();
// gh, the same way.
const ghAuto = new Set<string>(), ghUpdate = new Set<string>(), ghCapable = new Set<string>();
const ghInventory = new Map<string, string>();
// The AWS CLI, the same way.
const awsAuto = new Set<string>(), awsUpdate = new Set<string>(), awsCapable = new Set<string>();
const awsInventory = new Map<string, string>();
// Node, the same way.
const nodeAuto = new Set<string>(), nodeUpdate = new Set<string>(), nodeCapable = new Set<string>();
const nodeInventory = new Map<string, string>();
// Python, the same way.
const pythonAuto = new Set<string>(), pythonUpdate = new Set<string>(), pythonCapable = new Set<string>();
const pythonInventory = new Map<string, string>();
// Docker, the same way.
const dockerAuto = new Set<string>(), dockerUpdate = new Set<string>(), dockerCapable = new Set<string>();
const dockerInventory = new Map<string, string>();
/** Each box's live agent connection, as the registry hands it out; a reconnect is a new object. */
const conns = new Map<string, object>();
function seed(name: string, s: Seed = {}) {
  const id = `box-${name}`;
  const owner = s.owner ?? robin;
  boxes.set(id, {
    id, name, kind: 'ec2', status: 'ready', userId: owner.id, user: owner,
    lastActivityAt: s.activity === null ? null : ago(s.activity ?? 3), lastConnectedAt: ago(5),
    resumedFromHibernationAt: s.resumed ? ago(0.1) : null,
    // When the box last came up (a start, a resume, a first boot) and first ever did; hibernatedAt is kept through a resume only.
    lastReadyAt: s.coldStartH !== undefined ? ago(s.coldStartH) : s.resumed ? ago(0.1) : ago(240),
    readyAt: s.firstBoot && s.coldStartH !== undefined ? ago(s.coldStartH) : ago(240),
    hibernatedAt: s.resumed ? ago(30) : null, rehibernatePending: false,
  });
  inventory.set(id, s.version ?? '2.1.316');
  if (s.connected === false) offline.add(id);
  if (s.capable === false) incapable.add(id);
  if (s.autoOff) autoOff.add(id);
  if (s.updateOff) updateOff.add(id);
  // Last night's run, 25 h ago, unless the case says otherwise (null: never a run).
  const lastRunH = s.lastRunH === undefined ? 25 : s.lastRunH;
  if (lastRunH !== null) runs.set(`last-${id}`, { id: `last-${id}`, hostKey: id, component: 'claude', trigger: 'nightly', status: 'done', requestedAt: ago(lastRunH), startedAt: ago(lastRunH), finishedAt: ago(lastRunH) });
  if (s.inFlight) runs.set(`fl-${id}`, { id: `inflight${id.padEnd(16, 'x')}`, hostKey: id, component: 'claude', trigger: 'manual', status: 'running', requestedAt: ago(0.2), startedAt: ago(0.2) });
  // The sweep has known the box for ten days; a breach started breachH hours ago.
  states.set(`${id}:claude`, { hostKey: id, component: 'claude', firstSeenAt: ago(240), lastSeenAt: ago(0.25), breachFloor: s.breachH !== undefined ? '2.1.308' : null, breachSince: s.breachH !== undefined ? ago(s.breachH) : null, breachSeenAt: s.breachH !== undefined ? ago(0.25) : null });
  return id;
}

/** The box's policy fetch starting every queued run, as runs.ts boxPolicy does: each has now reached its box. */
const startQueued = (at = NOW) => { for (const r of runs.values()) if (r.status === 'requested') Object.assign(r, { status: 'running', startedAt: new Date(at) }); };
const rpcs = () => vi.mocked(sendToInstanceAgent).mock.calls.filter(c => c[1] === 'tool-update');
const byBox = (entries: PassEntry[], component = 'claude') => Object.fromEntries(entries.filter(e => e.component === component).map(e => [e.boxName, e.outcome === 'queued' || e.outcome === 'paced' ? `${e.outcome} ${e.trigger}/${e.restart}` : e.outcome]));

beforeEach(() => {
  runs.clear(); states.clear(); boxes.clear(); inventory.clear();
  for (const s of [offline, incapable, autoOff, updateOff, codexAuto, codexUpdate, codexCapable, cursorAuto, cursorUpdate, cursorCapable, devinAuto, devinUpdate, devinCapable, piAuto, piUpdate, piCapable, ghAuto, ghUpdate, ghCapable, awsAuto, awsUpdate, awsCapable, nodeAuto, nodeUpdate, nodeCapable, pythonAuto, pythonUpdate, pythonCapable, dockerAuto, dockerUpdate, dockerCapable]) s.clear();
  codexInventory.clear(); cursorInventory.clear(); devinInventory.clear(); piInventory.clear(); ghInventory.clear(); awsInventory.clear(); nodeInventory.clear(); pythonInventory.clear(); dockerInventory.clear(); conns.clear();
  resetAutoUpdateForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(isInstanceAgentConnected).mockImplementation((id: string) => !offline.has(id));
  vi.mocked(instanceAgentTransport).mockImplementation(((id: string) => ({ conn: conns.get(id) ?? conns.set(id, { id }).get(id), agentCommit: null, capabilities: [...(incapable.has(id) ? ['box-update-v1'] : ['tool-update-v1']), ...(codexCapable.has(id) ? ['tool-update-codex-v1'] : []), ...(cursorCapable.has(id) ? ['tool-update-cursor-v1'] : []), ...(devinCapable.has(id) ? ['tool-update-devin-v1'] : []), ...(piCapable.has(id) ? ['tool-update-pi-v1'] : []), ...(ghCapable.has(id) ? ['tool-update-gh-v1'] : []), ...(awsCapable.has(id) ? ['tool-update-aws-v1'] : []), ...(nodeCapable.has(id) ? ['tool-update-node-v1'] : []), ...(pythonCapable.has(id) ? ['tool-update-python-v1'] : []), ...(dockerCapable.has(id) ? ['tool-update-docker-v1'] : [])] })) as never);
  // Each tool's mode, per box: off unless its update set has the box, then auto or manual by its auto set.
  const sets: Record<string, (id: string) => [auto: boolean, update: boolean]> = {
    'claude-code-update-policy': id => [!autoOff.has(id), !updateOff.has(id)],
    'codex-update-policy': id => [codexAuto.has(id), codexUpdate.has(id)],
    'cursor-update-policy': id => [cursorAuto.has(id), cursorUpdate.has(id)],
    'devin-update-policy': id => [devinAuto.has(id), devinUpdate.has(id)],
    'pi-update-policy': id => [piAuto.has(id), piUpdate.has(id)],
    'gh-update-policy': id => [ghAuto.has(id), ghUpdate.has(id)],
    'aws-update-policy': id => [awsAuto.has(id), awsUpdate.has(id)],
    'node-update-policy': id => [nodeAuto.has(id), nodeUpdate.has(id)],
    'python-update-policy': id => [pythonAuto.has(id), pythonUpdate.has(id)],
    'docker-update-policy': id => [dockerAuto.has(id), dockerUpdate.has(id)],
  };
  ld.modeOf = (key, id) => {
    const set = sets[key];
    if (!set) return undefined;
    const [auto, update] = set(id);
    return update ? (auto ? 'auto' : 'manual') : 'off';
  };
  ld.raw.mockImplementation(async () => null);
});
afterEach(async () => { stopToolAutoUpdateSweep(); runs.clear(); await pumpFleet(); vi.clearAllMocks(); });

describe('AUTO_UPDATE', () => {
  it('lists every tool, and each reads its own auto through its descriptor (components.test.ts has the mode table)', async () => {
    expect([...AUTO_UPDATE]).toEqual(['claude', 'codex', 'cursor', 'devin', 'pi', 'gh', 'aws', 'node', 'python', 'docker']);
    for (const component of AUTO_UPDATE) {
      await TOOL_REGISTRY[component].auto(robin as never, { id: 'box-x', name: 'x', kind: 'ec2' });
      expect(vi.mocked(jsonVariation).mock.calls.at(-1)).toEqual([TOOL_REGISTRY[component].policyFlag, robin, null, { id: 'box-x', name: 'x', kind: 'ec2' }]);
    }
  });
});

describe('Docker: queued for the box\'s next start', () => {
  it('a box behind the fleet gets a nightly run written for its next start: never sent, no pacer slot, no resume run', async () => {
    const ids = ['fig', 'olive', 'plum', 'sage'].map(n => seed(n, { autoOff: true }));
    for (const id of ids) { dockerAuto.add(id); dockerUpdate.add(id); dockerCapable.add(id); }
    dockerInventory.set('box-fig', '29.10.0');       // behind the fleet's newest (and above the floor)
    dockerInventory.set('box-olive', '29.10.1');     // the fleet's newest: current
    dockerInventory.set('box-plum', '29.8.1');       // below the floor 29.9.3
    dockerInventory.set('box-sage', '29.10.0');
    boxes.get('box-sage')!.resumedFromHibernationAt = ago(0.1);
    // The pacer has no slot at all: the Docker runs are written anyway.
    for (let i = 0; i < 10; i++) runs.set(`busy${i}`, { id: `busy${i}`.padEnd(24, '0'), hostKey: `other${i}`, component: 'claude', trigger: 'manual', status: 'running', requestedAt: ago(0.1), startedAt: ago(0.1) });
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries, 'docker')).toEqual({ fig: 'queued nightly/none', olive: 'current', plum: 'queued floor/none', sage: 'queued nightly/none' });
    await pumpFleet();
    expect(rpcs()).toEqual([]);
    const docker = [...runs.values()].filter(r => r.component === 'docker');
    expect(docker.map(r => r.status)).toEqual(['requested', 'requested', 'requested']);
    // Still requested a day on (it waits for the start, not 15 minutes), and it holds the box: no second run.
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 25 * H }), 'docker')).toMatchObject({ fig: 'run-in-flight', plum: 'run-in-flight' });
    expect(docker.every(r => r.status === 'requested')).toBe(true);
  });
});

describe('Docker and a cold start (coldStart.ts, #1304)', () => {
  it('a cold start gives Docker no resume run: it is sessionless, and its runs install only at a start anyway', async () => {
    const fig = seed('fig', { autoOff: true, coldStartH: 0.5, activity: 0 });
    const olive = seed('olive', { autoOff: true });
    for (const id of [fig, olive]) { dockerAuto.add(id); dockerUpdate.add(id); dockerCapable.add(id); }
    dockerInventory.set(fig, '29.10.0'); dockerInventory.set(olive, '29.10.1');
    // A Docker run reached fig 5 h ago, before this morning's stop: only the nightly rules could give it one, and they don't yet.
    runs.set('dk-last', { id: 'dk-last'.padEnd(24, '0'), hostKey: fig, component: 'docker', trigger: 'nightly', status: 'done', outcome: 'updated', requestedAt: ago(5), startedAt: ago(5), finishedAt: ago(5) });
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries, 'docker').fig).toBe('ran-recently');
    expect([...runs.values()].some(r => r.component === 'docker' && r.trigger === 'resume')).toBe(false);
  });
});

describe('Docker: behind the whole fleet (Bugbot on #1305)', () => {
  it('compares with every host\'s Docker, not only the boxes its auto flag is on for', async () => {
    const fig = seed('fig', { autoOff: true });
    dockerAuto.add(fig); dockerUpdate.add(fig); dockerCapable.add(fig);
    dockerInventory.set(fig, '29.10.0');
    // A box the flag is off for, already on a newer Docker: fig is behind it.
    seed('olive', { autoOff: true }); dockerInventory.set('box-olive', '29.10.1');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'docker').fig).toBe('queued nightly/none');
  });
});

describe('Docker: a run that waited days for its start (Bugbot on #1305)', () => {
  it('counts from when it reached the box, its start, not from when it was asked for', async () => {
    const fig = seed('fig', { autoOff: true });
    dockerAuto.add(fig); dockerUpdate.add(fig); dockerCapable.add(fig);
    dockerInventory.set(fig, '29.10.0');
    seed('olive', { autoOff: true }); dockerAuto.add('box-olive'); dockerUpdate.add('box-olive'); dockerInventory.set('box-olive', '29.10.1');
    // Asked for three days ago, started at this morning's boot: the day's run.
    runs.set('waited', { id: 'waited'.padEnd(24, '0'), hostKey: fig, component: 'docker', trigger: 'nightly', status: 'done', outcome: 'updated', requestedAt: ago(72), startedAt: ago(0.2), finishedAt: ago(0.2) });
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'docker')).toMatchObject({ fig: 'ran-recently' });
  });
});

describe('a cold start counts as a resume (coldStart.ts)', () => {
  it('a box started from stopped gets its install-only resume run; a reconnect, a first boot and a boot run that already ran do not', async () => {
    // Every box is in use (activity now) and had a run 5 h ago, so the nightly rules give none of them a run.
    seed('apple', { coldStartH: 0.5, lastRunH: 5, activity: 0 });                 // stopped overnight, started this morning
    seed('bramble', { coldStartH: 20, lastRunH: 5, activity: 0 });                // started yesterday, a run since; its agent just reconnected
    boxes.get('box-bramble')!.lastConnectedAt = ago(0.05);
    seed('cherry', { resumed: true, lastRunH: 5, activity: 0 });                   // resumed from hibernation: the stored marker, as before
    seed('damson', { coldStartH: 0.5, firstBoot: true, lastRunH: 5, activity: 0 }); // its first boot: the image's tools and its setup
    seed('elder', { coldStartH: 0.5, lastRunH: 5, activity: 0 });                 // started, and Claude Code's boot unit reported a run in that boot
    runs.set('boot-elder', { id: 'boot-elder', hostKey: 'box-elder', component: 'claude', trigger: 'boot', status: 'done', requestedAt: ago(0.6), startedAt: ago(0.6), finishedAt: ago(0.6) });

    const entries = await runAutoUpdateSweep({ now: NOW });
    // COLD_START_DEMO=<file> writes the pass as the PR's demo transcript (run it on main for the "before").
    if (process.env.COLD_START_DEMO) {
      const lines = entries.filter(e => e.component === 'claude').map(e => `${e.boxName.padEnd(8)} ${e.component.padEnd(7)} ${(e.outcome === 'queued' ? `run ${e.trigger} (restart ${e.restart})` : `skip ${e.outcome}`).padEnd(26)} ${e.reason ?? ''}`.trimEnd());
      writeFileSync(process.env.COLD_START_DEMO, `sweep pass at ${new Date(NOW).toISOString()}\n\n${'box'.padEnd(8)} ${'tool'.padEnd(7)} ${'decision'.padEnd(26)} why\n${lines.join('\n')}\n`);
    }
    expect(byBox(entries)).toEqual({
      apple: 'queued resume/none', bramble: 'ran-recently', cherry: 'queued resume/none', damson: 'ran-recently', elder: 'ran-recently',
    });
    const reasons = Object.fromEntries(entries.filter(e => e.outcome === 'queued').map(e => [e.boxName, e.reason]));
    expect(reasons.apple).toBe('started from stopped: installs only, sessions pick it up when they next start');
    expect(reasons.cherry).toBe('resumed from hibernation: installs only, sessions pick it up when they next start');
    // Once apple's run has reached the box the start is spent: no second resume run, and nothing on the row to clear.
    startQueued();
    for (const r of runs.values()) if (r.status === 'running') Object.assign(r, { status: 'done', finishedAt: new Date(NOW) });
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 61 * 60_000 })).apple).toBe('ran-recently');
    expect(boxes.get('box-apple')!.lastReadyAt).toEqual(ago(0.5));
  });

  it('a cold start asks nothing of a tool already at its reference (pi on its newest pin)', async () => {
    const apple = seed('apple', { coldStartH: 0.5, lastRunH: 5, activity: 0, autoOff: true });
    const bramble = seed('bramble', { coldStartH: 0.5, lastRunH: 5, activity: 0, autoOff: true });
    for (const id of [apple, bramble]) { piAuto.add(id); piUpdate.add(id); piCapable.add(id); }
    for (const id of [apple, bramble]) runs.set(`pi-last-${id}`, { id: `pi-last-${id}`, hostKey: id, component: 'pi', trigger: 'nightly', status: 'done', requestedAt: ago(5), startedAt: ago(5), finishedAt: ago(5) });
    piInventory.set(apple, PI_PINNED_LATEST);
    piInventory.set(bramble, '1.0.2');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'pi')).toEqual({ apple: 'current', bramble: 'queued resume/none' });
  });
});

describe('a sweep pass over a made-up fleet', () => {
  it('gives each box the run its facts call for, and says why', async () => {
    seed('fig', { version: '2.1.290' });                                 // below the floor, new breach: idle
    seed('olive', { version: '2.1.290', breachH: 30 });                  // below for 30 h: force
    seed('plum', { resumed: true, activity: 0 });                        // resumed, active: idle resume
    seed('quince', {});                                                  // due, quiet, 03:00 in Berlin: nightly
    seed('rowan', { owner: sasha });                                     // due, quiet, 21:00 in New York: not yet
    seed('sloe', { owner: kim, activity: 0.2 });                         // no zone, active 12 min ago: not quiet
    seed('tamarind', { lastRunH: 50, activity: 0 });                     // due 26 h, never quiet: nightly anyway
    seed('umbu', { lastRunH: 5 });                                       // ran 5 h ago
    seed('vanilla', { connected: false, version: '2.1.290' });           // offline
    seed('walnut', { capable: false, version: '2.1.290' });              // no capability
    seed('xigua', { inFlight: true, version: '2.1.290' });               // a run in flight
    seed('yuzu', { updateOff: true, version: '2.1.290' });               // mode off
    seed('ziziphus', { autoOff: true, version: '2.1.290' });             // mode manual

    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries)).toEqual({
      fig: 'queued floor/idle', olive: 'queued floor/force', plum: 'queued resume/none', quince: 'queued nightly/idle',
      rowan: 'not-quiet', sloe: 'not-quiet', tamarind: 'queued nightly/none', umbu: 'ran-recently',
      vanilla: 'offline', walnut: 'not-capable', xigua: 'run-in-flight', yuzu: 'auto-off', ziziphus: 'auto-off',
    });
    const queued = entries.filter(e => e.outcome === 'queued');
    // Most urgent first.
    expect(queued.map(e => e.boxName)).toEqual(['olive', 'fig', 'plum', 'tamarind', 'quince']);
    expect(Object.fromEntries(queued.map(e => [e.boxName, e.reason]))).toEqual({
      olive: '2.1.290 has been below the floor 2.1.308 for 30 h: force',
      fig: '2.1.290 is below the floor 2.1.308',
      plum: 'resumed from hibernation: installs only, sessions pick it up when they next start',
      tamarind: "due for 24 h and never quiet: in the owner's night, installs only",
      quince: "quiet for an hour, the owner's night (Europe/Berlin)",
    });
    // The rows say what and why; the pacer sends them.
    const written = [...runs.values()].filter(r => r.reason);
    expect(written.map(r => [r.hostKey, r.trigger, r.restart, r.target, r.status, r.requestedById])).toEqual(expect.arrayContaining([
      ['box-olive', 'floor', 'force', 'latest', expect.any(String), null],
      ['box-plum', 'resume', 'none', 'latest', expect.any(String), null],
    ]));
    await pumpFleet();
    expect(rpcs().map(c => c[0]).sort()).toEqual(['box-fig', 'box-olive', 'box-plum', 'box-quince', 'box-tamarind']);
    // A new breach is recorded so the force clock runs.
    expect(states.get('box-fig:claude')).toMatchObject({ breachFloor: '2.1.308', breachSince: new Date(NOW) });
    // The resume marker is spent only once the resume run has reached the box, not when it is queued (Bugbot on #1163).
    expect(boxes.get('box-plum')!.resumedFromHibernationAt).not.toBeNull();
    startQueued();
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 60_000 })).plum).toBe('run-in-flight');
    expect(boxes.get('box-plum')!.resumedFromHibernationAt).toBeNull();

    // TOOL_SWEEP_DEMO=<file> writes the pass as the PR's demo transcript.
    if (process.env.TOOL_SWEEP_DEMO) {
      // Claude Code's entries: the other tools' flags are off in this fleet, every one of them auto-off.
      const lines = entries.filter(e => e.component === 'claude').map(e => `${e.boxName.padEnd(9)} ${e.owner.padEnd(6)} ${e.component.padEnd(7)} ${(e.outcome === 'queued' ? `run ${e.trigger} (restart ${e.restart})` : `skip ${e.outcome}`).padEnd(28)} ${e.reason ?? ''}`.trimEnd());
      const sent = rpcs().map(c => `${c[0]}: tool-update ${JSON.stringify(c[2])}`);
      writeFileSync(process.env.TOOL_SWEEP_DEMO, `sweep pass at ${new Date(NOW).toISOString()} (03:00 in Europe/Berlin, 21:00 in America/New_York)\n\n${'box'.padEnd(9)} ${'owner'.padEnd(6)} ${'tool'.padEnd(7)} ${'decision'.padEnd(28)} why\n${lines.join('\n')}\n\nsent by the pacer:\n${sent.join('\n')}\n`);
    }
  });

  it('a second pass right after the first makes no second run', async () => {
    seed('fig', { version: '2.1.290' });
    seed('quince', {});
    await runAutoUpdateSweep({ now: NOW });
    const again = await runAutoUpdateSweep({ now: NOW + 60_000 });
    expect(byBox(again)).toEqual({ fig: 'run-in-flight', quince: 'run-in-flight' });
    expect([...runs.values()].filter(r => r.reason)).toHaveLength(2);
  });

  it('leaves a box that connected under a minute ago for its hello pass', async () => {
    seed('fig', { version: '2.1.290' });
    boxes.get('box-fig')!.lastConnectedAt = new Date(NOW - 10_000);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'settling' });
    expect(byBox(await runAutoUpdateSweep({ now: NOW, onlyBox: 'box-fig' }))).toEqual({ fig: 'queued floor/idle' });
  });

  it('never takes the fleet past the pacer\'s limit: queues only the free slots, most urgent first, and keeps a waiting resume\'s marker', async () => {
    for (let i = 0; i < 7; i++) runs.set(`busy${i}`, { id: `busy${i}`.padEnd(24, '0'), hostKey: `elsewhere-${i}`, component: 'claude', trigger: 'manual', status: 'running', requestedAt: ago(0.1), startedAt: ago(0.1) });
    seed('apple', {});
    seed('banana', { version: '2.1.290' });
    seed('cherry', { resumed: true });
    seed('damson', {});
    const entries = await runAutoUpdateSweep({ now: NOW });
    // 7 in flight: 3 slots. The floor and the resume go first.
    expect(byBox(entries)).toEqual({ banana: 'queued floor/idle', cherry: 'queued resume/none', apple: 'queued nightly/idle', damson: 'paced nightly/idle' });

    await pumpFleet();
    runs.clear(); states.clear(); boxes.clear();
    vi.mocked(sendToInstanceAgent).mockClear();
    for (let i = 0; i < 10; i++) runs.set(`busy${i}`, { id: `busy${i}`.padEnd(24, '0'), hostKey: `elsewhere-${i}`, component: 'claude', trigger: 'manual', status: 'running', requestedAt: ago(0.1), startedAt: ago(0.1) });
    seed('cherry', { resumed: true });
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ cherry: 'paced resume/none' });
    expect(boxes.get('box-cherry')!.resumedFromHibernationAt).not.toBeNull();
    expect(rpcs()).toEqual([]);
  });
});

describe('Codex', () => {
  const codexRuns = () => [...runs.values()].filter(r => r.component === 'codex' && r.reason);

  it('gets its own runs from its own policy, only on a box that announces tool-update-codex-v1', async () => {
    const fig = seed('fig', {});
    const sage = seed('sage', {});
    for (const id of [fig, sage]) { codexAuto.add(id); codexUpdate.add(id); }
    codexCapable.add(fig);
    // Below codex-update-policy's default floor (0.131.0); Claude Code is current on both.
    codexInventory.set(fig, '0.120.0').set(sage, '0.120.0');
    const entries = await runAutoUpdateSweep({ now: NOW });
    // tool-update-v1 alone is Claude Code's unit, not Codex's.
    // Codex's policy defaults to restart none, so its automatic runs stop nothing until that changes.
    expect(byBox(entries, 'codex')).toEqual({ fig: 'queued floor/none', sage: 'not-capable' });
    expect(codexRuns().map(r => [r.hostKey, r.trigger, r.restart, r.reason])).toEqual([[fig, 'floor', 'none', '0.120.0 is below the floor 0.131.0']]);
    expect(states.get(`${fig}:codex`)).toMatchObject({ breachFloor: '0.131.0' });
    await pumpFleet();
    expect(rpcs().filter(c => (c[2] as { component: string }).component === 'codex')).toEqual([[fig, 'tool-update', { component: 'codex', run: codexRuns()[0].id }, 15_000]]);
  });

  it('with Codex\'s mode manual does nothing for Codex, whatever Claude Code\'s says', async () => {
    const fig = seed('fig', {});
    codexUpdate.add(fig); codexCapable.add(fig); codexInventory.set(fig, '0.120.0');
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries, 'codex')).toEqual({ fig: 'auto-off' });
    expect(codexRuns()).toEqual([]);
    expect(states.has(`${fig}:codex`)).toBe(false);
    expect(vi.mocked(prisma.toolAutoUpdateState.upsert).mock.calls.every(c => (c[0] as any).where.hostKey_component.component === 'claude')).toBe(true);
    // Its policy is read once, for its mode (manual here), and nothing past it.
    expect(vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === 'codex-update-policy')).toHaveLength(1);
  });

  it('with codex\'s mode off queues nothing for Codex', async () => {
    const fig = seed('fig', {});
    codexAuto.add(fig); codexCapable.add(fig); codexInventory.set(fig, '0.120.0');
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries, 'codex')).toEqual({ fig: 'auto-off' });
    expect(codexRuns()).toEqual([]);
    await pumpFleet();
    expect(rpcs().filter(c => (c[2] as { component: string }).component === 'codex')).toEqual([]);
  });
});

describe('the Cursor agent', () => {
  const PIN = '2026.10.22-27dcf5f'; // cursorUpdatePolicy.ts CURSOR_PINNED_LATEST, what its latest resolves to
  const cursorRuns = () => [...runs.values()].filter(r => r.component === 'cursor' && r.reason);
  const cursorRpcs = () => rpcs().filter(c => (c[2] as { component: string }).component === 'cursor');
  const on = (...ids: string[]) => { for (const id of ids) { cursorAuto.add(id); cursorUpdate.add(id); } };

  it('gets a nightly run on an older pin, only on a box that announces tool-update-cursor-v1, and restarts nothing (its policy says none)', async () => {
    const fig = seed('fig', {}), sage = seed('sage', {});
    on(fig, sage); cursorCapable.add(fig);
    cursorInventory.set(fig, '2026.09.01-1a2b3c4').set(sage, '2026.09.01-1a2b3c4');
    const entries = await runAutoUpdateSweep({ now: NOW });
    // tool-update-v1 alone is Claude Code's unit.
    expect(byBox(entries, 'cursor')).toEqual({ fig: 'queued nightly/none', sage: 'not-capable' });
    expect(cursorRuns().map(r => [r.hostKey, r.trigger, r.restart, r.target])).toEqual([[fig, 'nightly', 'none', 'latest']]);
    await pumpFleet();
    expect(cursorRpcs()).toEqual([[fig, 'tool-update', { component: 'cursor', run: cursorRuns()[0].id }, 15_000]]);
  });

  it('leaves alone a box on the newest pin, or ahead of every pin, even when it has been due for days', async () => {
    const fig = seed('fig', { lastRunH: 72, activity: 0 }), sage = seed('sage', { lastRunH: 72 });
    on(fig, sage); cursorCapable.add(fig).add(sage);
    cursorInventory.set(fig, PIN).set(sage, '2026.10.30-abc1234');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'cursor')).toEqual({ fig: 'current', sage: 'current' });
    expect(cursorRuns()).toEqual([]);
  });

  it('a box below its floor gets a floor run; another build of the floor\'s day is not below it', async () => {
    const fig = seed('fig', {}), sage = seed('sage', {});
    on(fig, sage); cursorCapable.add(fig).add(sage);
    cursorInventory.set(fig, '2025.08.01-1a2b3c4').set(sage, '2025.09.17-0000000');
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries, 'cursor')).toEqual({ fig: 'queued floor/none', sage: 'queued nightly/none' });
  });

  it('with cursor\'s mode manual does nothing for it, and reads its policy only for its mode', async () => {
    const fig = seed('fig', {});
    cursorUpdate.add(fig); cursorCapable.add(fig); cursorInventory.set(fig, '2025.08.01-1a2b3c4');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'cursor')).toEqual({ fig: 'auto-off' });
    expect(cursorRuns()).toEqual([]);
    expect(states.has(`${fig}:cursor`)).toBe(false);
    // Its policy is read once, for its mode (manual here), and nothing past it.
    expect(vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === 'cursor-update-policy')).toHaveLength(1);
  });

  it('with cursor\'s mode off queues nothing for it', async () => {
    const fig = seed('fig', {});
    cursorAuto.add(fig); cursorCapable.add(fig); cursorInventory.set(fig, '2025.08.01-1a2b3c4');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'cursor')).toEqual({ fig: 'auto-off' });
    expect(cursorRuns()).toEqual([]);
    await pumpFleet();
    expect(cursorRpcs()).toEqual([]);
  });
});

describe('the Devin CLI', () => {
  const devinRuns = () => [...runs.values()].filter(r => r.component === 'devin' && r.reason);
  const devinRpcs = () => rpcs().filter(c => (c[2] as { component: string }).component === 'devin');

  it('gets a nightly run only on a box that announces tool-update-devin-v1, restarting nothing (its policy says none); its floor is the fleet\'s oldest, so no floor run', async () => {
    const fig = seed('fig', {}), sage = seed('sage', {});
    for (const id of [fig, sage]) { devinAuto.add(id); devinUpdate.add(id); }
    devinCapable.add(fig);
    // At devin-update-policy's default floor (3000.11.92): not below it.
    devinInventory.set(fig, '3000.11.92').set(sage, '3000.11.92');
    const entries = await runAutoUpdateSweep({ now: NOW });
    // tool-update-v1 alone is Claude Code's unit.
    expect(byBox(entries, 'devin')).toEqual({ fig: 'queued nightly/none', sage: 'not-capable' });
    expect(devinRuns().map(r => [r.hostKey, r.trigger, r.restart, r.target])).toEqual([[fig, 'nightly', 'none', 'latest']]);
    expect(states.get(`${fig}:devin`)).toMatchObject({ breachFloor: null });
    await pumpFleet();
    expect(devinRpcs()).toEqual([[fig, 'tool-update', { component: 'devin', run: devinRuns()[0].id }, 15_000]]);
  });

  it('with devin\'s mode manual does nothing for it, and reads its policy only for its mode', async () => {
    const fig = seed('fig', {});
    devinUpdate.add(fig); devinCapable.add(fig); devinInventory.set(fig, '3000.11.92');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'devin')).toEqual({ fig: 'auto-off' });
    expect(devinRuns()).toEqual([]);
    expect(states.has(`${fig}:devin`)).toBe(false);
    // Its policy is read once, for its mode (manual here), and nothing past it.
    expect(vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === 'devin-update-policy')).toHaveLength(1);
  });

  it('with devin\'s mode off queues nothing for it', async () => {
    const fig = seed('fig', {});
    devinAuto.add(fig); devinCapable.add(fig); devinInventory.set(fig, '3000.11.92');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'devin')).toEqual({ fig: 'auto-off' });
    expect(devinRuns()).toEqual([]);
    await pumpFleet();
    expect(devinRpcs()).toEqual([]);
  });
});

describe('pi', () => {
  const piRuns = () => [...runs.values()].filter(r => r.component === 'pi' && r.reason);
  const piRpcs = () => rpcs().filter(c => (c[2] as { component: string }).component === 'pi');

  it('gets its own floor run from its own policy, only on a box that announces tool-update-pi-v1, restarting nothing (its policy says none)', async () => {
    const fig = seed('fig', {}), sage = seed('sage', {});
    for (const id of [fig, sage]) { piAuto.add(id); piUpdate.add(id); }
    piCapable.add(fig);
    // Below pi-update-policy's default floor (0.79.0).
    piInventory.set(fig, '0.70.0').set(sage, '0.70.0');
    const entries = await runAutoUpdateSweep({ now: NOW });
    // tool-update-v1 alone is Claude Code's unit.
    expect(byBox(entries, 'pi')).toEqual({ fig: 'queued floor/none', sage: 'not-capable' });
    expect(piRuns().map(r => [r.hostKey, r.trigger, r.restart, r.reason])).toEqual([[fig, 'floor', 'none', '0.70.0 is below the floor 0.79.0']]);
    await pumpFleet();
    expect(piRpcs()).toEqual([[fig, 'tool-update', { component: 'pi', run: piRuns()[0].id }, 15_000]]);
  });

  // latest is piUpdatePolicy.ts PI_PINNED_LATEST, the recipe's newest pin, never the fleet's newest version.
  it('gets a nightly run on an older pin, and leaves alone a box on the newest pin or ahead of every pin', async () => {
    const fig = seed('fig', {}), sage = seed('sage', { lastRunH: 72, activity: 0 }), oak = seed('oak', { lastRunH: 72 });
    for (const id of [fig, sage, oak]) { piAuto.add(id); piUpdate.add(id); piCapable.add(id); }
    piInventory.set(fig, '1.0.2').set(sage, PI_PINNED_LATEST).set(oak, '9.9.9');
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries, 'pi')).toEqual({ fig: 'queued nightly/none', sage: 'current', oak: 'current' });
    expect(piRuns().map(r => [r.hostKey, r.trigger, r.target])).toEqual([[fig, 'nightly', 'latest']]);
  });

  it('with pi\'s mode manual does nothing for it, and reads its policy only for its mode', async () => {
    const fig = seed('fig', {});
    piUpdate.add(fig); piCapable.add(fig); piInventory.set(fig, '0.70.0');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'pi')).toEqual({ fig: 'auto-off' });
    expect(piRuns()).toEqual([]);
    expect(states.has(`${fig}:pi`)).toBe(false);
    // Its policy is read once, for its mode (manual here), and nothing past it.
    expect(vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === 'pi-update-policy')).toHaveLength(1);
  });

  it('with pi\'s mode off queues nothing for it', async () => {
    const fig = seed('fig', {});
    piAuto.add(fig); piCapable.add(fig); piInventory.set(fig, '0.70.0');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'pi')).toEqual({ fig: 'auto-off' });
    expect(piRuns()).toEqual([]);
    await pumpFleet();
    expect(piRpcs()).toEqual([]);
  });
});

describe('gh', () => {
  const ghRuns = () => [...runs.values()].filter(r => r.component === 'gh' && r.reason);
  const ghRpcs = () => rpcs().filter(c => (c[2] as { component: string }).component === 'gh');
  const on = (...ids: string[]) => { for (const id of ids) { ghAuto.add(id); ghUpdate.add(id); } };

  it('runs nightly without waiting for a quiet window, in the owner\'s busy day, only on a box that announces tool-update-gh-v1, restarting nothing', async () => {
    // 21:00 in New York with the box active a minute ago: Claude Code waits, gh does not.
    const fig = seed('fig', { owner: sasha, activity: 0.02 }), sage = seed('sage', { owner: sasha, activity: 0.02 });
    on(fig, sage); ghCapable.add(fig);
    ghInventory.set(fig, '2.110.0').set(sage, '2.110.0');
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries)).toEqual({ fig: 'not-quiet', sage: 'not-quiet' });
    // tool-update-v1 alone is Claude Code's unit.
    expect(byBox(entries, 'gh')).toEqual({ fig: 'queued nightly/none', sage: 'not-capable' });
    expect(ghRuns().map(r => [r.hostKey, r.trigger, r.restart, r.target, r.reason])).toEqual([[fig, 'nightly', 'none', 'latest', 'due, and it runs in no session, so no quiet window to wait for']]);
    await pumpFleet();
    expect(ghRpcs()).toEqual([[fig, 'tool-update', { component: 'gh', run: ghRuns()[0].id }, 15_000]]);
  });

  it('still at most once in 24 h, a floor breach never forces, and a resume asks nothing of it', async () => {
    const fig = seed('fig', {}), sage = seed('sage', { resumed: true }), olive = seed('olive', {});
    on(fig, sage, olive); ghCapable.add(fig).add(sage).add(olive);
    ghInventory.set(fig, '2.110.0').set(sage, '2.110.0').set(olive, '2.90.0');
    // gh's own last runs (seed's are Claude Code's): five hours ago on fig and sage.
    for (const id of [fig, sage]) runs.set(`gh-${id}`, { id: `gh-${id}`, hostKey: id, component: 'gh', trigger: 'nightly', status: 'done', requestedAt: ago(5), startedAt: ago(5), finishedAt: ago(5) });
    // Below gh-update-policy's floor (2.102.0) for three days: Claude Code would force by now.
    states.set(`${olive}:gh`, { hostKey: olive, component: 'gh', firstSeenAt: ago(240), breachFloor: '2.102.0', breachSince: ago(72), breachSeenAt: ago(0.25) });
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries, 'gh')).toEqual({ fig: 'ran-recently', sage: 'ran-recently', olive: 'queued floor/none' });
    expect(ghRuns().find(r => r.hostKey === olive)!.reason).toBe('2.90.0 is below the floor 2.102.0');
    // Claude Code took the resume (its own run); gh does not hold the marker once that run has reached the box.
    expect(byBox(entries).sage).toBe('queued resume/none');
    startQueued();
    await runAutoUpdateSweep({ now: NOW + 60_000 });
    expect(boxes.get(sage)!.resumedFromHibernationAt).toBeNull();
  });

  it('with gh\'s mode manual does nothing for it, and reads its policy only for its mode', async () => {
    const fig = seed('fig', {});
    ghUpdate.add(fig); ghCapable.add(fig); ghInventory.set(fig, '2.90.0');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'gh')).toEqual({ fig: 'auto-off' });
    expect(ghRuns()).toEqual([]);
    expect(states.has(`${fig}:gh`)).toBe(false);
    // Its policy is read once, for its mode (manual here), and nothing past it.
    expect(vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === 'gh-update-policy')).toHaveLength(1);
  });

  it('with gh\'s mode off queues nothing for it', async () => {
    const fig = seed('fig', {});
    ghAuto.add(fig); ghCapable.add(fig); ghInventory.set(fig, '2.90.0');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'gh')).toEqual({ fig: 'auto-off' });
    expect(ghRuns()).toEqual([]);
    await pumpFleet();
    expect(ghRpcs()).toEqual([]);
  });
});


describe('python', () => {
  const pyRuns = () => [...runs.values()].filter(r => r.component === 'python' && r.reason);
  const pyRpcs = () => rpcs().filter(c => (c[2] as { component: string }).component === 'python');
  const on = (...ids: string[]) => { for (const id of ids) { pythonAuto.add(id); pythonUpdate.add(id); } };

  it('runs nightly without waiting for a quiet window, only on a box that announces tool-update-python-v1, restarting nothing', async () => {
    // 21:00 in New York with the box active a minute ago: Claude Code waits, Python does not (no sessions).
    const fig = seed('fig', { owner: sasha, activity: 0.02 }), sage = seed('sage', { owner: sasha, activity: 0.02 });
    on(fig, sage); pythonCapable.add(fig);
    pythonInventory.set(fig, '3.13.18').set(sage, '3.13.18');
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries)).toEqual({ fig: 'not-quiet', sage: 'not-quiet' });
    expect(byBox(entries, 'python')).toEqual({ fig: 'queued nightly/none', sage: 'not-capable' });
    expect(pyRuns().map(r => [r.hostKey, r.trigger, r.restart, r.target, r.reason])).toEqual([[fig, 'nightly', 'none', 'latest', 'due, and it runs in no session, so no quiet window to wait for']]);
    await pumpFleet();
    expect(pyRpcs()).toEqual([[fig, 'tool-update', { component: 'python', run: pyRuns()[0].id }, 15_000]]);
  });

  it('a floor breach queues a floor run that never forces, and a resume asks nothing of it', async () => {
    const olive = seed('olive', {}), sage = seed('sage', { resumed: true });
    on(olive, sage); pythonCapable.add(olive).add(sage);
    pythonInventory.set(olive, '3.13.16').set(sage, '3.13.18');
    runs.set(`py-${sage}`, { id: `py-${sage}`, hostKey: sage, component: 'python', trigger: 'nightly', status: 'done', requestedAt: ago(5), startedAt: ago(5), finishedAt: ago(5) });
    // Below python-update-policy's floor (3.13.18) for three days: Claude Code would force by now.
    states.set(`${olive}:python`, { hostKey: olive, component: 'python', firstSeenAt: ago(240), breachFloor: '3.13.18', breachSince: ago(72), breachSeenAt: ago(0.25) });
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries, 'python')).toEqual({ olive: 'queued floor/none', sage: 'ran-recently' });
    expect(pyRuns().find(r => r.hostKey === olive)!.reason).toBe('3.13.16 is below the floor 3.13.18');
  });

  it('with python\'s mode manual does nothing for it, and reads its policy only for its mode', async () => {
    const fig = seed('fig', {});
    pythonUpdate.add(fig); pythonCapable.add(fig); pythonInventory.set(fig, '3.13.16');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'python')).toEqual({ fig: 'auto-off' });
    expect(pyRuns()).toEqual([]);
    expect(states.has(`${fig}:python`)).toBe(false);
    // Its policy is read once, for its mode (manual here), and nothing past it.
    expect(vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === 'python-update-policy')).toHaveLength(1);
  });

  it('with python\'s mode off queues nothing for it', async () => {
    const fig = seed('fig', {});
    pythonAuto.add(fig); pythonCapable.add(fig); pythonInventory.set(fig, '3.13.16');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'python')).toEqual({ fig: 'auto-off' });
    expect(pyRuns()).toEqual([]);
    await pumpFleet();
    expect(pyRpcs()).toEqual([]);
  });
});
describe('the AWS CLI', () => {
  const awsRuns = () => [...runs.values()].filter(r => r.component === 'aws' && r.reason);
  const awsRpcs = () => rpcs().filter(c => (c[2] as { component: string }).component === 'aws');
  const on = (...ids: string[]) => { for (const id of ids) { awsAuto.add(id); awsUpdate.add(id); } };

  it('runs nightly without a quiet window, only on a box that announces tool-update-aws-v1, restarting nothing; never forces; takes no resume run', async () => {
    // 21:00 in New York with the box active a minute ago: Claude Code waits, the AWS CLI does not.
    const fig = seed('fig', { owner: sasha, activity: 0.02 }), sage = seed('sage', { owner: sasha, activity: 0.02 });
    const olive = seed('olive', { resumed: true });
    on(fig, sage, olive); awsCapable.add(fig).add(olive);
    awsInventory.set(fig, '2.40.0').set(sage, '2.40.0').set(olive, '2.30.0');
    // Below aws-update-policy's floor (2.35.3) for three days: Claude Code would force by now.
    states.set(`${olive}:aws`, { hostKey: olive, component: 'aws', firstSeenAt: ago(240), lastSeenAt: ago(0.25), breachFloor: '2.35.3', breachSince: ago(72), breachSeenAt: ago(0.25) });
    const entries = await runAutoUpdateSweep({ now: NOW });
    // tool-update-v1 alone is Claude Code's unit.
    expect(byBox(entries, 'aws')).toEqual({ fig: 'queued nightly/none', sage: 'not-capable', olive: 'queued floor/none' });
    expect(Object.fromEntries(awsRuns().map(r => [r.hostKey, [r.trigger, r.restart, r.reason]]))).toEqual({
      [fig]: ['nightly', 'none', 'due, and it runs in no session, so no quiet window to wait for'],
      [olive]: ['floor', 'none', '2.30.0 is below the floor 2.35.3'],
    });
    // Its run on the resumed box is the floor's, not a resume run, and it does not hold the marker for itself.
    expect(awsRuns().some(r => r.trigger === 'resume')).toBe(false);
    await pumpFleet();
    expect(awsRpcs().map(c => c[0]).sort()).toEqual([fig, olive].sort());
  });

  it('with aws\'s mode manual does nothing for it, and reads its policy only for its mode', async () => {
    const fig = seed('fig', {});
    awsUpdate.add(fig); awsCapable.add(fig); awsInventory.set(fig, '2.30.0');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'aws')).toEqual({ fig: 'auto-off' });
    expect(awsRuns()).toEqual([]);
    expect(states.has(`${fig}:aws`)).toBe(false);
    // Its policy is read once, for its mode (manual here), and nothing past it.
    expect(vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === 'aws-update-policy')).toHaveLength(1);
  });

  it('with aws\'s mode off queues nothing for it', async () => {
    const fig = seed('fig', {});
    awsAuto.add(fig); awsCapable.add(fig); awsInventory.set(fig, '2.30.0');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'aws')).toEqual({ fig: 'auto-off' });
    expect(awsRuns()).toEqual([]);
    await pumpFleet();
    expect(awsRpcs()).toEqual([]);
  });
});

describe('Node', () => {
  const nodeRuns = () => [...runs.values()].filter(r => r.component === 'node' && r.reason);
  const nodeRpcs = () => rpcs().filter(c => (c[2] as { component: string }).component === 'node');
  const on = (...ids: string[]) => { for (const id of ids) { nodeAuto.add(id); nodeUpdate.add(id); } };

  it('takes the quiet window like the session tool it is: its run stops and resumes Claude Code, Codex and pi sessions', async () => {
    // fig: 03:00 in Berlin, quiet. rowan: 21:00 in New York. sloe: active a minute ago.
    const fig = seed('fig', {}), rowan = seed('rowan', { owner: sasha }), sloe = seed('sloe', { activity: 0.02 }), sage = seed('sage', {});
    on(fig, rowan, sloe, sage); nodeCapable.add(fig).add(rowan).add(sloe);
    for (const id of [fig, rowan, sloe, sage]) nodeInventory.set(id, '24.23.0');
    const entries = await runAutoUpdateSweep({ now: NOW });
    // tool-update-v1 alone is Claude Code's unit.
    expect(byBox(entries, 'node')).toEqual({ fig: 'queued nightly/none', rowan: 'not-quiet', sloe: 'not-quiet', sage: 'not-capable' });
    // Its policy's default restart none caps the run (this Node recipe restarts the agent only); the decision asked idle.
    expect(nodeRuns().map(r => [r.hostKey, r.trigger, r.restart, r.reason])).toEqual([[fig, 'nightly', 'none', "quiet for an hour, the owner's night (Europe/Berlin)"]]);
    await pumpFleet();
    expect(nodeRpcs()).toEqual([[fig, 'tool-update', { component: 'node', run: nodeRuns()[0].id }, 15_000]]);
  });

  it('with a policy that allows it, its runs restart idle; a floor breach never forces, even after three days', async () => {
    ld.raw.mockImplementation((async (key: string) => (key === 'node-update-policy' ? { restart: 'idle' } : null)) as never);
    const fig = seed('fig', {}), olive = seed('olive', {});
    on(fig, olive); nodeCapable.add(fig).add(olive);
    nodeInventory.set(fig, '24.23.0').set(olive, '24.20.0');
    // Below node-update-policy's floor (24.22.1) for three days, with idle floor runs all along: Claude Code would force by now.
    states.set(`${olive}:node`, { hostKey: olive, component: 'node', firstSeenAt: ago(240), lastSeenAt: ago(0.25), breachFloor: '24.22.1', breachSince: ago(72), breachSeenAt: ago(0.25) });
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'node')).toEqual({ fig: 'queued nightly/idle', olive: 'queued floor/idle' });
    expect(nodeRuns().find(r => r.hostKey === olive)!.reason).toBe('24.20.0 is below the floor 24.22.1');
    ld.raw.mockImplementation((async () => null) as never);
  });

  it('with node\'s mode manual does nothing for it, and reads its policy only for its mode', async () => {
    const fig = seed('fig', {});
    nodeUpdate.add(fig); nodeCapable.add(fig); nodeInventory.set(fig, '24.20.0');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'node')).toEqual({ fig: 'auto-off' });
    expect(nodeRuns()).toEqual([]);
    expect(states.has(`${fig}:node`)).toBe(false);
    // Its policy is read once, for its mode (manual here), and nothing past it.
    expect(vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === 'node-update-policy')).toHaveLength(1);
  });

  it('with node\'s mode off queues nothing for it', async () => {
    const fig = seed('fig', {});
    nodeAuto.add(fig); nodeCapable.add(fig); nodeInventory.set(fig, '24.20.0');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }), 'node')).toEqual({ fig: 'auto-off' });
    expect(nodeRuns()).toEqual([]);
    await pumpFleet();
    expect(nodeRpcs()).toEqual([]);
  });
});

describe('a tool that fails to decide (Bugbot on #1163)', () => {
  it('keeps the box\'s resume marker for a later pass, while the other tools still act', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const plum = seed('plum', { resumed: true });
    codexAuto.add(plum); codexUpdate.add(plum); codexCapable.add(plum); codexInventory.set(plum, '0.163.0');
    // Codex's policy read throws on this pass.
    ld.raw.mockImplementation((async (key: string) => { if (key === 'codex-update-policy') throw new Error('flag source unreachable'); return null; }) as never);
    const first = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(first)).toEqual({ plum: 'queued resume/none' });
    expect(byBox(first, 'codex')).toEqual({});
    expect(boxes.get(plum)!.resumedFromHibernationAt).not.toBeNull();
    ld.raw.mockImplementation((async () => null) as never);
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 60_000 }), 'codex')).toEqual({ plum: 'queued resume/none' });
    startQueued(NOW + 60_000);
    await runAutoUpdateSweep({ now: NOW + 120_000 });
    expect(boxes.get(plum)!.resumedFromHibernationAt).toBeNull();
  });
});

describe('runs that never reach the box, and flag-off gaps (Bugbot on #1163)', () => {
  it('a resume run that expired unsent keeps the marker, and is asked for again after the hour', async () => {
    const plum = seed('plum', { resumed: true });
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ plum: 'queued resume/none' });
    // The leader restarts before the pacer sends it: the row expires, never fetched.
    await pumpFleet();
    // (dispatch stamps requestedAt with the real clock; the pass runs on the test's)
    for (const r of runs.values()) if (r.trigger === 'resume') Object.assign(r, { status: 'expired', requestedAt: new Date(NOW), finishedAt: new Date(NOW + 15 * 60_000) });
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 20 * 60_000 }))).toEqual({ plum: 'backing-off' });
    expect(boxes.get(plum)!.resumedFromHibernationAt).not.toBeNull();
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 61 * 60_000 }))).toEqual({ plum: 'queued resume/none' });
  });

  it('an unsent nightly run is not the day\'s run: the nightly goes again after the hour', async () => {
    const quince = seed('quince', {});
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ quince: 'queued nightly/idle' });
    await pumpFleet();
    for (const r of runs.values()) if (r.trigger === 'nightly' && r.reason) Object.assign(r, { status: 'expired', requestedAt: new Date(NOW) });
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 61 * 60_000 }))).toEqual({ quince: 'queued nightly/idle' });
  });

  it('a nightly clock left while the flag was off starts again: back on, a box with no run is not overdue at once', async () => {
    const sloe = seed('sloe', { lastRunH: null, activity: 0 });
    // Last looked at two days ago, before the flag went off; first seen ten days ago.
    states.get(`${sloe}:claude`)!.lastSeenAt = ago(48);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ sloe: 'not-quiet' });
    expect(states.get(`${sloe}:claude`)).toMatchObject({ firstSeenAt: new Date(NOW), lastSeenAt: new Date(NOW) });
    // Without the gap it would have been never-quiet: ten days due.
    states.get(`${sloe}:claude`)!.firstSeenAt = ago(240);
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 60_000 }))).toEqual({ sloe: 'queued nightly/none' });
  });
});

describe('a reconnect during a fleet pass (Bugbot on #1163)', () => {
  it('is left settling, on the hello\'s own clock, though the row\'s connect time read at the start says settled', async () => {
    let hello: ((ev: any) => void) | null = null;
    vi.mocked(onBoxAgentHello).mockImplementation(fn => { hello = fn; return () => {}; });
    startToolAutoUpdateSweep({ sweepMs: 10 ** 9, settleMs: 10 ** 9 });
    const fig = seed('fig', { version: '2.1.290' }), sage = seed('sage', { version: '2.1.290' });
    // fig says hello while the pass is gathering: after the instances are read, before anything is queued.
    vi.mocked(prisma.hostSoftware.findMany).mockImplementationOnce((async ({ where }: any) => {
      hello!({ instance: boxes.get(fig), user: robin, agentCommit: null, capabilities: ['tool-update-v1'] });
      return where.hostKey.in.filter((k: string) => inventory.has(k)).map((k: string) => ({ hostKey: k, version: inventory.get(k), ok: true }));
    }) as never);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'settling', sage: 'queued floor/idle' });
    expect([...runs.values()].filter(r => r.reason).map(r => r.hostKey)).toEqual([sage]);
    // Its own hello pass decides it.
    expect(byBox(await runAutoUpdateSweep({ now: NOW, onlyBox: fig }))).toEqual({ fig: 'queued floor/idle' });
    stopToolAutoUpdateSweep();
  });
});

describe('Devin on #1163', () => {
  it('a pass running when the lease is lost claims and sends nothing, and the automatic runs the pacer holds are ended, not sent', async () => {
    const fig = seed('fig', { version: '2.1.290' });
    // The lease is lost while the pass is gathering.
    vi.mocked(prisma.hostSoftware.findMany).mockImplementationOnce((async ({ where }: any) => {
      stopToolAutoUpdateSweep();
      return where.hostKey.in.filter((k: string) => inventory.has(k)).map((k: string) => ({ hostKey: k, version: inventory.get(k), ok: true }));
    }) as never);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'stopped' });
    expect([...runs.values()].filter(r => r.reason)).toEqual([]);
    await pumpFleet();
    expect(rpcs()).toEqual([]);

    // A run the pacer holds when the lease is lost is ended, and never sent.
    runs.clear(); vi.mocked(sendToInstanceAgent).mockClear();
    const run = await queueAutoRun(TOOL_REGISTRY.claude, boxes.get(fig) as never, 'floor', 'idle', 'latest', '2.1.290 is below the floor 2.1.308', NOW);
    expect(run).not.toBeNull();
    stopToolAutoUpdateSweep();
    await vi.waitFor(() => expect(runs.get(run!.id)).toMatchObject({ status: 'expired', detail: 'this orchestrator stopped leading before the run was sent' }));
    await pumpFleet();
    expect(rpcs()).toEqual([]);
  });

  it('a refused run, perhaps never sent, is not the day\'s run: an hour on, the nightly goes', async () => {
    const quince = seed('quince', {});
    runs.set('refused', { id: 'refused'.padEnd(24, '0'), hostKey: quince, component: 'claude', trigger: 'nightly', status: 'refused', requestedAt: ago(0.5), startedAt: null, finishedAt: ago(0.5), detail: 'the box agent is not connected' });
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ quince: 'backing-off' });
    runs.get('refused')!.requestedAt = ago(1.5);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ quince: 'queued nightly/idle' });
  });

  it('a refused resume run does not spend the marker: the resume is asked for again after the hour', async () => {
    const plum = seed('plum', { resumed: true });
    runs.set('refused', { id: 'refused'.padEnd(24, '0'), hostKey: plum, component: 'claude', trigger: 'resume', status: 'refused', requestedAt: ago(1.5), startedAt: null, finishedAt: ago(1.5) });
    // The marker is newer than that refusal here: a resume run goes now.
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ plum: 'queued resume/none' });
    expect(boxes.get(plum)!.resumedFromHibernationAt).not.toBeNull();
  });

  it('a run queued while its breach write fails is still sent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fig = seed('fig', { version: '2.1.290' });
    vi.mocked(prisma.toolAutoUpdateState.update).mockRejectedValueOnce(new Error('connection reset'));
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries)).toEqual({ fig: 'queued floor/idle' });
    await vi.waitFor(() => expect(rpcs().map(c => c[0])).toEqual([fig]));
  });
});

describe('review on #1163', () => {
  const missed = (id: string, hostKey: string, trigger: string, h: number, status = 'expired') =>
    runs.set(id, { id: id.padEnd(24, '0'), hostKey, component: 'claude', trigger, status, requestedAt: ago(h), startedAt: null, finishedAt: ago(h) });

  it('backs off runs that never reach the box, 1 h, 2 h, 4 h, and starts over once one reaches it', async () => {
    const quince = seed('quince', {});
    missed('m1', quince, 'nightly', 3.5);
    missed('m2', quince, 'nightly', 1.5, 'refused');
    // Two unreached: two hours after the newest.
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ quince: 'backing-off' });
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 0.6 * H }))).toEqual({ quince: 'queued nightly/idle' });

    // A run that reached the box after them starts the backoff over: they no longer count.
    runs.clear(); states.clear(); boxes.clear();
    const fig = seed('fig', { lastRunH: 25 });
    missed('m3', fig, 'nightly', 30);
    missed('m4', fig, 'nightly', 27);
    missed('m5', fig, 'nightly', 26);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'queued nightly/idle' });
  });

  it('a raised floor does not inherit the old floor\'s backoff: its first run goes at once (Devin on #1163)', async () => {
    const fig = seed('fig', { version: '2.1.290', lastRunH: 30 });
    for (const [id, h] of [['f1', 9], ['f2', 5], ['f3', 1.5]] as const) missed(id, fig, 'floor', h);
    // The breach the sweep has been timing is for an older floor; the policy's is now 2.1.308.
    states.get(`${fig}:claude`)!.breachFloor = '2.1.300';
    states.get(`${fig}:claude`)!.breachSince = ago(9);
    states.get(`${fig}:claude`)!.breachSeenAt = ago(0.25);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'queued floor/idle' });
    // Control: the same attempts under the floor they were made for back off (three: 4 h after the newest).
    runs.clear(); states.clear(); boxes.clear();
    const sage = seed('sage', { version: '2.1.290', lastRunH: 30, breachH: 9 });
    for (const [id, h] of [['s1', 9], ['s2', 5], ['s3', 1.5]] as const) missed(id, sage, 'floor', h);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ sage: 'backing-off' });
  });

  it('holds at a day after many runs that never reached the box', async () => {
    const quince = seed('quince', { lastRunH: null });
    // Eight of them, the newest 23 h ago: past 2^7 h, the hold is a day.
    for (let k = 0; k < 8; k++) missed(`m${k}`, quince, 'nightly', 23 + k * 2);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ quince: 'backing-off' });
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 1.1 * H }))).toEqual({ quince: 'queued nightly/idle' });
  });

  it('the never-quiet fallback gives Node no agent restart mid-day: it waits for the owner\'s night, and with no time zone it does not run', async () => {
    // rowan: 21:00 in New York; kim: no time zone. Both active a minute ago, a day overdue.
    const rowan = seed('rowan', { owner: sasha, activity: 0.02, lastRunH: 50 }), sloe = seed('sloe', { owner: kim, activity: 0.02, lastRunH: 50 });
    for (const id of [rowan, sloe]) { nodeAuto.add(id); nodeUpdate.add(id); nodeCapable.add(id); nodeInventory.set(id, '24.23.0'); }
    for (const id of [rowan, sloe]) runs.set(`node-${id}`, { id: `node-${id}`.padEnd(24, '0'), hostKey: id, component: 'node', trigger: 'nightly', status: 'done', requestedAt: ago(50), startedAt: ago(50) });
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries, 'node')).toEqual({ rowan: 'not-quiet', sloe: 'not-quiet' });
    // Claude Code, whose run restarts only its sessions (and here none: restart none), still installs for kim, at any hour.
    expect(byBox(entries)).toEqual({ rowan: 'not-quiet', sloe: 'queued nightly/none' });
  });
});

describe('the nightly schedule (tool-auto-update-schedule)', () => {
  // 14:00 in Berlin, the afternoon after NOW's night.
  const AFTERNOON = NOW + 11 * H;
  const KEY = 'tool-auto-update-schedule';
  const TEST = { nightFromHour: 15, nightToHour: 17, everyHours: 2 };
  const serve = (value: unknown) => ld.raw.mockImplementation((async (key: string) => (key === KEY ? value : null)) as never);
  const scheduleReads = () => vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === KEY);
  const berlinTime = (t: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
  afterEach(() => { ld.raw.mockImplementation((async () => null) as never); });

  /** A quiet Claude Code box (fig, its last run 25 h before 14:00) and a gh box (sage, gh's last run 4 h before), both robin's. */
  function afternoonFleet(start: number) {
    const fig = seed('fig', {}), sage = seed('sage', { autoOff: true });
    for (const id of [fig, sage]) {
      Object.assign(boxes.get(id)!, { lastActivityAt: new Date(start - 3 * H), lastConnectedAt: new Date(start - 5 * H) });
      Object.assign(states.get(`${id}:claude`)!, { lastSeenAt: new Date(start - 0.25 * H) });
    }
    Object.assign(runs.get(`last-${fig}`)!, { requestedAt: new Date(start - 25 * H), startedAt: new Date(start - 25 * H) });
    ghAuto.add(sage); ghUpdate.add(sage); ghCapable.add(sage); ghInventory.set(sage, '2.110.0');
    runs.set(`gh-${sage}`, { id: `gh-${sage}`.padEnd(24, '0'), hostKey: sage, component: 'gh', trigger: 'nightly', status: 'done', requestedAt: new Date(start - 4 * H), startedAt: new Date(start - 4 * H), finishedAt: new Date(start - 4 * H) });
    states.set(`${sage}:gh`, { hostKey: sage, component: 'gh', firstSeenAt: new Date(start - 240 * H), lastSeenAt: new Date(start - 0.25 * H), breachFloor: null, breachSince: null, breachSeenAt: null });
    return { fig, sage };
  }

  /** Every 15 minutes from 14:00 to 18:00 in Berlin; each run the pass queues reaches its box and finishes before the next. */
  async function simulateAfternoon(): Promise<{ queued: string[]; lines: string[] }> {
    const queued: string[] = [], lines: string[] = [];
    for (let t = AFTERNOON; t <= AFTERNOON + 4 * H; t += 15 * 60_000) {
      vi.mocked(console.log).mockClear();
      const entries = (await runAutoUpdateSweep({ now: t })).filter(e => (e.component === 'claude' && e.boxName === 'fig') || (e.component === 'gh' && e.boxName === 'sage'));
      await pumpFleet();
      for (const r of runs.values()) if (r.status === 'requested' || r.status === 'running') Object.assign(r, { status: 'done', requestedAt: new Date(t), startedAt: new Date(t), finishedAt: new Date(t + 5 * 60_000) });
      for (const e of entries) {
        if (e.outcome === 'queued') queued.push(`${berlinTime(t)} ${e.component}`);
        lines.push(`${berlinTime(t)}  ${e.boxName.padEnd(5)} ${e.component.padEnd(7)} ${(e.outcome === 'queued' ? `run ${e.trigger} (restart ${e.restart})` : `skip ${e.outcome}`).padEnd(28)} ${e.reason ?? ''}`.trimEnd());
      }
      for (const c of vi.mocked(console.log).mock.calls) if (String(c[0]).startsWith('[TOOL-AUTO]')) lines.push(`         log: ${String(c[0])}`.replace(/run auto0+\d+/, 'run <id>'));
    }
    return { queued, lines };
  }

  it('off or unset, an afternoon is today\'s: nothing nightly runs before the night, and a moved one runs in its window, with the window in its reason', async () => {
    afternoonFleet(AFTERNOON);
    const before = await simulateAfternoon();
    expect(before.queued).toEqual([]);
    expect(scheduleReads().length).toBeGreaterThan(0);

    runs.clear(); states.clear(); boxes.clear(); inventory.clear(); ghAuto.clear(); ghUpdate.clear(); ghCapable.clear(); ghInventory.clear(); autoOff.clear();
    resetAutoUpdateForTests();
    vi.mocked(sendToInstanceAgent).mockClear();
    serve(TEST);
    afternoonFleet(AFTERNOON);
    const after = await simulateAfternoon();
    // gh, sessionless, every 2 h from its last run; Claude Code once in the window, then not due again before it ends.
    expect(after.queued).toEqual(['14:00 gh', '15:00 claude', '16:00 gh', '18:00 gh']);
    const reasons = [...runs.values()].filter(r => r.reason).map(r => [r.component, r.reason]);
    expect(reasons).toContainEqual(['claude', "quiet for an hour, the owner's test window 15–17 (Europe/Berlin); test interval 2 h"]);
    expect(reasons).toContainEqual(['gh', 'due, and it runs in no session, so no quiet window to wait for; test interval 2 h']);
    expect(after.lines.join('\n')).toContain('[TOOL-AUTO] robin: test schedule from tool-auto-update-schedule: window 15–17, every 2 h, quiet 60 min (Europe/Berlin)');

    // TOOL_NIGHT_WINDOW_DEMO=<file> writes both afternoons as the PR's demo transcript.
    if (process.env.TOOL_NIGHT_WINDOW_DEMO) {
      const head = `${'time'.padEnd(6)} ${'box'.padEnd(5)} ${'tool'.padEnd(7)} ${'decision'.padEnd(28)} why`;
      writeFileSync(process.env.TOOL_NIGHT_WINDOW_DEMO, [
        'Sweep passes every 15 minutes, 14:00-18:00 on 2026-11-02 in Europe/Berlin (owner robin).',
        'fig: Claude Code, quiet (activity 3 h before 14:00), last run 25 h before 14:00.',
        'sage: gh (no sessions), last gh run 4 h before 14:00.',
        '',
        '## tool-auto-update-schedule off (fallback: night 00-06, every 24 h, quiet 60 min)',
        '', head, ...before.lines, '',
        `## tool-auto-update-schedule = ${JSON.stringify(TEST)}`,
        '', head, ...after.lines, '',
      ].join('\n'));
    }
  });

  it('is read once per owner per pass, for the owner, and only for owners with a tool on', async () => {
    serve(TEST);
    const fig = seed('fig', {}), sage = seed('sage', {});
    seed('rowan', { owner: sasha }); seed('sloe', { owner: kim, autoOff: true });
    for (const id of [fig, sage]) { ghAuto.add(id); ghUpdate.add(id); ghCapable.add(id); ghInventory.set(id, '2.110.0'); }
    await runAutoUpdateSweep({ now: NOW });
    expect(scheduleReads().map(c => [(c[1] as { unixUsername: string }).unixUsername, c[2], c[3]])).toEqual([['robin', null, undefined], ['sasha', null, undefined]]);
    vi.mocked(jsonVariation).mockClear();
    await runAutoUpdateSweep({ now: NOW + 60_000 });
    expect(scheduleReads()).toHaveLength(2);
  });

  it('a daytime test window makes a quiet box run; another owner keeps the night', async () => {
    ld.raw.mockImplementation((async (key: string, u: { id: string }) => (key === KEY && u.id === robin.id ? { nightFromHour: 15, nightToHour: 17, quietMinutes: 10 } : null)) as never);
    const at = AFTERNOON + 1.5 * H; // 15:30 in Berlin, 09:30 in New York
    seed('fig', {});
    seed('quince', {});
    seed('rowan', { owner: sasha });
    Object.assign(boxes.get('box-quince')!, { lastActivityAt: new Date(at - 20 * 60_000) });
    const entries = await runAutoUpdateSweep({ now: at });
    expect(byBox(entries)).toEqual({ fig: 'queued nightly/idle', quince: 'queued nightly/idle', rowan: 'not-quiet' });
    expect(entries.find(e => e.boxName === 'fig' && e.component === 'claude')!.reason).toBe("quiet for 10 min, the owner's test window 15–17 (Europe/Berlin)");
  });

  it('a wrap-past-midnight window runs at 23:00 and not at 05:00', async () => {
    serve({ nightFromHour: 22, nightToHour: 4 });
    seed('fig', {});
    const eleven = NOW - 4 * H; // 23:00 in Berlin
    Object.assign(states.get('box-fig:claude')!, { lastSeenAt: new Date(eleven - 0.25 * H) });
    Object.assign(boxes.get('box-fig')!, { lastActivityAt: new Date(eleven - 3 * H), lastConnectedAt: new Date(eleven - 5 * H) });
    Object.assign(runs.get('last-box-fig')!, { requestedAt: new Date(eleven - 25 * H), startedAt: new Date(eleven - 25 * H) });
    expect(byBox(await runAutoUpdateSweep({ now: eleven }))).toEqual({ fig: 'queued nightly/idle' });
    runs.clear(); boxes.clear(); states.clear(); resetAutoUpdateForTests();
    seed('fig', {});
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 2 * H }))).toEqual({ fig: 'not-quiet' }); // 05:00
  });

  it('invalid values, or a flag that cannot be read, fall back to today\'s schedule', async () => {
    serve({ nightFromHour: 15, nightToHour: 15, everyHours: 0, quietMinutes: 1 });
    seed('quince', {}); seed('umbu', { lastRunH: 5 });
    let entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries)).toEqual({ quince: 'queued nightly/idle', umbu: 'ran-recently' });
    expect(entries.find(e => e.boxName === 'quince' && e.component === 'claude')!.reason).toBe("quiet for an hour, the owner's night (Europe/Berlin)");
    expect(vi.mocked(console.log).mock.calls.some(c => String(c[0]).includes('test schedule'))).toBe(false);

    runs.clear(); boxes.clear(); states.clear(); resetAutoUpdateForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ld.raw.mockImplementation((async (key: string) => { if (key === KEY) throw new Error('ld down'); return null; }) as never);
    seed('quince', {}); seed('umbu', { lastRunH: 5 });
    entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries)).toEqual({ quince: 'queued nightly/idle', umbu: 'ran-recently' });
    expect(warn.mock.calls.some(c => String(c[0]).includes('could not read tool-auto-update-schedule'))).toBe(true);
    warn.mockRestore();
  });

  it('floor and force runs, and resume runs, are the same with any schedule', async () => {
    const pass = async () => {
      seed('fig', { version: '2.1.290' }); seed('olive', { version: '2.1.290', breachH: 30 }); seed('plum', { resumed: true, activity: 0 });
      const entries = (await runAutoUpdateSweep({ now: NOW })).filter(e => e.component === 'claude').map(e => [e.boxName, e.outcome, e.trigger, e.restart, e.reason]);
      runs.clear(); boxes.clear(); states.clear(); resetAutoUpdateForTests(); await pumpFleet();
      return entries;
    };
    const today = await pass();
    serve({ nightFromHour: 15, nightToHour: 17, everyHours: 1, quietMinutes: 10 });
    expect(await pass()).toEqual(today);
    expect(today.map(e => e.slice(0, 4))).toEqual([['olive', 'queued', 'floor', 'force'], ['fig', 'queued', 'floor', 'idle'], ['plum', 'queued', 'resume', 'none']]);
  });
});

describe('a floor run that reaches the box and fails backs off', () => {
  // Rows as the box's report leaves them: started by its policy fetch, then reported.
  const ran = (id: string, hostKey: string, h: number, over: Record<string, unknown> = {}) =>
    runs.set(id, { id: id.padEnd(24, '0'), hostKey, component: 'claude', trigger: 'floor', status: 'failed', outcome: 'failed', fromVersion: '2.1.290', toVersion: '2.1.290', requestedAt: ago(h), startedAt: ago(h), finishedAt: ago(h - 0.1), ...over });

  it('fail, fail, fail: the box is held as floor-failing, 4 h after the newest; then a raised floor starts over', async () => {
    const fig = seed('fig', { version: '2.1.290', breachH: 12 });
    ran('f1', fig, 6); ran('f2', fig, 4.5); ran('f3', fig, 3);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'floor-failing' });
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 0.9 * H }))).toEqual({ fig: 'floor-failing' });
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 1.1 * H }))).toEqual({ fig: 'queued floor/idle' });

    // The same three failures under a raised floor (2.1.312): a new breach, its first run at once.
    runs.clear(); states.clear(); boxes.clear();
    const sage = seed('sage', { version: '2.1.290', breachH: 12 });
    ran('s1', sage, 6); ran('s2', sage, 4.5); ran('s3', sage, 3);
    ld.raw.mockImplementation((async (key: string) => (key === 'claude-code-update-policy' ? { floor: '2.1.312' } : null)) as never);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ sage: 'queued floor/idle' });
    ld.raw.mockImplementation((async () => null) as never);
  });

  it('counts a run reported as updated that left the box below the floor, and not one that reached it', async () => {
    const fig = seed('fig', { version: '2.1.290', breachH: 12 });
    ran('u1', fig, 4, { status: 'done', outcome: 'updated', toVersion: '2.1.300' });
    ran('u2', fig, 1.5, { status: 'done', outcome: 'partial', toVersion: '2.1.300' });
    // Two failures, the newest 1.5 h ago: held 2 h.
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'floor-failing' });
    runs.clear(); states.clear(); boxes.clear();
    const sage = seed('sage', { version: '2.1.290', breachH: 12 });
    // A run that did reach the floor is no failure (the inventory reading 2.1.290 is behind it): one hour after it, as before.
    ran('ok', sage, 1.5, { status: 'done', outcome: 'updated', toVersion: '2.1.316' });
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ sage: 'queued floor/idle' });
  });

  it('past forceAfterHours, a breach whose floor runs fail stays idle, and says so; the same breach with none forces', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fig = seed('fig', { version: '2.1.290', breachH: 30 });
    ran('f1', fig, 2);
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries)).toEqual({ fig: 'queued floor/idle' });
    expect(entries.find(e => e.boxName === 'fig' && e.component === 'claude')?.reason).toBe('2.1.290 has been below the floor 2.1.308 for 30 h; force held: its floor runs are failing');
    expect(log.mock.calls.map(c => String(c[0])).find(l => l.startsWith('[TOOL-AUTO] fig'))).toMatch(/floor run \S+, restart idle: .*force held: its floor runs are failing$/);
    log.mockRestore();
    // Control: a run that never reached the box is no failure, so it holds nothing back from force.
    runs.clear(); states.clear(); boxes.clear();
    const sage = seed('sage', { version: '2.1.290', breachH: 30 });
    ran('s1', sage, 2, { status: 'expired', outcome: null, startedAt: null, finishedAt: null });
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ sage: 'queued floor/force' });
  });
});

describe('passes in a row (Bugbot on #1163)', () => {
  it('a hello pass asked for during a fleet pass runs after it, and a fleet pass during a hello pass covers the fleet', async () => {
    const fig = seed('fig', { version: '2.1.290' }), sage = seed('sage', { version: '2.1.290' });
    boxes.get(fig)!.lastConnectedAt = new Date(NOW - 10_000); // the fleet pass leaves it settling
    const fleet = runAutoUpdateSweep({ now: NOW });
    const hello = runAutoUpdateSweep({ now: NOW, onlyBox: fig });
    expect(byBox(await fleet)).toEqual({ fig: 'settling', sage: 'queued floor/idle' });
    expect(byBox(await hello)).toEqual({ fig: 'queued floor/idle' });

    runs.clear();
    const hello2 = runAutoUpdateSweep({ now: NOW + 60_000, onlyBox: fig });
    const fleet2 = runAutoUpdateSweep({ now: NOW + 60_000 });
    expect(Object.keys(byBox(await hello2))).toEqual(['fig']);
    expect(Object.keys(byBox(await fleet2)).sort()).toEqual(['fig', 'sage']);
  });

  it('shares only the same request: a second fleet pass, or a second hello of one box, while the first is pending', async () => {
    seed('fig', {});
    const a = runAutoUpdateSweep({ now: NOW }), b = runAutoUpdateSweep({ now: NOW });
    expect(b).toBe(a);
    const c = runAutoUpdateSweep({ now: NOW, onlyBox: 'box-fig' }), d = runAutoUpdateSweep({ now: NOW, onlyBox: 'box-fig' });
    expect(d).toBe(c);
    expect(c).not.toBe(a);
    await Promise.all([a, c]);
  });
});

describe('the orchestrator host', () => {
  it('is never a box here: its Claude Code has its own nightly run (orchestrator.ts)', async () => {
    seed('fig', { version: '2.1.290' });
    // A row keyed as the orchestrator's host, below the floor and due: the sweep must not touch it.
    boxes.set('orchestrator', { ...boxes.get('box-fig')!, id: 'orchestrator', name: 'orchestrator' });
    inventory.set('orchestrator', '2.1.290');
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(entries.some(e => e.hostKey === 'orchestrator')).toBe(false);
    expect([...runs.values()].filter(r => r.hostKey === 'orchestrator')).toEqual([]);
    expect([...states.keys()].some(k => k.startsWith('orchestrator:'))).toBe(false);
    expect(byBox(entries)).toEqual({ fig: 'queued floor/idle' });
  });
});

describe('Bugbot on #1163', () => {
  it('a box that cannot take a run keeps no force clock: back, it starts with idle', async () => {
    const olive = seed('olive', { version: '2.1.290', breachH: 30, connected: false });
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ olive: 'offline' });
    expect(states.get(`${olive}:claude`)).toMatchObject({ breachFloor: '2.1.308', breachSince: null });
    offline.clear();
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 60_000 }))).toEqual({ olive: 'queued floor/idle' });
    expect(states.get(`${olive}:claude`)!.breachSince).toEqual(new Date(NOW + 60_000));
  });

  it('a box still settling after a connect keeps its force clock, and is forced on its hello pass', async () => {
    const olive = seed('olive', { version: '2.1.290', breachH: 30 });
    boxes.get(olive)!.lastConnectedAt = new Date(NOW - 10_000);
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ olive: 'settling' });
    expect(states.get(`${olive}:claude`)!.breachSince).toEqual(ago(30));
    expect(byBox(await runAutoUpdateSweep({ now: NOW, onlyBox: olive }))).toEqual({ olive: 'queued floor/force' });
  });

  it('a force clock left while the flag was off is not a day of idle attempts: back on, the first run is idle', async () => {
    const olive = seed('olive', { version: '2.1.290', breachH: 30 });
    states.get(`${olive}:claude`)!.breachSeenAt = ago(48); // the last pass that saw it, before the flag went off
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ olive: 'queued floor/idle' });
    expect(states.get(`${olive}:claude`)).toMatchObject({ breachSince: new Date(NOW), breachSeenAt: new Date(NOW) });
  });

  it("a tool that cannot act on a resume yet keeps the marker for a later pass; once it can, it gets its resume run", async () => {
    const plum = seed('plum', { resumed: true });
    codexAuto.add(plum); codexUpdate.add(plum); codexInventory.set(plum, '0.163.0');
    // Codex's unit is not on the box yet: Claude Code's resume run is queued, the marker stays for Codex.
    const first = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(first)).toEqual({ plum: 'queued resume/none' });
    expect(byBox(first, 'codex')).toEqual({ plum: 'not-capable' });
    expect(boxes.get(plum)!.resumedFromHibernationAt).not.toBeNull();
    codexCapable.add(plum);
    const second = await runAutoUpdateSweep({ now: NOW + 60_000 });
    expect(byBox(second, 'codex')).toEqual({ plum: 'queued resume/none' });
    startQueued(NOW + 60_000);
    await runAutoUpdateSweep({ now: NOW + 120_000 });
    expect(boxes.get(plum)!.resumedFromHibernationAt).toBeNull();
  });

  it("a hello whose box reconnected during the wait runs no pass: the new connection's own hello does", async () => {
    let hello: ((ev: any) => void) | null = null;
    vi.mocked(onBoxAgentHello).mockImplementation(fn => { hello = fn; return () => {}; });
    const fig = seed('fig', { version: '2.1.290' });
    startToolAutoUpdateSweep({ sweepMs: 10 ** 9, settleMs: 20 });
    hello!({ instance: boxes.get(fig), user: robin, agentCommit: null, capabilities: ['tool-update-v1'] });
    conns.set(fig, { id: fig, again: true });
    await new Promise(r => setTimeout(r, 60));
    expect([...runs.values()].filter(r => r.reason)).toEqual([]);
    stopToolAutoUpdateSweep();
  });
});

describe('with every mode off', () => {
  it('does nothing: no state, no run, no RPC, and reads no flag past each policy', async () => {
    seed('fig', { version: '2.1.290', updateOff: true });
    seed('plum', { resumed: true, updateOff: true });
    states.clear();
    const entries = await runAutoUpdateSweep({ now: NOW });
    expect(byBox(entries)).toEqual({ fig: 'auto-off', plum: 'auto-off' });
    expect(prisma.toolAutoUpdateState.upsert).not.toHaveBeenCalled();
    expect(prisma.softwareUpdateRun.create).not.toHaveBeenCalled();
    expect(prisma.instance.updateMany).not.toHaveBeenCalled();
    // No on/off flag is read: each tool's policy is read once per box, for its mode, and nothing else.
    expect(boolVariation).not.toHaveBeenCalled();
    expect(vi.mocked(jsonVariation).mock.calls.map(c => c[0]).sort()).toEqual(AUTO_UPDATE.flatMap(c => [TOOL_REGISTRY[c].policyFlag, TOOL_REGISTRY[c].policyFlag]).sort());
    // No tool's inventory or run history is read either: a flag that is off costs no query (Devin on #1294).
    expect(prisma.hostSoftware.findMany).not.toHaveBeenCalled();
    expect(prisma.softwareUpdateRun.findMany).not.toHaveBeenCalled();
    await pumpFleet();
    expect(rpcs()).toEqual([]);
  });

  it('with a tool on for one box only, reads its inventory and run history for that box alone (Devin on #1294)', async () => {
    const fig = seed('fig', { version: '2.1.290' });
    seed('sage', { autoOff: true });
    await runAutoUpdateSweep({ now: NOW });
    const asked = (calls: unknown[][]) => calls.map(c => (c[0] as any).where?.hostKey?.in).filter(Boolean);
    // Only Claude Code's flag is on (for fig): every inventory and history read is for [fig].
    expect(asked(vi.mocked(prisma.hostSoftware.findMany).mock.calls)).toEqual([[fig]]);
    const history = asked(vi.mocked(prisma.softwareUpdateRun.findMany).mock.calls);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every(ids => JSON.stringify(ids) === JSON.stringify([fig]))).toBe(true);
  });
});

describe('the leader job', () => {
  it('is started and stopped with the rest of the leader work', () => {
    const index = readFileSync(join(__dirname, '../../index.ts'), 'utf8');
    const body = (fn: string) => index.slice(index.indexOf(`function ${fn}(`), index.indexOf('\n}\n', index.indexOf(`function ${fn}(`)));
    expect(body('startLeaderWork')).toContain('startToolAutoUpdateSweep();');
    expect(body('stopLeaderWork')).toContain('stopToolAutoUpdateSweep();');
  });

  it('sweeps on its interval and on a box\'s hello once it settles, and a stop ends both', async () => {
    let hello: ((ev: any) => void) | null = null;
    const unsubscribe = vi.fn();
    vi.mocked(onBoxAgentHello).mockImplementation(fn => { hello = fn; return unsubscribe; });
    seed('plum', { resumed: true });
    // This pass runs on the real clock (no `now`): a marker from NOW would be days old, past resumePending's cap.
    boxes.get('box-plum')!.resumedFromHibernationAt = new Date(Date.now() - 60_000);
    startToolAutoUpdateSweep({ sweepMs: 10 ** 9, settleMs: 20 });
    expect(hello).not.toBeNull();
    hello!({ instance: boxes.get('box-plum'), user: robin, agentCommit: null, capabilities: ['tool-update-v1'] });
    await vi.waitFor(() => expect([...runs.values()].some(r => r.hostKey === 'box-plum' && r.trigger === 'resume')).toBe(true));
    stopToolAutoUpdateSweep();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    // A hello pending when the lease is lost sends nothing.
    runs.clear(); seed('fig', { version: '2.1.290' });
    startToolAutoUpdateSweep({ sweepMs: 10 ** 9, settleMs: 20 });
    hello!({ instance: boxes.get('box-fig'), user: robin, agentCommit: null, capabilities: ['tool-update-v1'] });
    stopToolAutoUpdateSweep();
    await new Promise(r => setTimeout(r, 50));
    expect([...runs.values()].filter(r => r.reason)).toEqual([]);
  });

  it('the interval runs a full pass', async () => {
    seed('fig', { version: '2.1.290' });
    startToolAutoUpdateSweep({ sweepMs: 20, settleMs: 10 ** 9 });
    await vi.waitFor(() => expect([...runs.values()].some(r => r.hostKey === 'box-fig' && r.trigger === 'floor')).toBe(true));
  });
});

describe('autoUpdateSummary', () => {
  it('counts the last day\'s automatic runs by tool and trigger and lists the newest', async () => {
    seed('fig', { version: '2.1.290' });
    seed('quince', {});
    runs.set('man', { id: 'manual'.padEnd(24, '0'), hostKey: 'box-quince', component: 'claude', trigger: 'manual', status: 'done', requestedAt: ago(0.5) });
    await runAutoUpdateSweep({ now: NOW });
    const s = await autoUpdateSummary(NOW);
    expect(s.tools).toEqual([{ component: 'claude', policyFlag: 'claude-code-update-policy' }, { component: 'codex', policyFlag: 'codex-update-policy' }, { component: 'cursor', policyFlag: 'cursor-update-policy' }, { component: 'devin', policyFlag: 'devin-update-policy' }, { component: 'pi', policyFlag: 'pi-update-policy' }, { component: 'gh', policyFlag: 'gh-update-policy' }, { component: 'aws', policyFlag: 'aws-update-policy' }, { component: 'node', policyFlag: 'node-update-policy' }, { component: 'python', policyFlag: 'python-update-policy' }, { component: 'docker', policyFlag: 'docker-update-policy' }]);
    // An unsent manual run holds no automatic trigger: backoff is per trigger (#1163).
    expect(s.last24h).toEqual({ claude: { floor: 1, nightly: 1 } });
    expect(s.recent.map(r => [r.hostKey, r.trigger, r.reason])).toEqual(expect.arrayContaining([['box-fig', 'floor', '2.1.290 is below the floor 2.1.308']]));
    // Two boxes, and every tool but Claude Code (eight) off for both.
    expect(s.lastPass?.outcomes).toEqual({ queued: 2, 'auto-off': 18 });
  });
});

describe('the policy\'s mode decides (gate.ts)', () => {
  afterEach(() => { ld.raw.mockImplementation((async () => null) as never); });
  // The mode served beats the case's sets: fig is on for auto there, sage is off.
  const serveMode = (mode: unknown) => ld.raw.mockImplementation((async (key: string) => (key === 'claude-code-update-policy' ? { mode } : null)) as never);

  it('off: the sweep skips the tool, and reads nothing past the policy', async () => {
    seed('fig', { version: '2.1.290' });
    serveMode('off');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'auto-off' });
    expect(boolVariation).not.toHaveBeenCalled();
    expect(prisma.toolAutoUpdateState.upsert).not.toHaveBeenCalled();
    expect([...runs.values()].filter(r => r.trigger === 'floor')).toEqual([]);
  });

  it('manual: the sweep does not run it either (the Software tab still does)', async () => {
    seed('fig', { version: '2.1.290' });
    serveMode('manual');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'auto-off' });
    expect(await TOOL_REGISTRY.claude.enabled(robin as never, { id: 'box-fig', name: 'fig', kind: 'ec2' })).toBe(true);
  });

  it('auto: the sweep runs it, from one read of the policy and no other flag', async () => {
    seed('fig', { version: '2.1.290', updateOff: true });
    serveMode('auto');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'queued floor/idle' });
    expect(boolVariation).not.toHaveBeenCalled();
    // One read of the policy per box decides auto, enabled and the run.
    expect(vi.mocked(jsonVariation).mock.calls.filter(c => c[0] === 'claude-code-update-policy')).toHaveLength(1);
  });

  it('malformed: off, so the sweep skips it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    seed('fig', { version: '2.1.290' });
    serveMode('sometimes');
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'auto-off' });
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('missing, or the flag source down (the policy\'s fallback, null): off, so the sweep skips every tool', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    seed('fig', { version: '2.1.290' });
    ld.modeOf = null;
    expect(byBox(await runAutoUpdateSweep({ now: NOW }))).toEqual({ fig: 'auto-off' });
    serveMode(undefined);
    expect(byBox(await runAutoUpdateSweep({ now: NOW + 60_000 }))).toEqual({ fig: 'auto-off' });
    expect(boolVariation).not.toHaveBeenCalled();
    expect(prisma.toolAutoUpdateState.upsert).not.toHaveBeenCalled();
  });
});
