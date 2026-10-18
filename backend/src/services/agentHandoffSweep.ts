/**
 * The handoff sweep: moves every open agent_handoffs
 * row one step when its pane allows — type the "write it" line, then the
 * reset (/clear, /compact, or a kill and a prompted relaunch), then the
 * read-in line. Leader work, every 5 s. The rules are handoffStep in
 * services/agentHandoff.ts; this file only gathers its inputs and acts.
 *
 * Every step claims the row first (updateMany on its state), so an
 * overlapping process or a slow tick never types a line twice.
 */
import { prisma } from '../db';
import {
  OPEN_HANDOFF_STATES,
  READIN_CLAIM_STALE_MS,
  canStartOnHandoff,
  compactFocus,
  handoffStep,
  readInLine,
  writeRequestLine,
  type HandoffInitiator,
  type HandoffMode,
  type HandoffState,
} from './agentHandoff';
import { isProjectAgentConnected, sendForProject } from './agentRegistry';
import { ensureAgentSessionsAndLaunch, resolveAgentProvider, stopAgentPane } from './agentRuntime';
import { lastHumanHeartbeat } from './humanActivity';
import { PROVIDERS } from '../providers/registry';
import { getStatus, hasStatus, markAgentPaneStopped, notifyStatusChange, setStatus, updateStatusMeta } from './status';
import * as tmux from './tmux';
import type { SessionHandoff } from '../types';

const SWEEP_INTERVAL_MS = 5_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

type HandoffRow = NonNullable<Awaited<ReturnType<typeof prisma.agentHandoff.findUnique>>>;

/** What the status push carries for a handoff (SessionHandoff). */
export function handoffMeta(row: HandoffRow): SessionHandoff {
  return {
    id: row.id,
    state: row.state as SessionHandoff['state'],
    mode: row.mode as SessionHandoff['mode'],
    toProvider: row.toProvider && row.toProvider !== row.fromProvider ? row.toProvider : null,
    reason: row.reason,
    at: row.updatedAt,
  };
}

/**
 * Put the row's state on its pane's live status, for every surface. A pane
 * with no status entry yet (nothing has posted since an orchestrator
 * restart) gets one, as not_running — what getStatus reports for it anyway —
 * or the strip would miss the handoff until the agent's next post.
 */
export function publishHandoff(row: HandoffRow, session: string, instanceId: string | null): void {
  if (hasStatus(session, instanceId)) updateStatusMeta(session, { handoff: handoffMeta(row) }, instanceId);
  else setStatus(session, 'not_running', { handoff: handoffMeta(row) }, undefined, instanceId);
  notifyStatusChange(session, instanceId);
}

/** Move the row from `from` to new data, or null when another tick got there first. */
async function transition(id: string, from: HandoffState, data: Record<string, unknown>): Promise<HandoffRow | null> {
  const claimed = await prisma.agentHandoff.updateMany({ where: { id, state: from }, data });
  if (claimed.count !== 1) return null;
  return prisma.agentHandoff.findUnique({ where: { id } });
}

interface Pane {
  session: string;
  host: { userId: string; instanceId: string | null };
  unixUsername: string;
  projectName: string;
  hostHome: string | null;
  workflowId: string;
  /** The workflow's provider column as stored (null = the user's default). */
  storedProvider: string | null;
  provider: string;
}

/** The row's pane as it is now, or null when its project, workstream or agent is gone. */
async function loadPane(row: HandoffRow): Promise<Pane | null> {
  const project = await prisma.project.findFirst({
    where: { id: row.projectId, userId: row.userId, archived: false },
    include: {
      user: { select: { unixUsername: true, defaultAgentProvider: true } },
      instance: { select: { hostHome: true } },
      workstreams: { where: { name: row.workstream }, include: { workflows: { select: { id: true, type: true, provider: true } } } },
    },
  });
  const wf = project?.workstreams[0]?.workflows.find(w => w.type === 'agent');
  if (!project || !wf) return null;
  return {
    // Rebuilt rather than read back, so a renamed project is still found.
    session: tmux.sessionName(project.user.unixUsername, project.name, 'agent', row.workstream),
    host: { userId: row.userId, instanceId: project.instanceId },
    unixUsername: project.user.unixUsername,
    projectName: project.name,
    hostHome: project.instance?.hostHome ?? null,
    workflowId: wf.id,
    storedProvider: wf.provider,
    provider: resolveAgentProvider(wf.provider, project.user.defaultAgentProvider),
  };
}

