/**
 * How a run ends: the chat relay hands this module
 * every chat event it accepts; for a workstream that is a run, the `result`
 * event's text, cost and session id are remembered and the `turn-end`
 * finishes the row. Nothing else marks a run done: the scheduler's timeout
 * is the only other path, and it checks the state before writing.
 *
 * A second turn in the same chat (a person replying to a finished run from
 * the simple UI) also ends with turn-end; a row already finished is left
 * alone, so the person's follow-up never rewrites the run's report.
 *
 * The notes push to a space is a different matter: it follows every
 * turn-end of a run whose row is finished, whoever finished it. The timeout
 * sweep and Stop fail the row first and interrupt second, so their
 * turn-end arrives at a row that is already final; the notes the turn wrote
 * before the interrupt still go up. A follow-up turn's end pushes the file
 * again, which is the same file (or newer) and harmless. With space
 * folders on, the state file goes with the notes, and the run's log goes
 * to runs/<name>.md, ahead of the report. For the turn-end's own finish,
 * the log's and the notes' pushes take their queue places before the row
 * is final (for a row the sweep or Stop finished, the two are queued side
 * by side once it is), so the next run's pulls wait, and the log renders
 * from the final row. The row is never held `running` for the uploads.
 */
import { prisma } from '../../db';
import { noteAutomationRunActivity } from '../boxActivity';
import { onChatEvent, type ChatEventSeen } from '../chatRunner';
import { parseRunReport } from './brief';
import { automationLimitsFor } from './limits';
import { memoryDir } from './runner';
import { changesLabel, postRunReport, summarizeBranch, type BranchSummary } from './report';
import { occurrenceLabel } from './brief';
import { renderRunLog, runLogName } from './runLog';
import { folderOf } from './spaceFolder';
import { noteSpaceSyncError, pushAfterRun, pushRunLog, spaceFoldersEnabledFor, syncErrorText, type SyncTarget } from './spaceSync';
import { failureLabel } from './store';
import { skipReasonLabel } from './admit';
import * as tmux from '../tmux';

interface PendingResult {
  text: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  sessionId: string | null;
  isError: boolean;
  runnerError: string | null;
}

// project:workstreamId -> what the turn said before its turn-end. Small: one
// entry per live run. The relay vouches for the project and the box an event
// came from (chatRunner.ts handleChatFrame: only the box a project lives on
// speaks for it) but not for the workstreamId in the frame, so the key and
// the finish below both carry the project: a frame from another project's
// box naming this run's workstream touches nothing of this run's.
const pending = new Map<string, PendingResult>();
let unsubscribe: (() => void) | null = null;

/** The run this event speaks for: the relay-verified project and box, and the frame's workstream id. */
export interface RunRef { projectId: string; instanceId: string; workstreamId: string }

const pendingKey = (r: Pick<RunRef, 'projectId' | 'workstreamId'>): string => `${r.projectId}:${r.workstreamId}`;

function entry(r: RunRef): PendingResult {
  const key = pendingKey(r);
  let p = pending.get(key);
  if (!p) { p = { text: null, costUsd: null, inputTokens: null, outputTokens: null, sessionId: null, isError: false, runnerError: null }; pending.set(key, p); }
  return p;
}

/** Fold one event into what is known about its run's turn; true when the turn ended. */
export function noteEvent(seen: ChatEventSeen): boolean {
  const ev = seen.event as Record<string, unknown> | null;
  if (!ev || typeof ev !== 'object' || !seen.workstreamId) return false;
  switch (ev.type) {
    case 'system': {
      if (ev.subtype === 'init' && typeof ev.session_id === 'string') entry(seen).sessionId = ev.session_id;
      return false;
    }
    case 'result': {
      const p = entry(seen);
      if (typeof ev.result === 'string') p.text = ev.result;
      if (typeof ev.total_cost_usd === 'number') p.costUsd = ev.total_cost_usd;
      if (typeof ev.session_id === 'string') p.sessionId = ev.session_id;
      p.isError = ev.is_error === true;
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (usage) {
        if (typeof usage.input_tokens === 'number') p.inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === 'number') p.outputTokens = usage.output_tokens;
      }
      return false;
    }
    case 'runner-error': {
      entry(seen).runnerError = typeof ev.message === 'string' ? ev.message : 'the turn failed';
      return false;
    }
    case 'turn-end':
      return true;
    default:
      return false;
  }
}

