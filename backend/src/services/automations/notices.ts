/**
 * The outbox for an automation's alerts and webhook
 * . Two kinds of row (`automation_notices`):
 *
 * - **Events** (`channel: 'event'`): `run.finished`, `run.box_unavailable`
 *   and `automation.paused`, plain data inserted in the same transaction as
 *   the state change itself (finishRunWithEvent, alerts.ts pauseAutomations).
 *   The insert is all that happens there: no lookup, no regex, no flag, no
 *   Slack, so nothing about notifications can fail the state change (and if
 *   the insert itself fails, the change is written on its own).
 * - **Sends** (`slack`, `webhook`): what delivery makes of an event
 *   (alerts.ts expandEvent: the keyword match, the target, the message), each
 *   with its own dedupe key, then sent.
 *
 * Both are delivered at once in the background and, while they have not
 * gone, again by the scheduler's sweep with backoff, so an outage or an
 * orchestrator restart delays a notice rather than losing it, and the run's
 * path never awaits a delivery.
 *
 * A row is claimed before it is sent (`nextAttemptAt` pushed past a lease,
 * `attempts` counted), so two processes or a sweep racing the first attempt
 * send it once. `dedupeKey` keeps one row per event: a report retried after
 * a failed Slack post finds its alerts already queued.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { getSlackApp } from '../../slack/app';
import { boolVariationOrUnknown } from '../featureFlags';
import { ALERTS_FLAG } from './alertsFlag';
import type { FlagBox, FlagUser } from '../featureFlags';
import { dmChannelOf, isChannelMember } from './alertChannel';
import { appBoundedClient, postMessageWithin, type BoundedPost, type BoundedSlack } from './slackPost';
import { readWebhook, SEND_DEADLINE_MS, webhookSender, type SendOutcome, type WebhookSend } from './webhook';

export type NoticeChannel = 'slack' | 'webhook' | 'event';

export interface SlackNoticePayload { target: string; text: string }

export interface NewNotice {
  automationId: string;
  runId?: string | null;
  channel: NoticeChannel;
  kind: string;
  dedupeKey: string;
  payload: SlackNoticePayload | Record<string, unknown>;
}

/** Waits after the first attempt, the second, …; the attempt after the last wait is the last one. */
export const NOTICE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000] as const;
export const MAX_NOTICE_ATTEMPTS = NOTICE_BACKOFF_MS.length + 1;
/** How long a claimed row is left alone before another process may take it (a send has its own timeout well inside this). */
const CLAIM_LEASE_MS = 2 * 60_000;

/** When the attempt after `attempts` failed ones is due, or null when there is none left. */
export function nextAttemptAfter(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_NOTICE_ATTEMPTS) return null;
  return new Date(now.getTime() + NOTICE_BACKOFF_MS[Math.max(0, attempts - 1)]);
}

/** The row a notice is written as. */
export function noticeData(n: NewNotice): Prisma.AutomationNoticeCreateManyInput {
  return { automationId: n.automationId, runId: n.runId ?? null, channel: n.channel, kind: n.kind, dedupeKey: n.dedupeKey, payload: n.payload as Prisma.InputJsonValue };
}

/** The alert settings an event is expanded against: copied from the row when the event is written, so a later edit doesn't change what an event already raised. */
export const ALERT_SETTINGS_SELECT = { alertPrefix: true, alertRegex: true, alertTarget: true, healthAlerts: true, webhookHost: true } as const;
export type AlertSettingsSnapshot = { alertPrefix: string | null; alertRegex: string | null; alertTarget: string; healthAlerts: boolean; webhookHost: string | null };

/** An event's row, for the transaction of the state change that causes it. */
export function eventData(e: Omit<NewNotice, 'channel'>): Prisma.AutomationNoticeCreateManyInput {
  return noticeData({ ...e, channel: 'event' });
}

/** The event a run's new state raises, if any: its finish, or a box_unavailable skip. */
export function runEventFor(automationId: string, runId: string, data: { state?: unknown; reason?: unknown }): Prisma.AutomationNoticeCreateManyInput | null {
  if (data.state === 'done' || data.state === 'blocked' || data.state === 'needs_input' || data.state === 'failed') {
    return eventData({ automationId, runId, kind: 'run.finished', dedupeKey: `event:run:${runId}`, payload: {} });
  }
  if (data.state === 'skipped' && data.reason === 'box_unavailable') {
    return eventData({ automationId, runId, kind: 'run.box_unavailable', dedupeKey: `event:box_unavailable:${runId}`, payload: {} });
  }
  return null;
}

