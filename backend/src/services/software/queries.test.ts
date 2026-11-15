import { beforeEach, describe, expect, it, vi } from 'vitest';

// Made-up boxes and owners. One terminated box (i-dead) left a newer Claude Code behind in host_software.
const at = new Date('2026-11-10T10:00:00Z');
// The clock, a quarter of an hour after the rows were observed: the matrix reads an inventory older
// than INVENTORY_STALE_MS (a day) as no_inventory, so a real clock fails these a day after `at`.
vi.useFakeTimers({ toFake: ['Date'], now: new Date(at.getTime() + 15 * 60_000) });
const row = (hostKey: string, hostKind: string, component: string, version: string | null, ok = true) =>
  ({ hostKey, hostKind, component, version, raw: version, path: version ? '/usr/bin/x' : null, ok, source: 'agent', observedAt: at });
const user = (id: string, unixUsername: string) => ({ id, googleEmail: `${unixUsername}@example.com`, displayName: unixUsername, unixUsername, defaultAgentProvider: 'claude' });
const hostRows = [
  row('orchestrator', 'orchestrator', 'claude', '2.1.300'),
  row('orchestrator', 'orchestrator', 'gh', '2.80.0'),
  row('i-on', 'box', 'claude', '2.1.314'),
  row('i-old', 'box', 'claude', '2.1.240'),
  row('i-held', 'box', 'claude', '2.1.310'),
  row('i-pool', 'box', 'claude', '2.1.310'),
  row('i-on', 'box', 'gh', '2.103.0'),
  row('i-old', 'box', 'gh', '2.102.0'),
  row('i-on', 'box', 'tmux', '3.4'),
  row('i-dead', 'box', 'claude', '2.1.399'),
  row('i-dead', 'box', 'tmux', '3.9'),
];
// Runs requested or running: a run on otter-box, which is current, so the fleet's scope never takes it.
const runRows: Array<Record<string, unknown>> = [{ id: 'r-on', hostKey: 'i-on', component: 'claude', status: 'running', requestedAt: new Date(), startedAt: new Date() }];
const instances = [
  { id: 'i-on', name: 'otter-box', kind: 'ec2', status: 'ready', user: user('u1', 'river') },
  { id: 'i-old', name: 'heron-box', kind: 'ec2', status: 'ready', user: user('u2', 'marsh') },
  { id: 'i-held', name: 'wren-box', kind: 'ec2', status: 'ready', user: user('u3', 'moor') },
  { id: 'i-pool', name: 'pool-box', kind: 'ec2', status: 'ready', user: null },
];

vi.mock('../../db', () => ({
  prisma: {
    hostSoftware: { findMany: vi.fn(async (q?: any) => (q?.where?.hostKind ? [] : hostRows)) },
    instance: { findMany: vi.fn(async () => instances) },
    user: { findMany: vi.fn(async () => []) },
    softwareChange: { findMany: vi.fn(async () => []) },
    // A Claude Code run in flight on otter-box.
    // As Postgres would: by hostKey (one, or `in` a list) and status.
    softwareUpdateRun: { findMany: vi.fn(async (q?: any) => runRows.filter(r => {
      const hk = q?.where?.hostKey, st = q?.where?.status?.in;
      return (hk === undefined || (typeof hk === 'string' ? r.hostKey === hk : hk.in.includes(r.hostKey))) && (!st || st.includes(r.status));
    })) },
  },
}));
// Every box connected; heron-box's agent can update Claude Code but not gh.
vi.mock('../agentRegistry', () => ({
  isInstanceAgentConnected: () => true, inventoryHosts: () => [],
  instanceAgentTransport: (id: string) => ({ capabilities: id === 'i-old' ? ['tool-update-v1'] : ['tool-update-v1', 'tool-update-gh-v1', 'tool-update-node-v1'] }),
}));
// The pacer holds `queued-run` (runs.ts runActive reads its in-memory queue).
vi.mock('../toolUpdate/runs', async importOriginal => {
  const real = await importOriginal<typeof import('../toolUpdate/runs')>();
  return { ...real, runActive: (r: { id: string; status: string; requestedAt: Date; startedAt: Date | null; component: string }, now: number) => r.id === 'queued-run' || real.runActive(r, now) };
});
vi.mock('../boxUpdate', () => ({ targetBoxCommit: async () => null }));
vi.mock('../prDeploy', () => ({ newestOrchestratorImage: async () => null }));
vi.mock('../termagVersion', () => ({ termagVersion: async () => ({ sha: null }) }));
vi.mock('./collector', () => ({ collectorStatus: () => ({ lastSweepAt: null, lastSelfAt: null, lastError: null }) }));
// Each tool's policy flag: Claude Code pinned to 2.1.314, floor 2.1.308, auto; off for wren-box's owner.
// `throwFor`: an owner whose read throws (readPolicy's catch).
// The orchestrator's own pin: none (the floor only).
const throwFor = vi.hoisted(() => ({ owner: '' }));
const orchMode = vi.hoisted(() => ({ value: 'auto' }));
const policyFor = vi.fn((key: string, u: { unixUsername: string }) => {
  if (u.unixUsername === throwFor.owner) throw new Error('read failed');
  // Node's floor raised to 24.23.0 before any box has it, target latest (a floor-only raise).
  if (key === 'node-update-policy') return { mode: 'auto', floor: '24.23.0', target: 'latest' };
  if (key === 'claude-code-update-policy') return { mode: u.unixUsername === 'moor' ? 'off' : 'auto', floor: '2.1.308', target: '2.1.314' };
  return { mode: 'auto', floor: '2.102.0', target: 'latest' };
});
vi.mock('../featureFlags', () => ({
  jsonVariation: vi.fn(async (key: string, u: { unixUsername: string }) => policyFor(key, u)),
  jsonVariationForContext: vi.fn(async (key: string) => (key === 'orchestrator-claude-update-policy' ? { mode: orchMode.value } : { mode: 'auto', floor: '2.1.308', target: '2.1.314' })),
}));

