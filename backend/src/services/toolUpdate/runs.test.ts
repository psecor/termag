import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../db';
import { AgentNotConnectedError, AgentReplyError, AgentTransportError, instanceAgentTransport, isInstanceAgentConnected, sendToInstanceAgent } from '../agentRegistry';
import { ensureAgentSessionsAndLaunch } from '../agentRuntime';
import { isParkedSpawn } from '../agentSpawnStore';
import { boolVariation, jsonVariation } from '../featureFlags';
import {
  boxPolicy, previewTarget, pumpFleet, recordToolUpdateReport, relaunchReportedPanes, requestFleetUpdate, requestFloorRun, requestHostUpdate, sendToolUpdate, updatePreview,
} from './runs';
import { parseToolUpdateReport, type ToolUpdateReport } from './run';
import { TOOL_REGISTRY } from './components';

const claude = TOOL_REGISTRY.claude;

const rows = new Map<string, Record<string, any>>();
let nextId = 0;
const newId = () => `run${String(++nextId).padStart(22, '0')}`;
const matches = (r: Record<string, any>, where: Record<string, any>) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('in' in v) return v.in.includes(r[k]);
    if ('notIn' in v) return !v.notIn.includes(r[k]);
    if ('lt' in v) return r[k] < v.lt;
    if ('gte' in v) return r[k] >= v.gte;
    if ('not' in v) return r[k] !== v.not;
  }
  return r[k] === v;
});

// pg_advisory_xact_lock, as Postgres holds it: one transaction per key at a time, released at its end.
const locks = new Map<string, Promise<void>>();
const lockKeys: string[] = [];
vi.mock('../../db', () => {
  const prisma: any = {
    softwareUpdateRun: {
      create: vi.fn(async ({ data }: any) => { const r = { id: newId(), requestedAt: new Date(), startedAt: null, finishedAt: null, ...data }; rows.set(r.id, r); return r; }),
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      // A real query takes a while: concurrent claims interleave here unless something serializes them.
      findMany: vi.fn(async ({ where }: any) => { const out = [...rows.values()].filter(r => matches(r, where)).sort((a, b) => b.requestedAt - a.requestedAt); await new Promise(r => setTimeout(r, 2)); return out; }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(rows.get(where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: any) => { const hit = [...rows.values()].filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; }),
    },
    instance: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    hostSoftware: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    project: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
  };
  prisma.$transaction = vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
    let release = () => {};
    const tx = {
      ...prisma,
      $executeRaw: async (_sql: TemplateStringsArray, key: string) => {
        lockKeys.push(key);
        const prev = locks.get(key) ?? Promise.resolve();
        const held = new Promise<void>(r => { release = r; });
        locks.set(key, prev.then(() => held));
        await prev;
      },
    };
    try { return await fn(tx); } finally { release(); }
  });
  return { prisma };
});
vi.mock('../agentRegistry', () => {
  // The registry's error classes as it defines them: a reply with `error`, a transport failure, a send to nobody.
  class AgentReplyError extends Error {}
  class AgentTransportError extends Error {}
  class AgentNotConnectedError extends AgentTransportError {}
  return {
  AgentReplyError, AgentTransportError, AgentNotConnectedError,
  inventoryHosts: vi.fn(() => []),
  instanceAgentTransport: vi.fn(() => ({ capabilities: ['tool-update-v1'] })),
  isInstanceAgentConnected: vi.fn(() => true),
  sendToInstanceAgent: vi.fn(async () => ({ started: true })),
  };
});
vi.mock('../agentRuntime', () => ({ ensureAgentSessionsAndLaunch: vi.fn(async () => 'launched') }));
vi.mock('../agentSpawnStore', () => ({ isParkedSpawn: vi.fn(async () => false) }));
vi.mock('../featureFlags', () => ({ boolVariation: vi.fn(async () => true), jsonVariation: vi.fn(async () => null) }));
vi.mock('../software/collector', () => ({ refreshHostInventory: vi.fn(async () => true) }));
vi.mock('../status', () => ({ getStatus: vi.fn(() => ({ status: 'not_running' })) }));

const ada = { id: 'u1', unixUsername: 'ada', googleEmail: 'ada@example.test', displayName: 'Ada', defaultAgentProvider: 'claude' } as any;
const admin = { id: 'admin1', unixUsername: 'root', googleEmail: 'root@example.test', displayName: 'Root', defaultAgentProvider: 'claude' } as any;
const box = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `${id}-name`, kind: 'ec2', status: 'ready', userId: 'u1', hostHome: '/home/ada', user: ada, ...over });
const rpcs = (type: string) => vi.mocked(sendToInstanceAgent).mock.calls.filter(c => c[1] === type);

beforeEach(() => {
  rows.clear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(prisma.instance.findFirst).mockImplementation((async ({ where }: any) => (where.id.startsWith('box') ? box(where.id) : null)) as never);
  vi.mocked(prisma.instance.findUnique).mockImplementation((async ({ where }: any) => box(where.id)) as never);
});
afterEach(() => vi.clearAllMocks());

