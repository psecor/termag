import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { memoryBugReports, type MemoryBugReports } from '../../services/bugReportsMemory';
import { parseBugReportInput, type Reporter } from '../../services/bugReports';

// The admin bug-report routes (routes/admin/bugs.ts):
// list filters, new first, the counts, the detail, and triage. requireAdmin
// and the audit log run in adminRouter ahead of these; here a header stands
// in for an admin token, which may read but not triage.
vi.mock('../../db', () => ({ prisma: {} }));
const { bugsRouter } = await import('./bugs');

const now = new Date('2026-10-28T15:00:00Z');
let store: MemoryBugReports;
let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin1' } as Express.User;
    if (req.headers['x-test-token']) (req as { adminTokenId?: string }).adminTokenId = 't1';
    next();
  });
  app.use((req, res, next) => bugsRouter(store, () => now)(req, res, next));
  server = await new Promise<Server>(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const reporter: Reporter = {
  reporterUserId: 'u1', credential: 'box', boxId: 'i-1', projectId: 'p-1', workstream: 'ask-thread0001abc', threadId: 'thread0001abc',
  boxAgentCommit: 'abc123', boxAgentCapabilities: ['ask-v1'],
};
async function file(title: string, extra: Record<string, unknown> = {}) {
  const parsed = parseBugReportInput({ title, body: `${title}: repro`, ...extra });
  if (!('ok' in parsed)) throw new Error(parsed.error);
  return store.create(parsed.ok, reporter);
}

beforeEach(async () => {
  store = memoryBugReports(() => now);
  store.users.set('u1', 'ana@example.com').set('admin1', 'root@example.com');
  store.boxes.set('i-1', 'ana-box');
  store.projects.set('p-1', { userId: 'u1', instanceId: 'i-1', name: 'termag' });
  await file('space put over an existing file answers 403', { area: 'spaces', severity: 'high' });
  await file('gh pr list --search fails through the broker', { area: 'broker' });
  await file('publish refuses a bundle with an empty reason', { area: 'publish', severity: 'high' });
  await file('automation classifier denies box stop', { area: 'boxes', severity: 'low' });
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
const patch = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/bug-reports/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const ids = async (path: string) => ((await (await get(path)).json()).reports as Array<{ id: string }>).map(r => r.id);

describe('GET /bug-reports', () => {
  it('lists new reports first, with the reporter and box by name', async () => {
    await store.triage('bug4', { status: 'fixed' }, 'admin1', now);
    const body = await (await get('/bug-reports')).json();
    expect(body.reports.map((r: { id: string }) => r.id)).toEqual(['bug3', 'bug2', 'bug1', 'bug4']);
    expect(body.reports[0]).toMatchObject({ reporter: 'ana@example.com', box: 'ana-box', status: 'new', area: 'publish' });
  });

  it('filters by status, area and severity, and searches', async () => {
    await store.triage('bug1', { status: 'triaged' }, 'admin1', now);
    expect(await ids('/bug-reports?status=triaged')).toEqual(['bug1']);
    expect(await ids('/bug-reports?area=broker,boxes')).toEqual(['bug4', 'bug2']);
    expect(await ids('/bug-reports?severity=high')).toEqual(['bug3', 'bug1']);
    expect(await ids('/bug-reports?q=EMPTY%20reason')).toEqual(['bug3']);
    expect(await ids('/bug-reports?status=new&severity=high')).toEqual(['bug3']);
    expect((await get('/bug-reports?area=nope')).status).toBe(400);
  });

  it('keeps an old new report on a capped list, ahead of newer triaged ones', async () => {
    // bug1 is the oldest and still new; the three newer ones are triaged.
    store.rows.forEach((r, i) => { r.createdAt = new Date(now.getTime() - (4 - i) * 60_000); });
    for (const id of ['bug2', 'bug3', 'bug4']) store.rows.find(r => r.id === id)!.status = 'triaged';
    expect(await ids('/bug-reports?limit=2')).toEqual(['bug1', 'bug4']);
    expect(await ids('/bug-reports?limit=1')).toEqual(['bug1']);
  });

  it('works with an admin token', async () => {
    expect((await get('/bug-reports', { 'x-test-token': '1' })).status).toBe(200);
  });
});

describe('GET /bug-reports/counts', () => {
  it('counts every status, for the nav badge', async () => {
    await store.triage('bug2', { status: 'wontfix' }, 'admin1', now);
    expect(await (await get('/bug-reports/counts')).json()).toEqual({ counts: { new: 3, triaged: 0, duplicate: 0, fixed: 0, wontfix: 1 } });
  });
});

describe('PATCH /bug-reports/:id and the detail', () => {
  it('changes the status, links a PR, and shows both in the history', async () => {
    expect((await patch('bug1', { status: 'triaged', note: 'repro on stage' })).status).toBe(200);
    const r = await patch('bug1', { status: 'fixed', link: 'https://github.com/example-org/termag/pull/911' });
    expect((await r.json()).report).toMatchObject({ status: 'fixed', linkUrl: 'https://github.com/example-org/termag/pull/911', triagedAt: now.toISOString() });
    const d = await (await get('/bug-reports/bug1')).json();
    expect(d.reporter).toEqual({ user: 'ana@example.com', box: 'ana-box', project: 'termag' });
    expect(d.report).toMatchObject({ threadId: 'thread0001abc', boxAgentCommit: 'abc123', body: 'space put over an existing file answers 403: repro' });
    expect(d.events.map((e: { status: string; actor: string; note: string | null; linkUrl: string | null }) => [e.status, e.actor, e.note, e.linkUrl])).toEqual([
      ['triaged', 'root@example.com', 'repro on stage', null],
      ['fixed', 'root@example.com', null, 'https://github.com/example-org/termag/pull/911'],
    ]);
  });

  it('marks a duplicate, pointing at the root of a chain, and lists it on the original', async () => {
    expect((await patch('bug2', { duplicateOf: 'bug1' })).status).toBe(200);
    expect((await patch('bug3', { duplicateOf: 'bug2' })).status).toBe(200);
    expect(store.rows.find(r => r.id === 'bug3')).toMatchObject({ status: 'duplicate', duplicateOfId: 'bug1' });
    const d = await (await get('/bug-reports/bug1')).json();
    expect(d.duplicates.map((r: { id: string }) => r.id).sort()).toEqual(['bug2', 'bug3']);
    const dup = await (await get('/bug-reports/bug2')).json();
    expect(dup.duplicateOf).toMatchObject({ id: 'bug1', title: 'space put over an existing file answers 403' });
    // Back to new clears the pointer.
    await patch('bug2', { status: 'new' });
    expect(store.rows.find(r => r.id === 'bug2')).toMatchObject({ status: 'new', duplicateOfId: null });
  });

  it('moves an original’s duplicates along when it is itself marked a duplicate, so none chain', async () => {
    expect((await patch('bug2', { duplicateOf: 'bug1' })).status).toBe(200);
    expect((await patch('bug1', { duplicateOf: 'bug3' })).status).toBe(200);
    expect(store.rows.find(r => r.id === 'bug2')).toMatchObject({ status: 'duplicate', duplicateOfId: 'bug3' });
    const d = await (await get('/bug-reports/bug3')).json();
    expect(d.duplicates.map((r: { id: string }) => r.id).sort()).toEqual(['bug1', 'bug2']);
    const moved = await (await get('/bug-reports/bug2')).json();
    expect(moved.events.at(-1)).toMatchObject({ status: 'duplicate', duplicateOfId: 'bug3', actorId: 'admin1' });
  });

  it('refuses a duplicate of an unknown report or of its own duplicate, a bad link, and an unknown report', async () => {
    expect((await patch('bug1', { duplicateOf: 'bug99' })).status).toBe(400);
    await patch('bug2', { duplicateOf: 'bug1' });
    expect((await patch('bug1', { duplicateOf: 'bug2' })).status).toBe(400);
    expect((await patch('bug1', { link: 'https://example.com/x' })).status).toBe(400);
    expect((await patch('bug99', { status: 'fixed' })).status).toBe(404);
    expect((await get('/bug-reports/bug99')).status).toBe(404);
    expect(store.eventRows).toHaveLength(1);
  });

  it('needs a signed-in session, not an admin token', async () => {
    const r = await patch('bug1', { status: 'fixed' }, { 'x-test-token': '1' });
    expect(r.status).toBe(403);
    expect(store.rows[0].status).toBe('new');
  });
});
