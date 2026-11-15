import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => {
  const p: Record<string, any> = {
    user: { update: vi.fn(async () => ({})) },
    automationNotice: { create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    automationRun: { updateMany: vi.fn() },
    automation: { findUnique: vi.fn(async () => ({ alertPrefix: 'BLOCKER:', alertRegex: null, alertTarget: 'dm', healthAlerts: true, webhookHost: null })) },
  };
  p.$executeRaw = vi.fn(async () => 1);
  p.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(p));
  return p;
});
vi.mock('../../db', () => ({ prisma }));
vi.mock('../../slack/app', () => ({ getSlackApp: () => null }));

import { deliverDueNotices, deliverNotice, enqueueNotices, finishRunWithEvent, noticeSweepInFlight, startNoticeSweep, slackOutcome, dmChannelOf, ownedChannelOf, MAX_NOTICE_ATTEMPTS, nextAttemptAfter, SWEEP_BUDGET_MS, SWEEP_CONCURRENCY, type NoticeDeps } from './notices';

const now = new Date('2026-11-09T10:00:00Z');
const owner = { id: 'u1', slackUserId: 'U1', googleEmail: 'me@example.com', displayName: 'Me', unixUsername: 'me', defaultAgentProvider: 'claude' };
const box = { id: 'box1', name: 'box-1', kind: 'box' };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'n1', automationId: 'a1', runId: null, kind: 'keyword', channel: 'slack', attempts: 1, payload: { target: 'dm', text: 'hi' },
  automation: { id: 'a1', userId: 'u1', webhookHost: 'hooks.example.com', project: { slackChannelId: 'C-proj', user: owner, instance: box } },
  ...over,
});
const deps = (over: Partial<NoticeDeps> = {}): NoticeDeps => ({
  slack: vi.fn(async () => ({ ok: true as const })),
  webhook: vi.fn(async () => ({ ok: true as const })),
  readWebhook: vi.fn(async () => ({ url: 'https://hooks.example.com/x', secret: 'whsec_x' })),
  alertsOn: vi.fn(async () => true),
  expand: vi.fn(async () => []),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.automationNotice.updateMany.mockResolvedValue({ count: 1 });
  prisma.automationNotice.update.mockResolvedValue({});
  prisma.automationNotice.deleteMany.mockResolvedValue({ count: 0 });
  prisma.automationNotice.createMany.mockResolvedValue({ count: 0 });
  prisma.automationNotice.findMany.mockResolvedValue([]);
  prisma.automationRun.updateMany.mockResolvedValue({ count: 1 });
});

describe('startNoticeSweep', () => {
  it('starts a sweep and returns at once; a second while it runs starts none', async () => {
    let release!: () => void;
    prisma.automationNotice.findMany.mockReturnValueOnce(new Promise(resolve => { release = () => resolve([]); }));
    expect(startNoticeSweep(now, deps())).toBe(true);
    expect(startNoticeSweep(now, deps())).toBe(false);
    release();
    await noticeSweepInFlight();
    expect(startNoticeSweep(now, deps())).toBe(true);
    await noticeSweepInFlight();
  });
});