const pass = vi.hoisted(() => ({ value: null as null | { at: string; entries: Array<Record<string, string>> } }));
vi.mock('../toolUpdate/autoRuns', () => ({ lastAutoPass: () => pass.value }));

const { softwareMatrix } = await import('./queries');

beforeEach(() => { policyFor.mockClear(); });

describe('softwareMatrix: tools against each box\'s policy', () => {
  it('grades each state, and agrees with the policy rather than the fleet\'s newest', async () => {
    const m = await softwareMatrix();
    const cell = (hostKey: string, c: string) => m.hosts.find(h => h.hostKey === hostKey)!.cells[c];
    expect(cell('i-on', 'claude').state).toBe('current');
    expect(cell('i-on', 'claude').policy).toEqual({ mode: 'auto', floor: '2.1.308', target: '2.1.314', reference: '2.1.314' });
    expect(cell('i-old', 'claude').state).toBe('below-floor');
    expect(cell('i-held', 'claude').state).toBe('held');
    // No owner, no policy: held, and no policy on the cell.
    expect(cell('i-pool', 'claude').state).toBe('held');
    expect(cell('i-pool', 'claude').policy).toBeUndefined();
    // The orchestrator: below the shared floor; no pin, so at or above it would be current.
    expect(cell('orchestrator', 'claude').state).toBe('below-floor');
    expect(cell('orchestrator', 'claude').policy?.target).toBe('floor only');
    // gh under latest: the boxes' newest, not the orchestrator's; the orchestrator's own gh against the same, the old way.
    expect(cell('i-on', 'gh').state).toBe('current');
    expect(cell('i-old', 'gh').state).toBe('behind');
    expect(cell('orchestrator', 'gh').state).toBe('outdated');
    expect(cell('orchestrator', 'gh').policy).toBeUndefined();
  });
  it('leaves terminated boxes out of every host, count and reference', async () => {
    const m = await softwareMatrix();
    expect(m.hosts.map(h => h.hostKey)).not.toContain('i-dead');
    const claude = m.summary.find(s => s.component === 'claude')!;
    expect(claude.reference).toBe('2.1.314');
    expect(claude.floor).toBe('2.1.308');
    expect(claude.spread.map(v => v.version)).not.toContain('2.1.399');
    expect(claude.counts).toMatchObject({ current: 1, 'below-floor': 2, held: 2, behind: 0 });
    // A component no tool policy covers: the newest of the hosts that exist (3.9 was the terminated box's).
    expect(m.summary.find(s => s.component === 'tmux')!.reference).toBe('3.4');
  });
  it('reads each tool\'s policy once per owned box, never for an unowned one', async () => {
    await softwareMatrix();
    const owners = new Set(policyFor.mock.calls.map(c => c[1].unixUsername));
    expect([...owners].sort()).toEqual(['marsh', 'moor', 'river']);
    expect(policyFor.mock.calls.filter(c => c[0] === 'claude-code-update-policy')).toHaveLength(3);
  });
});