/** The row's final fields from what the turn said. */
export function finishFields(p: PendingResult | undefined, exit: { lost?: boolean; exitCode?: number | null; signal?: string | null }): {
  state: string; reason: string | null; summary: string | null; prUrl: string | null;
} {
  if (p?.runnerError || (!p?.text && exit.exitCode != null && exit.exitCode !== 0)) {
    return { state: 'failed', reason: 'runner-error', summary: p?.runnerError ?? `the agent exited ${exit.signal ?? exit.exitCode}`, prUrl: null };
  }
  if (exit.signal === 'SIGINT' && !p?.text) return { state: 'failed', reason: 'interrupted', summary: null, prUrl: null };
  if (exit.lost && !p?.text) return { state: 'failed', reason: 'runner-error', summary: 'the box lost the turn', prUrl: null };
  const report = parseRunReport(p?.text);
  return { state: p?.isError ? 'failed' : report.status, reason: p?.isError ? 'runner-error' : null, summary: report.summary || null, prUrl: report.prUrl };
}

/**
 * Finish the run of this workstream, if it is still running and the event
 * came from its own project's box (a sharee's box, or any box, naming the
 * victim's workstream id must not close or fail the run, nor push its
 * notes). Exported for the scheduler's tests.
 */
export async function completeRun(ref: RunRef, exit: { lost?: boolean; exitCode?: number | null; signal?: string | null }): Promise<void> {
  const key = pendingKey(ref);
  const p = pending.get(key);
  pending.delete(key);
  const run = await findRun(ref.workstreamId);
  if (!run) return;
  if (run.automation.projectId !== ref.projectId || (run.instanceId && run.instanceId !== ref.instanceId)) {
    console.warn(`[AUTOMATION] ${run.automation.project.name}: ignored a turn-end for run ${run.id} from project ${ref.projectId} on box ${ref.instanceId}`);
    return;
  }
  // The notes go up to the space only for the run's own turn: a later
  // follow-up on the workstream may be a project sharee who is no member of
  // the space, and its end must not publish their edits as the owner. The
  // turn-end that finishes the row is the run's; a row the timeout sweep or
  // Stop finished is pushed by them (pushNotesForRun), not by the turn-end
  // their interrupt causes, which looks the same as a follow-up's.
  let finished = false;
  if (run.state === 'running') {
    const fields = finishFields(p, exit);
    const finishedAt = new Date();
    // With space folders on, the run log's push holds its queue place before
    // the row is final: the row's finishing is what lets the next run (a Run
    // now the moment after) start, and that run's pull of this log (its
    // previous-run.md) queues behind it. The push renders from the row once
    // this finish has written it, so the row is not left `running` (for the
    // timeout sweep and the next occurrence's admit) while the log uploads.
    // The notes push holds its place the same way: queued after the row is
    // final, it would leave a gap in which the next run pulls stale notes.
    let rowFinal!: (ours: boolean) => void;
    const gate = new Promise<boolean>(resolve => { rowFinal = resolve; });
    const log = await queueRunLogForRun(run.id, 0, gate);
    const notes = await queueNotesPush(run, { delayMs: 0, gate });
    try {
      finished = await finishRow(run, p, fields, finishedAt);
    } finally {
      rowFinal(finished);
    }
    await Promise.all([log.done, notes.done]);
  }
  // What the run left on its branch, and the Slack report, follow every
  // finish the same way: the timeout sweep and Stop fail the row before the
  // turn ends, and a run that timed out is the one the channel most needs to
  // hear about. reportedAt keeps a follow-up turn's end from posting twice.
  await reportRun(run.id, p);
}

type RunRow = NonNullable<Awaited<ReturnType<typeof findRun>>>;

