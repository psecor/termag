/**
 * Automation rows as the routes answer them: the
 * automation with its project's name, box and schedule, its runs with the
 * words a row shows. Reads only; writes live with the scheduler and the
 * completion listener.
 */
import type { Automation, AutomationRun, Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { skipReasonLabel } from './admit';
import { changesLabel } from './report';
import { nextOccurrences } from './schedule';
import { mainAgentRow, modelView } from './model';
import { folderOf } from './spaceFolder';

export const LIVE_RUN_STATES = ['pending', 'running'] as const;
export const FINISHED_RUN_STATES = ['done', 'blocked', 'needs_input', 'failed'] as const;

export interface RunView {
  id: string;
  automationId: string;
  trigger: string;
  scheduledFor: string;
  state: string;
  reason: string | null;
  /** The reason in words, for a skipped or failed row. */
  reasonLabel: string | null;
  workstreamId: string | null;
  /** The run's workstream name, when its worktree still exists. */
  workstream: string | null;
  instanceId: string | null;
  chatSessionId: string | null;
  summary: string | null;
  branch: string | null;
  prUrl: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  commitsAhead: number | null;
  pushed: boolean | null;
  dirty: boolean | null;
  /** "3 commits, pushed" / "no changes" / null before the run ended. */
  changesLabel: string | null;
  reportedAt: string | null;
  /** Why the space step was skipped or failed for this run; null when it synced or there is no space. */
  spaceSyncError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  /** Seconds the run took, or has taken so far. */
  durationSec: number | null;
}

type SendError = { error: string; at: string };

function sendError(error: string | null, at: Date | null): SendError | null {
  return error && at ? { error, at: at.toISOString() } : null;
}

type AlertErrorColumns = {
  lastSlackError: string | null; lastSlackErrorAt: Date | null;
  lastWebhookError: string | null; lastWebhookErrorAt: Date | null;
  /** The single error these replaced (`Slack: …` / `webhook: …`): still on rows from before them, and still written by an old orchestrator during an overlapping deploy. */
  lastAlertError: string | null; lastAlertErrorAt: Date | null;
};

const LEGACY_PREFIX = { slack: 'Slack: ', webhook: 'webhook: ' } as const;

/**
 * One channel's last failure: the newer of its own column and the legacy
 * single error, when the legacy one names this channel. The channel's own At
 * is set by a success too, so a legacy failure counts only when it is newer
 * than the channel's last outcome of either kind: a failure from before the
 * per-channel columns, or a fresh one an old orchestrator writes during an
 * overlapping deploy (deploys run `db push`, so no backfill runs), shows, and
 * a stale one can't come back after a newer success or hide a newer failure.
 */
function channelError(channel: keyof typeof LEGACY_PREFIX, error: string | null, at: Date | null, a: AlertErrorColumns): SendError | null {
  const own = sendError(error, at);
  const legacy = a.lastAlertError;
  const prefix = LEGACY_PREFIX[channel];
  if (!legacy?.startsWith(prefix) || !a.lastAlertErrorAt) return own;
  if (at && a.lastAlertErrorAt <= at) return own;
  return sendError(legacy.slice(prefix.length), a.lastAlertErrorAt);
}

export function alertErrorsView(a: AlertErrorColumns): Pick<AutomationView, 'lastAlertErrors' | 'lastAlertError'> {
  const slack = channelError('slack', a.lastSlackError, a.lastSlackErrorAt, a);
  const webhook = channelError('webhook', a.lastWebhookError, a.lastWebhookErrorAt, a);
  const newer = slack && (!webhook || slack.at >= webhook.at) ? { error: `Slack: ${slack.error}`, at: slack.at } : webhook ? { error: `webhook: ${webhook.error}`, at: webhook.at } : null;
  return { lastAlertErrors: { slack, webhook }, lastAlertError: newer };
}

export interface AutomationView {
  id: string;
  projectId: string;
  projectName: string;
  instanceId: string | null;
  repoUrl: string | null;
  defaultBranch: string | null;
  schedule: string;
  timezone: string;
  prompt: string;
  /** chat (a chat-runner turn per run) or t3 (a T3 scheduled task's webhook per run). */
  kind: string;
  /** The T3 task a t3 automation starts; null for chat. */
  t3TaskId: string | null;
  tier: string;
  enabled: boolean;
  prOnChange: boolean;
  wakeBox: boolean;
  maxRunMinutes: number;
  keepRuns: number;
  spaceName: string | null;
  /** The folder of spaceName the automation lives in; null with no space. */
  spaceFolder: string | null;
  notifySlack: boolean;
  /** Keyword alert (alerts.ts): a run whose summary starts with alertPrefix or matches alertRegex pings alertTarget. */
  alertPrefix: string | null;
  alertRegex: string | null;
  /** dm (the owner's Slack DM), project (the project's channel) or a Slack channel id. */
  alertTarget: string;
  /** Pauses (with their cause) and box_unavailable streaks go to alertTarget. */
  healthAlerts: boolean;
  /** The outbound webhook's host; its URL and secret are never shown again after the save that set them. */
  webhook: { host: string } | null;
  /** What the next run starts on (model.ts): main's agent row; backend null is Claude's default, model a tier or null for Sonnet. */
  chatProvider: string | null;
  backend: string | null;
  model: string | null;
  pausedReason: string | null;
  consecutiveFailures: number;
  /** Wakes of its box EC2 refused in a row, since when, and the last error; null while its starts take. */
  boxStartFailures: { count: number; since: string | null; lastError: string | null } | null;
  /** Each channel's last failed alert send, until a send on that channel goes; null when none is failing. */
  lastAlertErrors: { slack: SendError | null; webhook: SendError | null };
  /** The newer of the two, with its channel named (`Slack: not_in_channel`): for CLIs from before lastAlertErrors. */
  lastAlertError: SendError | null;
  nextRunAt: string | null;
  /** The next three occurrences from now, for the sidebar and the page. */
  next: string[];
  lastRun: RunView | null;
  createdAt: string;
  updatedAt: string;
  /** The viewer owns it (else it is shared with them). */
  owner: boolean;
  archived: boolean;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function runView(r: AutomationRun & { workstream?: { name: string } | null }, now: Date = new Date()): RunView {
  const started = r.startedAt?.getTime() ?? null;
  const ended = r.finishedAt?.getTime() ?? (r.state === 'running' ? now.getTime() : null);
  const failedOrSkipped = r.state === 'skipped' || r.state === 'failed';
  return {
    id: r.id, automationId: r.automationId, trigger: r.trigger, scheduledFor: r.scheduledFor.toISOString(),
    state: r.state, reason: r.reason,
    reasonLabel: failedOrSkipped && r.reason ? (r.state === 'skipped' ? skipReasonLabel(r.reason) : failureLabel(r.reason)) : null,
    workstreamId: r.workstreamId, workstream: r.workstream?.name ?? null, instanceId: r.instanceId,
    chatSessionId: r.chatSessionId, summary: r.summary, branch: r.branch, prUrl: r.prUrl,
    costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
    commitsAhead: r.commitsAhead, pushed: r.pushed, dirty: r.dirty,
    changesLabel: r.finishedAt && r.state !== 'skipped' ? changesLabel({ commitsAhead: r.commitsAhead, pushed: r.pushed, dirty: r.dirty }) : null,
    reportedAt: iso(r.reportedAt), spaceSyncError: r.spaceSyncError,
    startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), retiredAt: iso(r.retiredAt), createdAt: r.createdAt.toISOString(),
    durationSec: started !== null && ended !== null ? Math.max(0, Math.round((ended - started) / 1000)) : null,
  };
}

export function failureLabel(reason: string): string {
  switch (reason) {
    case 'timeout': return 'stopped at its time limit';
    case 'interrupted': return 'stopped by its owner';
    case 'launch': return 'could not start';
    case 'runner-error': return 'the agent exited without an answer';
    default: return reason;
  }
}

export type AutomationRow = Automation & {
  project: { name: string; instanceId: string | null; repoUrl: string | null; repoDefaultBranch: string | null; archived: boolean; userId: string };
};

export const AUTOMATION_INCLUDE = {
  project: { select: { name: true, instanceId: true, repoUrl: true, repoDefaultBranch: true, archived: true, userId: true } },
} satisfies Prisma.AutomationInclude;

export async function automationView(a: AutomationRow, viewerId: string, now: Date = new Date()): Promise<AutomationView> {
  // The newest occurrence that says something: a run, or a skip with its
  // reason (the subtitle shows "skipped: the box was asleep"). Missed
  // occurrences are backfilled in bulk and say nothing about the automation.
  const last = await prisma.automationRun.findFirst({
    where: { automationId: a.id, NOT: { state: 'skipped', reason: 'missed' } },
    orderBy: { createdAt: 'desc' },
    include: { workstream: { select: { name: true } } },
  });
  const agent = await mainAgentRow(a.projectId);
  let next: string[] = [];
  if (a.enabled && !a.pausedReason && !a.project.archived) {
    try { next = nextOccurrences(a.schedule, a.timezone, now, 3).map(d => d.toISOString()); } catch { next = []; }
  }
  return {
    id: a.id, projectId: a.projectId, projectName: a.project.name, instanceId: a.project.instanceId,
    repoUrl: a.project.repoUrl, defaultBranch: a.project.repoDefaultBranch,
    schedule: a.schedule, timezone: a.timezone, prompt: a.prompt, kind: a.kind, t3TaskId: a.t3TaskId, tier: a.tier, enabled: a.enabled,
    prOnChange: a.prOnChange, wakeBox: a.wakeBox, maxRunMinutes: a.maxRunMinutes, keepRuns: a.keepRuns,
    spaceName: a.spaceName, spaceFolder: a.spaceName ? folderOf(a) : null, notifySlack: a.notifySlack,
    alertPrefix: a.alertPrefix, alertRegex: a.alertRegex, alertTarget: a.alertTarget, healthAlerts: a.healthAlerts, webhook: a.webhookHost ? { host: a.webhookHost } : null,
    ...modelView(agent), pausedReason: a.pausedReason, consecutiveFailures: a.consecutiveFailures,
    ...alertErrorsView(a),
    boxStartFailures: a.boxStartFailures > 0 ? { count: a.boxStartFailures, since: iso(a.boxStartFailingSince), lastError: a.boxStartError } : null,
    nextRunAt: iso(a.nextRunAt), next, lastRun: last ? runView(last, now) : null,
    createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
    owner: a.userId === viewerId, archived: a.project.archived,
  };
}

/** The automations a user owns or is shared, newest first. */
export async function automationsFor(userId: string): Promise<AutomationRow[]> {
  return prisma.automation.findMany({
    where: {
      project: { archived: false, OR: [{ userId }, { shares: { some: { userId } } }] },
    },
    include: AUTOMATION_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

/** One automation the user may see, by its id or its project's id. */
export async function automationFor(userId: string, id: string): Promise<AutomationRow | null> {
  return prisma.automation.findFirst({
    where: {
      OR: [{ id }, { projectId: id }],
      project: { OR: [{ userId }, { shares: { some: { userId } } }] },
    },
    include: AUTOMATION_INCLUDE,
  });
}

export async function runsFor(automationId: string, limit = 50): Promise<RunView[]> {
  const rows = await prisma.automationRun.findMany({
    where: { automationId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 500),
    include: { workstream: { select: { name: true } } },
  });
  const now = new Date();
  return rows.map(r => runView(r, now));
}