describe('softwareMatrix: whether the fleet update would act on a cell', () => {
  it('is the fleet update\'s own skip (selectFleet), from the box\'s facts', async () => {
    const m = await softwareMatrix();
    const cell = (hostKey: string, c: string) => m.hosts.find(h => h.hostKey === hostKey)!.cells[c];
    expect(cell('i-old', 'claude').state).toBe('below-floor');
    expect(cell('i-old', 'claude').refusal).toBeNull();
    expect(cell('i-held', 'claude').refusal).toBe('claude_update_off');
    expect(cell('i-old', 'gh').refusal).toBe('not_capable');
    // Current: no scope takes it, so nothing to skip, run or no run.
    expect(cell('i-on', 'claude').refusal).toBeNull();
    expect(cell('i-on', 'gh').refusal).toBeNull();
    // No policy, no refusal: an unowned box.
    expect(cell('i-pool', 'claude').refusal).toBeUndefined();
    // The orchestrator's Claude Code has a policy, but the fleet buttons never take the orchestrator (Bugbot on #1607).
    expect(cell('orchestrator', 'claude').refusal).toBe('orchestrator');
  });
  it('skips stale inventory, a run in flight, and a run the pacer has held past 15 minutes (Devin and Bugbot on #1607)', async () => {
    const old = new Date(Date.now() - 30 * 3600_000);
    const added = [
      { id: 'i-stale', name: 'stale-box', kind: 'ec2', status: 'ready', user: user('u4', 'heath') },
      { id: 'i-busy', name: 'busy-box', kind: 'ec2', status: 'ready', user: user('u5', 'fen') },
      { id: 'i-queued', name: 'queued-box', kind: 'ec2', status: 'ready', user: user('u6', 'delta') },
    ];
    const addedRows = [
      { ...row('i-stale', 'box', 'claude', '2.1.250'), observedAt: old },
      row('i-busy', 'box', 'claude', '2.1.250'),
      row('i-queued', 'box', 'claude', '2.1.250'),
    ];
    const addedRuns = [
      { id: 'r-busy', hostKey: 'i-busy', component: 'claude', status: 'running', requestedAt: new Date(), startedAt: new Date() },
      // Requested 20 minutes ago and still in the pacer: isInFlight alone would let it go.
      { id: 'queued-run', hostKey: 'i-queued', component: 'claude', status: 'requested', requestedAt: new Date(Date.now() - 20 * 60_000), startedAt: null },
    ];
    instances.push(...added); hostRows.push(...addedRows); runRows.push(...addedRuns);
    try {
      const m = await softwareMatrix();
      const cell = (hostKey: string) => m.hosts.find(h => h.hostKey === hostKey)!.cells.claude;
      expect(cell('i-stale')).toMatchObject({ state: 'below-floor', refusal: 'no_inventory' });
      expect(cell('i-busy')).toMatchObject({ state: 'below-floor', refusal: 'run_in_flight' });
      expect(cell('i-queued')).toMatchObject({ state: 'below-floor', refusal: 'run_in_flight' });
    } finally {
      instances.splice(-added.length); hostRows.splice(-addedRows.length); runRows.splice(-addedRuns.length);
    }
  });
  it('says policyUnavailable for an owned box whose policy read throws, never for an unowned one', async () => {
    throwFor.owner = 'marsh';
    try {
      const m = await softwareMatrix();
      const c = m.hosts.find(h => h.hostKey === 'i-old')!.cells.claude;
      expect(c).toMatchObject({ state: 'held', policyUnavailable: true });
      expect(c.policy).toBeUndefined();
      expect(m.hosts.find(h => h.hostKey === 'i-pool')!.cells.claude.policyUnavailable).toBeUndefined();
    } finally { throwFor.owner = ''; }
  });
});