describe('finishRunWithEvent', () => {
  it('writes the finish and its run.finished event in one transaction, plain data only', async () => {
    expect(await finishRunWithEvent({ id: 'r1', automationId: 'a1' }, { state: 'running' }, { state: 'done', finishedAt: now })).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.automationRun.updateMany).toHaveBeenCalledWith({ where: { state: 'running', id: 'r1' }, data: { state: 'done', finishedAt: now } });
    expect(prisma.automationNotice.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      channel: 'event', kind: 'run.finished', runId: 'r1', dedupeKey: 'event:run:r1',
      // The alert settings as they were at the finish: what delivery expands against.
      payload: { settings: { alertPrefix: 'BLOCKER:', alertRegex: null, alertTarget: 'dm', healthAlerts: true, webhookHost: null } },
    })], skipDuplicates: true });
  });

  it('a box_unavailable skip raises its own event; another skip raises none and needs no transaction', async () => {
    await finishRunWithEvent({ id: 'r1', automationId: 'a1' }, { state: 'pending' }, { state: 'skipped', reason: 'box_unavailable' });
    expect(prisma.automationNotice.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ kind: 'run.box_unavailable', dedupeKey: 'event:box_unavailable:r1' })], skipDuplicates: true });
    vi.clearAllMocks();
    prisma.automationRun.updateMany.mockResolvedValue({ count: 1 });
    await finishRunWithEvent({ id: 'r1', automationId: 'a1' }, { state: 'pending' }, { state: 'skipped', reason: 'missed' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.automationNotice.createMany).not.toHaveBeenCalled();
  });

  it('no event when the row had moved on, and a failed event insert never undoes the finish: it is written on its own', async () => {
    prisma.automationRun.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await finishRunWithEvent({ id: 'r1', automationId: 'a1' }, { state: 'running' }, { state: 'done' })).toBe(0);
    expect(prisma.automationNotice.createMany).not.toHaveBeenCalled();
    prisma.automationNotice.createMany.mockRejectedValueOnce(new Error('db down'));
    expect(await finishRunWithEvent({ id: 'r1', automationId: 'a1' }, { state: 'running' }, { state: 'failed', reason: 'timeout' })).toBe(1);
    expect(prisma.automationRun.updateMany).toHaveBeenLastCalledWith({ where: { state: 'running', id: 'r1' }, data: { state: 'failed', reason: 'timeout' } });
  });
});

describe('delivering an event', () => {
  const event = () => row({ channel: 'event', kind: 'run.finished', runId: 'r1', payload: {} });

  it('fans it out into its sends (written with their own dedupe keys), and the event is done', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(event());
    const send = { automationId: 'a1', runId: 'r1', channel: 'slack' as const, kind: 'keyword', dedupeKey: 'r1:keyword', payload: { target: 'dm', text: 'hi' } };
    const d = deps({ expand: vi.fn(async () => [send]) });
    expect(await deliverNotice('n1', now, d)).toBe(true);
    expect(d.expand).toHaveBeenCalledWith(expect.objectContaining({ kind: 'run.finished', runId: 'r1' }));
    expect(prisma.automationNotice.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ channel: 'slack', dedupeKey: 'r1:keyword' })], skipDuplicates: true });
    expect(d.slack).not.toHaveBeenCalled();
  });

  it('an expansion that fails (a lookup, the regex worker) is tried again later', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(event());
    await deliverNotice('n1', now, deps({ expand: vi.fn(async () => { throw new Error('db down'); }) }));
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { nextAttemptAt: new Date(now.getTime() + 60_000), lastError: 'the run.finished event could not be expanded: db down' } });
  });

  it('with the flag off, the event is dropped unexpanded', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(event());
    const d = deps({ alertsOn: vi.fn(async () => false) });
    await deliverNotice('n1', now, d);
    expect(d.expand).not.toHaveBeenCalled();
  });
});

describe('nextAttemptAfter', () => {
  it('backs off, then gives up', () => {
    expect(nextAttemptAfter(1, now)).toEqual(new Date(now.getTime() + 60_000));
    expect(nextAttemptAfter(2, now)).toEqual(new Date(now.getTime() + 5 * 60_000));
    expect(nextAttemptAfter(MAX_NOTICE_ATTEMPTS, now)).toBeNull();
  });
});