/**
 * A run row's conditional state change (`where` names the state it must
 * still be in) and the event it raises, in one transaction; returns the
 * rows changed, as updateMany does. If the transaction fails, the change is
 * written on its own: no notification ever undoes or skips a run's finish.
 */
export async function finishRunWithEvent(
  run: { id: string; automationId: string },
  where: Prisma.AutomationRunWhereInput,
  data: Prisma.AutomationRunUpdateManyMutationInput,
): Promise<number> {
  const args = { where: { ...where, id: run.id }, data };
  const event = runEventFor(run.automationId, run.id, data as { state?: unknown; reason?: unknown });
  if (!event) return (await prisma.automationRun.updateMany(args)).count;
  let count: number;
  try {
    count = await prisma.$transaction(async tx => {
      const r = await tx.automationRun.updateMany(args);
      if (r.count > 0) {
        // A copy of the automation's alert settings as they are now (a row read, no lookup elsewhere).
        const settings = await tx.automation.findUnique({ where: { id: run.automationId }, select: ALERT_SETTINGS_SELECT });
        await tx.automationNotice.createMany({ data: [{ ...event, payload: { settings } as Prisma.InputJsonValue }], skipDuplicates: true });
      }
      return r.count;
    });
  } catch (err) {
    console.error(`[AUTOMATION] run ${run.id}: writing its ${event.kind} event failed (${(err as Error).message}); writing the run without it`);
    return (await prisma.automationRun.updateMany(args)).count;
  }
  if (count > 0) startDelivery([event.dedupeKey]);
  return count;
}

/**
 * Start delivering notices a committed transaction wrote, by dedupe key, in
 * the background; what doesn't go now, the sweep sends. Never throws.
 */
export function startDelivery(dedupeKeys: string[]): void {
  if (dedupeKeys.length === 0) return;
  void prisma.automationNotice.findMany({ where: { dedupeKey: { in: dedupeKeys } }, select: { id: true } })
    .then(rows => Promise.all(rows.map(r => deliverNotice(r.id))))
    .catch(err => console.warn('[AUTOMATION] could not start delivering notices:', (err as Error).message));
}

/**
 * Queue notices and start delivering them, outside any other write (the
 * informational box_unavailable alert); never throws (a notice that
 * could not be written is logged, and the run goes on). Resolves once the
 * rows are written, to whether every one is now queued (written now or
 * before); the delivery is not awaited.
 */
export async function enqueueNotices(notices: NewNotice[]): Promise<boolean> {
  let all = true;
  for (const n of notices) {
    try {
      const row = await prisma.automationNotice.create({
        data: { automationId: n.automationId, runId: n.runId ?? null, channel: n.channel, kind: n.kind, dedupeKey: n.dedupeKey, payload: n.payload as Prisma.InputJsonValue },
        select: { id: true },
      });
      void deliverNotice(row.id).catch(err => console.warn(`[AUTOMATION] notice ${row.id} failed:`, (err as Error).message));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // already queued
      console.warn(`[AUTOMATION] could not queue the ${n.kind} notice for ${n.automationId}:`, (err as Error).message);
      all = false;
    }
  }
  return all;
}

/** `sent`: the outcome is a Slack post's or a webhook call's, not a check before one (the flag, a removed webhook). */
type Outcome = SendOutcome & { sent?: boolean };

type NoticeOwner = FlagUser & { slackUserId: string | null };

export interface NoticeDeps {
  slack: (payload: SlackNoticePayload, owner: { id: string; slackUserId: string | null; googleEmail: string }, projectChannel: string | null) => Promise<Outcome>;
  webhook: WebhookSend;
  readWebhook: typeof readWebhook;
  /** automation-alerts-enabled for the owner and box at delivery; null when the flag source could not say. */
  alertsOn: (owner: FlagUser, box: FlagBox | null) => Promise<boolean | null>;
  /** An event's sends (alerts.ts expandEvent); throws when it can't tell, and the event is tried again. */
  expand: (e: { automationId: string; runId: string | null; kind: string; payload: unknown }) => Promise<NewNotice[]>;
}

