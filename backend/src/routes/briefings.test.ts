import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// The box routes' trust boundary: only the token of
// the box a run was placed on may read its job or post its result, once. The
// briefings table is an in-memory array behind a minimal prisma.

type Row = Record<string, unknown> & { id: string; userId: string; instanceId: string | null; status: string };
let rows: Row[] = [];

const matches = (row: Row, where: Record<string, unknown> = {}) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const c = v as { in?: unknown[]; lt?: Date; gt?: Date };
    if (c.in) return c.in.includes(row[k]);
    if (c.lt) return (row[k] as Date) < c.lt;
    if (c.gt) return (row[k] as Date) > c.gt;
    return true;
  }
  return row[k] === v;
});

const briefing = {
  findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find(r => matches(r, where)) ?? null),
  findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter(r => matches(r, where))),
  create: vi.fn(async ({ data }: { data: Row }) => { const r = { ...data, id: `b${rows.length + 1}`, createdAt: new Date() }; rows.push(r); return r; }),
  updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const hit = rows.filter(r => matches(r, where));
    for (const r of hit) Object.assign(r, data);
    return { count: hit.length };
  }),
};
const prismaMock = {
  briefing,
  project: { findMany: vi.fn(async () => [{ id: 'p1', name: 'termag', archived: false }]) },
  projectShare: { findMany: vi.fn(async () => []) },
  instance: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => ({ hostUnixUser: 'pat' })) },
  $executeRaw: vi.fn(async () => 1),
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
};

vi.mock('../db', () => ({ prisma: prismaMock }));
vi.mock('../middleware/auth', () => {
  // x-test-user signs in; x-test-box makes it a box's agent token.
  const auth = (req: { headers: Record<string, string>; user?: unknown; agentInstanceId?: string | null }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!req.headers['x-test-user']) { res.status(401).json({ error: 'Unauthorized' }); return; }
    req.user = { id: req.headers['x-test-user'], unixUsername: 'pat' };
    req.agentInstanceId = req.headers['x-test-box'] ?? null;
    next();
  };
  return { requireAuth: auth, requireAuthOrAgentToken: auth };
});
const sendToInstanceAgent = vi.fn(async () => ({}));
vi.mock('../services/agentRegistry', () => ({
  instanceAgentTransport: () => null, isInstanceAgentConnected: () => true, sendToInstanceAgent,
}));
const ledgerSessionRow = {
  projectId: 'p1', projectName: 'termag', workstream: 'main', access: 'owner', instanceId: 'box-a', boxName: 'devbox', hostOffline: false, provider: 'claude',
  status: { now: 'idle', updatedAt: null, waitingReason: null, rateLimited: null, milestone: null },
  activity: { agentMs: 0, humanMs: 0, tokens: 0, visits: 1, lastVisitAt: null, peakContextTokens: null },
  digest: { branch: 'main', commits: [], transcript: null }, paneTail: null, prs: [], dismissed: false, notes: [],
};
const buildLedger = vi.fn(async (_user: unknown, window: unknown) => ({
  window, generatedAt: 'g', totals: { tokens: 7 }, sessions: [ledgerSessionRow], cloudSessions: [], otherPrs: [], notes: [], trust: 't',
  patterns: [{ id: 'many-switches', kind: 'many-switches', finding: 'f', projectId: null, workstream: null }],
  charts: { days: [], projects: [] },
}));
vi.mock('../services/briefing/ledger', () => ({ buildLedger, needsAttention: () => false }));
const deliver = vi.fn(async () => {});
vi.mock('../services/briefing/slack', () => ({ deliverBriefingDm: deliver }));

const { briefingsRouter, clearLedgerCalls, pruneLedgerCalls } = await import('./briefings');
const { recordResult, sweepStuckRuns, startBriefing, RUN_TIMEOUT_MS } = await import('../services/briefing/runner');
const { clearLedgerCache, LEDGER_CACHE_TTL_MS } = await import('../services/briefing/ledgerCache');

const CONTENT = JSON.stringify({ headline: 'You did things.', workedOn: [], leftOpen: [], workBetter: [{ patternId: 'many-switches', text: 'Batch reviews' }, { patternId: 'made-up', text: 'Nap' }] });
const running = (over: Partial<Row> = {}): Row => ({
  id: 'b1', userId: 'u1', instanceId: 'box-a', status: 'running', deliverSlack: true,
  since: new Date('2026-10-13T00:00:00Z'), until: new Date('2026-10-14T00:00:00Z'), tz: 'UTC', windowLabel: 'w',
  createdAt: new Date(), ...over,
});

let server: Server;
let base: string;

