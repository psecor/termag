/**
 * The first-link enable: a space's first
 * channel link turns Slack on for it. The person linking becomes the runner
 * (confirmed decision 2), whose identity, box and budget the orchestrator uses.
 *
 * Until M7 (the space orchestrator runner), the project and box are stubbed:
 * enable records the runner and the box choice (an existing box in
 * `SpaceSlack.instanceId`; a new small box in the `slack.enable` event's note,
 * with `instanceId` null), and `ensureOrchestratorProject` is a port whose
 * default does nothing, so `projectId` stays null and turns aren't answered
 * yet. M7 replaces the default with the real project and box provisioning.
 */
import type { SpaceStore } from '../spaces/spaceStore';
import type { SpaceSlackRow, SpaceSlackStore } from './linkStore';

/** The runner's box: one of theirs, or a new small one (the default). */
export type RunnerBoxChoice = { existing: string } | { new: { size: 'small' } };

export const DEFAULT_RUNNER_BOX: RunnerBoxChoice = { new: { size: 'small' } };

export interface EnableDeps {
  spaces: Pick<SpaceStore, 'box' | 'recordEvent'>;
  slack: Pick<SpaceSlackStore, 'enableSpaceSlack' | 'spaceSlack'>;
  /**
   * Creates the `space-orchestrator` project on the runner's box (M7). The
   * default, until then, creates nothing and returns null.
   */
  ensureOrchestratorProject?: (input: { spaceSlack: SpaceSlackRow; box: RunnerBoxChoice }) => Promise<{ projectId: string } | null>;
}

export interface EnableInput {
  spaceId: string;
  actorUserId: string;
  box: RunnerBoxChoice;
  /** The entry point (slack_command, web, cli, …), for the audit note. */
  via: string;
}

export type EnableResult =
  | { kind: 'enabled'; spaceSlack: SpaceSlackRow; created: boolean }
  | { kind: 'refused'; code: 'runner_no_box' };

/** Box states the orchestrator can't run on (as M7's orchestrator.ts). A stopped or hibernated box can be woken. */
export const GONE_BOX_STATUSES: ReadonlySet<string> = new Set(['terminated', 'failed', 'quarantined']);

export function boxChoiceNote(box: RunnerBoxChoice): string {
  return 'existing' in box ? `box=existing:${box.existing}` : `box=new:${box.new.size}`;
}

/**
 * The row: the actor becomes the runner, with the box they chose. A space
 * already on is returned unchanged (`created: false`) without looking at the
 * box, since the repeat chose nothing. `created` is true for a new row and for
 * a disabled one turned back on.
 */
export async function activateSpaceSlack(deps: EnableDeps, input: EnableInput): Promise<EnableResult> {
  const live = await deps.slack.spaceSlack(input.spaceId);
  if (live && !live.disabledAt) return { kind: 'enabled', spaceSlack: live, created: false };

  let instanceId: string | null = null;
  if ('existing' in input.box) {
    // Only a box the runner owns that isn't gone: the orchestrator runs as them, there.
    const box = await deps.spaces.box(input.box.existing);
    if (!box || box.userId !== input.actorUserId || GONE_BOX_STATUSES.has(box.status)) return { kind: 'refused', code: 'runner_no_box' };
    instanceId = box.id;
  }
  const { row, created } = await deps.slack.enableSpaceSlack({
    spaceId: input.spaceId, enabledById: input.actorUserId, runnerUserId: input.actorUserId, instanceId,
  });
  return { kind: 'enabled', spaceSlack: row, created };
}

/**
 * After activation (and, from the link service, after the channel claim): the
 * audit event for a new activation, and the project while the row has none.
 * Neither failure undoes the committed row: each is logged, and the project
 * step is retried by the next enable or link of the space.
 */
export async function completeEnable(
  deps: EnableDeps, input: EnableInput, res: { spaceSlack: SpaceSlackRow; created: boolean },
): Promise<void> {
  const row = res.spaceSlack;
  if (res.created) {
    await deps.spaces.recordEvent({
      spaceId: input.spaceId, actorUserId: input.actorUserId, action: 'slack.enable', surface: 'slack',
      note: `linkedVia=${input.via}; runner=${input.actorUserId}; ${boxChoiceNote(input.box)}`,
    }).catch(err => console.error(`[SPACE-SLACK] Recording slack.enable for ${input.spaceId} failed:`, (err as Error).message));
  }
  if (row.projectId || !deps.ensureOrchestratorProject) return;
  // A new activation uses the box the actor chose; a repeat, the runner's recorded box (or none yet).
  const box: RunnerBoxChoice | null = res.created ? input.box : row.instanceId ? { existing: row.instanceId } : null;
  if (!box) return;
  // M7: the project and box. Until then nothing is created and turns aren't answered.
  await deps.ensureOrchestratorProject({ spaceSlack: row, box })
    .catch(err => console.error(`[SPACE-SLACK] Orchestrator project for ${input.spaceId} failed (retried on the next link):`, (err as Error).message));
}

/** The first-link enable: activate, then complete. Safe to repeat. */
export async function enable(deps: EnableDeps, input: EnableInput): Promise<EnableResult> {
  const res = await activateSpaceSlack(deps, input);
  if (res.kind === 'enabled') await completeEnable(deps, input, res);
  return res;
}
