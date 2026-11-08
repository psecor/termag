/**
 * The Claude Code floor for the cloud-session spawn route (routes/claudeRunner.ts):
 * for each of the owner's
 * candidate boxes, what claudeFloorDecision says, from the policy flag's
 * floor, the box's inventory `claude` and whether its wrapper takes
 * --claude-floor. A box decided `too-old` gets a floor run.
 *
 * Never throws: a read that fails decides `ok` for every box, which is the
 * spawn route as it was before the floor.
 */
import type { User } from '@prisma/client';
import { prisma } from '../db';
import { claudeFloorDecision, type ClaudeFloorDecision } from './claudeRunnerSpawn';
import { TOOL_REGISTRY } from './toolUpdate/components';
import { requestFloorRun } from './toolUpdate/runs';

const claude = TOOL_REGISTRY.claude;

export interface FloorBox { id: string; name: string; kind: string; wrapperFloor?: boolean }

export async function runnerFloors(owner: User, boxes: FloorBox[]): Promise<Map<string, ClaudeFloorDecision>> {
  const out = new Map<string, ClaudeFloorDecision>();
  if (!boxes.length) return out;
  try {
    const rows = await prisma.hostSoftware.findMany({ where: { hostKey: { in: boxes.map(b => b.id) }, component: claude.inventoryName }, select: { hostKey: true, version: true, ok: true } });
    const installed = new Map(rows.map(r => [r.hostKey, r.ok ? r.version : null]));
    await Promise.all(boxes.map(async b => {
      const box = { id: b.id, name: b.name, kind: b.kind };
      // One read of the policy: its floor, and whether updating is on (its mode not off).
      const policy = await claude.policy(owner, box);
      const enforce = await claude.enabled(owner, box, policy);
      out.set(b.id, claudeFloorDecision({ floor: policy.floor, installed: installed.get(b.id) ?? null, wrapperFloor: !!b.wrapperFloor, enforce }));
    }));
  } catch (err) {
    console.warn('[CLAUDE-RUNNER] the Claude Code floor could not be read; not applied:', err instanceof Error ? err.message : String(err));
    out.clear();
  }
  return out;
}

/** A floor run for each box decided too-old, in the background (requestFloorRun skips one with a run in flight). */
export function requestFloorRuns(owner: User, boxes: FloorBox[], floors: Map<string, ClaudeFloorDecision>): void {
  for (const b of boxes) {
    if (floors.get(b.id)?.kind === 'too-old') void requestFloorRun(claude, { id: b.id, name: b.name, kind: b.kind }, owner);
  }
}
