import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync as realExists, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const rows = new Map<string, Record<string, any>>();
let nextId = 0;
const newId = () => `orun${String(++nextId).padStart(22, '0')}`;
const matches = (r: Record<string, any>, where: Record<string, any>) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(r[k]);
    if ('notIn' in v) return !v.notIn.includes(r[k]);
  }
  return r[k] === v;
});
vi.mock('../../db', () => {
  const softwareUpdateRun = {
    create: vi.fn(async ({ data }: any) => { const r = { id: newId(), requestedAt: new Date(), startedAt: null, finishedAt: null, ...data }; rows.set(r.id, r); return r; }),
    findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
    findMany: vi.fn(async ({ where }: any) => [...rows.values()].filter(r => matches(r, where)).sort((a, b) => b.requestedAt - a.requestedAt)),
    findFirst: vi.fn(async ({ where }: any) => [...rows.values()].filter(r => matches(r, where)).sort((a, b) => b.requestedAt - a.requestedAt)[0] ?? null),
    updateMany: vi.fn(async ({ where, data }: any) => { const hit = [...rows.values()].filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; }),
  };
  const prisma: any = {
    softwareUpdateRun,
    instance: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    hostSoftware: {
      findMany: vi.fn(async () => [{ hostKey: 'orchestrator', version: hostVersion.v, ok: true }]),
      findFirst: vi.fn(async () => ({ version: hostVersion.v })),
      count: vi.fn(async () => 0),
    },
    user: { findMany: vi.fn(async () => []) },
  };
  prisma.$transaction = vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn({ ...prisma, $executeRaw: vi.fn(async () => 0) }));
  return { prisma };
});
// The orchestrator host's inventoried claude, orchestrator-claude-update-policy's value (undefined: the flag
// serves nothing), and claude-code-update-policy's mode (for the admin and for the orchestrator alone).
const hostVersion = vi.hoisted(() => ({ v: '2.1.308' }));
const orchPolicy = vi.hoisted(() => ({ value: { mode: 'auto', target: '2.1.316' } as unknown }));
const toolMode = vi.hoisted(() => ({ mode: 'auto' as unknown }));
// boolVariation and boolVariationForContext are there only to show they are never called: no on/off flag is read.
vi.mock('../featureFlags', () => ({
  boolVariation: vi.fn(async () => true),
  boolVariationForContext: vi.fn(async () => true),
  jsonVariation: vi.fn(async () => ({ mode: toolMode.mode, floor: '2.1.310', target: 'latest' })),
  jsonVariationForContext: vi.fn(async (key: string) => (key === 'orchestrator-claude-update-policy' ? orchPolicy.value ?? null : { mode: toolMode.mode, floor: '2.1.310', target: 'latest' })),
}));
vi.mock('../software/collector', () => ({ selfInventory: vi.fn(async () => {}) }));
// The image's helper and unit: present unless a test says not.
let installed = true;
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn((p: string) => (p.startsWith('/usr/local/libexec/termag/') || p.startsWith('/etc/systemd/system/') ? installed : actual.existsSync(p))) };
});
// sudo: answers as the helper would.
let sudoAnswer: { code: number; stderr: string } = { code: 0, stderr: '' };
vi.mock('child_process', async (orig) => ({
  ...await orig<typeof import('child_process')>(),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string, err2: string) => void) => {
    if (sudoAnswer.code) cb(Object.assign(new Error('exit'), { code: sudoAnswer.code }), '', sudoAnswer.stderr);
    else cb(null, '', '');
  }),
}));

// What runs.ts reaches for a box, which these tests never are.
vi.mock('../agentRegistry', () => ({
  AgentReplyError: class extends Error {}, AgentNotConnectedError: class extends Error {},
  inventoryHosts: vi.fn(() => []), instanceAgentTransport: vi.fn(() => null), isInstanceAgentConnected: vi.fn(() => false), sendToInstanceAgent: vi.fn(),
}));
vi.mock('../agentRuntime', () => ({ ensureAgentSessionsAndLaunch: vi.fn() }));
vi.mock('../agentSpawnStore', () => ({ isParkedSpawn: vi.fn(async () => false) }));
vi.mock('../status', () => ({ getStatus: vi.fn(() => ({ status: 'not_running' })) }));