/** The run's transfer target, if its automation is in a space and its box and owner are known. */
async function syncTargetFor(run: RunRow): Promise<SyncTarget | null> {
  const a = run.automation;
  if (!a.spaceName || !a.project.instanceId) return null;
  const box = await prisma.instance.findUnique({ where: { id: a.project.instanceId }, select: { id: true, hostHome: true, hostUnixUser: true } });
  const owner = await prisma.user.findUnique({ where: { id: a.userId }, select: { unixUsername: true } });
  if (!box || !owner) return null;
  return {
    runId: run.id, userId: a.userId, projectId: a.projectId, projectName: a.project.name, spaceName: a.spaceName, folder: folderOf(a),
    host: { userId: a.userId, instanceId: box.id }, box: { id: box.id, hostHome: box.hostHome, hostUnixUser: box.hostUnixUser ?? owner.unixUsername },
    memoryDir: memoryDir(box.hostHome ?? `/home/${owner.unixUsername}`, a.projectId),
  };
}

/** Push the run's notes file (and, with space folders on, its state) to the automation's space, if it has one. */
async function pushNotes(run: RunRow, opts: { delayMs?: number; queued?: (done: Promise<unknown>) => void; gate?: Promise<boolean> } = {}): Promise<void> {
  // A row never linked to its workstream never got past its notes pull (the
  // runner links it after the pull): Stop or the timeout sweep caught the
  // run in its setup, and the box's file is the seed, or a copy from before
  // this run. Pushing it would replace the space's notes with that.
  if (!run.workstreamId) return;
  const t = await syncTargetFor(run);
  if (!t) return;
  const folders = await spaceFoldersEnabledFor(run.automation.userId).catch(() => false);
  const error = await pushAfterRun(t, { folders, delayMs: opts.delayMs, queued: opts.queued, gate: opts.gate });
  if (folders) await noteSpaceSyncError(run.id, error);
}

/**
 * The run's notes push, queued now and run after delayMs (`gate`: as for
 * the run log). Resolves when the push holds its place; `done` when it has
 * run. Never throws.
 */
async function queueNotesPush(run: RunRow, opts: { delayMs: number; gate?: Promise<boolean> }): Promise<{ done: Promise<void> }> {
  let done: Promise<unknown> = Promise.resolve();
  await new Promise<void>(resolve => {
    const all = pushNotes(run, { ...opts, queued: d => { done = d; resolve(); } });
    all.then(() => resolve(), err => { console.warn(`[AUTOMATION] notes push for run ${run.id} failed: ${(err as Error).message}`); resolve(); });
  });
  return { done: done.then(() => undefined, () => undefined) };
}

/** What the run left on its branch, read once and kept on the row (a later follow-up turn would rewrite it with its own tree). */
async function branchSummaryOf(run: RunRow): Promise<BranchSummary> {
  const kept = { commitsAhead: run.commitsAhead, pushed: run.pushed, dirty: run.dirty };
  const a = run.automation;
  if (kept.commitsAhead !== null || kept.pushed !== null || kept.dirty !== null || !a.project.instanceId || !run.workstream) return kept;
  const cwd = tmux.projectDirFor({ name: a.project.name, user: { unixUsername: a.project.user.unixUsername }, instance: { hostHome: a.project.instance?.hostHome ?? null } }, run.workstream.name);
  return summarizeBranch({ userId: a.userId, instanceId: a.project.instanceId }, cwd);
}

