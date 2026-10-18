/**
 * Running a briefing: a one-shot tmux session on
 * one of the owner's boxes whose only process is deploy/termag-briefing. That
 * wrapper fetches the job, runs `claude -p` with the MetaTerm read tools
 * (registered and pre-approved at user scope on every reconciled box), and
 * posts the result back with the box's agent token. The backend holds no
 * model credential; inference goes the way the owner's Claude already goes.
 *
 * Never starts a stopped box or claims a warm one for a briefing: no box
 * ready means the row is `skipped`, and the scheduler retries later that day.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { instanceAgentTransport, isInstanceAgentConnected, sendToInstanceAgent } from '../agentRegistry';
import { RUNNER_AGENT_CAPABILITY, runnerBoxes, tmuxSafe } from '../claudeRunnerSpawn';
import { parseBriefingContent, scrubProjectIds } from './content';
import { buildLedger } from './ledger';
import { ledgerCacheKey, peekLedger } from './ledgerCache';
import { previousDone, visibleProjects } from './store';
import type { BriefingResultBody, Ledger, LedgerTotals } from './types';
import { BRIEFING_AGENT_CAPABILITY } from './types';
import { resolveWindow } from './window';

/** A run that has not reported back by then is marked failed. */
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;

export type Trigger = 'manual' | 'schedule' | 'slack';

export interface BriefingBox {
  id: string;
  kind: string;
  status: string;
  name: string;
  hostHome: string | null;
  hostUnixUser: string | null;
  lastConnectedAt: Date | null;
  connected: boolean;
  capable: boolean;
}

export function briefingSessionName(hostUnixUser: string, briefingId: string): string {
  // The fixed `-r` tail keeps it from parsing as a project's agent/ctrl pane
  // (status.ts parseSessionName), like the runner sessions.
  return `${tmuxSafe(hostUnixUser)}-briefing-${tmuxSafe(briefingId)}-r`;
}

export function briefingLaunch(hostHome: string, hostUnixUser: string, briefingId: string) {
  const home = hostHome.replace(/\/+$/, '');
  return {
    sessionName: briefingSessionName(hostUnixUser, briefingId),
    command: [`${home}/.local/bin/termag-briefing`, briefingId],
    cwd: `${home}/.termag/briefing`,
    gitInit: false as const,
  };
}

/** Why no box could take the run, in words the card and the DM show. */
export function noBoxReason(candidates: BriefingBox[]): string {
  if (candidates.length === 0) return 'You have no box that is running. Start or add one, and the next run will use it.';
  const reachable = runnerBoxes(candidates.map(b => ({ ...b, capable: true })));
  if (reachable.length === 0) return 'None of your boxes is running with its agent connected right now.';
  return 'Your boxes are running an older termag. The briefing works once a box updates (it does so on its own, or run termag-box-update on it).';
}

async function candidateBoxes(userId: string): Promise<BriefingBox[]> {
  const rows = await prisma.instance.findMany({
    where: { userId, kind: 'ec2', status: 'ready' },
    select: { id: true, kind: true, status: true, name: true, hostHome: true, hostUnixUser: true, lastConnectedAt: true },
  });
  return rows.map(b => {
    const caps = instanceAgentTransport(b.id)?.capabilities ?? [];
    return {
      ...b,
      connected: isInstanceAgentConnected(b.id),
      capable: caps.includes(RUNNER_AGENT_CAPABILITY) && caps.includes(BRIEFING_AGENT_CAPABILITY),
    };
  });
}

export interface StartInput {
  user: { id: string };
  trigger: Trigger;
  tz: string;
  deliverSlack?: boolean;
  scheduleKey?: string | null;
  now?: Date;
}

export type StartOutcome =
  | { kind: 'started' | 'skipped' | 'failed' | 'already_running'; id: string }
  | { kind: 'duplicate' };

/**
 * Create a briefing row and launch it. One run at a time per user: a run
 * still inside its timeout is returned instead of starting another. The check
 * and the insert hold a per-user advisory lock, so two starts at once ("Run
 * now" beside Slack's "Run again" or the scheduler, on any process) cannot
 * both pass the check. A lock rather than a partial unique index, which
 * `prisma db push` cannot express and would drop.
 */
