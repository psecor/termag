import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  collabRequest: { create: vi.fn(), findMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
  project: { findFirst: vi.fn() },
  workstream: { findFirst: vi.fn() },
}));
const slack = vi.hoisted(() => ({ client: { users: { lookupByEmail: vi.fn() } } as any }));
vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuthOrAgentToken: vi.fn() }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => true) }));
vi.mock('../services/briefing/slack', () => ({ slackIdFor: vi.fn(async () => 'USENDER1') }));
vi.mock('../slack/app', () => ({ getSlackApp: vi.fn(() => slack) }));
vi.mock('../slack/collab', () => ({
  deliverPreview: vi.fn(async () => true),
  sendRequest: vi.fn(async () => ({ ok: true, permalink: 'https://slack/p1' })),
  resolvePeople: vi.fn(async (_c: unknown, people: string[]) => ({ ids: people.map(p => (p.includes('@') ? 'UZANE001' : p)), missing: [] })),
}));
vi.mock('./spawns', () => ({ resolveCaller: vi.fn() }));

import { draftFor, requestsFor } from './collab';
import { boolVariation } from '../services/featureFlags';
import { slackIdFor } from '../services/briefing/slack';
import { getSlackApp } from '../slack/app';
import { deliverPreview, resolvePeople, sendRequest } from '../slack/collab';
import { resolveCaller } from './spawns';

const user = { id: 'u1', unixUsername: 'me', googleEmail: 'me@example.com', displayName: 'Me', slackUserId: 'USENDER1' } as unknown as Express.User;
const caller = { session: 'me-termag-slack-app-agent', projectId: 'p1', projectName: 'termag', workstream: 'slack-app', role: 'agent', instanceId: 'box1', provider: 'claude' };
const draft = { kind: 'help', ask: 'Status tests fail on the box', context: ['Started after #420'], evidence: 'Error: boom' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(boolVariation).mockResolvedValue(true);
  vi.mocked(getSlackApp).mockReturnValue(slack as never);
  vi.mocked(slackIdFor).mockResolvedValue('USENDER1');
  vi.mocked(resolveCaller).mockResolvedValue({ ok: true, value: caller } as never);
  prisma.collabRequest.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'cr1', ...data }));
  prisma.collabRequest.count.mockResolvedValue(0);
  prisma.collabRequest.deleteMany.mockResolvedValue({ count: 1 });
  prisma.workstream.findFirst.mockResolvedValue({ id: 'w1' });
});

describe('draftFor', () => {
  it('is off unless the flag is on', async () => {
    vi.mocked(boolVariation).mockResolvedValue(false);
    const r = await draftFor(user, 'box1', { ...draft, session: caller.session });
    expect(r.status).toBe(403);
    expect(prisma.collabRequest.create).not.toHaveBeenCalled();
  });

  it('stores an agent draft against its own pane and previews it, never posts it', async () => {
    const r = await draftFor(user, 'box1', { ...draft, session: caller.session });
    expect(r).toMatchObject({ status: 201, body: { id: 'cr1', state: 'draft' } });
    expect(resolveCaller).toHaveBeenCalledWith(user, caller.session, 'box1');
    expect(prisma.collabRequest.create.mock.calls[0][0].data).toMatchObject({
      userId: 'u1', kind: 'help', projectId: 'p1', workstream: 'slack-app', fromSession: caller.session, fromRole: 'agent',
      origin: 'agent', toChannel: 'project', toPeople: [],
    });
    expect(deliverPreview).toHaveBeenCalledWith('cr1');
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('ignores send:true from an agent: only the person can send', async () => {
    await draftFor(user, 'box1', { ...draft, session: caller.session, send: true });
    expect(sendRequest).not.toHaveBeenCalled();
    expect(deliverPreview).toHaveBeenCalled();
  });

  it('needs the agent pane itself, not a ctrl pane or no session', async () => {
    expect((await draftFor(user, 'box1', draft)).status).toBe(400);
    vi.mocked(resolveCaller).mockResolvedValue({ ok: true, value: { ...caller, role: 'ctrl' } } as never);
    expect((await draftFor(user, 'box1', { ...draft, session: 'me-termag-slack-app-ctrl' })).status).toBe(400);
  });

  it('refuses drafts with secret-shaped text before storing anything', async () => {
    const r = await draftFor(user, 'box1', { ...draft, session: caller.session, evidence: 'ghp_' + 'a'.repeat(36) });
    expect(r).toMatchObject({ status: 400, body: { code: 'secret' } });
    expect(prisma.collabRequest.create).not.toHaveBeenCalled();
  });

  it('resolves emails to Slack ids and reports people it cannot find', async () => {
    await draftFor(user, 'box1', { ...draft, session: caller.session, to: { people: ['zane@example.com'] } });
    expect(prisma.collabRequest.create.mock.calls[0][0].data).toMatchObject({ toChannel: null, toPeople: ['UZANE001'] });
    vi.mocked(resolvePeople).mockResolvedValueOnce({ ids: [], missing: ['nobody@example.com'] });
    const r = await draftFor(user, 'box1', { ...draft, session: caller.session, to: { people: ['nobody@example.com'] } });
    expect(r.status).toBe(400);
  });

  it('needs Slack, and a Slack account for the sender', async () => {
    vi.mocked(getSlackApp).mockReturnValue(null as never);
    expect((await draftFor(user, 'box1', { ...draft, session: caller.session })).status).toBe(503);
    vi.mocked(getSlackApp).mockReturnValue(slack as never);
    vi.mocked(slackIdFor).mockResolvedValue(null);
    expect((await draftFor(user, 'box1', { ...draft, session: caller.session })).body).toMatchObject({ code: 'no_slack' });
  });

  it('sends the web form at once with send:true, as the sender', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'p1' });
    const r = await draftFor(user, undefined, { ...draft, projectId: 'p1', workstream: 'slack-app', send: true });
    expect(r).toMatchObject({ status: 201, body: { state: 'open', permalink: 'https://slack/p1' } });
    expect(prisma.collabRequest.create.mock.calls[0][0].data).toMatchObject({ origin: 'web', fromSession: null });
    // The web caller is the owner already (its session), so the Slack-id link is not re-checked.
    expect(sendRequest).toHaveBeenCalledWith('cr1', 'USENDER1', { authenticatedSender: true });
  });

  it('checks the web form project is the user\'s own', async () => {
    prisma.project.findFirst.mockResolvedValue(null);
    expect((await draftFor(user, undefined, { ...draft, projectId: 'other' })).status).toBe(404);
  });
});

