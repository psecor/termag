/**
 * POST /api/cli/v1/bug-reports (routes/cliBugReports.ts,
 * docs/bug-reports.md) through the real cliApiRouter and its bearer check:
 * a box's own credential and a device sign-in both file, the rate limit is
 * per box, secret-shaped strings never reach the store, and nothing reads
 * reports back through this route.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import { memoryBugReports, type MemoryBugReports } from '../services/bugReportsMemory';
import { REPORTS_PER_HOUR } from '../services/bugReports';

vi.mock('../db', () => ({ prisma: {} }));

const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const cliUser = (id: string): CliUser => ({ id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id });
const DEVICE = { alice: 'tmcli_' + 'a'.repeat(64), bob: 'tmcli_' + 'b'.repeat(64) };
const BOX_A1 = 'tmag_alice_a1';
const BOX_A2 = 'tmag_alice_a2';
const now = new Date('2026-10-28T12:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    const who = (Object.keys(DEVICE) as Array<keyof typeof DEVICE>).find(u => sha256Hex(DEVICE[u]) === hash);
    if (!who) return null;
    return { id: `s-${who}`, userId: who, user: cliUser(who), deviceName: 'mbp', tokenPrefix: 'tmcli_xxx', createdAt: now, lastUsedAt: now, revokedAt: null } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    if (raw === BOX_A1) return { user: cliUser('alice'), instanceId: 'i-a1' };
    if (raw === BOX_A2) return { user: cliUser('alice'), instanceId: 'i-a2' };
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
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({
    store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now,
    bugReports: {
      get store() { return reports; },
    },
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => {
  reports = memoryBugReports(() => now);
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

describe('reading /api/cli/v1/bug-reports', () => {
  // Reports are write-only from the CLI; reading and triage are the admin's
  // (/api/admin/bug-reports). Neither credential gets a list, filtered or not.
  it.each([['a box token', BOX_A1], ['a sign-in', DEVICE.alice]])('answers a GET with %s 405, and lists nothing', async (_name, token) => {
    await post(BOX_A1, report);
    for (const query of ['', '?mine=1', '?q=space']) {
      const r = await list(token, query);
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('POST');
      const body = await r.json();
      expect(body).toMatchObject({ code: 'method_not_allowed' });
      expect(body).not.toHaveProperty('reports');
    }
  });
});