export async function startBriefing(input: StartInput): Promise<StartOutcome> {
  const now = input.now ?? new Date();
  const window = resolveWindow({ now, tz: input.tz, previous: await previousDone(input.user.id) });
  const boxes = await candidateBoxes(input.user.id);
  const box = runnerBoxes(boxes)[0] as BriefingBox | undefined;

  let row;
  try {
    row = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`briefing:${input.user.id}`}))`;
      const running = await tx.briefing.findFirst({
        where: { userId: input.user.id, status: 'running', createdAt: { gt: new Date(now.getTime() - RUN_TIMEOUT_MS) } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (running) return { alreadyRunning: running.id } as const;
      return tx.briefing.create({
        data: {
          userId: input.user.id,
          trigger: input.trigger,
          status: box ? 'running' : 'skipped',
          error: box ? null : noBoxReason(boxes),
          since: new Date(window.since),
          until: new Date(window.until),
          tz: window.tz,
          windowLabel: window.label,
          windowBasis: window.basis,
          instanceId: box?.id ?? null,
          scheduleKey: input.scheduleKey ?? null,
          deliverSlack: input.deliverSlack === true,
          startedAt: box ? now : null,
        },
      });
    });
  } catch (err) {
    // Another process (an overlapping deploy) made today's scheduled row first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { kind: 'duplicate' };
    throw err;
  }
  if ('alreadyRunning' in row) return { kind: 'already_running', id: row.alreadyRunning };
  if (!box) {
    console.log(`[BRIEFING] ${row.id} for ${input.user.id} skipped: ${row.error}`);
    return { kind: 'skipped', id: row.id };
  }

  const launch = briefingLaunch(box.hostHome!, box.hostUnixUser!, row.id);
  try {
    await sendToInstanceAgent(box.id, 'tmux-create', {
      sessionName: launch.sessionName, cwd: launch.cwd, gitInit: launch.gitInit, command: launch.command,
    }, 15_000);
    console.log(`[BRIEFING] ${row.id} (${input.trigger}) started on ${box.name} for ${window.label}`);
    return { kind: 'started', id: row.id };
  } catch (err) {
    const msg = (err as Error).message;
    const error = /ENOENT|EACCES|no such file/i.test(msg)
      ? `termag-briefing is not installed on ${box.name} yet. It arrives with the box's next update.`
      : `Could not start the review on ${box.name}: ${msg.slice(0, 200)}`;
    await prisma.briefing.update({ where: { id: row.id }, data: { status: 'failed', error, finishedAt: new Date() } });
    console.error(`[BRIEFING] ${row.id} launch on ${box.name} failed: ${msg}`);
    return { kind: 'failed', id: row.id };
  }
}

/** The running row a box token may act on: the owner's, placed on that very box. */
export async function runningRowForBox(userId: string, instanceId: string | null | undefined, id: string) {
  if (!instanceId) return null;
  return prisma.briefing.findFirst({ where: { id, userId, instanceId } });
}

export type ResultOutcome = { status: 204 } | { status: 404 } | { status: 409 } | { status: 400; error: string };

export function parseResultBody(body: unknown): BriefingResultBody | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Expected a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.result !== 'string') return { error: 'result must be a string' };
  if (b.result.length > 200_000) return { error: 'result too large' };
  const exitStatus = Number.isInteger(b.exitStatus) ? (b.exitStatus as number) : -1;
  const usage = b.usage && typeof b.usage === 'object' ? b.usage as BriefingResultBody['usage'] : undefined;
  return {
    result: b.result,
    exitStatus,
    isError: b.isError === true,
    usage,
    model: typeof b.model === 'string' ? b.model.slice(0, 120) : null,
  };
}

const tokenCount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