// Done / Defer marks, in memory.
let marks: Array<{ key: string; kind: 'done' | 'defer'; until: string; createdAt: string }> = [];
const dismissals = {
  list: vi.fn(async () => marks),
  dismiss: vi.fn(async (_u: string, input: { key: string; action: 'done' | 'defer' }) => {
    const m = { key: input.key, kind: input.action, until: '2099-01-01T00:00:00.000Z', createdAt: '2026-10-17T00:00:00.000Z' };
    marks = [...marks.filter(x => x.key !== input.key), m];
    return m;
  }),
  restore: vi.fn(async (_u: string, key: string) => { marks = marks.filter(x => x.key !== key); }),
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/briefings', briefingsRouter(dismissals));
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/briefings`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => { rows = [running()]; marks = []; vi.clearAllMocks(); clearLedgerCache(); clearLedgerCalls(); });

const asBox = (box: string | null, user = 'u1') => ({ 'x-test-user': user, ...(box ? { 'x-test-box': box } : {}), 'content-type': 'application/json' });
const post = (id: string, headers: Record<string, string>, body: unknown = { result: CONTENT, exitStatus: 0 }) =>
  fetch(`${base}/${id}/result`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('GET /:id/job and POST /:id/result', () => {
  it('serve the box the run was placed on', async () => {
    const job = await fetch(`${base}/b1/job`, { headers: asBox('box-a') });
    expect(job.status).toBe(200);
    expect((await job.json()).prompt).toContain('{"briefing": "b1"}');
    expect((await post('b1', asBox('box-a'))).status).toBe(204);
    expect(rows[0]).toMatchObject({ status: 'done', stats: { tokens: 7 } });
    expect(deliver).toHaveBeenCalledWith('b1');
  });

  it('answer 404 to another box, another user and a signed-in browser', async () => {
    for (const h of [asBox('box-b'), asBox('box-a', 'u2'), asBox(null)]) {
      expect((await fetch(`${base}/b1/job`, { headers: h })).status).toBe(404);
      expect((await post('b1', h)).status).toBe(404);
    }
    expect(rows[0].status).toBe('running');
  });

  it('answer 401 without auth and 409 to a replay', async () => {
    expect((await post('b1', { 'content-type': 'application/json' })).status).toBe(401);
    expect((await post('b1', asBox('box-a'))).status).toBe(204);
    expect((await post('b1', asBox('box-a'))).status).toBe(409);
    expect((await fetch(`${base}/b1/job`, { headers: asBox('box-a') })).status).toBe(409);
  });

  it('reject a malformed body before touching the row', async () => {
    expect((await post('b1', asBox('box-a'), { exitStatus: 0 })).status).toBe(400);
    expect(rows[0].status).toBe('running');
  });
});

describe('GET /ledger', () => {
  const get = (qs: string, user = 'u1') => fetch(`${base}/ledger?${qs}`, { headers: asBox('box-a', user) });

  it('answers the index, then sessions, from one build', async () => {
    const idx = await (await get('briefing=b1')).json();
    expect(idx).toMatchObject({ view: 'index', sessions: [{ projectId: 'p1', workstream: 'main', box: 'devbox', hasDetail: true }] });
    expect(idx.sessions[0].digest).toBeUndefined();
    const one = await get('briefing=b1&projectId=p1&workstream=main');
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ view: 'session', session: { digest: { branch: 'main' } } });
    expect((await get('briefing=b1&projectId=p1')).status).toBe(200);
    expect((await get('briefing=b1&view=full')).status).toBe(200);
    expect(buildLedger).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a session the ledger does not have, or another user\'s briefing', async () => {
    expect((await get('briefing=b1&projectId=p9')).status).toBe(404);
    expect((await get('briefing=b1', 'u2')).status).toBe(404);
  });

  it('rate limits builds, not cached reads', async () => {
    // Inside the 7-day cap: a capped start moves with the clock and misses the cache.
    const since = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const first = since(24);
    expect((await get(`since=${first}`)).status).toBe(200);
    expect((await get(`since=${first}&projectId=p1`)).status).toBe(200);
    expect((await get(`since=${since(23)}`)).status).toBe(429);
  });

  it('caches a briefing run\'s ledger for longer than the run may take', () => {
    expect(LEDGER_CACHE_TTL_MS).toBeGreaterThan(RUN_TIMEOUT_MS);
  });

  it('keeps what the result needs on the row, for a result that misses the cache', async () => {
    await get('briefing=b1');
    expect(rows[0]).toMatchObject({ stats: { tokens: 7 }, patterns: [{ id: 'many-switches' }], charts: { days: [], projects: [] } });
    clearLedgerCache();
    rows[0].stats = { tokens: 9 };
    expect((await post('b1', asBox('box-a'))).status).toBe(204);
    expect(buildLedger).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ status: 'done', stats: { tokens: 9 } });
    // Work better is still checked against the patterns the review was given.
    expect((rows[0].content as { workBetter: Array<{ key: string }> }).workBetter.map(w => w.key)).toEqual(['pattern:many-switches']);
  });

  it('gives the result its review\'s ledger totals and charts, and keeps only its patterns', async () => {
    await get('briefing=b1');
    expect((await post('b1', asBox('box-a'))).status).toBe(204);
    expect(buildLedger).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ status: 'done', stats: { tokens: 7 }, charts: { days: [], projects: [] } });
    expect((rows[0].content as { workBetter: Array<{ key: string }> }).workBetter.map(w => w.key)).toEqual(['pattern:many-switches']);
  });

  it('flags nothing as dismissed in the index unless the ledger did', async () => {
    const idx = await (await get('briefing=b1')).json();
    expect(idx.sessions[0].dismissed).toBe(false);
    expect(idx.patterns).toHaveLength(1);
    expect(idx.charts).toBeUndefined();
  });
});

describe('Done and Defer', () => {
  const headers = { 'x-test-user': 'u1', 'content-type': 'application/json' };
  const put = (body: unknown) => fetch(`${base}/dismissals`, { method: 'PUT', headers, body: JSON.stringify(body) });

  it('marks an item, shows it on latest, and brings it back', async () => {
    expect((await put({ key: 'pattern:many-switches', action: 'defer' })).status).toBe(200);
    expect((await put({ key: 'open:p1:feat-x', action: 'done' })).status).toBe(200);
    const latest = await (await fetch(`${base}/latest`, { headers })).json();
    expect(latest.dismissals.map((d: { key: string }) => d.key)).toEqual(['pattern:many-switches', 'open:p1:feat-x']);
    expect((await fetch(`${base}/dismissals?key=${encodeURIComponent('open:p1:feat-x')}`, { method: 'DELETE', headers })).status).toBe(204);
    expect(marks.map(m => m.key)).toEqual(['pattern:many-switches']);
  });

  it('refuses keys that name no briefing item and unknown actions', async () => {
    expect((await put({ key: 'o/termag#12', action: 'defer' })).status).toBe(400);
    expect((await put({ key: 'pattern:x', action: 'snooze' })).status).toBe(400);
    expect(dismissals.dismiss).not.toHaveBeenCalled();
  });

  it('still answers latest when the marks cannot be read', async () => {
    dismissals.list.mockRejectedValueOnce(new Error('db down'));
    const r = await fetch(`${base}/latest`, { headers });
    expect(r.status).toBe(200);
    expect((await r.json()).dismissals).toEqual([]);
  });
});

describe('recordResult', () => {
  const user = { id: 'u1', unixUsername: 'pat' };
  const body = (over = {}) => ({ result: CONTENT, exitStatus: 0, isError: false, model: 'm', usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 1 }, ...over });

  it('stores done with the token counts', async () => {
    expect(await recordResult(user, 'box-a', 'b1', body(), deliver)).toEqual({ status: 204 });
    expect(rows[0]).toMatchObject({ status: 'done', inputTokens: 5, outputTokens: 1, model: 'm', error: null });
  });

  it('fails on a non-zero exit or unparseable content, and keeps the reason', async () => {
    await recordResult(user, 'box-a', 'b1', body({ exitStatus: 1, result: 'boom' }), deliver);
    expect(rows[0]).toMatchObject({ status: 'failed' });
    expect(String(rows[0].error)).toMatch(/exit 1.*boom/);
    rows = [running()];
    await recordResult(user, 'box-a', 'b1', body({ result: 'not json' }), deliver);
    expect(rows[0].status).toBe('failed');
  });

  it('loses to a sweep that got there first', async () => {
    rows[0].status = 'failed';
    expect(await recordResult(user, 'box-a', 'b1', body(), deliver)).toEqual({ status: 409 });
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('sweepStuckRuns', () => {
  it('fails an overdue run and drops its session', async () => {
    rows = [running({ createdAt: new Date(Date.now() - RUN_TIMEOUT_MS - 1000) })];
    expect(await sweepStuckRuns()).toBe(1);
    expect(rows[0].status).toBe('failed');
    expect(sendToInstanceAgent).toHaveBeenCalledWith('box-a', 'tmux-kill', expect.objectContaining({ exact: true }));
  });

  it('leaves a run alone when its result landed after the read', async () => {
    rows = [running({ createdAt: new Date(Date.now() - RUN_TIMEOUT_MS - 1000) })];
    briefing.updateMany.mockImplementationOnce(async () => { rows[0].status = 'done'; return { count: 0 }; });
    expect(await sweepStuckRuns()).toBe(0);
    expect(rows[0].status).toBe('done');
    expect(sendToInstanceAgent).not.toHaveBeenCalled();
  });
});

describe('startBriefing', () => {
  it('checks for a running run under the per-user lock', async () => {
    const out = await startBriefing({ user: { id: 'u1' }, trigger: 'manual', tz: 'UTC' });
    expect(out).toEqual({ kind: 'already_running', id: 'b1' });
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
    expect(briefing.create).not.toHaveBeenCalled();
  });

  it('records a skip when no box is ready', async () => {
    rows = [];
    const out = await startBriefing({ user: { id: 'u1' }, trigger: 'manual', tz: 'UTC' });
    expect(out.kind).toBe('skipped');
    expect(rows[0]).toMatchObject({ status: 'skipped', instanceId: null });
  });
});

describe('pruneLedgerCalls', () => {
  it('forgets callers past the interval', () => {
    const m = new Map([['old', 0], ['new', 9_000]]);
    pruneLedgerCalls(m, 10_000);
    expect([...m.keys()]).toEqual(['new']);
  });
});
