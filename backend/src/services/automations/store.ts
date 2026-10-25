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
  startedAt: string | null;
  finishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  /** Seconds the run took, or has taken so far. */
  durationSec: number | null;
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
  tier: string;
  enabled: boolean;
  prOnChange: boolean;
  wakeBox: boolean;
  maxRunMinutes: number;
  keepRuns: number;
  spaceName: string | null;
  notifySlack: boolean;
  pausedReason: string | null;
  consecutiveFailures: number;
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
    reportedAt: iso(r.reportedAt),
    startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), retiredAt: iso(r.retiredAt), createdAt: r.createdAt.toISOString(),
    durationSec: started !== null && ended !== null ? Math.max(0, Math.round((ended - started) / 1000)) : null,
  };
}

export function failureLabel(reason: string): string {
  switch (reason) {
    case 'timeout': return 'stopped at its time limit';
    case 'interrupted': return 'stopped by its owner';
    case 'launch': return 'could not start';
    case 'runner-error': return 'Claude exited without an answer';
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
  let next: string[] = [];
  if (a.enabled && !a.pausedReason && !a.project.archived) {
    try { next = nextOccurrences(a.schedule, a.timezone, now, 3).map(d => d.toISOString()); } catch { next = []; }
  }
  return {
    id: a.id, projectId: a.projectId, projectName: a.project.name, instanceId: a.project.instanceId,
    repoUrl: a.project.repoUrl, defaultBranch: a.project.repoDefaultBranch,
    schedule: a.schedule, timezone: a.timezone, prompt: a.prompt, tier: a.tier, enabled: a.enabled,
    prOnChange: a.prOnChange, wakeBox: a.wakeBox, maxRunMinutes: a.maxRunMinutes, keepRuns: a.keepRuns,
    spaceName: a.spaceName, notifySlack: a.notifySlack, pausedReason: a.pausedReason, consecutiveFailures: a.consecutiveFailures,
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