describe('deliverNotice', () => {
  it('claims the row before sending, and marks it delivered', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(row());
    const d = deps();
    expect(await deliverNotice('n1', now, d)).toBe(true);
    expect(prisma.automationNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'n1', deliveredAt: null, failedAt: null, nextAttemptAt: { lte: now } } }));
    expect(d.slack).toHaveBeenCalledWith({ target: 'dm', text: 'hi' }, owner, 'C-proj');
    expect(prisma.automationNotice.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: expect.objectContaining({ deliveredAt: expect.any(Date) }) });
  });

  it('sends nothing when another process holds the claim', async () => {
    prisma.automationNotice.updateMany.mockResolvedValue({ count: 0 });
    const d = deps();
    expect(await deliverNotice('n1', now, d)).toBe(false);
    expect(d.slack).not.toHaveBeenCalled();
  });

  it('signs and posts a webhook notice with its own id as the delivery id', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook', kind: 'run.done', payload: { event: 'run.done' } }));
    const d = deps();
    expect(await deliverNotice('n1', now, d)).toBe(true);
    expect(d.webhook).toHaveBeenCalledWith('https://hooks.example.com/x', 'whsec_x', '{"event":"run.done"}', 'n1', now);
  });

  it('a failure that may pass is tried again later; one that will not, or the last attempt, gives up', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook', attempts: 2 }));
    await deliverNotice('n1', now, deps({ webhook: vi.fn(async () => ({ ok: false, error: 'answered 503', retry: true })) }));
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { nextAttemptAt: new Date(now.getTime() + 5 * 60_000), lastError: 'answered 503' } });

    await deliverNotice('n1', now, deps({ webhook: vi.fn(async () => ({ ok: false, error: 'answered 410', retry: false })) }));
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { failedAt: now, lastError: 'answered 410' } });

    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook', attempts: MAX_NOTICE_ATTEMPTS }));
    await deliverNotice('n1', now, deps({ webhook: vi.fn(async () => ({ ok: false, error: 'answered 503', retry: true })) }));
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { failedAt: now, lastError: 'answered 503' } });
  });

  it("keeps each channel's last failed send in its own columns, cleared by that channel's next success, and leaves updatedAt alone", async () => {
    /** What each raw write ran: [sql, ...values] (a Prisma.Sql, `?` for each value). */
    const writes = () => prisma.$executeRaw.mock.calls.map(([q]: [{ sql: string; values: unknown[] }]) => [q.sql, ...q.values]);
    prisma.automationNotice.findUnique.mockResolvedValue(row());
    await deliverNotice('n1', now, deps({ slack: vi.fn(async () => ({ ok: false, error: 'not_in_channel', retry: false })) }));
    expect(writes()).toEqual([[
      'UPDATE "automations" SET "lastSlackError" = ?, "lastSlackErrorAt" = ? WHERE "id" = ? AND ("lastSlackErrorAt" IS NULL OR "lastSlackErrorAt" < ?)',
      'not_in_channel', expect.any(Date), 'a1', expect.any(Date),
    ]]);

    prisma.$executeRaw.mockClear();
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook' }));
    await deliverNotice('n1', now, deps());
    expect(writes()).toEqual([[
      'UPDATE "automations" SET "lastWebhookError" = ?, "lastWebhookErrorAt" = ? WHERE "id" = ? AND ("lastWebhookErrorAt" IS NULL OR "lastWebhookErrorAt" < ?)',
      null, expect.any(Date), 'a1', expect.any(Date),
    ]]);
    expect(writes()[0][0]).not.toContain('updatedAt');
  });

  it('per channel, the send that finished last wins whichever is written last, and one channel never clears the other', async () => {
    // The conditional UPDATEs, run against one row as Postgres would.
    const stored: Record<'Slack' | 'Webhook', { error: string | null; at: Date | null }> = { Slack: { error: null, at: null }, Webhook: { error: null, at: null } };
    prisma.$executeRaw.mockImplementation(async (q: { sql: string; values: unknown[] }) => {
      const col = stored[/"last(Slack|Webhook)Error"/.exec(q.sql)![1] as 'Slack' | 'Webhook'];
      const [error, at] = q.values as [string | null, Date];
      if (col.at !== null && !(col.at < at)) return 0;
      Object.assign(col, { error, at });
      return 1;
    });
    const at = (iso: string) => vi.setSystemTime(new Date(iso));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const slackFails = deps({ slack: vi.fn(async () => ({ ok: false, error: 'not_in_channel', retry: false })) });
      const slackRow = row();
      const hookRow = row({ channel: 'webhook' });
      prisma.automationNotice.findUnique.mockResolvedValue(slackRow);
      at('2026-11-10T10:00:02Z'); await deliverNotice('n1', now, deps()); // a success that finished at :02
      at('2026-11-10T10:00:01Z'); await deliverNotice('n1', now, slackFails); // a failure that finished at :01, written after it
      expect(stored.Slack.error).toBeNull();
      at('2026-11-10T10:00:03Z'); await deliverNotice('n1', now, slackFails);
      expect(stored.Slack).toEqual({ error: 'not_in_channel', at: new Date('2026-11-10T10:00:03Z') });
      at('2026-11-10T10:00:02.500Z'); await deliverNotice('n1', now, deps()); // an older success can't clear a newer failure
      expect(stored.Slack.error).toBe('not_in_channel');

      // The reviewed case: the webhook's next run.done goes, and Slack's failure stays.
      prisma.automationNotice.findUnique.mockResolvedValue(hookRow);
      at('2026-11-10T10:00:05Z'); await deliverNotice('n1', now, deps());
      expect(stored.Slack.error).toBe('not_in_channel');
      at('2026-11-10T10:00:06Z'); await deliverNotice('n1', now, deps({ webhook: vi.fn(async () => ({ ok: false, error: 'answered 503', retry: true })) }));
      prisma.automationNotice.findUnique.mockResolvedValue(slackRow);
      at('2026-11-10T10:00:07Z'); await deliverNotice('n1', now, deps()); // Slack goes again: only its own failure clears
      expect(stored.Slack.error).toBeNull();
      expect(stored.Webhook.error).toBe('answered 503');
    } finally {
      vi.useRealTimers();
      prisma.$executeRaw.mockImplementation(async () => 1);
    }
  });

  it('a Slack post stopped at its deadline is given up, not tried again: it may have posted', () => {
    expect(slackOutcome({ ok: false, deadline: true, maybePosted: true, error: 'Slack did not answer within 10 s' }, 'dm')).toEqual({ ok: false, error: 'Slack did not answer within 10 s; not tried again, since it may have posted', retry: false });
    // Stopped in the DM's lookup, before the post: nothing went, so it is tried again.
    expect(slackOutcome({ ok: false, deadline: true, maybePosted: false, error: 'Slack did not answer within 10 s' }, 'dm')).toMatchObject({ retry: true });
    expect(slackOutcome({ ok: false, noChannel: true }, 'dm')).toEqual({ ok: false, error: 'the bot has no Slack user for the owner', retry: false });
    expect(slackOutcome({ ok: false, deadline: false, error: 'not_in_channel', code: 'not_in_channel' }, 'C1')).toMatchObject({ retry: false });
    expect(slackOutcome({ ok: false, deadline: false, error: 'ECONNRESET', code: null }, 'C1')).toMatchObject({ retry: true });
    expect(slackOutcome({ ok: true }, 'C1')).toEqual({ ok: true });
  });

  it('notes no send for an event, the flag off, or a removed webhook, and a failed note never fails the delivery', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'event', kind: 'run.finished' }));
    await deliverNotice('n1', now, deps());
    prisma.automationNotice.findUnique.mockResolvedValue(row());
    await deliverNotice('n1', now, deps({ alertsOn: vi.fn(async () => false) }));
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook' }));
    await deliverNotice('n1', now, deps({ readWebhook: vi.fn(async () => null) }));
    expect(prisma.$executeRaw).not.toHaveBeenCalled();

    prisma.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    prisma.automationNotice.findUnique.mockResolvedValue(row());
    expect(await deliverNotice('n1', now, deps())).toBe(true);
  });

  it('gives up on a webhook that was removed since: no credential, or the row no longer names one', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook' }));
    await deliverNotice('n1', now, deps({ readWebhook: vi.fn(async () => null) }));
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { failedAt: now, lastError: 'the webhook was removed' } });
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook', automation: { ...row().automation, webhookHost: null } }));
    const d = deps();
    await deliverNotice('n1', now, d);
    expect(d.readWebhook).not.toHaveBeenCalled();
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { failedAt: now, lastError: 'the webhook was removed' } });
  });

  it('retries a credential it could not read (store, database or KMS down): an outage is not a removal', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook' }));
    const d = deps({ readWebhook: vi.fn(async () => { throw new Error('KMS throttled'); }) });
    await deliverNotice('n1', now, d);
    expect(d.webhook).not.toHaveBeenCalled();
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { nextAttemptAt: new Date(now.getTime() + 60_000), lastError: 'the webhook could not be read: KMS throttled' } });
  });

  it('never sends to a stored URL whose host is not the one the automation names (a rollback raced a newer save)', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook', automation: { ...row().automation, webhookHost: 'new.example.com' } }));
    const d = deps();
    await deliverNotice('n1', now, d);
    expect(d.webhook).not.toHaveBeenCalled();
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { nextAttemptAt: expect.any(Date), lastError: "the webhook's stored URL is not the automation's" } });
  });

  it('drops a queued notice once the flag is off for the owner, and waits when the flag source cannot say', async () => {
    prisma.automationNotice.findUnique.mockResolvedValue(row({ channel: 'webhook' }));
    const off = deps({ alertsOn: vi.fn(async () => false) });
    await deliverNotice('n1', now, off);
    expect(off.alertsOn).toHaveBeenCalledWith(owner, box);
    expect(off.webhook).not.toHaveBeenCalled();
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { failedAt: now, lastError: 'automation-alerts-enabled is off' } });
    const unknown = deps({ alertsOn: vi.fn(async () => null) });
    await deliverNotice('n1', now, unknown);
    expect(unknown.webhook).not.toHaveBeenCalled();
    expect(prisma.automationNotice.update).toHaveBeenLastCalledWith({ where: { id: 'n1' }, data: { nextAttemptAt: expect.any(Date), lastError: 'automation-alerts-enabled could not be evaluated' } });
  });

  it('never throws', async () => {
    prisma.automationNotice.updateMany.mockRejectedValue(new Error('db down'));
    await expect(deliverNotice('n1', now, deps())).resolves.toBe(false);
  });
});

