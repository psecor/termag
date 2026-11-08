/**
 * POST /api/cli/v1/bug-reports (routes/cliBugReports.ts,
 * docs/bug-reports.md) through the real cliApiRouter and its bearer check:
 * a box's own credential and a device sign-in both file, the rate limit is
 * per box, secret-shaped strings never reach the store. Reading and triage
 * take an admin's box token only, the owner's role asked on every request,
 * and each call is an audit row naming the box.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import { memoryBugReports, type MemoryBugReports } from '../services/bugReportsMemory';
import { REPORTS_PER_HOUR, type BugReportStore } from '../services/bugReports';
import type { AuditEntry } from '../middleware/admin';

vi.mock('../db', () => ({ prisma: {} }));

const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const cliUser = (id: string): CliUser => ({ id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id });
const DEVICE = { alice: 'tmcli_' + 'a'.repeat(64), bob: 'tmcli_' + 'b'.repeat(64) };
const BOX_A1 = 'tmag_alice_a1';
const BOX_A2 = 'tmag_alice_a2';
const BOX_B = 'tmag_bob_b1';
/** A legacy per-user agent token: owner-bound, `agent` scope, no instance. */
const LEGACY_ALICE = 'tmag_alice_legacy';
const now = new Date('2026-10-28T12:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    const who = (Object.keys(DEVICE) as Array<keyof typeof DEVICE>).find(u => sha256Hex(DEVICE[u]) === hash);
    if (!who) return null;
    return { id: `s-${who}`, userId: who, user: cliUser(who), deviceName: 'mbp', tokenPrefix: 'tmcli_xxx', createdAt: now, lastUsedAt: now, revokedAt: null } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    if (raw === BOX_A1) return { user: cliUser('alice'), instanceId: 'i-a1', tokenId: 'tok-a1' };
    if (raw === BOX_A2) return { user: cliUser('alice'), instanceId: 'i-a2', tokenId: 'tok-a2' };
    if (raw === LEGACY_ALICE) return { user: cliUser('alice'), instanceId: null, tokenId: 'tok-legacy' };
    if (raw === BOX_B) return { user: cliUser('bob'), instanceId: 'i-b1', tokenId: 'tok-b1' };
    return null;
  },
  createSession: async () => { throw new Error('unused'); },
  findSessionById: async () => null,
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

let reports: MemoryBugReports;
/** Who is an admin right now; the route asks on every request. */
let admins: Set<string>;
let audits: AuditEntry[];
/** Boxes hosting a project with a ProjectShare; the gate asks on every request. */
let sharedBoxes: Set<string>;
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({
    store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now,
    bugReports: {
      // The handlers take the store once, at mount; each test gets a fresh one behind this.
      store: new Proxy({} as BugReportStore, { get: (_t, k) => Reflect.get(reports, k) }),
      adminBox: {
        isAdmin: async id => admins.has(id),
        boxHasSharedProject: async boxId => sharedBoxes.has(boxId),
        audit: e => { audits.push(e); },
      },
    },
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => {
  reports = memoryBugReports(() => now);
  admins = new Set(['alice']);
  sharedBoxes = new Set();
  audits = [];
  reports.projects.set('p-a1', { userId: 'alice', instanceId: 'i-a1', name: 'termag' });
  reports.projects.set('p-bob', { userId: 'bob', instanceId: 'i-b1', name: 'bobs' });
  reports.threads.set('thread0001abc', 'alice');
});

const post = (token: string | null, body: unknown) => fetch(`${base}/api/cli/v1/bug-reports`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const list = (token: string, query = '') => fetch(`${base}/api/cli/v1/bug-reports${query}`, { headers: { authorization: `Bearer ${token}` } });
const report = { title: 'space put over an existing file answers 403', body: '`termag space put` of an existing path: 403', area: 'spaces', severity: 'high' };

describe('POST /api/cli/v1/bug-reports', () => {
  it('files with a box token as that box, with its project and ask thread', async () => {
    const r = await post(BOX_A1, { ...report, projectId: 'p-a1', workstream: 'ask-thread0001abc', agentProvider: 'claude', agentModel: 'opus', cliVersion: '0.1.0' });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body).toEqual({ id: 'bug1', status: 'new', redacted: [] });
    expect(reports.rows[0]).toMatchObject({
      reporterUserId: 'alice', credential: 'box', boxId: 'i-a1', projectId: 'p-a1', workstream: 'ask-thread0001abc',
      threadId: 'thread0001abc', agentProvider: 'claude', agentModel: 'opus', area: 'spaces', severity: 'high',
    });
  });

  it('files with a device sign-in, taking the box from the caller\'s own project only', async () => {
    expect((await post(DEVICE.alice, { ...report, projectId: 'p-a1' })).status).toBe(201);
    expect(reports.rows[0]).toMatchObject({ reporterUserId: 'alice', credential: 'device', boxId: 'i-a1', projectId: 'p-a1' });
    // Bob names Alice's project: kept as his report, without her project or box.
    expect((await post(DEVICE.bob, { ...report, projectId: 'p-a1', workstream: 'main' })).status).toBe(201);
    expect(reports.rows[1]).toMatchObject({ reporterUserId: 'bob', boxId: null, projectId: null, workstream: null });
  });

  it('does not let a box token claim a project on another box', async () => {
    expect((await post(BOX_A2, { ...report, projectId: 'p-a1' })).status).toBe(201);
    expect(reports.rows[0]).toMatchObject({ boxId: 'i-a2', projectId: null, threadId: null });
  });

  it('refuses a missing or unknown credential', async () => {
    expect((await post(null, report)).status).toBe(401);
    expect((await post('tmag_nobody', report)).status).toBe(401);
    expect(reports.rows).toEqual([]);
  });

  it('refuses a bad report with the reason', async () => {
    const r = await post(BOX_A1, { ...report, severity: 'sev1' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: 'invalid_request', error: expect.stringMatching(/severity is one of/) });
  });

  it('redacts secret-shaped strings before storing and says so', async () => {
    const tok = `ghp_${'s'.repeat(36)}`;
    const r = await post(BOX_A1, { ...report, command: `GH_TOKEN=${tok} gh pr list --search foo`, errorOutput: `bad credentials ${tok}` });
    expect(r.status).toBe(201);
    expect((await r.json()).redacted).toEqual(['GitHub token']);
    expect(JSON.stringify(reports.rows)).not.toContain(tok);
    expect(reports.rows[0].command).toBe('GH_TOKEN=[redacted: GitHub token] gh pr list --search foo');
  });

  it(`allows ${REPORTS_PER_HOUR} an hour per box, and another box is counted apart`, async () => {
    for (let i = 0; i < REPORTS_PER_HOUR; i++) expect((await post(BOX_A1, report)).status).toBe(201);
    const r = await post(BOX_A1, report);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('600');
    expect(await r.json()).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/20 bug reports an hour from one box/) });
    expect((await post(BOX_A2, report)).status).toBe(201);
    // A sign-in naming the full box's project counts against that box too.
    expect((await post(DEVICE.alice, { ...report, projectId: 'p-a1' })).status).toBe(429);
  });

  it('forgets reports older than an hour', async () => {
    for (let i = 0; i < REPORTS_PER_HOUR; i++) await post(BOX_A1, report);
    for (const row of reports.rows) row.createdAt = new Date(now.getTime() - 61 * 60_000);
    expect((await post(BOX_A1, report)).status).toBe(201);
  });
});

