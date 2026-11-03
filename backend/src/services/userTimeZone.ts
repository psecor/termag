/**
 * Each person's time zone, as their termag clients last reported it, so
 * working time is banked by their day (services/worktimeDays.ts). The web UI
 * and the desktop send theirs when they read working time; it is kept in
 * User.timeZone, and in memory here because banking runs synchronously on
 * hook and heartbeat events. index.ts loads every recorded zone before it
 * hydrates statuses or listens.
 *
 * Keyed by unix username in both forms: human time is banked under the raw
 * name, an agent's under the tmux-safe one (services/tmux.ts tmuxSafeName).
 * Each orchestrator process keeps its own copy: during an overlapping deploy
 * the one that didn't serve a client's read keeps the older zone until it
 * restarts.
 */
import { prisma } from '../db';
import { isTimeZone } from './timeZone';
import { tmuxSafeName } from './tmux';

const zones = new Map<string, string>();
/** By user id: the zone wanted on User.timeZone, and the one it holds as far as this process saw. */
const wanted = new Map<string, string>();
const stored = new Map<string, string | null>();
const writing = new Set<string>();

/** `raw` if it's an IANA zone this runtime knows, else null. */
export function validTimeZone(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 && isTimeZone(raw) ? raw : null;
}

/**
 * Writes the wanted zone to the person's row, one write at a time. A write
 * that fails is tried again on their next report; a newer zone wanted while
 * one was being written follows it.
 */
function persist(userId: string, unixUsername: string): void {
  const zone = wanted.get(userId);
  if (!zone || writing.has(userId) || stored.get(userId) === zone) return;
  writing.add(userId);
  prisma.user.update({ where: { id: userId }, data: { timeZone: zone } })
    .then(() => { stored.set(userId, zone); })
    .catch((err: Error) => { console.warn(`[WORKTIME] could not record ${unixUsername}'s time zone: ${err.message}`); })
    .finally(() => {
      writing.delete(userId);
      if (stored.get(userId) === zone) persist(userId, unixUsername);
    });
}

function remember(unixUsername: string, zone: string): void {
  zones.set(unixUsername, zone);
  zones.set(tmuxSafeName(unixUsername), zone);
}

/** The zone this person's working time is banked in; undefined: the orchestrator's. */
export function timeZoneFor(username: string): string | undefined {
  return zones.get(username);
}

/**
 * Records the zone a client reported for `user` when it is a zone and has
 * changed, and answers the zone to read their days in: the reported one, else
 * the one on record, else undefined (the orchestrator's). Never throws.
 */
export function noteUserTimeZone(
  user: { readonly id: string; readonly unixUsername: string; readonly timeZone?: string | null },
  reported: unknown,
): string | undefined {
  const recorded = validTimeZone(user.timeZone);
  // The request's own row says what's stored, when it carries the column (a CLI user doesn't).
  if (user.timeZone !== undefined && !stored.has(user.id)) stored.set(user.id, recorded);
  const zone = validTimeZone(reported);
  if (!zone) {
    if (recorded && !timeZoneFor(user.unixUsername)) remember(user.unixUsername, recorded);
    return recorded ?? timeZoneFor(user.unixUsername);
  }
  if (timeZoneFor(user.unixUsername) !== zone) remember(user.unixUsername, zone);
  wanted.set(user.id, zone);
  persist(user.id, user.unixUsername);
  return zone;
}

/**
 * Reads every recorded zone, so banking right after a restart uses them.
 * index.ts awaits it before anything can bank. A zone reported while it
 * reads is newer than the row, so it is kept.
 */
export async function loadUserTimeZones(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { timeZone: { not: null } },
    select: { id: true, unixUsername: true, timeZone: true },
  });
  for (const u of users) {
    const zone = validTimeZone(u.timeZone);
    if (!zone) continue;
    if (!stored.has(u.id)) stored.set(u.id, zone);
    if (!timeZoneFor(u.unixUsername)) remember(u.unixUsername, zone);
  }
}

/** Tests: forget every zone. */
export function forgetUserTimeZones(): void {
  zones.clear();
  wanted.clear();
  stored.clear();
  writing.clear();
}
