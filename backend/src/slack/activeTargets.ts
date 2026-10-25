/**
 * What a chat user's `/t` drives outside a project channel: set by
 * `/t switch`, `/t attach`, the Slack Home tab's Attach and a first `/t`, and
 * read by every `/t` in a DM or a non-project channel, the DM executor's
 * working directory and the Home tab. Discord's `/t` shares it, keyed by its
 * own user ids.
 *
 * Reads use the map, so they stay synchronous. Every write goes through to
 * `chat_active_targets`, one person's writes in order, and loadActiveTargets reads the rows back each time a
 * chat bot connects (on the lease holder, services/leaderOnly.ts), so a deploy
 * or a lease handover keeps everyone's choice instead of falling back to their
 * first project. A failed write is logged; the map still has it until the
 * process ends.
 *
 * A first `/t`'s fallback (the first project with an agent) is a guess, not
 * a choice: guessActiveTarget keeps it in the map only, and any saved row
 * replaces it. Otherwise a load that failed, followed by one DM `/t`, would
 * overwrite the person's saved choice with the guess.
 */
import { prisma } from '../db';

export type ChatPlatform = 'slack' | 'discord';

export interface ActiveTarget {
  projectId: string;
  workstream: string;
}

// chatUserId → target, with when it was set (ms) so a load never replaces a
// newer choice with an older row. A guess has at 0, so every row beats it.
const targets = new Map<string, ActiveTarget & { at: number }>();

// The writes for one person, chained so they commit in the order they were
// made: two quick `/t switch`es must not leave the first one saved.
const writes = new Map<string, Promise<void>>();

function writeInOrder(platform: ChatPlatform, chatUserId: string, what: string, write: () => Promise<unknown>): void {
  const key = `${platform}:${chatUserId}`;
  const next = (writes.get(key) ?? Promise.resolve())
    .then(write)
    .then(() => {}, err => console.error(`[CHAT] Failed to ${what}:`, (err as Error).message));
  writes.set(key, next);
  void next.then(() => { if (writes.get(key) === next) writes.delete(key); });
}

export function getActiveTarget(chatUserId: string): ActiveTarget | null {
  const t = targets.get(chatUserId);
  return t ? { projectId: t.projectId, workstream: t.workstream } : null;
}

export function setActiveTarget(platform: ChatPlatform, chatUserId: string, target: ActiveTarget, now: Date = new Date()): void {
  targets.set(chatUserId, { ...target, at: now.getTime() });
  // The row carries the same time as the map, which is what loadActiveTargets compares.
  const row = { projectId: target.projectId, workstream: target.workstream, updatedAt: now };
  writeInOrder(platform, chatUserId, 'save the active target', () => prisma.chatActiveTarget.upsert({
    where: { platform_chatUserId: { platform, chatUserId } },
    update: row,
    create: { platform, chatUserId, ...row },
  }));
}

/**
 * A fallback target: used until the person picks one, never saved, replaced
 * by any saved row. It fills an empty slot only: callers pick the fallback
 * after an await, and a retried load may have filled the slot meanwhile.
 */
export function guessActiveTarget(chatUserId: string, target: ActiveTarget): void {
  if (!targets.has(chatUserId)) targets.set(chatUserId, { ...target, at: 0 });
}

/** Forget a target, e.g. once its project is gone. */
export function clearActiveTarget(platform: ChatPlatform, chatUserId: string): void {
  targets.delete(chatUserId);
  writeInOrder(platform, chatUserId, 'forget the active target', () => prisma.chatActiveTarget.deleteMany({ where: { platform, chatUserId } }));
}

/**
 * Read the saved targets into the map, keeping any entry set since its row
 * was written. Rows of archived projects are skipped (deleted projects take
 * theirs with them). Safe to call from every bot's start, and again after
 * the lease comes back: another holder's newer choices win, this process's
 * newer ones stay.
 */
export async function loadActiveTargets(): Promise<number> {
  const rows = await prisma.chatActiveTarget.findMany({ where: { project: { archived: false } } });
  for (const r of rows) {
    const at = r.updatedAt.getTime();
    const mine = targets.get(r.chatUserId);
    if (!mine || mine.at < at) targets.set(r.chatUserId, { projectId: r.projectId, workstream: r.workstream, at });
  }
  return rows.length;
}

const RETRY_MS = 30_000;
let retry: ReturnType<typeof setTimeout> | null = null;

/**
 * loadActiveTargets for a chat bot's start: waits for the first try, and when
 * it fails keeps trying every 30 s in the background until one succeeds, so
 * a passing database error doesn't leave everyone on a guess until the next
 * deploy. One retry timer however many bots call it.
 */
export async function loadActiveTargetsOrRetry(tag: string): Promise<void> {
  try {
    await loadActiveTargets();
    if (retry) clearTimeout(retry);
    retry = null;
  } catch (err) {
    console.error(`[${tag}] Could not load the saved /t targets, trying again in 30 s:`, (err as Error).message);
    if (retry) return;
    retry = setTimeout(() => { retry = null; void loadActiveTargetsOrRetry(tag); }, RETRY_MS);
    retry.unref?.();
  }
}

export function resetActiveTargetsForTests(): void {
  targets.clear();
  writes.clear();
  if (retry) clearTimeout(retry);
  retry = null;
}