/** The run log for a row as it is (or is about to be written). */
async function runLogText(run: RunRow): Promise<string> {
  const agent = run.workstreamId
    ? await prisma.workflow.findFirst({ where: { workstreamId: run.workstreamId, type: 'agent' }, select: { provider: true, model: true } }).catch(() => null)
    : null;
  const failedOrSkipped = run.state === 'failed' || run.state === 'skipped';
  const summarized = run.commitsAhead !== null || run.pushed !== null || run.dirty !== null;
  return renderRunLog({
    automationName: run.automation.project.name, logName: runLogName(run), occurrenceLabel: occurrenceLabel(run.scheduledFor, run.automation.timezone),
    trigger: run.trigger, provider: agent?.provider ?? null, model: agent?.model ?? null, state: run.state,
    reasonLabel: failedOrSkipped && run.reason ? (run.state === 'skipped' ? skipReasonLabel(run.reason) : failureLabel(run.reason)) : null,
    summary: run.summary, workstream: run.workstream?.name ?? null, branch: run.branch, prUrl: run.prUrl,
    changes: summarized ? changesLabel({ commitsAhead: run.commitsAhead, pushed: run.pushed, dirty: run.dirty }) : null,
    costUsd: run.costUsd, inputTokens: run.inputTokens, outputTokens: run.outputTokens, startedAt: run.startedAt, finishedAt: run.finishedAt,
    spaceSyncError: run.spaceSyncError ? syncErrorText(run.spaceSyncError) : null,
  });
}

/** The run's transfer target when its log goes to the space: in a space, folders on, and linked to its workstream (past its pull). */
async function runLogTarget(run: RunRow): Promise<SyncTarget | null> {
  if (!run.workstreamId || !run.automation.spaceName) return null;
  if (!(await spaceFoldersEnabledFor(run.automation.userId).catch(() => false))) return null;
  return syncTargetFor(run);
}

/**
 * A run's log, queued now: for a run the timeout sweep or Stop finished,
 * beside its notes push (the row is already final, so the next run may
 * start and ask for this log at once); for the turn-end's own finish, just
 * before the row is written (`gate`: whether that finish was this run's,
 * awaited in the queue). Written after delayMs from the row as it is then.
 * Resolves when the push holds its place; `done` when it has run. Never
 * throws.
 */
async function queueRunLogForRun(runId: string, delayMs: number, gate?: Promise<boolean>): Promise<{ done: Promise<void> }> {
  let done: Promise<unknown> = Promise.resolve();
  try {
    const run = await findRunById(runId);
    const t = run ? await runLogTarget(run) : null;
    if (run && t) {
      const render = async (): Promise<string | null> => {
        if (gate && !(await gate)) return null;
        const now = await findRunById(runId);
        if (!now || now.state === 'running' || now.state === 'pending') return null;
        const changes = await branchSummaryOf(now);
        await prisma.automationRun.update({ where: { id: runId }, data: changes }).catch(() => {});
        return runLogText({ ...now, ...changes });
      };
      await new Promise<void>(resolve => {
        pushRunLog(t, runLogName(run), render, { delayMs, queued: d => { done = d; resolve(); } })
          .then(error => noteSpaceSyncError(runId, error))
          .then(() => resolve(), err => { console.warn(`[AUTOMATION] run log for run ${runId} failed: ${(err as Error).message}`); resolve(); });
      });
    }
  } catch (err) {
    console.warn(`[AUTOMATION] run log for run ${runId} failed: ${(err as Error).message}`);
  }
  return { done: done.then(() => undefined, () => undefined) };
}

/**
 * The notes push for a run the timeout sweep or Stop finished: they own
 * that end, so they call this once the interrupt has had a moment to stop
 * the turn's writes. Never throws.
 */
export async function pushNotesForRun(runId: string): Promise<void> {
  try {
    const run = await prisma.automationRun.findUnique({
      where: { id: runId },
      include: { automation: { include: { project: { select: { name: true, userId: true, instanceId: true } } } } },
    });
    if (run) await pushNotes(run as RunRow);
  } catch (err) {
    console.warn(`[AUTOMATION] notes push for run ${runId} failed: ${(err as Error).message}`);
  }
}

/**
 * The timeout sweep's and Stop's push: queued now, so the next run's pull
 * (which the same scheduler tick may start) waits for it, and run after
 * delayMs, once the interrupt has stopped the turn's writes. Resolves when
 * the push holds its place in the queue; `done` when it has run. Never throws.
 */