describe('sendToolUpdate', () => {
  it('sends only the component and the run id', async () => {
    expect(await sendToolUpdate('box-a', 'claude', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ started: true });
    expect(rpcs('tool-update')).toEqual([['box-a', 'tool-update', { component: 'claude', run: 'ckz9v1q2w0000abcd1234efgh' }, 15_000]]);
  });

  it('sends nothing to an agent without tool-update-v1, or for an id that is not a run id', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValueOnce({ capabilities: ['box-update-v1'] } as never);
    expect(await sendToolUpdate('box-a', 'claude', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'the agent does not announce tool-update-v1' });
    expect(await sendToolUpdate('box-a', 'claude', 'x; reboot')).toEqual({ refused: 'not a run id' });
    expect(rpcs('tool-update')).toEqual([]);
  });

  it('passes the agent\'s error on', async () => {
    vi.mocked(sendToInstanceAgent).mockRejectedValueOnce(new AgentReplyError('unit not loaded'));
    expect(await sendToolUpdate('box-a', 'claude', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'unit not loaded' });
  });

  it('calls a timeout or a dropped connection uncertain: the unit may have started', async () => {
    vi.mocked(sendToInstanceAgent).mockRejectedValueOnce(new AgentTransportError('Agent request timed out: tool-update'));
    expect(await sendToolUpdate('box-a', 'claude', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ uncertain: 'Agent request timed out: tool-update' });
    vi.mocked(sendToInstanceAgent).mockRejectedValueOnce(new AgentTransportError('Agent disconnected'));
    expect(await sendToolUpdate('box-a', 'claude', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ uncertain: 'Agent disconnected' });
    vi.mocked(isInstanceAgentConnected).mockReturnValueOnce(false);
    expect(await sendToolUpdate('box-a', 'claude', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'the box agent is not connected' });
    // The agent went away between the check and the send: nothing was sent.
    vi.mocked(sendToInstanceAgent).mockRejectedValueOnce(new AgentNotConnectedError('Instance agent not connected'));
    expect(await sendToolUpdate('box-a', 'claude', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'Instance agent not connected' });
  });

  it('still answers a plain {error} reply as a refusal', async () => {
    vi.mocked(sendToInstanceAgent).mockResolvedValueOnce({ error: 'unit not loaded' });
    expect(await sendToolUpdate('box-a', 'claude', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'unit not loaded' });
  });
});