/**
 * What a bounded post comes to. One stopped at its deadline is not tried
 * again: Slack may have posted it, and a second try would post it twice
 * (slackPost.ts). It is given up and shown as the last failed send.
 */
export function slackOutcome(r: BoundedPost, target: SlackNoticePayload['target']): Outcome {
  if (r.ok) return { ok: true };
  if ('noChannel' in r) return { ok: false, error: target === 'dm' ? 'the bot has no Slack user for the owner' : 'the project has no Slack channel', retry: false };
  if (r.deadline) {
    return r.maybePosted ? { ok: false, error: `${r.error}; not tried again, since it may have posted`, retry: false } : { ok: false, error: r.error, retry: true };
  }
  // The channel is wrong or the bot can't post there: another try won't change that.
  const fatal = r.code === 'channel_not_found' || r.code === 'not_in_channel' || r.code === 'is_archived' || r.code === 'invalid_channel'
    || r.code === OWNER_NOT_IN_CHANNEL || r.code === OWNER_UNKNOWN;
  return { ok: false, error: r.error, retry: !fatal };
}

/** The owner's DM (alertChannel.ts): null only when Slack has no user for them; a lookup that failed throws and is retried. */
export { dmChannelOf };

const OWNER_NOT_IN_CHANNEL = 'owner_not_in_channel';
const OWNER_UNKNOWN = 'owner_unknown';

function ownerRefusal(code: string, message: string): Error {
  // Slack's error shape, so postMessageWithin reports the code and slackOutcome gives the notice up.
  return Object.assign(new Error(message), { data: { error: code } });
}

/**
 * A channel-id target, checked again at every post: the owner must still be
 * a member (alertChannel.ts isChannelMember). The save checks it too, but
 * only when the target changes, and an owner can leave the channel after;
 * without this the bot would keep posting a summary they steer into a
 * channel they are no longer in. Not a member, or no Slack user to check, is
 * given up and shown as the last failed send; a lookup that fails for a
 * moment throws Slack's error and is retried.
 */
export async function ownedChannelOf(client: Pick<BoundedSlack, 'users' | 'conversations'>, owner: { id: string; slackUserId: string | null; googleEmail: string }, channel: string): Promise<string> {
  const me = await dmChannelOf(client, owner);
  if (!me) throw ownerRefusal(OWNER_UNKNOWN, `termag can't find the owner's Slack user, so it can't check they are still in ${channel}`);
  if (!(await isChannelMember(client, channel, me))) throw ownerRefusal(OWNER_NOT_IN_CHANNEL, `the owner is no longer a member of ${channel}`);
  return channel;
}

/**
 * Post to the target: the owner's DM, the project's channel, or a channel id,
 * within SEND_DEADLINE_MS in all, the DM's lookup included (postMessageWithin).
 */
async function postSlack(payload: SlackNoticePayload, owner: { id: string; slackUserId: string | null; googleEmail: string }, projectChannel: string | null): Promise<Outcome> {
  const client = getSlackApp()?.client;
  const bounded = client ? appBoundedClient(client) : null;
  if (!client || !bounded) return { ok: false, error: 'Slack is not configured', retry: true };
  const channelOf = (c: BoundedSlack) => payload.target === 'dm' ? dmChannelOf(c, owner)
    : payload.target === 'project' ? projectChannel
      : ownedChannelOf(c, owner, payload.target);
  return slackOutcome(await postMessageWithin(SEND_DEADLINE_MS, bounded, channelOf, { text: payload.text, unfurl_links: false, unfurl_media: false }), payload.target);
}

const defaultDeps: NoticeDeps = {
  slack: postSlack, webhook: webhookSender(), readWebhook,
  alertsOn: (owner, box) => boolVariationOrUnknown(ALERTS_FLAG, owner, false, box),
  // Loaded when first needed: alerts.ts builds on this module.
  expand: async e => (await import('./alerts')).expandEvent(e),
};

