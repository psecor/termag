/**
 * Whether a rename asks the box to carry the agent conversations along, and
 * what follows once it has (agent/conversation-move.js).
 *
 * Claude Code and pi keep a conversation under a folder named after the cwd
 * it ran in, so a project or workstream rename that moves the checkout left
 * `claude --resume` there with nothing to list. An agent announcing
 * `rename-conversations-v1` moves those folders when the rename RPC
 * (`project-rename`, `git-worktree-move`, `workspace-move`) says
 * `conversations: true`, which it says when `rename-conversations-enabled` is
 * on for the owner and the box. An older agent is never asked and renames as
 * it always has.
 *
 * The box's answer names the Claude folders it moved as token-usage buckets
 * (`usageSources`, in the spelling the usage scan reports). Their files scan
 * under the new name from then on, so the rows kept under the old name follow
 * them (tokenUsageSampler.moveUsageSources).
 */
import { prisma } from '../db';
import { projectAgentCapabilities, type ProjectHost } from './agentRegistry';
import { boolVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';
import { moveUsageSources, type UsageSourceMove } from './tokenUsageSampler';

export const RENAME_CONVERSATIONS_CAPABILITY = 'rename-conversations-v1';

/**
 * Whether this rename's RPC should carry `conversations: true`: a box whose
 * agent knows it, with the flag on. Never throws: a workstream rename has
 * already renamed its row when it asks, so a failed lookup is a no.
 */
export async function carriesConversations(user: FlagUser, host: ProjectHost): Promise<boolean> {
  if (!host.instanceId) return false;
  try {
    if (!projectAgentCapabilities(host).includes(RENAME_CONVERSATIONS_CAPABILITY)) return false;
    const box = await prisma.instance.findUnique({ where: { id: host.instanceId }, select: { id: true, name: true, kind: true } });
    return await boolVariation('rename-conversations-enabled', user, false, box);
  } catch {
    return false;
  }
}

const bucketName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 400;

/** The usage buckets a rename's answer says moved, old name → new; anything malformed is dropped. */
export function movedUsageSources(answer: unknown): UsageSourceMove[] {
  const list = (answer as { usageSources?: unknown } | null)?.usageSources;
  if (!Array.isArray(list)) return [];
  return list
    .map(s => s as { from?: unknown; to?: unknown } | null)
    .filter((s): s is UsageSourceMove => Boolean(s) && bucketName(s!.from) && bucketName(s!.to));
}

/** After a box's rename answered: move the moved buckets' usage rows to their new names, in the background. */
export function afterConversationsMoved(userId: string, host: ProjectHost, answer: unknown): void {
  const moves = movedUsageSources(answer);
  if (!host.instanceId || moves.length === 0) return;
  moveUsageSources(userId, host.instanceId, moves)
    .then(n => console.log(`[RENAME] ${host.instanceId}: ${moves.length} Claude folder(s) moved; usage rows dropped for a rescan ${n.dropped}, renamed ${n.rekeyed}`))
    .catch(err => console.warn(`[RENAME] ${host.instanceId}: could not move the moved folders' usage rows: ${(err as Error).message}`));
}