describe('requestHostUpdate', () => {
  it('writes a manual run, sends it, and answers its id', async () => {
    const a = await requestHostUpdate(claude, 'box-a', 'force', admin);
    expect(a).toMatchObject({ status: 202, body: { acknowledged: true } });
    const run = rows.get((a.body as { runId: string }).runId)!;
    expect(run).toMatchObject({ hostKey: 'box-a', instanceId: 'box-a', component: 'claude', trigger: 'manual', restart: 'force', status: 'requested', requestedById: 'admin1', target: 'latest' });
    expect(rpcs('tool-update')[0][2]).toEqual({ component: 'claude', run: run.id });
  });

  it('answers the contract\'s 404 and 409s before writing anything', async () => {
    vi.mocked(boolVariation).mockResolvedValueOnce(false);
    expect(await requestHostUpdate(claude, 'box-a', 'idle', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
    vi.mocked(isInstanceAgentConnected).mockReturnValueOnce(false);
    expect(await requestHostUpdate(claude, 'box-a', 'idle', admin)).toEqual({ status: 409, body: { code: 'offline' } });
    vi.mocked(instanceAgentTransport).mockReturnValueOnce({ capabilities: [] } as never);
    expect(await requestHostUpdate(claude, 'box-a', 'idle', admin)).toEqual({ status: 409, body: { code: 'not_capable' } });
    expect(rows.size).toBe(0);
    await requestHostUpdate(claude, 'box-a', 'idle', admin);
    expect(await requestHostUpdate(claude, 'box-a', 'idle', admin)).toEqual({ status: 409, body: { code: 'run_in_flight' } });
    expect(rows.size).toBe(1);
  });

  it('ends the run refused when the agent refuses it', async () => {
    vi.mocked(sendToInstanceAgent).mockRejectedValueOnce(new AgentReplyError('unit not loaded'));
    const a = await requestHostUpdate(claude, 'box-a', 'none', admin);
    expect(a).toMatchObject({ status: 502, body: { code: 'agent_refused', error: 'unit not loaded' } });
    expect(rows.get((a.body as { runId: string }).runId)).toMatchObject({ status: 'refused', detail: 'unit not loaded' });
  });

  it('a disconnect after the send is uncertain too: 202 acknowledged false', async () => {
    vi.mocked(sendToInstanceAgent).mockRejectedValueOnce(new AgentTransportError('Agent disconnected'));
    const a = await requestHostUpdate(claude, 'box-a', 'idle', admin);
    expect(a).toMatchObject({ status: 202, body: { acknowledged: false } });
    expect(rows.get((a.body as { runId: string }).runId)!.status).toBe('requested');
  });

  it('keeps a run whose acknowledgement was lost requested, holding the box, and says so', async () => {
    vi.mocked(sendToInstanceAgent).mockRejectedValueOnce(new AgentTransportError('Agent request timed out: tool-update'));
    const a = await requestHostUpdate(claude, 'box-a', 'idle', admin);
    const runId = (a.body as { runId: string }).runId;
    expect(a).toEqual({ status: 202, body: { runId, acknowledged: false } });
    expect(rows.get(runId)).toMatchObject({ status: 'requested', detail: expect.stringContaining('acknowledgement was lost') });
    expect(await requestHostUpdate(claude, 'box-a', 'idle', admin)).toEqual({ status: 409, body: { code: 'run_in_flight' } });
    // The box did get it: its fetch starts the run as usual.
    expect(await boxPolicy(claude, 'box-a', ada, runId)).toMatchObject({ body: { restart: 'idle', run: { id: runId } } });
  });

  it('hands the orchestrator to its own runs (orchestrator.test.ts), and is 404 for a host nobody knows', async () => {
    // This host's image has no helper: not capable. Its only restart is none.
    expect(await requestHostUpdate(claude, 'orchestrator', 'none', admin)).toMatchObject({ status: 409, body: { code: 'not_capable' } });
    expect(await requestHostUpdate(claude, 'orchestrator', 'idle', admin)).toMatchObject({ status: 409, body: { code: 'restart_not_supported' } });
    expect(await requestHostUpdate(claude, 'nope', 'idle', admin)).toMatchObject({ status: 404, body: { code: 'no_such_host' } });
  });
});

describe('one run in flight per box and component (Bugbot on #975)', () => {
  it('two concurrent single-host requests give one run and one run_in_flight', async () => {
    const [a, b] = await Promise.all([requestHostUpdate(claude, 'box-a', 'idle', admin), requestHostUpdate(claude, 'box-a', 'force', admin)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect([a, b].find(x => x.status === 409)!.body).toEqual({ code: 'run_in_flight' });
    expect(rows.size).toBe(1);
    expect(rpcs('tool-update')).toHaveLength(1);
    expect(lockKeys).toContain('tool-update:box-a:claude');
  });

  it('two concurrent floor runs give one run', async () => {
    await Promise.all([requestFloorRun(claude, box('box-a'), ada), requestFloorRun(claude, box('box-a'), ada)]);
    expect([...rows.values()].map(r => r.trigger)).toEqual(['floor']);
    expect(rpcs('tool-update')).toHaveLength(1);
  });

  it('a run queued past 15 minutes still holds its box', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const boxes = Array.from({ length: 11 }, (_, i) => box(`box-${String(i).padStart(2, '0')}`));
      vi.mocked(prisma.instance.findMany).mockResolvedValueOnce(boxes as never);
      await requestFleetUpdate(claude, 'all', 'idle', admin);
      await pumpFleet();
      expect(rpcs('tool-update')).toHaveLength(10);
      const waiting = [...rows.values()].find(r => r.hostKey === 'box-10')!;
      expect(waiting.status).toBe('requested');
      vi.setSystemTime(Date.now() + 20 * 60_000);
      // The ten sent ones expired unfetched; the queued one did not, and it still holds box-10.
      expect(await requestHostUpdate(claude, 'box-10', 'force', admin)).toEqual({ status: 409, body: { code: 'run_in_flight' } });
      await requestFloorRun(claude, box('box-10'), ada);
      expect([...rows.values()].filter(r => r.hostKey === 'box-10')).toHaveLength(1);
      expect((await updatePreview(claude, 'box-10', admin)).body).toMatchObject({ runInFlight: { id: waiting.id, status: 'requested' } });
      // A slot is free now: the pacer sends it, and it is the box's only run.
      await pumpFleet();
      expect(rpcs('tool-update').map(c => (c[2] as { run: string }).run)).toContain(waiting.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('previewTarget', () => {
  // The Software tab counts "behind" against the preview's target (Bugbot on #1080).
  it('names the Cursor agent\'s newest pinned build for latest, and leaves an exact target and other tools alone', () => {
    expect(previewTarget(TOOL_REGISTRY.cursor, 'latest')).toBe(TOOL_REGISTRY.cursor.latestReference);
    expect(previewTarget(TOOL_REGISTRY.cursor, '2026.10.01-0a1b2c3')).toBe('2026.10.01-0a1b2c3');
    expect(previewTarget(TOOL_REGISTRY.claude, 'latest')).toBe('latest');
  });
});

describe('updatePreview', () => {
  it('counts the box\'s Claude agent panes from the live status, and names a run in flight', async () => {
    const { getStatus } = await import('../status');
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      { name: 'web', workflows: [{ provider: 'claude', workstream: { name: 'main' } }, { provider: null, workstream: { name: 'x' } }, { provider: 'codex', workstream: { name: 'y' } }] },
    ] as never);
    vi.mocked(getStatus).mockImplementation(((s: string) => ({ status: s === 'ada-web-agent' ? 'working' : 'idle' })) as never);
    vi.mocked(prisma.hostSoftware.findMany).mockResolvedValueOnce([{ hostKey: 'box-a', version: '2.1.300', ok: true }] as never);
    const run = await requestHostUpdate(claude, 'box-a', 'idle', admin);
    const p = await updatePreview(claude, 'box-a', admin);
    expect(p).toEqual({
      status: 200,
      body: {
        hostKey: 'box-a', connected: true, capable: true, current: '2.1.300', target: 'latest', floor: '2.1.308', liveSessions: 2, busySessions: 1,
        runInFlight: { id: (run.body as { runId: string }).runId, status: 'requested', trigger: 'manual', requestedAt: expect.any(String) },
      },
    });
    expect(vi.mocked(getStatus).mock.calls.map(c => c[0])).toEqual(['ada-web-agent', 'ada-web-x-agent']);
  });

  it('is claude_update_off with the flag off for the owner and box', async () => {
    vi.mocked(boolVariation).mockResolvedValueOnce(false);
    expect(await updatePreview(claude, 'box-a', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
    expect(vi.mocked(boolVariation).mock.calls[0]).toEqual(['claude-code-update-enabled', ada, false, { id: 'box-a', name: 'box-a-name', kind: 'ec2' }]);
  });
});

describe('requestFleetUpdate', () => {
  it('writes a run for every box the scope takes and starts ten, the rest as runs end', async () => {
    const boxes = Array.from({ length: 12 }, (_, i) => box(`box-${String(i).padStart(2, '0')}`));
    vi.mocked(prisma.instance.findMany).mockResolvedValueOnce(boxes as never);
    vi.mocked(prisma.hostSoftware.findMany).mockResolvedValueOnce(boxes.map(b => ({ hostKey: b.id, version: '2.1.300', ok: true })) as never);
    const a = await requestFleetUpdate(claude, 'below-floor', 'idle', admin);
    expect(a.status).toBe(202);
    expect((a.body as { runs: unknown[] }).runs).toHaveLength(12);
    await pumpFleet();
    expect(rpcs('tool-update')).toHaveLength(10);
    // Two runs end: the pacer starts the last two.
    const started = rpcs('tool-update').slice(0, 2).map(c => (c[2] as { run: string }).run);
    for (const id of started) Object.assign(rows.get(id)!, { status: 'done' });
    await pumpFleet();
    expect(rpcs('tool-update')).toHaveLength(12);
  });

  it('selects below-floor against each box\'s own floor, read for its owner and the box', async () => {
    vi.mocked(prisma.instance.findMany).mockResolvedValueOnce([box('box-low'), box('box-high')] as never);
    vi.mocked(prisma.hostSoftware.findMany).mockResolvedValueOnce([{ hostKey: 'box-low', version: '2.1.310', ok: true }, { hostKey: 'box-high', version: '2.1.310', ok: true }] as never);
    vi.mocked(jsonVariation).mockImplementation((async (_k: string, _u: unknown, _f: unknown, b: { id: string } | null) => ({ floor: b?.id === 'box-high' ? '2.1.400' : '2.1.308' })) as never);
    const a = await requestFleetUpdate(claude, 'below-floor', 'idle', admin);
    expect((a.body as { runs: Array<{ hostKey: string }> }).runs.map(r => r.hostKey)).toEqual(['box-high']);
    vi.mocked(jsonVariation).mockImplementation((async () => null) as never);
  });

  it('never sends a queued run while single-host runs fill the ten slots', async () => {
    const solo = Array.from({ length: 10 }, (_, i) => `box-s${i}`);
    for (const id of solo) expect((await requestHostUpdate(claude, id, 'idle', admin)).status).toBe(202);
    vi.mocked(prisma.instance.findMany).mockResolvedValueOnce([box('box-q')] as never);
    await requestFleetUpdate(claude, 'all', 'idle', admin);
    await pumpFleet();
    expect(rpcs('tool-update')).toHaveLength(10);
    for (const id of solo.slice(0, 1)) Object.assign([...rows.values()].find(r => r.hostKey === id)!, { status: 'done' });
    await pumpFleet();
    expect(rpcs('tool-update')).toHaveLength(11);
  });

  it('skips with the reason, and is claude_update_off for an admin the flag is off for', async () => {
    vi.mocked(prisma.instance.findMany).mockResolvedValueOnce([box('box-a'), box('box-b')] as never);
    vi.mocked(prisma.hostSoftware.findMany).mockResolvedValueOnce([{ hostKey: 'box-a', version: '2.1.312', ok: true }] as never);
    expect(await requestFleetUpdate(claude, 'below-floor', 'idle', admin)).toEqual({ status: 202, body: { runs: [], skipped: [{ hostKey: 'box-b', reason: 'unknown_version' }] } });
    vi.mocked(boolVariation).mockResolvedValueOnce(false);
    expect(await requestFleetUpdate(claude, 'all', 'idle', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
  });
});

describe('boxPolicy', () => {
  it('starts the box\'s requested run once; a retry within 5 minutes gets the same run, later none', async () => {
    const id = ((await requestHostUpdate(claude, 'box-a', 'force', admin)).body as { runId: string }).runId;
    const t0 = Date.now();
    const first = await boxPolicy(claude, 'box-a', ada, id, t0);
    expect(first).toMatchObject({ status: 200, start: true, body: { restart: 'force', run: { id, component: 'claude' } } });
    expect(rows.get(id)).toMatchObject({ status: 'running', startedAt: expect.any(Date) });
    // The first answer was lost: the retry gets it again, without a second start.
    expect(await boxPolicy(claude, 'box-a', ada, id, t0 + 60_000)).toMatchObject({ status: 200, start: false, body: { restart: 'force', run: { id } } });
    expect(await boxPolicy(claude, 'box-a', ada, id, t0 + 6 * 60_000)).toMatchObject({ status: 200, body: { restart: 'none', run: null } });
  });

  it('gives a retry nothing once the run has reported', async () => {
    const id = ((await requestHostUpdate(claude, 'box-a', 'force', admin)).body as { runId: string }).runId;
    await boxPolicy(claude, 'box-a', ada, id);
    await recordToolUpdateReport('box-a', parseToolUpdateReport({ component: 'claude', trigger: 'manual', outcome: 'updated', run: id }) as ToolUpdateReport);
    expect(await boxPolicy(claude, 'box-a', ada, id)).toMatchObject({ status: 200, body: { restart: 'none', run: null } });
  });

  it('is restart none with the flag off, 404 for another box\'s run, and reads the policy flag for the owner and box', async () => {
    const id = ((await requestHostUpdate(claude, 'box-a', 'force', admin)).body as { runId: string }).runId;
    vi.mocked(boolVariation).mockResolvedValueOnce(false);
    expect(await boxPolicy(claude, 'box-a', ada, id)).toMatchObject({ status: 200, body: { restart: 'none', run: null } });
    expect(rows.get(id)!.status).toBe('requested');
    expect(await boxPolicy(claude, 'box-b', ada, id)).toEqual({ status: 404, body: { code: 'no_such_run' } });
    expect(vi.mocked(jsonVariation)).toHaveBeenCalledWith('claude-code-update-policy', ada, null, { id: 'box-a', name: 'box-a-name', kind: 'ec2' });
  });
});

describe('recordToolUpdateReport', () => {
  const report = (body: Record<string, unknown>) => parseToolUpdateReport({ component: 'claude', ...body }) as ToolUpdateReport;

  it('ends the run it names', async () => {
    const id = ((await requestHostUpdate(claude, 'box-a', 'idle', admin)).body as { runId: string }).runId;
    const r = await recordToolUpdateReport('box-a', report({ trigger: 'manual', outcome: 'updated', run: id, fromVersion: '2.1.300', toVersion: '2.1.312', sessions: { stopped: 2 } }));
    expect(r.status).toBe(204);
    expect(rows.get(id)).toMatchObject({ status: 'done', outcome: 'updated', toVersion: '2.1.312', sessions: expect.objectContaining({ stopped: 2 }), finishedAt: expect.any(Date) });
  });

  it('creates a row for a boot run, and refuses another box\'s run', async () => {
    const r = await recordToolUpdateReport('box-a', report({ trigger: 'boot', outcome: 'current' }));
    expect(r.status).toBe(204);
    expect([...rows.values()]).toEqual([expect.objectContaining({ trigger: 'boot', status: 'done', hostKey: 'box-a' })]);
    const id = ((await requestHostUpdate(claude, 'box-b', 'idle', admin)).body as { runId: string }).runId;
    expect(await recordToolUpdateReport('box-a', report({ trigger: 'manual', outcome: 'updated', run: id }))).toEqual({ status: 404, body: { code: 'no_such_run' } });
  });

  it('takes the first report of an expired run, and treats a second as a repeat', async () => {
    const id = ((await requestHostUpdate(claude, 'box-a', 'idle', admin)).body as { runId: string }).runId;
    Object.assign(rows.get(id)!, { status: 'expired', finishedAt: new Date(0) });
    const r = await recordToolUpdateReport('box-a', report({ trigger: 'manual', outcome: 'updated', run: id, toVersion: '2.1.312' }));
    expect(r).toMatchObject({ status: 204, runId: id });
    expect(r).not.toHaveProperty('repeat');
    expect(rows.get(id)).toMatchObject({ status: 'done', outcome: 'updated', toVersion: '2.1.312' });
    expect(await recordToolUpdateReport('box-a', report({ trigger: 'manual', outcome: 'failed', run: id }))).toMatchObject({ repeat: true });
  });

  it('writes nothing for a repeated report of a run that has ended', async () => {
    const id = ((await requestHostUpdate(claude, 'box-a', 'idle', admin)).body as { runId: string }).runId;
    await recordToolUpdateReport('box-a', report({ trigger: 'manual', outcome: 'updated', run: id, detail: 'first' }));
    const finishedAt = rows.get(id)!.finishedAt;
    const again = await recordToolUpdateReport('box-a', report({ trigger: 'manual', outcome: 'failed', run: id, detail: 'second' }));
    expect(again).toMatchObject({ status: 204, runId: id, repeat: true });
    expect(rows.get(id)).toMatchObject({ status: 'done', outcome: 'updated', detail: 'first', finishedAt });
  });

  it('refuses a report naming the run under another component', async () => {
    const id = ((await requestHostUpdate(claude, 'box-a', 'idle', admin)).body as { runId: string }).runId;
    rows.get(id)!.component = 'gh';
    expect(await recordToolUpdateReport('box-a', report({ trigger: 'manual', outcome: 'updated', run: id }))).toEqual({ status: 404, body: { code: 'no_such_run' } });
  });
});

describe('relaunchReportedPanes', () => {
  const projects = [
    { id: 'p1', name: 'web', workflows: [
      { type: 'agent', provider: 'claude', backend: null, model: null, workstream: { name: 'main', askThread: null } },
      { type: 'agent', provider: 'claude', backend: null, model: null, workstream: { name: 'fresh', askThread: null } },
      { type: 'agent', provider: 'claude', backend: null, model: null, workstream: { name: 'parked', askThread: null } },
      { type: 'agent', provider: 'claude-chat', backend: null, model: null, workstream: { name: 'chat', askThread: null } },
      { type: 'agent', provider: 'claude', backend: null, model: null, workstream: { name: 'untouched', askThread: null } },
    ] },
  ];

  it('relaunches exactly the reported agent panes through the launch path, resume only with a conversation', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce(projects as never);
    vi.mocked(isParkedSpawn).mockImplementation(async (_u, _p, ws) => ws === 'parked');
    vi.mocked(ensureAgentSessionsAndLaunch).mockResolvedValueOnce('launched').mockResolvedValueOnce('running');
    const out = await relaunchReportedPanes(claude, box('box-a'), ada, [
      { session: 'ada-web-agent', role: 'agent', sessionId: 's1', hadConversation: true },
      { session: 'ada-web-fresh-agent', role: 'agent', sessionId: null, hadConversation: false },
      { session: 'ada-web-parked-agent', role: 'agent', sessionId: null, hadConversation: true },
      { session: 'ada-web-chat-agent', role: 'agent', sessionId: null, hadConversation: true },
      { session: 'ada-web-ctrl', role: 'other', sessionId: 's9', hadConversation: true },
      { session: 'ada-elsewhere-agent', role: 'agent', sessionId: null, hadConversation: true },
    ]);
    expect(out).toEqual([
      { session: 'ada-web-agent', outcome: 'launched', resume: true },
      { session: 'ada-web-fresh-agent', outcome: 'running', resume: false },
      { session: 'ada-web-parked-agent', outcome: 'parked-spawn' },
      // The chat runner's Claude is not a pane agent: another provider than this tool's.
      { session: 'ada-web-chat-agent', outcome: 'other-provider' },
      { session: 'ada-elsewhere-agent', outcome: 'unknown-session' },
    ]);
    expect(vi.mocked(ensureAgentSessionsAndLaunch).mock.calls.map(c => c[0])).toEqual([
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'claude', instanceId: 'box-a', workstream: 'main', hostHome: '/home/ada', resume: true },
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'claude', instanceId: 'box-a', workstream: 'fresh', hostHome: '/home/ada', resume: false },
    ]);
    vi.mocked(isParkedSpawn).mockReset();
  });

  it('reads nothing when no agent pane was reported', async () => {
    expect(await relaunchReportedPanes(claude, box('box-a'), ada, [{ session: 'ada-web-ctrl', role: 'other', sessionId: null, hadConversation: false }])).toEqual([]);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });
});

describe('Codex, the second tool', () => {
  const codex = TOOL_REGISTRY.codex;

  it('sends a Codex run only to an agent that announces tool-update-codex-v1', async () => {
    // tool-update-v1 alone is an agent with Claude Code's unit, not Codex's.
    expect(await sendToolUpdate('box-a', 'codex', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'the agent does not announce tool-update-codex-v1' });
    vi.mocked(instanceAgentTransport).mockReturnValueOnce({ capabilities: ['tool-update-v1', 'tool-update-codex-v1'] } as never);
    expect(await sendToolUpdate('box-a', 'codex', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ started: true });
    expect(rpcs('tool-update')).toEqual([['box-a', 'tool-update', { component: 'codex', run: 'ckz9v1q2w0000abcd1234efgh' }, 15_000]]);
  });

  it('a box without Codex\'s unit is not_capable, and nothing is written', async () => {
    expect(await requestHostUpdate(codex, 'box-a', 'idle', admin)).toEqual({ status: 409, body: { code: 'not_capable' } });
    expect(rows.size).toBe(0);
  });

  it('reads codex-update-enabled and Codex\'s policy, and counts only Codex panes', async () => {
    const { getStatus } = await import('../status');
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['tool-update-v1', 'tool-update-codex-v1'] } as never);
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      { name: 'web', workflows: [{ provider: 'claude', workstream: { name: 'main' } }, { provider: 'codex', workstream: { name: 'y' } }] },
    ] as never);
    vi.mocked(getStatus).mockImplementation((() => ({ status: 'working' })) as never);
    vi.mocked(prisma.hostSoftware.findMany).mockResolvedValueOnce([{ hostKey: 'box-a', version: '0.163.0', ok: true }] as never);
    const p = await updatePreview(codex, 'box-a', admin);
    expect(p).toMatchObject({ status: 200, body: { capable: true, current: '0.163.0', target: 'latest', floor: '0.131.0', liveSessions: 1, busySessions: 1 } });
    expect(vi.mocked(getStatus).mock.calls.map(c => c[0])).toEqual(['ada-web-y-agent']);
    expect(vi.mocked(prisma.hostSoftware.findMany).mock.calls[0][0]).toMatchObject({ where: { component: 'codex' } });
    expect(vi.mocked(boolVariation).mock.calls[0][0]).toBe('codex-update-enabled');
    expect(vi.mocked(jsonVariation).mock.calls[0][0]).toBe('codex-update-policy');
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['tool-update-v1'] } as never);
  });

  it('is claude_update_off while codex-update-enabled is off, whatever Claude Code\'s flag says', async () => {
    vi.mocked(boolVariation).mockImplementation((async (key: string) => key === 'claude-code-update-enabled') as never);
    expect(await updatePreview(codex, 'box-a', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
    expect(await requestFleetUpdate(codex, 'all', 'idle', admin)).toEqual({ status: 404, body: { code: 'claude_update_off' } });
    expect(await updatePreview(claude, 'box-a', admin)).toMatchObject({ status: 200 });
    vi.mocked(boolVariation).mockImplementation((async () => true) as never);
  });

  it('never asks for a floor run: the cloud-session runner has no Codex floor', async () => {
    await requestFloorRun(codex, box('box-a'), ada);
    expect(rows.size).toBe(0);
    expect(rpcs('tool-update')).toEqual([]);
  });

  it('a box\'s policy fetch for a Codex run gets Codex\'s floor; a Claude run id asked as Codex is no such run', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['tool-update-v1', 'tool-update-codex-v1'] } as never);
    const a = await requestHostUpdate(codex, 'box-a', 'idle', admin);
    const runId = (a.body as { runId: string }).runId;
    expect(rows.get(runId)).toMatchObject({ component: 'codex', target: 'latest' });
    expect(await boxPolicy(codex, 'box-a', ada, runId)).toMatchObject({ status: 200, body: { floor: '0.131.0', target: 'latest', restart: 'idle', run: { id: runId, component: 'codex' } } });
    expect(await boxPolicy(claude, 'box-a', ada, runId)).toEqual({ status: 404, body: { code: 'no_such_run' } });
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['tool-update-v1'] } as never);
  });

  it('relaunches only the Codex agent panes, resuming each by the conversation the box saw', async () => {
    const id = '01a18c85-d963-7800-93d4-991c84da09d5';
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([{ id: 'p1', name: 'web', workflows: [
      { type: 'agent', provider: 'codex', backend: null, model: null, workstream: { name: 'main', askThread: null } },
      { type: 'agent', provider: 'codex', backend: null, model: null, workstream: { name: 'new', askThread: null } },
      { type: 'agent', provider: 'claude', backend: null, model: null, workstream: { name: 'cl', askThread: null } },
    ] }] as never);
    const out = await relaunchReportedPanes(codex, box('box-a'), ada, [
      { session: 'ada-web-agent', role: 'agent', sessionId: id, hadConversation: true },
      { session: 'ada-web-new-agent', role: 'agent', sessionId: null, hadConversation: false },
      { session: 'ada-web-cl-agent', role: 'agent', sessionId: 's1', hadConversation: true },
    ]);
    expect(out).toEqual([
      { session: 'ada-web-agent', outcome: 'launched', resume: true },
      { session: 'ada-web-new-agent', outcome: 'launched', resume: false },
      { session: 'ada-web-cl-agent', outcome: 'other-provider' },
    ]);
    expect(vi.mocked(ensureAgentSessionsAndLaunch).mock.calls.map(c => c[0])).toEqual([
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'codex', instanceId: 'box-a', workstream: 'main', hostHome: '/home/ada', resume: true, resumeSessionId: id },
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'codex', instanceId: 'box-a', workstream: 'new', hostHome: '/home/ada', resume: false },
    ]);
  });
});

