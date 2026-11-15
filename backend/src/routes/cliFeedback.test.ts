/**
 * POST /api/cli/v1/feedback (routes/cliFeedback.ts) through
 * the real cliApiRouter and its bearer check: a box's own credential and a
 * device sign-in both log, the project only when it is the caller's, the rate
 * limit per box, secret-shaped strings never reach the store, and there is no
 * CLI read.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import { memoryFeedback, type MemoryFeedback } from '../services/feedbackMemory';
import { FEEDBACK_PER_HOUR, type FeedbackStore } from '../services/feedback';

vi.mock('../db', () => ({ prisma: {} }));

const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const cliUser = (id: string): CliUser => ({ id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id });
const DEVICE = { alice: 'tmcli_' + 'a'.repeat(64), bob: 'tmcli_' + 'b'.repeat(64) };
const BOX_A1 = 'tmag_alice_a1';
const BOX_A2 = 'tmag_alice_a2';
const now = new Date('2026-11-13T12:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    const who = (Object.keys(DEVICE) as Array<keyof typeof DEVICE>).find(u => sha256Hex(DEVICE[u]) === hash);
    if (!who) return null;
    return { id: `s-${who}`, userId: who, user: cliUser(who), deviceName: 'mbp', tokenPrefix: 'tmcli_xxx', createdAt: now, lastUsedAt: now, revokedAt: null } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    if (raw === BOX_A1) return { user: cliUser('alice'), instanceId: 'i-a1', tokenId: 'tok-a1' };
    if (raw === BOX_A2) return { user: cliUser('alice'), instanceId: 'i-a2', tokenId: 'tok-a2' };
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

let feedback: MemoryFeedback;
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({
    store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now,
    // The route takes the store once, at mount; each test gets a fresh one behind this.
    feedback: { store: new Proxy({} as FeedbackStore, { get: (_t, k) => Reflect.get(feedback, k) }) },
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => {
  feedback = memoryFeedback(() => now);
  feedback.projects.set('p-a1', { userId: 'alice', instanceId: 'i-a1', name: 'termag' });
  feedback.threads.set('thread0001abc', 'alice');
});

const post = (token: string | null, body: unknown) => fetch(`${base}/api/cli/v1/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const said = { body: 'I wish asks showed their progress in the sidebar', kind: 'idea' };

describe('POST /api/cli/v1/feedback', () => {
  it('logs with a box token as that box, with its project, ask thread and agent', async () => {
    const r = await post(BOX_A1, { ...said, projectId: 'p-a1', workstream: 'ask-thread0001abc', agentProvider: 'claude', agentModel: 'opus', cliVersion: '0.4.1' });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: 'fb1', status: 'new', redacted: [] });
    expect(feedback.rows[0]).toMatchObject({
      reporterUserId: 'alice', credential: 'box', boxId: 'i-a1', projectId: 'p-a1', workstream: 'ask-thread0001abc',
      threadId: 'thread0001abc', agentProvider: 'claude', agentModel: 'opus', cliVersion: '0.4.1', kind: 'idea', body: said.body,
    });
  });

  it('logs with a device sign-in, taking the box from the caller\'s own project only', async () => {
    expect((await post(DEVICE.alice, { ...said, projectId: 'p-a1' })).status).toBe(201);
    expect(feedback.rows[0]).toMatchObject({ reporterUserId: 'alice', credential: 'device', boxId: 'i-a1', projectId: 'p-a1' });
    // Bob names Alice's project: kept as his feedback, without her project or box.
    expect((await post(DEVICE.bob, { ...said, projectId: 'p-a1', workstream: 'main' })).status).toBe(201);
    expect(feedback.rows[1]).toMatchObject({ reporterUserId: 'bob', boxId: null, projectId: null, workstream: null });
  });

  it('does not let a box token claim a project on another box', async () => {
    expect((await post(BOX_A2, { ...said, projectId: 'p-a1' })).status).toBe(201);
    expect(feedback.rows[0]).toMatchObject({ boxId: 'i-a2', projectId: null, threadId: null });
  });

  it('refuses a missing or unknown credential, and an empty body with the reason', async () => {
    expect((await post(null, said)).status).toBe(401);
    expect((await post('tmag_nobody', said)).status).toBe(401);
    const r = await post(BOX_A1, { body: '  ' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: 'invalid_request', error: expect.stringMatching(/body is required/) });
    expect(feedback.rows).toEqual([]);
  });

  it('redacts secret-shaped strings before storing and says so', async () => {
    const tok = `ghp_${'s'.repeat(36)}`;
    const r = await post(BOX_A1, { body: `the token ${tok} showed in the sidebar`, kind: 'problem' });
    expect(r.status).toBe(201);
    expect((await r.json()).redacted).toEqual(['GitHub token']);
    expect(JSON.stringify(feedback.rows)).not.toContain(tok);
  });

  it(`allows ${FEEDBACK_PER_HOUR} an hour per box, and forgets older ones`, async () => {
    for (let i = 0; i < FEEDBACK_PER_HOUR; i++) expect((await post(BOX_A1, said)).status).toBe(201);
    const r = await post(BOX_A1, said);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('600');
    expect(await r.json()).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/20 pieces of feedback an hour from one box/) });
    expect((await post(BOX_A2, said)).status).toBe(201);
    for (const row of feedback.rows) row.createdAt = new Date(now.getTime() - 61 * 60_000);
    expect((await post(BOX_A1, said)).status).toBe(201);
  });

  it('has no CLI read: GET is 405, pointing at the admin page', async () => {
    const r = await fetch(`${base}/api/cli/v1/feedback`, { headers: { authorization: `Bearer ${BOX_A1}` } });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
    expect(await r.json()).toMatchObject({ code: 'method_not_allowed', error: expect.stringMatching(/\/admin\/feedback/) });
  });
});