describe('enqueueNotices', () => {
  it('writes each notice, skips one already queued, and never throws', async () => {
    prisma.automationNotice.create
      .mockResolvedValueOnce({ id: 'n1' })
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }))
      .mockRejectedValueOnce(new Error('db down'));
    prisma.automationNotice.updateMany.mockResolvedValue({ count: 0 });
    const n = { automationId: 'a1', channel: 'slack' as const, kind: 'keyword', payload: { target: 'dm', text: 'hi' } };
    // The duplicate is already queued; the one that failed to write is not, so not everything is.
    await expect(enqueueNotices([{ ...n, dedupeKey: 'r1:keyword' }, { ...n, dedupeKey: 'r1:keyword' }, { ...n, dedupeKey: 'r2:keyword' }])).resolves.toBe(false);
    expect(prisma.automationNotice.create).toHaveBeenCalledTimes(3);
  });
});

describe('deliverDueNotices', () => {
  it('sends a few at a time and starts none past its time budget', async () => {
    prisma.automationNotice.findMany.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })));
    prisma.automationNotice.findUnique.mockResolvedValue(row());
    let live = 0;
    let peak = 0;
    const slack = vi.fn(async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return { ok: true as const }; });
    expect(await deliverDueNotices(now, deps({ slack }))).toBe(12);
    expect(peak).toBe(SWEEP_CONCURRENCY);
    let t = 0;
    const clock = () => (t += SWEEP_BUDGET_MS / 3);
    const late = vi.fn(async () => ({ ok: true as const }));
    await deliverDueNotices(now, deps({ slack: late }), clock);
    expect(late.mock.calls.length).toBeLessThan(12);
  });

  it('delivers what is due and prunes old finished rows', async () => {
    prisma.automationNotice.findMany.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);
    prisma.automationNotice.findUnique.mockResolvedValue(row());
    // Pruning runs at most hourly; a sweep an hour after the last one prunes.
    expect(await deliverDueNotices(new Date(now.getTime() + 2 * 60 * 60_000), deps())).toBe(2);
    expect(prisma.automationNotice.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ createdAt: { lt: expect.any(Date) } }) }));
  });
});