describe('the Cursor agent, the third tool', () => {
  const cursor = TOOL_REGISTRY.cursor;
  const chat = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

  it('sends a Cursor run only to an agent that announces tool-update-cursor-v1', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValueOnce({ capabilities: ['tool-update-v1', 'tool-update-codex-v1'] } as never);
    expect(await sendToolUpdate('box-a', 'cursor', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'the agent does not announce tool-update-cursor-v1' });
  });

  it('compares a box with an exact Cursor build as its target', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['tool-update-cursor-v1'] } as never);
    vi.mocked(prisma.instance.findMany).mockResolvedValueOnce([box('box-old'), box('box-new')] as never);
    vi.mocked(prisma.hostSoftware.findMany).mockResolvedValueOnce([{ hostKey: 'box-old', version: '2026.10.01-0a1b2c3', ok: true }, { hostKey: 'box-new', version: '2026.10.22-27dcf5f', ok: true }] as never);
    vi.mocked(jsonVariation).mockImplementation((async () => ({ target: '2026.10.22-27dcf5f' })) as never);
    const a = await requestFleetUpdate(cursor, 'behind', 'idle', admin);
    expect((a.body as { runs: Array<{ hostKey: string }> }).runs.map(r => r.hostKey)).toEqual(['box-old']);
    expect(rows.get((a.body as { runs: Array<{ runId: string }> }).runs[0].runId)).toMatchObject({ component: 'cursor', target: '2026.10.22-27dcf5f' });
    vi.mocked(jsonVariation).mockImplementation((async () => null) as never);
    vi.mocked(instanceAgentTransport).mockReturnValue({ capabilities: ['tool-update-v1'] } as never);
  });

  it('relaunches a Cursor agent pane on the chat the box saw, and one without a chat fresh', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([{ id: 'p1', name: 'web', workflows: [
      { type: 'agent', provider: 'cursor', backend: null, model: null, workstream: { name: 'main', askThread: null } },
      { type: 'agent', provider: 'cursor', backend: null, model: null, workstream: { name: 'new', askThread: null } },
    ] }] as never);
    const out = await relaunchReportedPanes(cursor, box('box-a'), ada, [
      { session: 'ada-web-agent', role: 'agent', sessionId: chat, hadConversation: true },
      { session: 'ada-web-new-agent', role: 'agent', sessionId: null, hadConversation: true },
    ]);
    expect(out).toEqual([
      { session: 'ada-web-agent', outcome: 'launched', resume: true },
      { session: 'ada-web-new-agent', outcome: 'launched', resume: false },
    ]);
    expect(vi.mocked(ensureAgentSessionsAndLaunch).mock.calls.map(c => c[0])).toEqual([
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'cursor', instanceId: 'box-a', workstream: 'main', hostHome: '/home/ada', resume: true, resumeSessionId: chat },
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'cursor', instanceId: 'box-a', workstream: 'new', hostHome: '/home/ada', resume: false },
    ]);
  });
});

