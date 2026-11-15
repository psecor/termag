/**
 * An automation's alerts ("Alerts and the outbound
 * webhook"), all decided here on the orchestrator, so they arrive whether or
 * not anyone's laptop is on:
 *
 * - **Keyword alerts.** A finished run whose STATUS summary starts with the
 *   automation's `alertPrefix`, or matches its `alertRegex`, pings
 *   `alertTarget`: the owner's Slack DM, the project's channel, or a channel.
 * - **Health alerts.** Every pause the scheduler makes goes through
 *   `pauseAutomation`, which names the cause (three failed runs in a row and
 *   what the last one was, a timeout among them; the box gone; a T3 task
 *   gone), and the first `box_unavailable` skip of a streak is told too, so
 *   an automation never stops silently. On unless the owner turns
 *   `healthAlerts` off.
 * - **The webhook** (webhook.ts) gets `run.done`, `run.failed` and
 *   `automation.paused`.
 *
 * Everything here is queued in the outbox (notices.ts) and never throws: an
 * alert that cannot be sent never fails, holds up or changes a run. All of it
 * is behind automation-alerts-enabled, read for the owner and the box; off,
 * the pause itself still happens and nothing is sent.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { sessionLink, slackEscape, webBase } from '../briefing/slack';
import { occurrenceLabel } from './brief';
import { ALERT_SETTINGS_SELECT, enqueueNotices, eventData, startDelivery, type AlertSettingsSnapshot, type NewNotice } from './notices';
import { boundedRegexTest } from './boundedRegex';
import { reportableSummary, slackQuote } from './report';
import { failureLabel } from './store';
import { webhookBody, type WebhookEvent } from './webhook';


const MAX_PREFIX = 200;
const MAX_REGEX = 200;
/** A summary is at most 2000 characters (brief.ts parseRunReport); the regex never sees more. */
const MAX_MATCHED = 2000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AlertSettings {
  alertPrefix?: string | null;
  alertRegex?: string | null;
  alertTarget?: string;
  healthAlerts?: boolean;
}

/** `dm`, `project`, or a Slack channel id. */
export function isAlertTarget(v: unknown): v is string {
  return v === 'dm' || v === 'project' || (typeof v === 'string' && /^[CG][A-Z0-9]{8,20}$/.test(v));
}

/**
 * The regex an `alertRegex` stands for, or why it is refused: `source` or
 * `/source/flags` (flags among i, m, s, u). The summary it runs on is short
 * and the model's; the match itself runs in a worker with a time limit
 * (boundedRegex.ts), which is the real bound. This is the early, friendly
 * refusal of the obvious catastrophic shapes: backreferences and a
 * quantified group that itself holds a quantifier (`(a+)+`).
 */
export function compileAlertRegex(raw: string): { ok: true; regex: RegExp } | { ok: false; error: string } {
  const slashed = /^\/(.+)\/([a-z]*)$/s.exec(raw);
  const source = slashed ? slashed[1] : raw;
  const flags = slashed ? slashed[2] : '';
  if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) return { ok: false, error: 'alertRegex flags may only be i, m, s and u' };
  if (/\\[1-9]|\\k</.test(source)) return { ok: false, error: 'alertRegex may not use backreferences' };
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/.test(source)) {
    return { ok: false, error: 'alertRegex may not repeat a group that itself repeats, like (a+)+' };
  }
  try {
    return { ok: true, regex: new RegExp(source, flags) };
  } catch (err) {
    return { ok: false, error: `alertRegex is not a valid regular expression: ${(err as Error).message}` };
  }
}

