/**
 * The `web` notification target of routes/status.ts: a
 * session that starts waiting pushes once to its project OWNER's devices.
 * Independent of the hook's `notify` bit and of the Slack/Discord target
 * list. Collaborators get nothing in this phase.
 *
 * Session → owner: `resolveSessionProject(session, instanceId)` rebuilds the
 * candidate tmux names from each possible owner's projects and workstreams
 * (the same match Slack `/t` and the context sampler use), so a session that
 * maps to no project — a cloud runner session, an arbitrary tmux name — is
 * never pushed.
 */
import { prisma } from '../db';
import { webPushEnabledFor } from './pushFlag';
import type { AgentStatus } from '../types/index';
import { getAllStatuses } from './status';
import { parseStatusKey, statusKey } from './statusKey';
import { isAmbiguousSession, resolveSessionProject, type ResolvedSession } from './sessionResolver';
import { sessionBelongsToUser } from './tmux';
import {
  appBaseUrl, buildWaitingPayload, defaultSendDeps, isLiveSubscription, sendToUser, type SendDeps,
} from './webPush';

/** The same session waiting again inside this window does not re-notify. */
export const PUSH_WAITING_COOLDOWN_MS = 30_000;

/**
 * Pure: push on a transition INTO waiting (from anything else, including no
 * prior status), unless this session last pushed under the cooldown ago.
 */
export function shouldPushWaiting(
  prev: AgentStatus['status'] | undefined,
  next: AgentStatus['status'],
  lastPushedAt: number | null | undefined,
  now: number,
  cooldownMs: number = PUSH_WAITING_COOLDOWN_MS,
): boolean {
  if (next !== 'waiting' || prev === 'waiting') return false;
  if (lastPushedAt == null) return true;
  return now - lastPushedAt >= cooldownMs;
}

/**
 * Pure: how many of the owner's project sessions are waiting, one per
 * (project, workstream) so an agent and ctrl pane both waiting count once.
 */
export function countOwnerWaiting(
  waiting: { resolved: ResolvedSession | null }[],
  ownerId: string,
): number {
  const seen = new Set<string>();
  for (const { resolved } of waiting) {
    if (!resolved || resolved.userId !== ownerId || !resolved.projectId) continue;
    seen.add(`${resolved.projectId}\0${resolved.workstream ?? 'main'}`);
  }
  return seen.size;
}

const lastPushedAt = new Map<string, number>();

/** Test seam. */
export function resetPushWaitingState(): void {
  lastPushedAt.clear();
}

async function resolveOwnedProject(session: string, instanceId: string | null): Promise<ResolvedSession | null> {
  const r = await resolveSessionProject(session, instanceId);
  if (!r || isAmbiguousSession(r) || !r.projectId || !r.workstream) return null;
  return r;
}

async function ownerWaitingCount(ownerId: string, ownerUnixUsername: string): Promise<number> {
  const waiting: { resolved: ResolvedSession | null }[] = [];
  for (const [key, entry] of getAllStatuses()) {
    if (entry.status !== 'waiting') continue;
    const { instanceId, session } = parseStatusKey(key);
    // Cheap prefilter; the resolver below is what decides ownership.
    if (!sessionBelongsToUser(session, ownerUnixUsername)) continue;
    waiting.push({ resolved: await resolveOwnedProject(session, instanceId).catch(() => null) });
  }
  return countOwnerWaiting(waiting, ownerId);
}

export interface WaitingTransition {
  session: string;
  instanceId: string | null;
  prev: AgentStatus['status'] | undefined;
  next: AgentStatus['status'];
  message?: string | null;
  waitingReason?: AgentStatus['waitingReason'];
  now?: number;
}

/**
 * Call after every status write. Decides synchronously (so two posts racing
 * cannot both pass the cooldown), then resolves and sends in the background.
 * Returns whether a push was dispatched; never throws, never rejects.
 */
export function pushOnWaitingTransition(t: WaitingTransition, deps?: SendDeps): boolean {
  const now = t.now ?? Date.now();
  const key = statusKey(t.instanceId, t.session);
  if (!shouldPushWaiting(t.prev, t.next, lastPushedAt.get(key), now)) return false;
  const sendDeps = deps ?? defaultSendDeps();
  if (!sendDeps.vapid) return false;
  lastPushedAt.set(key, now);

  void (async () => {
    const owner = await resolveOwnedProject(t.session, t.instanceId);
    if (!owner?.projectId || !owner.workstream) return;
    if (!await webPushEnabledFor(owner.userId)) return;
    const project = await prisma.project.findUnique({
      where: { id: owner.projectId },
      select: { name: true, user: { select: { unixUsername: true } } },
    });
    if (!project) return;
    const payload = buildWaitingPayload({
      baseUrl: appBaseUrl(),
      projectId: owner.projectId,
      projectName: project.name,
      workstream: owner.workstream,
      session: t.session,
      tag: key,
      message: t.message,
      waitingReason: t.waitingReason,
      waitingCount: await ownerWaitingCount(owner.userId, project.user.unixUsername),
    });
    const summary = await sendToUser(owner.userId, payload, sendDeps);
    if (summary.sent || summary.failed) {
      console.log(`[PUSH] waiting ${t.session}: sent=${summary.sent} failed=${summary.failed} removed=${summary.removed}`);
    }
  })().catch(err => {
    console.warn(`[PUSH] waiting push for ${t.session} failed:`, err instanceof Error ? err.message : String(err));
  });
  return true;
}

/**
 * Should this session's Slack/Discord "needs input" post be skipped? Yes when
 * its owner turned on `pushMutesChat` and has at least one live subscription
 * (push is on, so the phone gets it instead). Fails open: any error → false,
 * the chat post goes out as before.
 */
export async function waitingChatMuted(session: string, instanceId: string | null, deps?: SendDeps): Promise<boolean> {
  try {
    if (!(deps ?? defaultSendDeps()).vapid) return false;
    const owner = await resolveOwnedProject(session, instanceId);
    if (!owner) return false;
    if (!await webPushEnabledFor(owner.userId)) return false;
    const user = await prisma.user.findUnique({
      where: { id: owner.userId },
      select: { pushMutesChat: true, pushSubscriptions: { select: { lastUsedAt: true, failedAt: true } } },
    });
    if (!user?.pushMutesChat) return false;
    return user.pushSubscriptions.some(isLiveSubscription);
  } catch (err) {
    console.warn(`[PUSH] chat-mute check for ${session} failed:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}