describe('softwareMatrix: what each scope of the fleet update takes (Bugbot on #1607)', () => {
  it('a floor-only raise under latest: every box below the floor, none behind its reference', async () => {
    const added = [row('i-on', 'box', 'node', '24.22.1'), row('i-old', 'box', 'node', '24.22.1')];
    hostRows.push(...added);
    try {
      const m = await softwareMatrix();
      const cell = (hostKey: string) => m.hosts.find(h => h.hostKey === hostKey)!.cells.node;
      // The reference under latest is the boxes' newest, 24.22.1: on it, so behind takes neither.
      expect(cell('i-on')).toMatchObject({ state: 'below-floor', refusal: null, fleet: { 'below-floor': true, behind: false } });
      expect(cell('i-on').policy?.reference).toBe('24.22.1');
      // Each scope is what selectFleet itself takes over the box's facts, refusals included.
      expect(m.hosts.find(h => h.hostKey === 'i-held')!.cells.claude.fleet).toEqual({ 'below-floor': false, behind: false });
      expect(m.hosts.find(h => h.hostKey === 'i-old')!.cells.claude.fleet).toEqual({ 'below-floor': true, behind: true });
      expect(m.hosts.find(h => h.hostKey === 'i-on')!.cells.claude.fleet).toEqual({ 'below-floor': false, behind: false });
      // The orchestrator and unowned boxes have no fleet scopes: the buttons never take them.
      expect(m.hosts.find(h => h.hostKey === 'orchestrator')!.cells.claude.fleet).toBeUndefined();
      expect(m.hosts.find(h => h.hostKey === 'i-pool')!.cells.claude.fleet).toBeUndefined();
    } finally { hostRows.splice(-added.length); }
  });
});

describe('softwareMatrix: the orchestrator\'s own policy grades it (Bugbot on #1607)', () => {
  it('with its own mode off: mode off, and no host panel Update with no admin to ask for', async () => {
    orchMode.value = 'off';
    try {
      const c = (await softwareMatrix()).hosts.find(h => h.hostKey === 'orchestrator')!.cells.claude;
      expect(c).toMatchObject({ state: 'below-floor', refusal: 'orchestrator_panel_off', policy: { mode: 'off' } });
      expect(c.panel).toBeUndefined();
    } finally { orchMode.value = 'auto'; }
    // Its nightly run on (orchestrator-claude-update-policy auto, Claude Code's on for its own context): mode auto.
    const c = (await softwareMatrix()).hosts.find(h => h.hostKey === 'orchestrator')!.cells.claude;
    expect(c).toMatchObject({ refusal: 'orchestrator', policy: { mode: 'auto' } });
    orchMode.value = 'manual';
    try {
      expect((await softwareMatrix()).hosts.find(h => h.hostKey === 'orchestrator')!.cells.claude.policy?.mode).toBe('manual');
    } finally { orchMode.value = 'auto'; }
  });
});

describe('softwareMatrix: the orchestrator\'s grade is its own, the host panel the admin\'s (Bugbot on #1607)', () => {
  it('two admins whose claude-code-update-policy differs: the same state, mode and counts, a different host panel', async () => {
    // claude-code-update-policy is mode off for moor and auto for river (policyFor above); the orchestrator's
    // own context is auto, with its nightly run on.
    const on = await softwareMatrix(user('u7', 'river') as never);
    const off = await softwareMatrix(user('u8', 'moor') as never);
    const orch = (m: Awaited<ReturnType<typeof softwareMatrix>>) => m.hosts.find(h => h.hostKey === 'orchestrator')!.cells.claude;
    // The grade is the orchestrator's own: the same for both.
    expect(orch(on).state).toBe(orch(off).state);
    expect(orch(on).policy).toEqual(orch(off).policy);
    expect(orch(on).policy?.mode).toBe('auto');
    expect(on.summary.find(r => r.component === 'claude')!.counts).toEqual(off.summary.find(r => r.component === 'claude')!.counts);
    // The host panel is each admin's, as orchestratorPreview gives it them.
    expect(orch(on)).toMatchObject({ refusal: 'orchestrator', panel: { offered: true, mode: 'auto' } });
    // The nightly run is on while this admin's own policy is off: their panel has no Update, the grade still says auto.
    expect(orch(off)).toMatchObject({ refusal: 'orchestrator_panel_off', panel: { offered: false, mode: 'off' }, policy: { mode: 'auto' } });
  });
});