describe('dmChannelOf', () => {
  const owner = { id: 'u1', slackUserId: null, googleEmail: 'me@example.com' };
  const slackError = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
  const users = (lookup: () => Promise<unknown>) => ({ users: { lookupByEmail: vi.fn(lookup) } }) as never;

  it('uses the linked id, else finds the owner by email and links them', async () => {
    expect(await dmChannelOf(users(async () => { throw new Error('not called'); }), { ...owner, slackUserId: 'U1' })).toBe('U1');
    expect(await dmChannelOf(users(async () => ({ user: { id: 'U2' } })), owner)).toBe('U2');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { slackUserId: 'U2' } });
  });

  it('is null only when Slack says there is no such user; any other failure throws, so the post is retried', async () => {
    expect(await dmChannelOf(users(async () => { throw slackError('users_not_found'); }), owner)).toBeNull();
    await expect(dmChannelOf(users(async () => { throw slackError('ratelimited'); }), owner)).rejects.toThrow('ratelimited');
    await expect(dmChannelOf(users(async () => { throw new Error('socket hang up'); }), owner)).rejects.toThrow('socket hang up');
  });
});

describe('ownedChannelOf', () => {
  const owner = { id: 'u1', slackUserId: 'U-me', googleEmail: 'me@example.com' };
  const slackError = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
  /** Members paged two at a time. */
  const client = (members: string[] | Error) => ({
    users: { lookupByEmail: vi.fn(async () => ({ user: {} })) },
    conversations: {
      members: vi.fn(async ({ cursor }: { cursor?: string }) => {
        if (members instanceof Error) throw members;
        const from = cursor ? Number(cursor) : 0;
        return { members: members.slice(from, from + 2), response_metadata: { next_cursor: from + 2 < members.length ? String(from + 2) : '' } };
      }),
    },
  }) as never;

  it('posts to a channel the owner is still in, across pages', async () => {
    expect(await ownedChannelOf(client(['U-a', 'U-bot', 'U-me']), owner, 'C1')).toBe('C1');
  });

  it('refuses, and the notice is given up, once the owner has left or has no Slack user to check', async () => {
    const left = await ownedChannelOf(client(['U-bot', 'U-a']), owner, 'C1').catch(e => e);
    expect(left).toMatchObject({ message: 'the owner is no longer a member of C1', data: { error: 'owner_not_in_channel' } });
    expect(slackOutcome({ ok: false, deadline: false, error: left.message, code: left.data.error }, 'C1')).toMatchObject({ retry: false });
    const unknown = await ownedChannelOf(client(['U-me']), { ...owner, slackUserId: null }, 'C1').catch(e => e);
    expect(unknown).toMatchObject({ data: { error: 'owner_unknown' } });
    expect(slackOutcome({ ok: false, deadline: false, error: unknown.message, code: unknown.data.error }, 'C1')).toMatchObject({ retry: false });
  });

  it("a members read that fails for a moment throws Slack's error, and the post is retried", async () => {
    const err = await ownedChannelOf(client(slackError('ratelimited')), owner, 'C1').catch(e => e);
    expect(err).toMatchObject({ data: { error: 'ratelimited' } });
    expect(slackOutcome({ ok: false, deadline: false, error: err.message, code: 'ratelimited' }, 'C1')).toMatchObject({ retry: true });
  });
});
