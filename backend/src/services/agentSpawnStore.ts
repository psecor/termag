/**
 * The agent_spawns claims the launch path needs. Kept
 * apart from routes/spawns.ts so services/agentRuntime.ts can claim a brief
 * without importing a route.
 */
import { prisma } from '../db';
import { spawnLaunchCommand } from './agentSpawn';
import { SPAWN_CLAIM_WINDOW_MS } from './spawnLimits';
import { recordSpawnEvent } from './spawnEvents';

/** A brief not launched within this long is left alone: the spawn has failed some other way. */
const CLAIM_WINDOW_MS = SPAWN_CLAIM_WINDOW_MS;

export interface SpawnLaunch {
  id: string;
  /** The prompted launch line, before launchCommandFor's telemetry wrapping. */
  command: string;
}

/**
 * The launch for a spawned agent's first start, or null for an ordinary
 * launch. Claims the brief (launchedAt null → now) so only one launch types
 * it. By spawn id when the caller has one (the spawn route's own create);
 * otherwise by the child project's id, for the launches that come later — a
 * box's hello or clone report, or reconnect reconstruction after a first
 * launch that never typed. Never by name: two spawns racing for one name must
 * not swap briefs. Never throws: a failed lookup must not stop a normal launch.
 */
export async function claimSpawnLaunch(k: {
  spawnId?: string | null;
  userId: string;
  projectId: string | null;
  workstream: string;
  provider: string;
}): Promise<SpawnLaunch | null> {
  if (!k.spawnId && !k.projectId) return null;
  try {
    const row = await prisma.agentSpawn.findFirst({
      where: {
        // By id it must still be this project's spawn: an id is only a pointer, never a grant.
        ...(k.spawnId ? { id: k.spawnId, childProjectId: k.projectId ?? '' } : { childProjectId: k.projectId }),
        userId: k.userId,
        childWorkstream: k.workstream,
        provider: k.provider,
        launchedAt: null,
        state: 'starting',
        createdAt: { gte: new Date(Date.now() - CLAIM_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!row) return null;
    const claimed = await prisma.agentSpawn.updateMany({
      where: { id: row.id, launchedAt: null },
      data: { launchedAt: new Date(), state: 'running' },
    });
    if (claimed.count !== 1) return null;
    console.log(`[SPAWN] ${k.workstream}: launching on brief ${row.id}`);
    void recordSpawnEvent({ kind: 'launched', spawnId: row.id, userId: k.userId, reason: k.spawnId ? 'create' : 'later' });
    return { id: row.id, command: spawnLaunchCommand(k.provider, row.id) };
  } catch (err) {
    console.warn(`[SPAWN] ${k.workstream}: brief lookup failed, plain launch:`, (err as Error).message);
    return null;
  }
}

/** Hand a claimed brief back when typing its launch failed, so the next launch tries again. */
export async function releaseSpawnLaunch(id: string): Promise<void> {
  await prisma.agentSpawn.updateMany({
    where: { id, state: 'running', reportedAt: null },
    data: { launchedAt: null, state: 'starting' },
  }).catch(err => console.warn(`[SPAWN] could not release brief ${id}:`, (err as Error).message));
}