async function type(pane: Pane, keys: string): Promise<void> {
  await sendForProject(pane.host, 'tmux-send-keys', { sessionName: pane.session, keys, withEnter: true, literal: true }, 5000);
}

async function finish(row: HandoffRow, state: 'failed' | 'aborted', reason: string, pane: Pane | null): Promise<void> {
  const done = await transition(row.id, row.state as HandoffState, { state, reason: reason.slice(0, 500), doneAt: new Date() });
  console.warn(`[HANDOFF] ${row.id} ${state}: ${reason}`);
  if (done && pane) publishHandoff(done, pane.session, pane.host.instanceId);
}

function runtimeContext(pane: Pane, workstream: string) {
  return {
    userId: pane.host.userId,
    unixUsername: pane.unixUsername,
    projectName: pane.projectName,
    instanceId: pane.host.instanceId,
    workstream,
    hostHome: pane.hostHome,
  };
}

/**
 * Kill the pane's agent and start the next one on the handoff — Switch
 * agent's sequence (routes/workstreams.ts): the row first (cheap to undo),
 * then the pane, then the status, then the launch, which claims the handoff
 * (claimHandoffLaunch) and types the prompted line.
 */
async function restart(row: HandoffRow, pane: Pane): Promise<void> {
  // No provider asked for = the one the pane runs NOW: a Switch agent since
  // the request must not be undone.
  const to = row.toProvider ?? pane.provider;
  if (!canStartOnHandoff(to)) {
    await finish(row, 'failed', `${PROVIDERS[to]?.displayName ?? to} cannot be started on a handoff`, pane);
    return;
  }
  const switching = to !== pane.provider;
  if (switching) await prisma.workflow.update({ where: { id: pane.workflowId }, data: { provider: to } });
  try {
    await stopAgentPane({ ...runtimeContext(pane, row.workstream), provider: pane.provider });
  } catch (err) {
    if (switching) {
      await prisma.workflow.update({ where: { id: pane.workflowId }, data: { provider: pane.storedProvider } }).catch(e =>
        console.error('[HANDOFF] failed to revert the workflow provider:', (e as Error).message));
    }
    await finish(row, 'failed', `could not stop ${PROVIDERS[pane.provider]?.displayName ?? pane.provider}: ${(err as Error).message}`, pane);
    return;
  }
  await prisma.agentHandoff.updateMany({ where: { id: row.id, state: 'resetting' }, data: { killedAt: new Date() } });
  markAgentPaneStopped(pane.session, pane.host.instanceId, { handoff: handoffMeta(row) });
  await relaunch(row, pane, to);
}

async function relaunch(row: HandoffRow, pane: Pane, provider: string): Promise<void> {
  let outcome: string;
  try {
    outcome = await ensureAgentSessionsAndLaunch({ ...runtimeContext(pane, row.workstream), provider });
  } catch (err) {
    console.warn(`[HANDOFF] ${row.id}: launch failed, retrying: ${(err as Error).message}`);
    return;
  }
  const now = await prisma.agentHandoff.findUnique({ where: { id: row.id } });
  if (!now) return;
  if (now.state === 'done') {
    console.log(`[HANDOFF] ${pane.session}: restarted ${provider} on handoff ${row.id}`);
    publishHandoff(now, pane.session, pane.host.instanceId);
    return;
  }
  // Something else started an agent in the pane (a person, or a launch whose
  // claim lookup failed); the handoff did not reach it.
  if (outcome === 'running') await finish(now, 'failed', 'another agent was started in the pane before the handoff launch', pane);
  // busy / unknown: the next tick tries again (handoffStep's relaunch).
}

