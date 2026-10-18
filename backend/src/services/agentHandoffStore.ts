/**
 * The agent_handoffs claim the launch path needs.
 * Kept apart from the sweep so services/agentRuntime.ts can claim a restart's
 * prompt file without importing it — the same split as agentSpawnStore.ts.
 */
import { prisma } from '../db';
import { handoffLaunchCommand } from './agentHandoff';

/** A restart not launched within this long is left alone: the sweep fails it. */
const CLAIM_WINDOW_MS = 60 * 60 * 1000;


export interface HandoffLaunch {
  id: string;
  /** The prompted launch line, before launchCommandFor's telemetry wrapping. */
  command: string;
}

/**
 * The launch for a pane a handoff restart just killed, or null for an
 * ordinary launch. Claims the row (launchedAt null → now, state → done) so
 * exactly one launch types it: the sweep's own, or reconnect reconstruction
 * if the box dropped in between, which would otherwise type the old
 * conversation's resume command. 'held' when another claimer took the row
 * between our read and our write (two processes during an overlapping
 * deploy): it is typing the launch, so the caller types nothing. Within one
 * process the pane lock (agentRuntime's withPaneLock) already serializes the
 * launches, so the second one's probe sees the agent the first started. By project id and workstream, never by name. Never
 * throws: a failed lookup must not stop a normal launch.
 */
export async function claimHandoffLaunch(k: {
  userId: string;
  projectId: string | null;
  workstream: string;
  provider: string;
}): Promise<HandoffLaunch | 'held' | null> {
  if (!k.projectId) return null;
  try {
    const row = await prisma.agentHandoff.findFirst({
      where: {
        userId: k.userId,
        projectId: k.projectId,
        workstream: k.workstream,
        mode: 'restart',
        state: 'resetting',
        launchedAt: null,
        resetAt: { gte: new Date(Date.now() - CLAIM_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fromProvider: true, toProvider: true },
    });
    if (!row) return null;
    // A restart that named a provider claims only that one's launch (anything
    // else is some other launch, a switch since); one that did not starts
    // whatever the pane runs now (the sweep's restart picks it).
    if (row.toProvider && row.toProvider !== k.provider) return null;
    // Before the claim: a provider that cannot start on a file must not mark the row done.
    const command = handoffLaunchCommand(k.provider, row.id);
    const now = new Date();
    const claimed = await prisma.agentHandoff.updateMany({
      where: { id: row.id, state: 'resetting', launchedAt: null },
      data: { launchedAt: now, doneAt: now, state: 'done' },
    });
    // Another launch claimed it between our read and our write: it is typing the handoff.
    if (claimed.count !== 1) return 'held';
    console.log(`[HANDOFF] ${k.workstream}: launching on handoff ${row.id}`);
    return { id: row.id, command };
  } catch (err) {
    console.warn(`[HANDOFF] ${k.workstream}: handoff lookup failed, plain launch:`, (err as Error).message);
    return null;
  }
}

/** Hand a claimed restart back when typing its launch failed, so the sweep tries again. */
export async function releaseHandoffLaunch(id: string): Promise<void> {
  await prisma.agentHandoff.updateMany({
    where: { id, state: 'done' },
    data: { launchedAt: null, doneAt: null, state: 'resetting' },
  }).catch(err => console.warn(`[HANDOFF] could not release handoff ${id}:`, (err as Error).message));
}