describe('the Devin CLI, the fourth tool', () => {
  const devin = TOOL_REGISTRY.devin;
  const sid = '9c1e2f3a-4b5c-4d6e-8f70-123456789abc';

  it('sends a Devin run only to an agent that announces tool-update-devin-v1', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValueOnce({ capabilities: ['tool-update-v1', 'tool-update-cursor-v1'] } as never);
    expect(await sendToolUpdate('box-a', 'devin', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'the agent does not announce tool-update-devin-v1' });
  });

  it('relaunches a Devin agent pane on the session the box saw, and one without a session fresh', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([{ id: 'p1', name: 'web', workflows: [
      { type: 'agent', provider: 'devin', backend: null, model: null, workstream: { name: 'main', askThread: null } },
      { type: 'agent', provider: 'devin', backend: null, model: null, workstream: { name: 'new', askThread: null } },
      { type: 'agent', provider: 'cursor', backend: null, model: null, workstream: { name: 'cu', askThread: null } },
    ] }] as never);
    const out = await relaunchReportedPanes(devin, box('box-a'), ada, [
      { session: 'ada-web-agent', role: 'agent', sessionId: sid, hadConversation: true },
      { session: 'ada-web-new-agent', role: 'agent', sessionId: null, hadConversation: false },
      { session: 'ada-web-cu-agent', role: 'agent', sessionId: sid, hadConversation: true },
    ]);
    expect(out).toEqual([
      { session: 'ada-web-agent', outcome: 'launched', resume: true },
      { session: 'ada-web-new-agent', outcome: 'launched', resume: false },
      { session: 'ada-web-cu-agent', outcome: 'other-provider' },
    ]);
    expect(vi.mocked(ensureAgentSessionsAndLaunch).mock.calls.map(c => c[0])).toEqual([
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'devin', instanceId: 'box-a', workstream: 'main', hostHome: '/home/ada', resume: true, resumeSessionId: sid },
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'devin', instanceId: 'box-a', workstream: 'new', hostHome: '/home/ada', resume: false },
    ]);
  });
});