export async function queueNotesPushForRun(runId: string, delayMs: number): Promise<{ done: Promise<void> }> {
  try {
    const run = await prisma.automationRun.findUnique({
      where: { id: runId },
      include: { automation: { include: { project: { select: { name: true, userId: true, instanceId: true } } } } },
    });
    if (run) return await queueNotesPush(run as RunRow, { delayMs });
  } catch (err) {
    console.warn(`[AUTOMATION] notes push for run ${runId} failed: ${(err as Error).message}`);
  }
  return { done: Promise.resolve() };
}

/**
 * What the timeout sweep and Stop do for a run they ended: the notes push
 * takes its queue place now (so the next run's pull waits for it) and runs
 * after delayMs, once the interrupt has stopped the turn's writes; the
 * report follows both the push and that delay. The branch summary is kept
 * the first time it is taken, so taking it while the turn was still writing
 * would have recorded in-flight dirty or unpushed state for good. The
 * interrupt's turn-end usually reports first (reportRun posts once); a box
 * that is gone never sends one, and this is what reports then. Resolves once
 * the push is queued; never throws.
 */
export async function settleInterruptedRun(runId: string, delayMs: number): Promise<void> {
  const { done } = await queueNotesPushForRun(runId, delayMs);
  const log = await queueRunLogForRun(runId, delayMs);
  const settled = new Promise(r => setTimeout(r, delayMs));
  void Promise.all([done, log.done, settled])
    .then(() => reportRun(runId))
    .catch(err => console.warn(`[AUTOMATION] report for run ${runId} failed: ${(err as Error).message}`));
}

const RUN_INCLUDE = {
  automation: { include: { project: { select: { name: true, userId: true, instanceId: true, slackChannelId: true, instance: { select: { hostHome: true } }, user: { select: { unixUsername: true } } } } } },
  workstream: { select: { name: true } },
} as const;

function findRun(workstreamId: string) {
  return prisma.automationRun.findUnique({ where: { workstreamId }, include: RUN_INCLUDE });
}

function findRunById(id: string) {
  return prisma.automationRun.findUnique({ where: { id }, include: RUN_INCLUDE });
}

/** Write the run's final fields and the automation's failure count, if the row is still running; true when this call did. */
async function finishRow(run: RunRow, p: PendingResult | undefined, fields: ReturnType<typeof finishFields>, finishedAt: Date): Promise<boolean> {
  const updated = await prisma.automationRun.updateMany({
    where: { id: run.id, state: 'running' },
    data: {
      state: fields.state, reason: fields.reason, summary: fields.summary, prUrl: fields.prUrl, finishedAt,
      chatSessionId: p?.sessionId ?? run.chatSessionId, costUsd: p?.costUsd ?? null, inputTokens: p?.inputTokens ?? null, outputTokens: p?.outputTokens ?? null,
    },
  });
  if (updated.count === 0) return false;
  // The run's end is the box in use, as its start was: the idle window counts from here.
  await noteAutomationRunActivity(run.instanceId, finishedAt);
  const a = run.automation;
  const failed = fields.state === 'failed';
  if (failed) {
    const user = await prisma.user.findUnique({ where: { id: a.userId }, select: { id: true, unixUsername: true, googleEmail: true, displayName: true, defaultAgentProvider: true } });
    const box = a.project.instanceId ? await prisma.instance.findUnique({ where: { id: a.project.instanceId }, select: { id: true, name: true, kind: true } }) : null;
    const limits = user ? await automationLimitsFor(user, box) : null;
    const failures = a.consecutiveFailures + 1;
    const pause = limits ? failures >= limits.pauseAfterFailures : false;
    await prisma.automation.update({
      where: { id: a.id },
      data: { consecutiveFailures: failures, ...(pause ? { pausedReason: 'consecutive_failures' } : {}) },
    });
    if (pause) console.warn(`[AUTOMATION] ${a.project.name}: paused after ${failures} failed runs`);
  } else if (a.consecutiveFailures !== 0) {
    await prisma.automation.update({ where: { id: a.id }, data: { consecutiveFailures: 0 } });
  }
  console.log(`[AUTOMATION] ${a.project.name} ${run.scheduledFor.toISOString()} → ${fields.state}${fields.reason ? ` (${fields.reason})` : ''}`);
  return true;
}