const call = (method: string, path: string, token: string, body?: unknown) => fetch(`${base}/api/cli/v1${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
// The audit row is written on the response's finish, just after the client has it.
const settle = () => new Promise(r => setTimeout(r, 20));

describe('reading and triage from an admin\'s box', () => {
  beforeEach(async () => {
    reports.users.set('alice', 'alice@example.com').set('bob', 'bob@example.com');
    await post(BOX_B, report);
    await post(BOX_B, { ...report, title: 'gh pr list --search fails through the broker', area: 'broker', severity: 'low' });
    audits = [];
  });

  it('lists, filters, counts and shows with the box token of an admin', async () => {
    const r = await list(BOX_A1);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.reports.map((x: { id: string }) => x.id)).toEqual(['bug2', 'bug1']);
    expect(body.reports[0]).toMatchObject({ reporter: 'bob@example.com', status: 'new', area: 'broker' });
    expect((await (await list(BOX_A1, '?area=spaces')).json()).reports.map((x: { id: string }) => x.id)).toEqual(['bug1']);
    expect((await list(BOX_A1, '?area=nope')).status).toBe(400);

    expect(await (await call('GET', '/bug-reports/counts', BOX_A1)).json()).toEqual({ counts: expect.objectContaining({ new: 2, triaged: 0 }) });
    const one = await (await call('GET', '/bug-reports/bug1', BOX_A1)).json();
    expect(one).toMatchObject({ report: { id: 'bug1', title: report.title }, reporter: { user: 'bob@example.com' }, events: [] });
    expect((await call('GET', '/bug-reports/bug9', BOX_A1)).status).toBe(404);
  });

  it('triages with today\'s fields, and the history names the admin', async () => {
    const r = await call('PATCH', '/bug-reports/bug2', BOX_A1, { status: 'triaged', link: 'https://github.com/example-org/termag/issues/12', note: 'seen it' });
    expect(r.status).toBe(200);
    expect((await r.json()).report).toMatchObject({ status: 'triaged', linkUrl: 'https://github.com/example-org/termag/issues/12' });
    expect((await call('PATCH', '/bug-reports/bug1', BOX_A2, { duplicateOf: 'bug2' })).status).toBe(200);
    expect(reports.rows.find(x => x.id === 'bug1')).toMatchObject({ status: 'duplicate', duplicateOfId: 'bug2' });
    const events = (await (await call('GET', '/bug-reports/bug2', BOX_A1)).json()).events;
    expect(events[0]).toMatchObject({ actorId: 'alice', actor: 'alice@example.com', note: 'seen it' });
    expect((await call('PATCH', '/bug-reports/bug2', BOX_A1, { status: 'closed' })).status).toBe(400);
  });

  it('writes an audit row per call naming the owner, the box and its token', async () => {
    await list(BOX_A1, '?status=new');
    await call('PATCH', '/bug-reports/bug1', BOX_A2, { status: 'wontfix', note: 'by design' });
    await settle();
    expect(audits).toEqual([
      { actorId: 'alice', tokenId: 'tok-a1', boxId: 'i-a1', surface: 'rest', action: 'GET /api/cli/v1/bug-reports', args: { status: 'new' }, outcome: 'ok', status: 200 },
      { actorId: 'alice', tokenId: 'tok-a2', boxId: 'i-a2', surface: 'rest', action: 'PATCH /api/cli/v1/bug-reports/bug1', args: { id: 'bug1', status: 'wontfix', note: 'by design' }, outcome: 'ok', status: 200 },
    ]);
  });

  it('refuses the box of a non-admin, with the reason, and lists nothing', async () => {
    for (const [method, path, body] of [['GET', '/bug-reports'], ['GET', '/bug-reports/counts'], ['GET', '/bug-reports/bug1'], ['PATCH', '/bug-reports/bug1', { status: 'fixed' }]] as const) {
      const r = await call(method, path, BOX_B, body);
      expect(r.status).toBe(403);
      const got = await r.json();
      expect(got).toMatchObject({ code: 'admin_required', error: expect.stringMatching(/Only termag admins/) });
      expect(got).not.toHaveProperty('reports');
    }
    expect(reports.rows.find(x => x.id === 'bug1')?.status).toBe('new');
    await settle();
    expect(audits).toEqual([]);
  });

  it('stops on the next request once the owner is demoted', async () => {
    expect((await list(BOX_A1)).status).toBe(200);
    admins.delete('alice');
    expect((await list(BOX_A1)).status).toBe(403);
    expect((await call('PATCH', '/bug-reports/bug1', BOX_A1, { status: 'fixed' })).status).toBe(403);
    expect(reports.rows.find(x => x.id === 'bug1')?.status).toBe('new');
  });

  it('refuses a device sign-in, an admin\'s included: box credentials only', async () => {
    const r = await list(DEVICE.alice);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: 'box_credential_required' });
    expect((await call('PATCH', '/bug-reports/bug1', DEVICE.alice, { status: 'fixed' })).status).toBe(403);
  });

  it('refuses an admin\'s legacy agent token that belongs to no box', async () => {
    for (const [method, path, body] of [['GET', '/bug-reports'], ['GET', '/bug-reports/counts'], ['GET', '/bug-reports/bug1'], ['PATCH', '/bug-reports/bug1', { status: 'fixed' }]] as const) {
      const r = await call(method, path, LEGACY_ALICE, body);
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ code: 'box_credential_required' });
    }
    expect(reports.rows.find(x => x.id === 'bug1')?.status).toBe('new');
    await settle();
    expect(audits).toEqual([]);
  });

  it('refuses an admin\'s box that hosts a shared project, on all four routes, whoever the share is with', async () => {
    // i-a1 hosts a project shared with someone (bob, or another admin: the gate doesn't ask who).
    sharedBoxes.add('i-a1');
    for (const [method, path, body] of [['GET', '/bug-reports'], ['GET', '/bug-reports/counts'], ['GET', '/bug-reports/bug1'], ['PATCH', '/bug-reports/bug1', { status: 'fixed' }]] as const) {
      const r = await call(method, path, BOX_A1, body);
      expect(r.status).toBe(403);
      const got = await r.json();
      expect(got).toMatchObject({ code: 'box_shared', error: expect.stringMatching(/don't run from a box with shared projects.*web UI/) });
      expect(got).not.toHaveProperty('reports');
    }
    expect(reports.rows.find(x => x.id === 'bug1')?.status).toBe('new');
    // Alice's other box shares nothing, and is allowed.
    expect((await list(BOX_A2)).status).toBe(200);
    await settle();
    expect(audits.map(a => a.boxId)).toEqual(['i-a2']);
  });

  it('allows the box again on the next request once its share is removed', async () => {
    sharedBoxes.add('i-a1');
    expect((await list(BOX_A1)).status).toBe(403);
    sharedBoxes.delete('i-a1');
    expect((await list(BOX_A1)).status).toBe(200);
    expect((await call('PATCH', '/bug-reports/bug1', BOX_A1, { status: 'fixed' })).status).toBe(200);
  });

  it('answers a device sign-in as before, shares or not', async () => {
    sharedBoxes.add('i-a1');
    const r = await list(DEVICE.alice);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: 'box_credential_required' });
    // Filing is not gated: the shared box still files.
    expect((await post(BOX_A1, report)).status).toBe(201);
  });

  it('refuses a missing or unknown token with 401, and other methods with 405', async () => {
    expect((await fetch(`${base}/api/cli/v1/bug-reports`)).status).toBe(401);
    expect((await list('tmag_nobody')).status).toBe(401);
    const r = await call('DELETE', '/bug-reports', BOX_A1);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, POST');
  });
});