describe('pi, the fifth tool', () => {
  const pi = TOOL_REGISTRY.pi;

  it('sends a pi run only to an agent that announces tool-update-pi-v1', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValueOnce({ capabilities: ['tool-update-v1', 'tool-update-devin-v1'] } as never);
    expect(await sendToolUpdate('box-a', 'pi', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'the agent does not announce tool-update-pi-v1' });
  });

  it('relaunches a pi agent pane with the provider\'s resume command, and only pi\'s', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([{ id: 'p1', name: 'web', workflows: [
      { type: 'agent', provider: 'pi', backend: null, model: null, workstream: { name: 'main', askThread: null } },
      { type: 'agent', provider: 'pi', backend: null, model: null, workstream: { name: 'new', askThread: null } },
      { type: 'agent', provider: 'claude', backend: null, model: null, workstream: { name: 'cl', askThread: null } },
    ] }] as never);
    const out = await relaunchReportedPanes(pi, box('box-a'), ada, [
      { session: 'ada-web-agent', role: 'agent', sessionId: '019a0003-1111-7222-8333-444444444444', hadConversation: true },
      { session: 'ada-web-new-agent', role: 'agent', sessionId: null, hadConversation: false },
      { session: 'ada-web-cl-agent', role: 'agent', sessionId: null, hadConversation: true },
    ]);
    expect(out).toEqual([
      { session: 'ada-web-agent', outcome: 'launched', resume: true },
      { session: 'ada-web-new-agent', outcome: 'launched', resume: false },
      { session: 'ada-web-cl-agent', outcome: 'other-provider' },
    ]);
    // A provider with a resumeCommand continues the pane's directory's last session: no id passed.
    expect(vi.mocked(ensureAgentSessionsAndLaunch).mock.calls.map(c => c[0])).toEqual([
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'pi', instanceId: 'box-a', workstream: 'main', hostHome: '/home/ada', resume: true },
      { userId: 'u1', unixUsername: 'ada', projectName: 'web', provider: 'pi', instanceId: 'box-a', workstream: 'new', hostHome: '/home/ada', resume: false },
    ]);
  });
});

