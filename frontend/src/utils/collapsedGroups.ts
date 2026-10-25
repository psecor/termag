/**
 * Collapsed project-list groups (one per box, plus Shared with me, This host
 * and the cloud-session groups), remembered per browser. A collapsed group
 * shows its header and a one-line rollup instead of its rows. Pure helpers so
 * the storage round trip and the rollup are testable without a DOM;
 * ProjectControl owns the state.
 */
import type { AgentStatusValue } from '../types';

export const COLLAPSED_GROUPS_KEY = 'termag-collapsed-groups';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The collapsed group keys, empty when nothing valid is stored (or storage is unavailable). */
export function readCollapsedGroups(storage: StorageLike | null): Set<string> {
  try {
    const raw = storage?.getItem(COLLAPSED_GROUPS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(storage: StorageLike | null, keys: Set<string>): void {
  try { storage?.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...keys].sort())); } catch { /* private mode */ }
}

/**
 * Drops box ids the box list no longer has, so terminated boxes don't pile up
 * in storage. The fixed groups (`__shared`, `__local`, …) are kept: they come
 * and go with their rows and should stay collapsed when they come back. Only
 * call once the box list has loaded; before that every box looks gone.
 */
export function pruneCollapsedGroups(keys: Set<string>, knownBoxIds: Set<string>): Set<string> {
  const next = new Set([...keys].filter(k => k.startsWith('__') || knownBoxIds.has(k)));
  return next.size === keys.size ? keys : next;
}

export interface GroupRollup {
  sessions: number;
  /** The strongest status across the sessions: drives the rollup's dot. */
  top: AgentStatusValue;
  working: number;
  waiting: number;
  /** "7 sessions · 2 working · 1 waiting · 1 stopped unseen"; zero counts are left out. */
  label: string;
}

const PRIORITY: Record<AgentStatusValue, number> = { working: 4, waiting: 3, idle: 2, not_running: 1 };

/**
 * What a collapsed group stands for: one status per agent session (a project
 * contributes one per workstream, a cloud session one) and how many of them
 * stopped since this browser last looked.
 */
export function groupRollup(statuses: AgentStatusValue[], unseenStops = 0): GroupRollup {
  let top: AgentStatusValue = 'not_running';
  let working = 0;
  let waiting = 0;
  for (const s of statuses) {
    if (PRIORITY[s] > PRIORITY[top]) top = s;
    if (s === 'working') working++;
    else if (s === 'waiting') waiting++;
  }
  const n = statuses.length;
  const parts = [`${n} session${n === 1 ? '' : 's'}`];
  if (working) parts.push(`${working} working`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (unseenStops) parts.push(`${unseenStops} stopped unseen`);
  return { sessions: n, top, working, waiting, label: parts.join(' · ') };
}