/**
 * The branch summary and the Slack report for a finished run, read back
 * from the row so a row the timeout sweep or Stop finished reports what it
 * says (`failed: timeout`), not what this turn's frames said. Once per run:
 * reportedAt is claimed before the post, so two callers (a follow-up
 * turn-end while the branch state is still being read, a retried frame,
 * the sweep and the turn-end) cannot both post; a post that fails gives the
 * claim back. Exported for the paths with no turn-end to wait for: a launch
 * that failed, and a timeout or Stop whose interrupt never comes back.
 */
export async function reportRun(runId: string, p?: PendingResult | undefined): Promise<void> {
  const run = await prisma.automationRun.findUnique({
    where: { id: runId },
    include: { automation: { include: { project: { select: { name: true, instanceId: true, slackChannelId: true, repoUrl: true, instance: { select: { hostHome: true } }, user: { select: { unixUsername: true } } } } } }, workstream: { select: { name: true } } },
  });
  if (!run || run.state === 'running' || run.state === 'pending' || run.reportedAt) return;
  const a = run.automation;
  // The branch is summarized once, when the run's own end is reported: a
  // later follow-up turn would otherwise rewrite Changes with its own tree.
  let changes = { commitsAhead: run.commitsAhead, pushed: run.pushed, dirty: run.dirty };
  const summarized = run.commitsAhead !== null || run.pushed !== null || run.dirty !== null;
  if (!summarized && a.project.instanceId && run.workstream) {
    const cwd = tmux.projectDirFor({ name: a.project.name, user: { unixUsername: a.project.user.unixUsername }, instance: { hostHome: a.project.instance?.hostHome ?? null } }, run.workstream.name);
    changes = await summarizeBranch({ userId: a.userId, instanceId: a.project.instanceId }, cwd);
    await prisma.automationRun.update({ where: { id: run.id }, data: changes }).catch(() => {});
  }
  // The run's end is reported once, whether or not there is anywhere to post
  // it: a run that finished with Slack off (or no channel yet) is claimed as
  // reported all the same, so a later follow-up turn, or opting in after the
  // run, never posts a report for it.
  const claimed = await prisma.automationRun.updateMany({ where: { id: run.id, reportedAt: null }, data: { reportedAt: new Date() } });
  if (claimed.count === 0) return;
  if (!a.notifySlack || !a.project.slackChannelId) return;
  const posted = await postRunReport(a.project.slackChannelId, {
    projectId: a.projectId, projectName: a.project.name, repoUrl: a.project.repoUrl,
    run: { state: run.state, reason: run.reason, summary: run.summary, prUrl: run.prUrl, scheduledFor: run.scheduledFor, costUsd: run.costUsd ?? p?.costUsd ?? null, workstream: run.workstream?.name ?? null },
    occurrenceLabel: occurrenceLabel(run.scheduledFor, a.timezone), changes, base: null,
  });
  if (!posted) await prisma.automationRun.update({ where: { id: run.id }, data: { reportedAt: null } }).catch(() => {});
}

/** Subscribe to the chat relay. Every process does this: completion is event-driven, not leader work. */
export function startAutomationCompletion(): void {
  if (unsubscribe) return;
  unsubscribe = onChatEvent(seen => {
    if (!noteEvent(seen)) return;
    const ev = seen.event as { exitCode?: number | null; signal?: string | null; lost?: boolean };
    completeRun(seen, { exitCode: ev.exitCode ?? null, signal: ev.signal ?? null, lost: ev.lost === true })
      .catch(err => console.error('[AUTOMATION] completion failed:', (err as Error).message));
  });
}

export function stopAutomationCompletion(): void {
  unsubscribe?.();
  unsubscribe = null;
  pending.clear();
}

/** Tests. */
export function pendingResultFor(projectId: string, workstreamId: string): PendingResult | undefined {
  return pending.get(pendingKey({ projectId, workstreamId }));
}
