/**
 * The spawn_events log: one row for each thing that
 * happens to a spawn, refusals included, so a person and the fleet view can
 * see who hits which limit. Recording never throws and never blocks a spawn.
 * `detail` holds counts and reasons only: never brief, report or pane text.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { emitSpawnEvent } from './spawnMetrics';

export type SpawnEventKind = 'requested' | 'refused' | 'created' | 'launched' | 'reported' | 'nudged' | 'failed' | 'ended'
  | 'parked' | 'resumed' | 'retired' | 'retire_refused' | 'adopted' | 'orphaned'
  /** A spawned agent's pane status changed (reason: working | waiting | idle | not_running), for replay. */
  | 'status';

export const SPAWN_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface SpawnEventInput {
  kind: SpawnEventKind;
  userId: string;
  spawnId?: string | null;
  reason?: string | null;
  instanceId?: string | null;
  parentProjectId?: string | null;
  parentWorkstream?: string | null;
  /** Not stored (agent_spawns has it); carried on the OTel log record. */
  rootSpawnId?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

export async function recordSpawnEvent(e: SpawnEventInput): Promise<void> {
  // The same event as OpenTelemetry signals (no-op without an exporter). Not
  // status changes: a few a turn per agent, and L3's traces carry them as span events.
  if (e.kind !== 'status') emitSpawnEvent(e);
  await prisma.spawnEvent.create({
    data: {
      kind: e.kind,
      userId: e.userId,
      spawnId: e.spawnId ?? null,
      reason: e.reason ?? null,
      instanceId: e.instanceId ?? null,
      parentProjectId: e.parentProjectId ?? null,
      parentWorkstream: e.parentWorkstream ?? null,
      detail: (e.detail ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  }).catch(err => console.warn(`[SPAWN] could not record ${e.kind} event:`, (err as Error).message));
}

export async function sweepSpawnEvents(now: number = Date.now()): Promise<number> {
  const r = await prisma.spawnEvent.deleteMany({ where: { at: { lt: new Date(now - SPAWN_EVENT_RETENTION_MS) } } });
  return r.count;
}