describe('the GitHub CLI, the sixth tool and the first root recipe', () => {
  const gh = TOOL_REGISTRY.gh;

  it('sends a gh run only to an agent that announces tool-update-gh-v1', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValueOnce({ capabilities: ['tool-update-v1', 'tool-update-pi-v1'] } as never);
    expect(await sendToolUpdate('box-a', 'gh', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'the agent does not announce tool-update-gh-v1' });
  });

  it('relaunches no pane: gh has no provider, so any agent pane a report lists is another tool\'s', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([{ id: 'p1', name: 'web', workflows: [
      { type: 'agent', provider: 'claude', backend: null, model: null, workstream: { name: 'main', askThread: null } },
    ] }] as never);
    const out = await relaunchReportedPanes(gh, box('box-a'), ada, [
      { session: 'ada-web-agent', role: 'agent', sessionId: null, hadConversation: true },
    ]);
    expect(out).toEqual([{ session: 'ada-web-agent', outcome: 'other-provider' }]);
    expect(vi.mocked(ensureAgentSessionsAndLaunch)).not.toHaveBeenCalled();
  });
});

describe('the AWS CLI, the seventh tool and the second root recipe', () => {
  const aws = TOOL_REGISTRY.aws;

  it('sends an aws run only to an agent that announces tool-update-aws-v1', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValueOnce({ capabilities: ['tool-update-v1', 'tool-update-gh-v1'] } as never);
    expect(await sendToolUpdate('box-a', 'aws', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'the agent does not announce tool-update-aws-v1' });
  });

  it('relaunches no pane: the AWS CLI has no provider', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([{ id: 'p1', name: 'web', workflows: [
      { type: 'agent', provider: 'claude', backend: null, model: null, workstream: { name: 'main', askThread: null } },
    ] }] as never);
    const out = await relaunchReportedPanes(aws, box('box-a'), ada, [{ session: 'ada-web-agent', role: 'agent', sessionId: null, hadConversation: true }]);
    expect(out).toEqual([{ session: 'ada-web-agent', outcome: 'other-provider' }]);
    expect(vi.mocked(ensureAgentSessionsAndLaunch)).not.toHaveBeenCalled();
  });
});

describe('Node, the last tool', () => {
  it('sends a node run only to an agent that announces tool-update-node-v1', async () => {
    vi.mocked(instanceAgentTransport).mockReturnValueOnce({ capabilities: ['tool-update-v1', 'tool-update-aws-v1'] } as never);
    expect(await sendToolUpdate('box-a', 'node', 'ckz9v1q2w0000abcd1234efgh')).toEqual({ refused: 'the agent does not announce tool-update-node-v1' });
  });
});