/** The box's report: validate, store, deliver. */
export async function recordResult(
  user: { id: string; unixUsername: string },
  instanceId: string | null | undefined,
  id: string,
  body: BriefingResultBody,
  deliver: (briefingId: string) => Promise<void>,
): Promise<ResultOutcome> {
  const row = await runningRowForBox(user.id, instanceId, id);
  if (!row) return { status: 404 };
  if (row.status !== 'running') return { status: 409 };

  const usage = body.usage ?? {};
  const inputTokens = tokenCount(usage.input_tokens) + tokenCount(usage.cache_read_input_tokens) + tokenCount(usage.cache_creation_input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  let status: 'done' | 'failed' = 'failed';
  let error: string | null = null;
  let content: Prisma.InputJsonValue | undefined;
  if (body.exitStatus !== 0 || body.isError) {
    error = `The review on the box failed (exit ${body.exitStatus}): ${body.result.replace(/\s+/g, ' ').slice(0, 300)}`;
  } else {
    const parsed = parseBriefingContent(body.result);
    if (parsed.ok) {
      const visible = new Set((await visibleProjects(user.id, null)).map(p => p.id));
      content = scrubProjectIds(parsed.content, visible) as unknown as Prisma.InputJsonValue;
      status = 'done';
    } else {
      error = parsed.error;
    }
  }

  // Totals for the stats strip, from the review's own ledger (PR counts
  // included): this process's cached copy, else what rememberLedger saved on
  // the row when the review read it (another process, or a long run), else a
  // database-only ledger (no box reads).
  let stats: Prisma.InputJsonValue | undefined;
  try {
    const window = {
      since: row.since.toISOString(), until: row.until.toISOString(), tz: row.tz, label: row.windowLabel,
      basis: 'explicit' as const, previousBriefingAt: null,
    };
    const cached = peekLedger(ledgerCacheKey(user.id, window, id));
    const totals = cached ? (await cached).totals
      : (row.stats as LedgerTotals | null) ?? (await buildLedger(user, window, undefined, { light: true })).totals;
    stats = totals as unknown as Prisma.InputJsonValue;
  } catch (err) {
    console.error(`[BRIEFING] ${id}: stats failed:`, (err as Error).message);
  }

  const updated = await prisma.briefing.updateMany({
    where: { id, status: 'running' },
    data: {
      status, error, content, stats, inputTokens, outputTokens,
      model: body.model ?? null,
      finishedAt: new Date(),
    },
  });
  if (updated.count === 0) return { status: 409 };
  console.log(`[BRIEFING] ${id} ${status}${error ? `: ${error}` : ''} (${inputTokens} in / ${outputTokens} out)`);
  if (row.deliverSlack) void deliver(id).catch(err => console.error(`[BRIEFING] ${id}: Slack delivery failed:`, (err as Error).message));
  return { status: 204 };
}

/**
 * Keep what the result needs from a review's ledger on its row, so the result
 * has it whichever process takes the post and however long the run took. Only
 * while the run is running; a failure only costs the PR counts.
 */
export async function rememberLedger(userId: string, briefingId: string, ledger: Ledger): Promise<void> {
  await prisma.briefing.updateMany({
    where: { id: briefingId, userId, status: 'running' },
    data: { stats: ledger.totals as unknown as Prisma.InputJsonValue },
  }).catch(err => console.warn(`[BRIEFING] ${briefingId}: could not keep the ledger totals:`, (err as Error).message));
}

/** Mark runs that never reported as failed, and drop their tmux session if it is still there. */
export async function sweepStuckRuns(now: Date = new Date()): Promise<number> {
  const stuck = await prisma.briefing.findMany({
    where: { status: 'running', createdAt: { lt: new Date(now.getTime() - RUN_TIMEOUT_MS) } },
    select: { id: true, instanceId: true },
  });
  let swept = 0;
  for (const r of stuck) {
    const won = await prisma.briefing.updateMany({
      where: { id: r.id, status: 'running' },
      data: { status: 'failed', error: `The review did not report back within ${RUN_TIMEOUT_MS / 60_000} minutes.`, finishedAt: now },
    });
    // A result that landed between the read and this update wins; leave it be.
    if (won.count === 0) continue;
    swept++;
    if (r.instanceId && isInstanceAgentConnected(r.instanceId)) {
      const box = await prisma.instance.findUnique({ where: { id: r.instanceId }, select: { hostUnixUser: true } });
      if (box?.hostUnixUser) {
        void sendToInstanceAgent(r.instanceId, 'tmux-kill', { sessionName: briefingSessionName(box.hostUnixUser, r.id), exact: true }).catch(() => {});
      }
    }
  }
  return swept;
}