describe('draftFor guards', () => {
  it('caps drafts per user per hour', async () => {
    prisma.collabRequest.count.mockResolvedValue(20);
    const r = await draftFor(user, 'box1', { ...draft, session: caller.session });
    expect(r).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    expect(prisma.collabRequest.create).not.toHaveBeenCalled();
  });

  it('refuses a web draft for a workstream that does not exist', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'p1' });
    prisma.workstream.findFirst.mockResolvedValue(null);
    const r = await draftFor(user, undefined, { ...draft, projectId: 'p1', workstream: 'nope', send: true });
    expect(r.status).toBe(404);
    expect(prisma.collabRequest.create).not.toHaveBeenCalled();
  });

  it('drops the row when a web send fails before posting, so no unsendable draft is left', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 'p1' });
    vi.mocked(sendRequest).mockResolvedValueOnce({ ok: false, error: 'Slack refused it: channel_not_found' });
    const r = await draftFor(user, undefined, { ...draft, projectId: 'p1', send: true });
    expect(r).toMatchObject({ status: 502, body: { error: 'Slack refused it: channel_not_found' } });
    expect(prisma.collabRequest.deleteMany).toHaveBeenCalledWith({ where: { id: 'cr1', state: 'draft' } });
  });
});

describe('requestsFor', () => {
  it('is behind the flag too', async () => {
    vi.mocked(boolVariation).mockResolvedValue(false);
    expect((await requestsFor(user, 'box1', caller.session)).status).toBe(403);
    expect(prisma.collabRequest.findMany).not.toHaveBeenCalled();
  });

  it('lists the calling workstream\'s requests with their replies, newest first', async () => {
    prisma.collabRequest.findMany.mockResolvedValue([{
      id: 'cr1', kind: 'help', ask: 'x', state: 'open', workstream: 'slack-app', permalink: null, sentAt: null, resolvedAt: null,
      createdAt: new Date(0), toPeople: [], responses: [{ id: 'r1', responderName: 'Zane', responderSlackId: 'UZ', text: 'try y', source: 'thread', createdAt: new Date(0) }],
    }]);
    const r = await requestsFor(user, 'box1', caller.session);
    expect(prisma.collabRequest.findMany.mock.calls[0][0].where).toEqual({ userId: 'u1', projectId: 'p1', workstream: 'slack-app', state: { not: 'canceled' } });
    expect((r.body as any).requests[0].responses[0]).toMatchObject({ from: 'Zane', text: 'try y' });
  });
});