/** The alert settings a create or PATCH may carry, validated; absent keys stay absent. */
export function parseAlertSettings(body: Record<string, unknown>): Parsed<AlertSettings> {
  const out: AlertSettings = {};
  if (body.alertPrefix !== undefined) {
    const v = body.alertPrefix;
    if (v !== null && (typeof v !== 'string' || v.length > MAX_PREFIX)) return { ok: false, error: `alertPrefix must be text of at most ${MAX_PREFIX} characters, or null` };
    out.alertPrefix = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  if (body.alertRegex !== undefined) {
    const v = body.alertRegex;
    if (v !== null && (typeof v !== 'string' || v.length > MAX_REGEX)) return { ok: false, error: `alertRegex must be a regular expression of at most ${MAX_REGEX} characters, or null` };
    if (typeof v === 'string' && v.trim()) {
      const compiled = compileAlertRegex(v.trim());
      if (!compiled.ok) return { ok: false, error: compiled.error };
      out.alertRegex = v.trim();
    } else {
      out.alertRegex = null;
    }
  }
  if (body.alertTarget !== undefined) {
    if (!isAlertTarget(body.alertTarget)) return { ok: false, error: 'alertTarget must be dm, project or a Slack channel id (C… or G…)' };
    out.alertTarget = body.alertTarget;
  }
  if (body.healthAlerts !== undefined) {
    if (typeof body.healthAlerts !== 'boolean') return { ok: false, error: 'healthAlerts must be true or false' };
    out.healthAlerts = body.healthAlerts;
  }
  return { ok: true, value: out };
}

/**
 * What a run's summary matched, as the alert names it (`` `BLOCKER:` `` or
 * `/re/`), or null. The regex runs off the event loop with a hard time limit
 * (boundedRegex.ts): one that runs past it is no match, and is logged.
 */
export async function keywordMatch(summary: string | null, prefix: string | null, regex: string | null): Promise<string | null> {
  if (!summary) return null;
  const text = summary.trim();
  if (prefix && text.startsWith(prefix)) return prefix;
  if (regex) {
    const compiled = compileAlertRegex(regex);
    if (!compiled.ok) return null;
    const result = await boundedRegexTest(compiled.regex.source, compiled.regex.flags, text.slice(0, MAX_MATCHED));
    if (result === 'timeout') console.warn(`[AUTOMATION] alertRegex ${regex.slice(0, 80)} ran past its time limit; taken as no match`);
    if (result === true) return regex.startsWith('/') ? regex : `/${regex}/`;
  }
  return null;
}

/** The cause of a pause in words: what the alert, the webhook and the logs say. */
export function pauseCause(reason: string, detail: { failures?: number; lastReason?: string | null; error?: string | null } = {}): string {
  switch (reason) {
    case 'consecutive_failures': {
      const last = detail.lastReason ? `; the last one ${failureLabel(detail.lastReason)}` : '';
      return `${detail.failures ?? 'several'} runs failed in a row${last}`;
    }
    case 'box_gone': return `its box is gone${detail.error ? ` (${detail.error})` : ''}`;
    default: return detail.error ? `${reason.replace(/_/g, ' ')}: ${detail.error}` : reason.replace(/_/g, ' ');
  }
}

const ALERT_INCLUDE = {
  project: {
    select: {
      name: true, instanceId: true,
      user: { select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } },
      instance: { select: { id: true, name: true, kind: true } },
    },
  },
} as const;

type AlertRow = NonNullable<Awaited<ReturnType<typeof loadAutomation>>>;

function loadAutomation(id: string) {
  return prisma.automation.findUnique({ where: { id }, include: ALERT_INCLUDE });
}

interface RunForAlert {
  id: string; state: string; reason: string | null; summary: string | null; trigger: string; scheduledFor: Date;
  startedAt: Date | null; finishedAt: Date | null; prUrl: string | null; workstream: { name: string } | null;
}

function links(a: AlertRow, run: RunForAlert | null): { run: string | null; automation: string | null } {
  const base = webBase();
  return {
    run: run?.workstream ? sessionLink(base, a.projectId, run.workstream.name) : null,
    automation: base ? `${base}/automations/${encodeURIComponent(a.projectId)}` : null,
  };
}

