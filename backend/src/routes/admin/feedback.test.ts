import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { memoryFeedback, type MemoryFeedback } from '../../services/feedbackMemory';
import { parseFeedbackInput } from '../../services/feedback';
import type { Reporter } from '../../services/cliReporter';

// The admin feedback routes (routes/admin/feedback.ts): the
// list with names, newest first, its filters, the counts, and marking seen.
// requireAdmin and the audit log run in adminRouter ahead of these; here a
// header stands in for an admin token, which may read but not change.
vi.mock('../../db', () => ({ prisma: {} }));
const { feedbackRouter } = await import('./feedback');

const now = new Date('2026-11-13T15:00:00Z');
let store: MemoryFeedback;
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
  app.use((req, res, next) => feedbackRouter(store, () => now)(req, res, next));
  server = await new Promise<Server>(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const reporter: Reporter = {
  reporterUserId: 'u1', credential: 'box', boxId: 'i-1', projectId: 'p-1', workstream: 'main', threadId: null,
  boxAgentCommit: 'abc123', boxAgentCapabilities: ['ask-v1'],
};
async function log(body: string, kind?: string) {
  const parsed = parseFeedbackInput({ body, kind, agentProvider: 'claude', cliVersion: '0.4.1' });
  if (!('ok' in parsed)) throw new Error(parsed.error);
  return store.create(parsed.ok, reporter);
}

beforeEach(async () => {
  store = memoryFeedback(() => now);
  store.users.set('u1', 'ana@example.com').set('admin1', 'root@example.com');
  store.boxes.set('i-1', 'ana-box');
  store.projects.set('p-1', { userId: 'u1', instanceId: 'i-1', name: 'termag' });
  await log('The sidebar is confusing: I never find my asks', 'problem');
  await log('Spaces are great, sharing a handoff took seconds', 'praise');
  await log('I wish asks showed progress', 'idea');
});

const get = (path: string) => fetch(`${base}${path}`);
const patch = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/feedback/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const ids = async (path: string) => ((await (await get(path)).json()).feedback as Array<{ id: string }>).map(r => r.id);

describe('GET /feedback', () => {
  it('lists newest first with who, where from and the text', async () => {
    const body = await (await get('/feedback')).json();
    expect(body.feedback.map((f: { id: string }) => f.id)).toEqual(['fb3', 'fb2', 'fb1']);
    expect(body.feedback[0]).toMatchObject({
      id: 'fb3', body: 'I wish asks showed progress', kind: 'idea', status: 'new', createdAt: expect.any(String),
      reporter: 'ana@example.com', box: 'ana-box', boxId: 'i-1', project: 'termag', projectId: 'p-1', workstream: 'main',
      agentProvider: 'claude', cliVersion: '0.4.1', seenAt: null, seenBy: null,
    });
  });

  it('filters by status, kind and text, and refuses an unknown value', async () => {
    expect(await ids('/feedback?kind=praise,idea')).toEqual(['fb3', 'fb2']);
    expect(await ids('/feedback?q=SIDEBAR')).toEqual(['fb1']);
    expect(await ids('/feedback?limit=1')).toEqual(['fb3']);
    expect((await get('/feedback?status=fixed')).status).toBe(400);
  });

  it('says whether more matched than it returned, and not when exactly the limit matched', async () => {
    const more = async (path: string) => (await (await get(path)).json()).more;
    expect(await more('/feedback?limit=2')).toBe(true);
    expect(await more('/feedback?limit=3')).toBe(false);
    expect(await more('/feedback')).toBe(false);
    expect(await ids('/feedback?limit=2')).toEqual(['fb3', 'fb2']);
  });

  it('returns at most 500, with more set only when a 501st matched', async () => {
    for (let i = 3; i < 500; i++) await log(`remark ${i}`);
    let body = await (await get('/feedback?limit=9999')).json();
    expect([body.feedback.length, body.more]).toEqual([500, false]);
    await log('one more');
    body = await (await get('/feedback')).json();
    expect([body.feedback.length, body.more]).toEqual([500, true]);
  });

  it('counts per status, zeros included', async () => {
    expect(await (await get('/feedback/counts')).json()).toEqual({ counts: { new: 3, seen: 0 } });
  });
});

describe('PATCH /feedback/:id', () => {
  it('marks seen, naming the admin, and back to new clears it', async () => {
    const r = await patch('fb1', { status: 'seen' });
    expect(r.status).toBe(200);
    expect((await r.json()).feedback).toMatchObject({ status: 'seen', seenAt: now.toISOString(), seenBy: 'root@example.com' });
    expect(await ids('/feedback?status=new')).toEqual(['fb3', 'fb2']);
    expect(await (await get('/feedback/counts')).json()).toEqual({ counts: { new: 2, seen: 1 } });
    expect((await (await patch('fb1', { status: 'new' })).json()).feedback).toMatchObject({ status: 'new', seenAt: null, seenBy: null });
  });

  it('refuses a bad status, an unknown id, and an admin token', async () => {
    expect((await patch('fb1', { status: 'fixed' })).status).toBe(400);
    expect((await patch('fb9', { status: 'seen' })).status).toBe(404);
    expect((await patch('fb1', { status: 'seen' }, { 'x-test-token': '1' })).status).toBe(403);
    expect(store.rows.find(r => r.id === 'fb1')?.status).toBe('new');
  });
});