const { execFile } = await import('child_process');
const { boolVariation, boolVariationForContext, jsonVariationForContext } = await import('../featureFlags');
const { selfInventory } = await import('../software/collector');
const { TOOL_REGISTRY } = await import('./components');
const { requestHostUpdate, updatePreview, listUpdateRuns } = await import('./runs');
const orch = await import('./orchestrator');

const claude = TOOL_REGISTRY.claude;
const admin = { id: 'admin1', unixUsername: 'root', googleEmail: 'root@example.test', displayName: 'Root', defaultAgentProvider: 'claude' } as any;
let dir: string;
const record = (id: string, body: Record<string, unknown>) => {
  writeFileSync(path.join(dir, 'runs', `${id}.json`), JSON.stringify({
    component: 'claude', host: 'orchestrator', trigger: 'manual', outcome: 'updated', run: id, target: '2.1.316', fromVersion: '2.1.308', toVersion: '2.1.316',
    detail: 'policy=ok installed(2.1.308->2.1.316) runner-restarted unit_binary=current; host sessions on an old binary: 2 (ada 1, bob 1), left running',
    sessions: { stopped: 0, resumed: 0, fresh: 0, cut: 0, typed: 0, other: 2, runnersLeft: 0 }, panes: [], ...body,
  }));
};
const sudoCalls = () => vi.mocked(execFile).mock.calls.map(c => [c[0], c[1]]);

beforeEach(() => {
  hostVersion.v = '2.1.308';
  orchPolicy.value = { mode: 'auto', target: '2.1.316' };
  toolMode.mode = 'auto';
  rows.clear();
  orch.resetOrchestratorRecordsForTest();
  dir = mkdtempSync(path.join(tmpdir(), 'orch-claude-'));
  mkdirSync(path.join(dir, 'requests')); mkdirSync(path.join(dir, 'runs'));
  process.env.ORCHESTRATOR_CLAUDE_UPDATE_DIR = dir;
  installed = true;
  sudoAnswer = { code: 0, stderr: '' };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(boolVariation).not.toHaveBeenCalled();
  expect(boolVariationForContext).not.toHaveBeenCalled();
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_CLAUDE_UPDATE_DIR;
});