describe('softwareMatrix: the sweep\'s last pass', () => {
  it('puts a skip that blocks an update on its cell, and only those', async () => {
    pass.value = { at: '2026-11-10T09:45:00Z', entries: [
      { hostKey: 'i-old', component: 'claude', outcome: 'floor-failing' },
      { hostKey: 'i-old', component: 'gh', outcome: 'current' },
      { hostKey: 'i-old', component: 'gh', outcome: 'backing-off' },
      // otter-box's Claude Code is current: the sweep's not-capable there blocks nothing (Devin on #1608).
      { hostKey: 'i-on', component: 'claude', outcome: 'not-capable' },
      { hostKey: 'i-held', component: 'claude', outcome: 'not-capable' },
    ] };
    const m = await softwareMatrix();
    const cell = (hostKey: string, c: string) => m.hosts.find(h => h.hostKey === hostKey)!.cells[c];
    expect(cell('i-old', 'claude').sweep).toEqual({ why: 'floor-failing', at: '2026-11-10T09:45:00Z' });
    expect(cell('i-old', 'gh').sweep?.why).toBe('backing-off');
    expect(cell('i-on', 'claude').state).toBe('current');
    expect(cell('i-on', 'claude').sweep).toBeUndefined();
    // Held (mode off) is no update due either.
    expect(cell('i-held', 'claude').sweep).toBeUndefined();
    pass.value = null;
  });
});

describe('softwareMatrix: a cell\'s run in flight is runActive\'s (Bugbot and Devin on #1608)', () => {
  it('a Docker run queued 3 days, a run at running for 2 hours, and a normal one', async () => {
    const h = 3600_000;
    const addedRows = [row('i-on', 'box', 'docker', '29.9.3'), row('i-old', 'box', 'docker', '29.9.3'), row('i-held', 'box', 'node', '24.22.1')];
    const addedRuns = [
      // At-start (Docker): requested, waiting for the box's next start, 3 days in (its expiry is longer).
      { id: 'r-docker', hostKey: 'i-on', component: 'docker', status: 'requested', requestedAt: new Date(Date.now() - 72 * h), startedAt: null },
      // Running for 2 hours: past runActive's stale cut-off, so not in flight any more.
      { id: 'r-stuck', hostKey: 'i-old', component: 'docker', status: 'running', requestedAt: new Date(Date.now() - 2 * h), startedAt: new Date(Date.now() - 2 * h) },
      { id: 'r-node', hostKey: 'i-held', component: 'node', status: 'running', requestedAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 60_000) },
    ];
    hostRows.push(...addedRows); runRows.push(...addedRuns);
    try {
      const m = await softwareMatrix();
      const cell = (hostKey: string, c: string) => m.hosts.find(x => x.hostKey === hostKey)!.cells[c];
      expect(cell('i-on', 'docker').inFlight).toMatchObject({ id: 'r-docker', status: 'requested', atStart: true });
      expect(cell('i-old', 'docker').inFlight).toBeUndefined();
      expect(cell('i-held', 'node').inFlight).toEqual({ id: 'r-node', status: 'running', requestedAt: addedRuns[2].requestedAt.toISOString() });
      // otter-box's Claude Code run (fixtures above) is in flight too; a tool with no run has none.
      expect(cell('i-on', 'claude').inFlight?.id).toBe('r-on');
      expect(cell('i-on', 'gh').inFlight).toBeUndefined();
    } finally { hostRows.splice(-addedRows.length); runRows.splice(-addedRuns.length); }
  });
});

describe('softwareMatrix: the orchestrator\'s own update in flight (Devin on #1608)', () => {
  it('gives the orchestrator\'s Claude Code cell the run its host panel shows, and none once it ends', async () => {
    const started = new Date(Date.now() - 5 * 60_000);
    const orchRun = { id: 'r-orch', hostKey: 'orchestrator', component: 'claude', status: 'running', requestedAt: started, startedAt: started };
    runRows.push(orchRun);
    try {
      const m = await softwareMatrix();
      const cell = m.hosts.find(h => h.hostKey === 'orchestrator')!.cells.claude;
      expect(cell.inFlight).toEqual({ id: 'r-orch', status: 'running', requestedAt: started.toISOString() });
      // Its other tools, and the boxes' runs, are not it.
      expect(m.hosts.find(h => h.hostKey === 'orchestrator')!.cells.gh.inFlight).toBeUndefined();
      orchRun.status = 'done';
      const after = (await softwareMatrix()).hosts.find(h => h.hostKey === 'orchestrator')!.cells.claude;
      expect(after.inFlight).toBeUndefined();
    } finally { runRows.splice(runRows.indexOf(orchRun), 1); }
  });
  it('none with no run in flight on the orchestrator, whatever the boxes run', async () => {
    const m = await softwareMatrix();
    expect(m.hosts.find(h => h.hostKey === 'orchestrator')!.cells.claude.inFlight).toBeUndefined();
    expect(m.hosts.find(h => h.hostKey === 'i-on')!.cells.claude.inFlight?.id).toBe('r-on');
  });
});