export async function advanceHandoff(row: HandoffRow, now: number = Date.now()): Promise<void> {
  const pane = await loadPane(row);
  if (!pane) { await finish(row, 'aborted', 'the project, workstream or its agent is gone', null); return; }
  const status = getStatus(pane.session, pane.host.instanceId);
  // The live status is in memory only: after an orchestrator restart (or a
  // write that missed it) put the open handoff back, so the strip and Abort
  // show while the row is still open.
  if (status?.handoff?.id !== row.id || status.handoff.state !== row.state) publishHandoff(row, pane.session, pane.host.instanceId);
  const step = handoffStep({
    state: row.state as HandoffState,
    mode: row.mode as HandoffMode,
    initiator: row.initiator as HandoffInitiator,
    paneStatus: status?.status ?? null,
    connected: isProjectAgentConnected(pane.host),
    humanLastTyped: lastHumanHeartbeat(pane.unixUsername, pane.projectName, pane.host.instanceId),
    createdAt: row.createdAt,
    writeRequestedAt: row.writeRequestedAt,
    writtenAt: row.writtenAt,
    resetAt: row.resetAt,
    launchedAt: row.launchedAt,
    contextTokensBefore: row.contextTokensBefore,
    contextTokensNow: status?.contextTokens ?? null,
    now,
  });

  switch (step.kind) {
    case 'wait':
      return;
    case 'abort':
    case 'fail':
      await finish(row, step.kind === 'abort' ? 'aborted' : 'failed', step.reason, pane);
      return;
    case 'request-write': {
      const next = await transition(row.id, 'requested', { state: 'writing', writeRequestedAt: new Date(now) });
      if (!next) return;
      try {
        await type(pane, writeRequestLine(row.id));
        publishHandoff(next, pane.session, pane.host.instanceId);
        console.log(`[HANDOFF] ${pane.session}: asked for the handoff (${row.id})`);
      } catch (err) {
        // Back to requested: the next idle tick types it again.
        await transition(row.id, 'writing', { state: 'requested', writeRequestedAt: null });
        console.warn(`[HANDOFF] ${pane.session}: could not ask for the handoff (${row.id}):`, (err as Error).message);
      }
      return;
    }
    case 'reset': {
      // The compact's "did the context drop" baseline is the reading now, not
      // at the request: writing the handoff grew the window.
      const next = await transition(row.id, 'written', {
        state: 'resetting', resetAt: new Date(now), contextTokensBefore: status?.contextTokens ?? row.contextTokensBefore,
      });
      if (!next) return;
      publishHandoff(next, pane.session, pane.host.instanceId);
      if (next.mode === 'restart') { await restart(next, pane); return; }
      const config = PROVIDERS[pane.provider];
      const command = next.mode === 'clear' ? config?.clearCommand : config?.compactCommand;
      if (!command) { await finish(next, 'failed', `${config?.displayName ?? pane.provider} has no ${next.mode} command`, pane); return; }
      try {
        await type(pane, next.mode === 'compact' ? `${command} ${compactFocus(row.id)}` : command);
        console.log(`[HANDOFF] ${pane.session}: ${command} (${row.id})`);
      } catch (err) {
        await finish(next, 'failed', `could not type ${command}: ${(err as Error).message}`, pane);
      }
      return;
    }
    case 'read-in': {
      // Claim the line (launchedAt) without leaving resetting: the row is done
      // only once it was typed, and a failed send hands the claim back, so the
      // next tick types it again — the pane is already cleared, and without
      // the line the next agent never reads the handoff.
      const claimed = await prisma.agentHandoff.updateMany({
        where: {
          id: row.id, state: 'resetting',
          // Unclaimed, or a claim a dead leader left (READIN_CLAIM_STALE_MS).
          OR: [{ launchedAt: null }, { launchedAt: { lt: new Date(now - READIN_CLAIM_STALE_MS) } }],
        },
        data: { launchedAt: new Date(now) },
      });
      if (claimed.count !== 1) return;
      try {
        await type(pane, readInLine(row.id));
      } catch (err) {
        await prisma.agentHandoff.updateMany({ where: { id: row.id, state: 'resetting' }, data: { launchedAt: null } });
        console.warn(`[HANDOFF] ${pane.session}: could not type the read-in line, retrying (${row.id}):`, (err as Error).message);
        return;
      }
      const next = await transition(row.id, 'resetting', { state: 'done', doneAt: new Date() });
      if (next) publishHandoff(next, pane.session, pane.host.instanceId);
      console.log(`[HANDOFF] ${pane.session}: read-in typed, done (${row.id})`);
      return;
    }
    case 'relaunch':
      // The leader died between the claim and the kill: the old agent still
      // runs, so do the whole restart again (the provider write is idempotent).
      if (!row.killedAt) { await restart(row, pane); return; }
      // The workflow row already says what restart() chose.
      await relaunch(row, pane, row.toProvider ?? pane.provider);
      return;
  }
}

export async function runHandoffTick(now: number = Date.now()): Promise<void> {
  const rows = await prisma.agentHandoff.findMany({
    where: { state: { in: OPEN_HANDOFF_STATES } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  for (const row of rows) {
    try {
      await advanceHandoff(row, now);
    } catch (err) {
      console.error(`[HANDOFF] ${row.id}: step failed:`, (err as Error).message);
    }
  }
}

export function startHandoffSweep(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runHandoffTick()
      .catch(err => console.error('[HANDOFF] sweep failed:', (err as Error).message))
      .finally(() => { running = false; });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopHandoffSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