describe('the flag gate', () => {
  it('is off unless both modes are on, read for the admin and the orchestrator', async () => {
    const { jsonVariation } = await import('../featureFlags');
    orchPolicy.value = { mode: 'off', target: '2.1.316' };
    expect(await updatePreview(claude, 'orchestrator', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
    expect(await requestHostUpdate(claude, 'orchestrator', 'none', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
    orchPolicy.value = { mode: 'auto', target: '2.1.316' };
    toolMode.mode = 'off';
    expect(await requestHostUpdate(claude, 'orchestrator', 'none', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
    expect(sudoCalls()).toEqual([]);
    expect(rows.size).toBe(0);
    expect(vi.mocked(jsonVariation)).toHaveBeenCalledWith('claude-code-update-policy', admin, null, orch.ORCHESTRATOR_LD_BOX);
    expect(vi.mocked(jsonVariationForContext)).toHaveBeenCalledWith('orchestrator-claude-update-policy', orch.ORCHESTRATOR_LD_CONTEXT, null);
  });

  it('previews the orchestrator row once on: capable, the policy, restart none only', async () => {
    const p = await updatePreview(claude, 'orchestrator', admin);
    expect(p).toMatchObject({ status: 200, body: { hostKey: 'orchestrator', kind: 'orchestrator', capable: true, current: '2.1.308', connected: true, floor: '2.1.310', target: '2.1.316', floorOnly: false, nothingToDo: false, restarts: ['none'], runInFlight: null } });
    expect(p.body).toMatchObject({ runnerHeld: false });
    // A quarantine held the runner: the row says so.
    writeFileSync(path.join(dir, 'runner-held'), '2026-11-02T12:00:00Z the install of 2.1.316 could not be verified or put back\n');
    expect(await updatePreview(claude, 'orchestrator', admin)).toMatchObject({ status: 200, body: { runnerHeld: true } });
    installed = false;
    expect(await updatePreview(claude, 'orchestrator', admin)).toMatchObject({ status: 200, body: { capable: false } });
  });
});

describe('the orchestrator\'s own policy (orchestrator-claude-update-policy; Fabian\'s decision on #1165)', () => {
  it('takes only an exact version as the target; null, a tag or garbage is the floor only', () => {
    expect(orch.parseOrchestratorTarget({ target: '2.1.316' })).toBe('2.1.316');
    for (const v of [null, undefined, {}, { target: null }, { target: 'latest' }, { target: 'stable' }, { target: '2.1' }, { target: '2.1.316; id' }, { target: 2 }, 'latest']) {
      expect(orch.parseOrchestratorTarget(v)).toBeNull();
    }
  });

  it('reads the target for the orchestrator\'s context alone, and the floor from the shared policy', async () => {
    expect(await orch.orchestratorPolicy(claude, admin)).toEqual({ floor: '2.1.310', target: '2.1.316' });
    expect(vi.mocked(jsonVariationForContext)).toHaveBeenCalledWith('orchestrator-claude-update-policy', orch.ORCHESTRATOR_LD_CONTEXT, null);
    // claude-code-update-policy's own target (latest) never reaches the orchestrator.
    orchPolicy.value = undefined;
    expect(await orch.orchestratorPolicy(claude, admin)).toEqual({ floor: '2.1.310', target: null });
  });

  it('with no pin, the row says floor only and offers nothing while the host is at or above the floor', async () => {
    for (const value of [{ target: null }, {}, { target: 'latest' }]) {
      orchPolicy.value = { mode: 'auto', ...value };
      hostVersion.v = '2.1.316';
      expect(await updatePreview(claude, 'orchestrator', admin)).toMatchObject({ status: 200, body: { target: null, floorOnly: true, nothingToDo: true } });
      expect(await requestHostUpdate(claude, 'orchestrator', 'none', admin)).toMatchObject({ status: 409, body: { code: 'floor_only' } });
    }
    expect(sudoCalls()).toEqual([]);
    // Below the floor there is something to do: the floor.
    hostVersion.v = '2.1.300';
    expect(await updatePreview(claude, 'orchestrator', admin)).toMatchObject({ status: 200, body: { floorOnly: true, nothingToDo: false } });
    const a = await requestHostUpdate(claude, 'orchestrator', 'none', admin);
    expect(a.status).toBe(202);
    const runId = (a.body as { runId: string }).runId;
    expect(JSON.parse(readFileSync(path.join(dir, 'requests', `${runId}.json`), 'utf8'))).toEqual({ floor: '2.1.310', target: null });
  });

  it('with no pin, still offers a run while a quarantine holds the runner (Bugbot on #1165)', async () => {
    orchPolicy.value = { mode: 'auto', target: null };
    hostVersion.v = '2.1.316';
    writeFileSync(path.join(dir, 'runner-held'), 'x\n');
    expect(await updatePreview(claude, 'orchestrator', admin)).toMatchObject({ status: 200, body: { floorOnly: true, nothingToDo: false, runnerHeld: true } });
    expect((await requestHostUpdate(claude, 'orchestrator', 'none', admin)).status).toBe(202);
    rows.clear();
    expect(await orch.orchestratorNightlyTick(Date.parse('2026-11-03T03:00:00Z'))).toBe('started');
  });

  it('passes a pin below what runs on as it is: the recipe moves down to it, never below the floor', async () => {
    orchPolicy.value = { mode: 'auto', target: '2.1.309' };
    hostVersion.v = '2.1.316';
    const runId = ((await requestHostUpdate(claude, 'orchestrator', 'none', admin)).body as { runId: string }).runId;
    expect(JSON.parse(readFileSync(path.join(dir, 'requests', `${runId}.json`), 'utf8'))).toEqual({ floor: '2.1.310', target: '2.1.309' });
  });

  it('reads a floor-only record', async () => {
    orchPolicy.value = { mode: 'auto', target: null };
    hostVersion.v = '2.1.300';
    const runId = ((await requestHostUpdate(claude, 'orchestrator', 'none', admin)).body as { runId: string }).runId;
    record(runId, { outcome: 'floor-only', target: '2.1.310', fromVersion: '2.1.312', toVersion: '2.1.312', detail: 'policy=floor-only no-downgrade(2.1.312>2.1.310) unit_binary=current' });
    await orch.syncOrchestratorRuns();
    expect(rows.get(runId)).toMatchObject({ status: 'done', outcome: 'floor-only' });
  });
});

describe('a manual run', () => {
  it('writes the policy for the run, then starts the helper with the run id alone', async () => {
    const a = await requestHostUpdate(claude, 'orchestrator', 'none', admin);
    expect(a).toMatchObject({ status: 202, body: { acknowledged: true } });
    const runId = (a.body as { runId: string }).runId;
    expect(sudoCalls()).toEqual([['sudo', ['-n', '/usr/local/libexec/termag/claude-orchestrator-update-start', runId]]]);
    expect(JSON.parse(readFileSync(path.join(dir, 'requests', `${runId}.json`), 'utf8'))).toEqual({ floor: '2.1.310', target: '2.1.316' });
    expect(rows.get(runId)).toMatchObject({ hostKey: 'orchestrator', instanceId: null, component: 'claude', trigger: 'manual', restart: 'none', status: 'running', target: '2.1.316', requestedById: 'admin1' });
  });

  it('is Claude Code only: another tool on the orchestrator host takes no run', async () => {
    expect(await requestHostUpdate(TOOL_REGISTRY.codex, 'orchestrator', 'none', admin)).toMatchObject({ status: 409, body: { code: 'not_capable' } });
    expect(sudoCalls()).toEqual([]);
  });

  it('takes restart none only: host sessions are counted, never stopped', async () => {
    for (const r of ['idle', 'force'] as const) {
      expect(await requestHostUpdate(claude, 'orchestrator', r, admin)).toMatchObject({ status: 409, body: { code: 'restart_not_supported' } });
    }
    expect(sudoCalls()).toEqual([]);
  });

  it('is not_capable on an image without the helper, and run_in_flight while one runs', async () => {
    installed = false;
    expect(await requestHostUpdate(claude, 'orchestrator', 'none', admin)).toMatchObject({ status: 409, body: { code: 'not_capable' } });
    installed = true;
    expect((await requestHostUpdate(claude, 'orchestrator', 'none', admin)).status).toBe(202);
    expect(await requestHostUpdate(claude, 'orchestrator', 'none', admin)).toEqual({ status: 409, body: { code: 'run_in_flight' } });
    expect(sudoCalls()).toHaveLength(1);
  });

  it('ends refused when sudo or the helper refuses, and leaves no request behind', async () => {
    sudoAnswer = { code: 1, stderr: 'sudo: a password is required' };
    const a = await requestHostUpdate(claude, 'orchestrator', 'none', admin);
    expect(a).toMatchObject({ status: 502, body: { code: 'helper_refused', error: 'sudo: a password is required' } });
    const runId = (a.body as { runId: string }).runId;
    expect(rows.get(runId)).toMatchObject({ status: 'refused', detail: 'sudo: a password is required' });
    expect(realExists(path.join(dir, 'requests', `${runId}.json`))).toBe(false);
    // A refused run does not hold the host.
    sudoAnswer = { code: 0, stderr: '' };
    expect((await requestHostUpdate(claude, 'orchestrator', 'none', admin)).status).toBe(202);
  });

  it('ends with the root recipe\'s record, which the runs list reads', async () => {
    const runId = ((await requestHostUpdate(claude, 'orchestrator', 'none', admin)).body as { runId: string }).runId;
    record(runId, {});
    const list = await listUpdateRuns(claude, admin, 50);
    expect(list.status).toBe(200);
    expect(rows.get(runId)).toMatchObject({ status: 'done', outcome: 'updated', trigger: 'manual', fromVersion: '2.1.308', toVersion: '2.1.316', sessions: { other: 2 } });
    expect(rows.get(runId)!.detail).toContain('left running');
    expect(realExists(path.join(dir, 'requests', `${runId}.json`))).toBe(false);
    expect(selfInventory).toHaveBeenCalled();
    // Read once.
    expect(await orch.syncOrchestratorRuns()).toBe(0);
  });

  it('records a quarantine, and the runner held, as failed', async () => {
    const runId = ((await requestHostUpdate(claude, 'orchestrator', 'none', admin)).body as { runId: string }).runId;
    record(runId, { outcome: 'failed', toVersion: null, detail: 'policy=ok REJECTED(2.1.316) quarantined runner-stopped unit_binary=-' });
    await orch.syncOrchestratorRuns();
    expect(rows.get(runId)).toMatchObject({ status: 'failed', outcome: 'failed', detail: expect.stringContaining('quarantined runner-stopped') });
  });

  it('records STALE or DOWN as failed', async () => {
    const runId = ((await requestHostUpdate(claude, 'orchestrator', 'none', admin)).body as { runId: string }).runId;
    record(runId, { outcome: 'failed', detail: 'policy=ok installed(2.1.308->2.1.316) runner-restarted unit_binary=DOWN(activating/auto-restart)' });
    await orch.syncOrchestratorRuns();
    expect(rows.get(runId)).toMatchObject({ status: 'failed', outcome: 'failed' });
  });

  it('ignores a record whose id is not a run id or that names another run', async () => {
    writeFileSync(path.join(dir, 'runs', 'x;id.json'), '{}');
    record('orunaaaaaaaaaaaaaaaaaaaaaa', { run: 'orunbbbbbbbbbbbbbbbbbbbbbb' });
    expect(await orch.syncOrchestratorRuns()).toBe(0);
    expect(rows.size).toBe(0);
  });
});

describe('the boot run', () => {
  it('becomes a boot row once, dated when it ran', async () => {
    const id = 'boot0123456789abcdef0123456789abcdef';
    record(id, { trigger: 'boot', fromVersion: '2.1.292', toVersion: '2.1.308', target: '2.1.308', detail: 'installed(2.1.292->2.1.308) unit_binary=-' });
    const at = new Date('2026-11-02T08:00:00Z');
    utimesSync(path.join(dir, 'runs', `${id}.json`), at, at);
    expect(await orch.syncOrchestratorRuns()).toBe(1);
    expect(rows.get(id)).toMatchObject({ id, hostKey: 'orchestrator', instanceId: null, trigger: 'boot', restart: 'none', status: 'done', outcome: 'updated', fromVersion: '2.1.292', toVersion: '2.1.308', requestedAt: at });
    // Another process (or this one after a restart) reads it again: no second row.
    orch.resetOrchestratorRecordsForTest();
    expect(await orch.syncOrchestratorRuns()).toBe(0);
    expect(rows.size).toBe(1);
  });
});

describe('the nightly run', () => {
  const now = Date.parse('2026-11-03T03:00:00Z');
  it('is due once in 24 hours, on a capable host with nothing in flight', () => {
    expect(orch.nightlyDue({ capable: true, inFlight: false, lastRunAt: null, now })).toBe(true);
    expect(orch.nightlyDue({ capable: true, inFlight: false, lastRunAt: new Date(now - 23 * 3600_000), now })).toBe(false);
    expect(orch.nightlyDue({ capable: true, inFlight: false, lastRunAt: new Date(now - 24 * 3600_000), now })).toBe(true);
    expect(orch.nightlyDue({ capable: false, inFlight: false, lastRunAt: null, now })).toBe(false);
    expect(orch.nightlyDue({ capable: true, inFlight: true, lastRunAt: null, now })).toBe(false);
    // A failed run is not the day's: tried again an hour on.
    expect(orch.nightlyDue({ capable: true, inFlight: false, lastRunAt: null, lastFailedAt: new Date(now - 30 * 60_000), now })).toBe(false);
    expect(orch.nightlyDue({ capable: true, inFlight: false, lastRunAt: null, lastFailedAt: new Date(now - 61 * 60_000), now })).toBe(true);
  });

  it('follows the host\'s mode, read for the orchestrator alone, and takes the policy for that context', async () => {
    orchPolicy.value = { mode: 'manual', target: '2.1.316' };
    expect(await orch.orchestratorNightlyTick(now)).toBe('off');
    expect(vi.mocked(jsonVariationForContext)).toHaveBeenCalledWith('orchestrator-claude-update-policy', orch.ORCHESTRATOR_LD_CONTEXT, null);
    expect(vi.mocked(jsonVariationForContext)).toHaveBeenCalledWith('claude-code-update-policy', orch.ORCHESTRATOR_LD_CONTEXT, null);
    expect(sudoCalls()).toEqual([]);
    orchPolicy.value = { mode: 'auto', target: '2.1.316' };
    expect(await orch.orchestratorNightlyTick(now)).toBe('started');
    const run = [...rows.values()][0];
    expect(run).toMatchObject({ trigger: 'nightly', requestedById: null, target: '2.1.316', status: 'running' });
    expect(JSON.parse(readFileSync(path.join(dir, 'requests', `${run.id}.json`), 'utf8'))).toEqual({ floor: '2.1.310', target: '2.1.316' });
    expect(await orch.orchestratorNightlyTick(now + 60_000)).toBe('not-due');
  });

  it('does not count a failed run as the day\'s: it tries again an hour later', async () => {
    rows.set('n1', { id: 'n1', hostKey: 'orchestrator', component: 'claude', trigger: 'nightly', status: 'failed', outcome: 'failed', target: 'latest', requestedAt: new Date(now - 30 * 60_000) });
    expect(await orch.orchestratorNightlyTick(now)).toBe('not-due');
    rows.set('n1', { ...rows.get('n1')!, requestedAt: new Date(now - 2 * 3600_000) });
    expect(await orch.orchestratorNightlyTick(now)).toBe('started');
  });

  it('with no pin and the host at or above the floor, runs nothing (the boot run keeps the floor)', async () => {
    orchPolicy.value = { mode: 'auto', target: null };
    hostVersion.v = '2.1.316';
    expect(await orch.orchestratorNightlyTick(now)).toBe('floor-only');
    orchPolicy.value = { mode: 'auto' };
    expect(await orch.orchestratorNightlyTick(now)).toBe('floor-only');
    expect(sudoCalls()).toEqual([]);
  });

  it('counts a manual run as the day\'s, but not a boot run', async () => {
    rows.set('boot1', { id: 'boot1', hostKey: 'orchestrator', component: 'claude', trigger: 'boot', status: 'done', requestedAt: new Date(now - 3600_000) });
    rows.set('m1', { id: 'm1', hostKey: 'orchestrator', component: 'claude', trigger: 'manual', status: 'done', requestedAt: new Date(now - 2 * 3600_000) });
    expect(await orch.orchestratorNightlyTick(now)).toBe('not-due');
    // A run that never reached the unit (refused, or expired after a process died before the helper) does not count (Bugbot on #1165).
    rows.set('m1', { ...rows.get('m1')!, status: 'expired' });
    rows.set('m2', { id: 'm2', hostKey: 'orchestrator', component: 'claude', trigger: 'nightly', status: 'refused', requestedAt: new Date(now - 3600_000) });
    expect(await orch.orchestratorNightlyTick(now)).toBe('started');
  });
});

describe('the host\'s mode (orchestrator-claude-update-policy; gate.ts)', () => {
  const now = Date.parse('2026-11-03T03:00:00Z');
  const hostPolicyReads = () => vi.mocked(jsonVariationForContext).mock.calls.filter(c => c[0] === 'orchestrator-claude-update-policy');

  it('off: the row answers 404 and the nightly run is off', async () => {
    orchPolicy.value = { mode: 'off', target: '2.1.316' };
    expect(await updatePreview(claude, 'orchestrator', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
    expect(await requestHostUpdate(claude, 'orchestrator', 'none', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
    expect(await orch.orchestratorNightlyTick(now)).toBe('off');
    expect(sudoCalls()).toEqual([]);
  });

  it('manual: the row is on and the nightly run is off', async () => {
    orchPolicy.value = { mode: 'manual', target: '2.1.316' };
    expect(await updatePreview(claude, 'orchestrator', admin)).toMatchObject({ status: 200, body: { target: '2.1.316' } });
    // One read of the host's policy for the preview: its mode and its target.
    expect(hostPolicyReads()).toHaveLength(1);
    expect(await orch.orchestratorNightlyTick(now)).toBe('off');
  });

  it('auto: the nightly run starts', async () => {
    orchPolicy.value = { mode: 'auto', target: '2.1.316' };
    expect(await orch.orchestratorNightlyTick(now)).toBe('started');
    expect(hostPolicyReads()).toHaveLength(1);
  });

  it('the tool\'s own mode off stops the nightly run too, read for the orchestrator alone', async () => {
    orchPolicy.value = { mode: 'auto', target: '2.1.316' };
    toolMode.mode = 'off';
    expect(await orch.orchestratorNightlyTick(now)).toBe('off');
    expect(sudoCalls()).toEqual([]);
    toolMode.mode = 'manual';
    expect(await orch.orchestratorNightlyTick(now)).toBe('started');
  });

  it('the tool\'s own mode missing (or the flag source down) stops the nightly run: missing is off', async () => {
    orchPolicy.value = { mode: 'auto', target: '2.1.316' };
    for (const mode of [undefined, 'sometimes']) {
      toolMode.mode = mode;
      expect(await orch.orchestratorNightlyTick(now)).toBe('off');
    }
    vi.mocked(jsonVariationForContext).mockImplementation((async (key: string) => (key === 'orchestrator-claude-update-policy' ? orchPolicy.value : null)) as never);
    expect(await orch.orchestratorNightlyTick(now)).toBe('off');
    vi.mocked(jsonVariationForContext).mockImplementation((async (key: string) => (key === 'orchestrator-claude-update-policy' ? orchPolicy.value ?? null : { mode: toolMode.mode, floor: '2.1.310', target: 'latest' })) as never);
    expect(sudoCalls()).toEqual([]);
  });

  it('the tool\'s own mode off closes the row too, whatever the host\'s says', async () => {
    orchPolicy.value = { mode: 'auto', target: '2.1.316' };
    const { jsonVariation } = await import('../featureFlags');
    vi.mocked(jsonVariation).mockResolvedValueOnce({ mode: 'off', floor: '2.1.310' });
    expect(await updatePreview(claude, 'orchestrator', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
  });

  it('missing, malformed, or the flag source down (the fallback, null): off, the row and the nightly run alike', async () => {
    for (const value of [{ target: '2.1.316' }, { mode: 'nightly', target: '2.1.316' }, { mode: null }, undefined]) {
      orchPolicy.value = value;
      expect(await updatePreview(claude, 'orchestrator', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
      expect(await requestHostUpdate(claude, 'orchestrator', 'none', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
      expect(await orch.orchestratorNightlyTick(now)).toBe('off');
    }
    expect(sudoCalls()).toEqual([]);
    expect(orch.parseOrchestratorMode({ mode: 'auto' })).toBe('auto');
    expect(orch.parseOrchestratorMode(null)).toBe('off');
    expect(orch.parseOrchestratorMode({ mode: 'sometimes' })).toBe('off');
  });
});