function hostOf(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

/** What one attempt of a notice comes to, before the row is written. */
async function attempt(
  n: { id: string; automationId: string; runId: string | null; kind: string; channel: string; payload: unknown; automation: { id: string; userId: string; webhookHost: string | null; project: { slackChannelId: string | null; user: NoticeOwner; instance: FlagBox | null } } },
  now: Date, deps: NoticeDeps,
): Promise<Outcome> {
  // Checked at delivery, not only at enqueue: a notice queued before the flag
  // went off is dropped, not sent. A flag that can't be evaluated waits.
  const on = await deps.alertsOn(n.automation.project.user, n.automation.project.instance);
  if (on === null) return { ok: false, error: 'automation-alerts-enabled could not be evaluated', retry: true };
  if (!on) return { ok: false, error: 'automation-alerts-enabled is off', retry: false };
  if (n.channel === 'event') {
    // Fan the event out into its sends, each with its own dedupe key, and start them.
    let sends: NewNotice[];
    try {
      sends = await deps.expand(n);
      if (sends.length) await prisma.automationNotice.createMany({ data: sends.map(noticeData), skipDuplicates: true });
    } catch (err) {
      return { ok: false, error: `the ${n.kind} event could not be expanded: ${(err as Error).message}`, retry: true };
    }
    startDelivery(sends.map(x => x.dedupeKey));
    return { ok: true };
  }
  if (n.channel === 'slack') return { ...await deps.slack(n.payload as SlackNoticePayload, n.automation.project.user, n.automation.project.slackChannelId), sent: true };
  // The row says whether there is a webhook; the credential store only holds it.
  if (!n.automation.webhookHost) return { ok: false, error: 'the webhook was removed', retry: false };
  let hook: Awaited<ReturnType<typeof readWebhook>>;
  try {
    hook = await deps.readWebhook(n.automation.userId, n.automation.id);
  } catch (err) {
    // No store, or the database or KMS failing: an outage, not a removal.
    return { ok: false, error: `the webhook could not be read: ${(err as Error).message}`, retry: true };
  }
  if (!hook) return { ok: false, error: 'the webhook was removed', retry: false };
  // Fail closed when the credential and the row disagree (a rollback raced a
  // newer save): never send to a receiver the automation no longer names.
  if (hostOf(hook.url) !== n.automation.webhookHost) return { ok: false, error: "the webhook's stored URL is not the automation's", retry: true };
  return { ...await deps.webhook(hook.url, hook.secret, JSON.stringify(n.payload), n.id, now), sent: true };
}

/** Each channel's last-failure columns (constants: the only identifiers spliced into noteSend's SQL). */
const ERROR_COLUMNS = {
  slack: { error: Prisma.raw('"lastSlackError"'), at: Prisma.raw('"lastSlackErrorAt"') },
  webhook: { error: Prisma.raw('"lastWebhookError"'), at: Prisma.raw('"lastWebhookErrorAt"') },
} as const;

/**
 * Keep each channel's last failed send (`Automation.lastSlackError` / `lastSlackErrorAt` and
 * `lastWebhookError` / `lastWebhookErrorAt`, shown by `termag automation show` and the full UI),
 * cleared only by the next send on the same channel that goes: a webhook that answers can't hide
 * Slack alerts that have stopped, nor the other way round. Raw SQL so the write leaves `updatedAt`
 * alone: it names a pause's episode and is where a never-run schedule catches up from.
 * Never throws: the notice is already written either way.
 */
async function noteSend(automationId: string, channel: string, outcome: Outcome, finishedAt: Date): Promise<void> {
  if (!outcome.sent || (channel !== 'slack' && channel !== 'webhook')) return;
  const col = ERROR_COLUMNS[channel];
  // A channel's sends can run side by side (two runs' Slack alerts), so the
  // newest outcome wins, whichever is written last: each write is one
  // conditional UPDATE on the time its send finished. A success keeps that
  // time with the error cleared, so a failure that finished before it but is
  // written after can't bring it back.
  try {
    const error = outcome.ok ? null : outcome.error.slice(0, 500);
    await prisma.$executeRaw(Prisma.sql`UPDATE "automations" SET ${col.error} = ${error}, ${col.at} = ${finishedAt} WHERE "id" = ${automationId} AND (${col.at} IS NULL OR ${col.at} < ${finishedAt})`);
  } catch (err) {
    console.warn(`[AUTOMATION] could not note the last send for ${automationId}:`, (err as Error).message);
  }
}

/** Deliver one notice if it is due and unclaimed. Never throws. Returns whether it went. */
export async function deliverNotice(id: string, now: Date = new Date(), deps: NoticeDeps = defaultDeps): Promise<boolean> {
  try {
    const claimed = await prisma.automationNotice.updateMany({
      where: { id, deliveredAt: null, failedAt: null, nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return false;
    const n = await prisma.automationNotice.findUnique({
      where: { id },
      include: {
        automation: {
          select: {
            id: true, userId: true, webhookHost: true,
            project: {
              select: {
                slackChannelId: true,
                user: { select: { id: true, slackUserId: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } },
                instance: { select: { id: true, name: true, kind: true } },
              },
            },
          },
        },
      },
    });
    if (!n) return false;
    const outcome = await attempt(n, now, deps);
    const finishedAt = new Date();
    if (outcome.ok) {
      await prisma.automationNotice.update({ where: { id }, data: { deliveredAt: new Date(), lastError: null } });
      await noteSend(n.automationId, n.channel, outcome, finishedAt);
      return true;
    }
    const next = outcome.retry ? nextAttemptAfter(n.attempts, now) : null;
    await prisma.automationNotice.update({
      where: { id },
      data: next ? { nextAttemptAt: next, lastError: outcome.error.slice(0, 500) } : { failedAt: now, lastError: outcome.error.slice(0, 500) },
    });
    await noteSend(n.automationId, n.channel, outcome, finishedAt);
    console.warn(`[AUTOMATION] ${n.kind} notice for ${n.automationId} not delivered (attempt ${n.attempts}): ${outcome.error}${next ? '' : '; giving up'}`);
    return false;
  } catch (err) {
    console.warn(`[AUTOMATION] notice ${id} failed:`, (err as Error).message);
    return false;
  }
}

/** Delivered or abandoned notices are kept this long, for a look at what went where, then deleted. */
export const NOTICE_KEEP_MS = 30 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
let lastPrunedAt = 0;

let sweeping: Promise<number> | null = null;

/**
 * The scheduler's step, detached: starts a sweep unless the last one is
 * still running, and returns at once, so a slow receiver can never hold the
 * scheduler's tick (and with it every automation's timeouts and starts).
 * Returns whether it started one.
 */
export function startNoticeSweep(now: Date = new Date(), deps: NoticeDeps = defaultDeps): boolean {
  if (sweeping) return false;
  sweeping = deliverDueNotices(now, deps)
    .catch(err => { console.error('[AUTOMATION] notice sweep failed:', (err as Error).message); return 0; })
    .finally(() => { sweeping = null; });
  return true;
}

/** Tests: the sweep in flight, if any. */
export function noticeSweepInFlight(): Promise<number> | null {
  return sweeping;
}

/** How many notices the sweep sends at once, and how long it starts new ones for: a slow receiver must not hold the scheduler's tick. */
export const SWEEP_CONCURRENCY = 5;
export const SWEEP_BUDGET_MS = 20_000;
const SWEEP_BATCH = 50;

/**
 * The scheduler's step: the notices that are due again, and the old ones
 * pruned. Leader work, one pass a minute. Sends SWEEP_CONCURRENCY at a time
 * and starts none after SWEEP_BUDGET_MS, so a sweep takes at most about the
 * budget plus one send's timeout; what it leaves is due on the next tick.
 */
export async function deliverDueNotices(now: Date = new Date(), deps: NoticeDeps = defaultDeps, clock: () => number = Date.now): Promise<number> {
  if (now.getTime() - lastPrunedAt >= PRUNE_EVERY_MS) {
    lastPrunedAt = now.getTime();
    await prisma.automationNotice.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - NOTICE_KEEP_MS) }, OR: [{ deliveredAt: { not: null } }, { failedAt: { not: null } }] } });
  }
  const due = await prisma.automationNotice.findMany({
    where: { deliveredAt: null, failedAt: null, nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: SWEEP_BATCH,
    select: { id: true },
  });
  const deadline = clock() + SWEEP_BUDGET_MS;
  const queue = due.map(d => d.id);
  let sent = 0;
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined && clock() < deadline; id = queue.shift()) {
      if (await deliverNotice(id, now, deps)) sent++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, queue.length) }, worker));
  return sent;
}