function linkLine(l: { run: string | null; automation: string | null }): string | null {
  const parts = [l.run ? `<${l.run}|the run>` : null, l.automation ? `<${l.automation}|the automation>` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The keyword alert's Slack text. */
export function keywordAlertText(i: { name: string; occurrence: string; matched: string; run: Pick<RunForAlert, 'id' | 'state' | 'reason' | 'summary'>; links: { run: string | null; automation: string | null } }): string {
  const lines = [
    `🔔 *${slackEscape(i.name)}* run ${slackEscape(i.occurrence)} matched \`${slackEscape(i.matched)}\` → *${i.run.state.replace('_', ' ')}*${i.run.reason ? ` (${slackEscape(i.run.reason)})` : ''}`,
    `Run \`${i.run.id}\``,
  ];
  const summary = reportableSummary(i.run.summary);
  if (summary) lines.push(slackQuote(summary));
  const l = linkLine(i.links);
  if (l) lines.push(l);
  return lines.join('\n');
}

/** The pause alert's Slack text. */
export function pauseAlertText(i: { name: string; automationId: string; cause: string; runId: string | null; links: { run: string | null; automation: string | null } }): string {
  const lines = [
    `⏸ *${slackEscape(i.name)}* is paused: ${slackEscape(i.cause)}.`,
    `No scheduled run starts until it is resumed: \`termag automation resume ${i.automationId}\`, or Resume on its page.${i.runId ? ` Last run \`${i.runId}\`.` : ''}`,
  ];
  const l = linkLine(i.links);
  if (l) lines.push(l);
  return lines.join('\n');
}

/** The box-unavailable alert's Slack text. */
export function boxUnavailableText(i: { name: string; occurrence: string; box: string | null; detail: string | null; runId: string; wakeBox: boolean; links: { run: string | null; automation: string | null } }): string {
  const box = i.box ? ` *${slackEscape(i.box)}*` : '';
  const why = i.wakeBox ? `its box${box} did not come up${i.detail ? ` (${slackEscape(i.detail)})` : ''}` : `its box${box} was asleep and Start the box is off`;
  const lines = [
    `💤 *${slackEscape(i.name)}* skipped its run ${slackEscape(i.occurrence)}: ${why}. Later runs are skipped the same way until the box is up; I won't repeat this until one runs.`,
    `Run \`${i.runId}\``,
  ];
  const l = linkLine(i.links);
  if (l) lines.push(l);
  return lines.join('\n');
}

function webhookNotice(a: AlertRow, event: WebhookEvent, dedupeKey: string, at: Date, run: RunForAlert | null, pause?: { reason: string; cause: string }): NewNotice {
  return {
    automationId: a.id, runId: run?.id ?? null, channel: 'webhook', kind: event, dedupeKey,
    payload: webhookBody({ event, at, automation: { id: a.id, projectId: a.projectId, name: a.project.name }, run, pause, links: links(a, run) }),
  };
}

const RUN_SELECT = {
  id: true, state: true, reason: true, summary: true, trigger: true, scheduledFor: true, startedAt: true, finishedAt: true, prUrl: true,
  workstream: { select: { name: true } },
} as const;

export interface PauseCause {
  /** The run that tipped it, if one did. */
  runId?: string | null;
  failures?: number;
  lastReason?: string | null;
  error?: string | null;
  /** The owner was already DMed about this pause (a box terminate's notice): the alert skips the DM. */
  ownerTold?: boolean;
  /** Other fields to write with the pause (the failure count). */
  also?: Record<string, unknown>;
}

/** What an `automation.paused` event row carries: plain data, evaluated at delivery. */
interface PausedEvent {
  reason: string;
  cause: Omit<PauseCause, 'also'>;
  /** The row's updatedAt from before the pause: names the episode in the sends' dedupe keys. */
  episode: string;
  /** pauseDmFallback's: only the owner's DM. */
  dmOnly?: boolean;
  /** When the pause was written: the webhook's `at`. */
  pausedAt?: string;
  /** The alert settings when the pause was written (expandEvent uses them over the row's current ones). */
  settings?: AlertSettingsSnapshot;
}

const pausedEventKey = (id: string, episode: string, dmOnly = false) => `event:paused:${id}:${episode}${dmOnly ? ':dm' : ''}`;

type PauseRowSnapshot = ({ updatedAt: Date } & AlertSettingsSnapshot) | null;

/**
 * An automation.paused event row from the automation's row as read with the
 * pause (its updatedAt names the episode; its alert settings are copied for
 * delivery): pure, shared by the pause and the terminate's DM fallback.
 */
function pausedEventRow(id: string, row: PauseRowSnapshot, reason: string, cause: Omit<PauseCause, 'also'>, opts: { episode?: string; dmOnly?: boolean } = {}): Prisma.AutomationNoticeCreateManyInput {
  const { updatedAt, ...settings } = row ?? { updatedAt: null };
  const episode = opts.episode ?? updatedAt?.toISOString() ?? new Date().toISOString();
  const event: PausedEvent = {
    reason, cause, episode, pausedAt: new Date().toISOString(),
    ...(row ? { settings: settings as AlertSettingsSnapshot } : {}), ...(opts.dmOnly ? { dmOnly: true } : {}),
  };
  return eventData({ automationId: id, runId: cause.runId ?? null, kind: 'automation.paused', dedupeKey: pausedEventKey(id, episode, opts.dmOnly), payload: event as unknown as Record<string, unknown> });
}

/**
 * Pause automations: the one place the scheduler, completion and the box
 * lifecycle stop one, so every cause is told the same way. In one
 * transaction, each automation still running is paused (a conditional
 * write, so one already paused, by a Run now failing on it or a racing
 * process, is neither paused nor told again) and a plain `automation.paused`
 * event row is inserted for it: no lookup, no flag, no Slack in the
 * transaction. Delivery turns the event into the health alert and the
 * webhook call (expandEvent), with retries. Should even that insert fail,
 * the pauses are written on their own: no notification ever undoes or
 * skips a pause. Returns the ids it paused (empty after such a fallback).
 */
export async function pauseAutomations(automationIds: string[], reason: string, cause: PauseCause = {}): Promise<string[]> {
  if (automationIds.length === 0) return [];
  const { also, ...told } = cause;
  try {
    const { paused, keys } = await prisma.$transaction(async tx => {
      const paused: string[] = [];
      const rows: Prisma.AutomationNoticeCreateManyInput[] = [];
      for (const id of automationIds) {
        const before = await tx.automation.findUnique({ where: { id }, select: { updatedAt: true, ...ALERT_SETTINGS_SELECT } });
        const moved = await tx.automation.updateMany({ where: { id, pausedReason: null }, data: { ...(also ?? {}), pausedReason: reason } });
        if (moved.count === 0) {
          if (also) await tx.automation.update({ where: { id }, data: also });
          continue;
        }
        paused.push(id);
        rows.push(pausedEventRow(id, before as PauseRowSnapshot, reason, told));
      }
      if (rows.length) await tx.automationNotice.createMany({ data: rows, skipDuplicates: true });
      return { paused, keys: rows.map(r => r.dedupeKey) };
    });
    for (const id of paused) console.warn(`[AUTOMATION] ${id}: paused: ${pauseCause(reason, cause)}`);
    startDelivery(keys);
    return paused;
  } catch (err) {
    console.error(`[AUTOMATION] pausing ${automationIds.join(', ')} with its event failed (${(err as Error).message}); pausing without it`);
    await prisma.automation.updateMany({ where: { id: { in: automationIds }, pausedReason: null }, data: { ...(also ?? {}), pausedReason: reason } });
    return [];
  }
}

/** pauseAutomations for one. */
export async function pauseAutomation(automationId: string, reason: string, cause: PauseCause = {}): Promise<void> {
  await pauseAutomations([automationId], reason, cause);
}

/**
 * A box terminate's fallback: its summary DM to the owner didn't go, so
 * each paused automation gets a DM-only pause event (delivery sends it to
 * the ones whose alerts go to the owner's DM). Never throws.
 */
export async function pauseDmFallback(automationIds: string[], reason: string, cause: PauseCause = {}): Promise<void> {
  const { also: _also, ...told } = cause;
  for (const id of automationIds) {
    try {
      const row = await prisma.automation.findUnique({ where: { id }, select: { updatedAt: true, ...ALERT_SETTINGS_SELECT } });
      const r = pausedEventRow(id, row as PauseRowSnapshot, reason, { ...told, ownerTold: false }, { dmOnly: true });
      await enqueueNotices([{ automationId: id, runId: r.runId ?? null, channel: 'event', kind: r.kind, dedupeKey: r.dedupeKey, payload: r.payload as Record<string, unknown> }]);
    } catch (err) {
      console.warn(`[AUTOMATION] ${id}: pause DM failed:`, (err as Error).message);
    }
  }
}

/**
 * A failed run (a failed turn, a launch that failed, a timeout, a T3 call
 * that failed): counted, and the automation paused once the count reaches
 * pauseAfterFailures. `failuresBefore` is the count the caller read.
 */
export async function noteFailedRun(automationId: string, failuresBefore: number, pauseAfterFailures: number, run: { id: string; reason: string | null }): Promise<void> {
  const failures = failuresBefore + 1;
  if (failures >= pauseAfterFailures) {
    await pauseAutomation(automationId, 'consecutive_failures', { runId: run.id, failures, lastReason: run.reason, also: { consecutiveFailures: failures } });
  } else {
    await prisma.automation.update({ where: { id: automationId }, data: { consecutiveFailures: failures } });
  }
}

// ── Delivery: an event row turned into its sends ───────────────────────

const FINISHED_STATES = ['done', 'blocked', 'needs_input', 'failed'];

/** An event row as delivery hands it over. */
export interface EventRow { automationId: string; runId: string | null; kind: string; payload: unknown }

/**
 * The sends an event comes to, built at delivery (notices.ts), where a
 * failure is retried with backoff: the keyword match (in its bounded
 * worker), the lookups and the messages. Each send keeps its own dedupe key
 * (`<run>:keyword`, `<run>:webhook:<event>`, `<id>:paused:<episode>`, …), so
 * an event expanded twice sends each once. The flag was checked by delivery
 * already. Throws when it can't tell, so the event is tried again.
 */
export async function expandEvent(e: EventRow): Promise<NewNotice[]> {
  const row = await loadAutomation(e.automationId);
  if (!row) return [];
  // Expanded against the settings the event was written with, when it carries them.
  const settings = (e.payload as { settings?: AlertSettingsSnapshot | null } | null)?.settings;
  const a: AlertRow = settings ? { ...row, ...settings } : row;
  switch (e.kind) {
    case 'run.finished': return e.runId ? runSends(a, e.runId) : [];
    case 'run.box_unavailable': return e.runId ? boxUnavailableSends(a, e.runId) : [];
    case 'automation.paused': return pauseSends(a, e.runId, e.payload as PausedEvent);
    default: return [];
  }
}

async function runSends(a: AlertRow, runId: string): Promise<NewNotice[]> {
  if (!a.alertPrefix && !a.alertRegex && !a.webhookHost) return [];
  const run = await prisma.automationRun.findUnique({ where: { id: runId }, select: RUN_SELECT });
  if (!run || !FINISHED_STATES.includes(run.state)) return [];
  const notices: NewNotice[] = [];
  const matched = await keywordMatch(run.summary, a.alertPrefix, a.alertRegex);
  if (matched) {
    notices.push({
      automationId: a.id, runId: run.id, channel: 'slack', kind: 'keyword', dedupeKey: `${run.id}:keyword`,
      payload: { target: a.alertTarget, text: keywordAlertText({ name: a.project.name, occurrence: occurrenceLabel(run.scheduledFor, a.timezone), matched, run, links: links(a, run) }) },
    });
  }
  if (a.webhookHost) {
    const event: WebhookEvent = run.state === 'failed' ? 'run.failed' : 'run.done';
    notices.push(webhookNotice(a, event, `${run.id}:webhook:${event}`, run.finishedAt ?? new Date(), run));
  }
  return notices;
}

async function pauseSends(a: AlertRow, runId: string | null, e: PausedEvent): Promise<NewNotice[]> {
  if (!a.healthAlerts && !a.webhookHost) return [];
  const words = pauseCause(e.reason, e.cause);
  const run = runId ? await prisma.automationRun.findUnique({ where: { id: runId }, select: RUN_SELECT }) : null;
  const key = `${a.id}:paused:${e.episode}`;
  const out: NewNotice[] = [];
  const health = a.healthAlerts && (e.dmOnly ? a.alertTarget === 'dm' : !(e.cause.ownerTold && a.alertTarget === 'dm'));
  if (health) {
    out.push({
      automationId: a.id, runId: run?.id ?? null, channel: 'slack', kind: 'health', dedupeKey: e.dmOnly ? `${key}:dm` : key,
      payload: { target: a.alertTarget, text: pauseAlertText({ name: a.project.name, automationId: a.id, cause: words, runId: run?.id ?? null, links: links(a, run) }) },
    });
  }
  if (a.webhookHost && !e.dmOnly) out.push(webhookNotice(a, 'automation.paused', `${key}:webhook`, e.pausedAt ? new Date(e.pausedAt) : new Date(), run, { reason: e.reason, cause: words }));
  return out;
}

/**
 * A run skipped as box_unavailable: the health alert goes for the first of
 * a streak only (the run before it, missed ones aside, was not skipped the
 * same way), so a parked box with Start the box off is said once, not every
 * occurrence.
 */
async function boxUnavailableSends(a: AlertRow, runId: string): Promise<NewNotice[]> {
  if (!a.healthAlerts) return [];
  const run = await prisma.automationRun.findUnique({ where: { id: runId }, select: { ...RUN_SELECT, createdAt: true } });
  if (!run || run.state !== 'skipped' || run.reason !== 'box_unavailable') return [];
  const before = await prisma.automationRun.findFirst({
    where: { automationId: a.id, id: { not: runId }, createdAt: { lte: run.createdAt }, NOT: [{ state: 'skipped', reason: 'missed' }, { state: { in: ['pending', 'running'] } }] },
    orderBy: { createdAt: 'desc' },
    select: { state: true, reason: true },
  });
  if (before?.state === 'skipped' && before.reason === 'box_unavailable') return [];
  return [{
    automationId: a.id, runId, channel: 'slack', kind: 'health', dedupeKey: `${runId}:box_unavailable`,
    payload: {
      target: a.alertTarget,
      text: boxUnavailableText({
        name: a.project.name, occurrence: occurrenceLabel(run.scheduledFor, a.timezone), box: a.project.instance?.name ?? null,
        detail: a.boxStartError, runId, wakeBox: a.wakeBox, links: links(a, null),
      }),
    },
  }];
}
