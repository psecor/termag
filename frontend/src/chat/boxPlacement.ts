// Runs on: Auto in New session: the placement the
// server sends (GET /api/boxes/placement, backend services/boxPlacement.ts),
// and the words New session's box pill and its "Where this session runs"
// dialog say about it. Pure, so the drawer and its tests read the same words.
import type { BoxPlacementPolicy } from '../types';

/** The drawer's choice for Auto; the others are NEW_BOX or a box's id. */
export const AUTO = 'auto';

export type PlacementHeat = 'ok' | 'warm' | 'hot' | 'unknown';

export interface PlacementBox {
  instanceId: string;
  name: string;
  status: string;
  /** Its agent is connected now: a ready box that isn't is offline. */
  connected: boolean;
  heat: PlacementHeat;
  heatReasons: string[];
  /** The tightest of memory, disk and load against its hot threshold, 1 being the threshold; null with no recent sample. */
  load: number | null;
  sessions: number;
  hasRepos: boolean;
  checkoutProjectId: string | null;
  lastUsedAt: string | null;
}

export type PlacementPick =
  | { kind: 'box'; instanceId: string; reason: string[] }
  | { kind: 'new'; source: 'pool' | 'cold'; reason: string[] };

export interface PlacementView {
  policy: BoxPlacementPolicy;
  policySource: 'personal' | 'org';
  recommended: PlacementPick;
  boxes: PlacementBox[];
  newBox: { source: 'pool' | 'cold' };
}

/** The reason as one line: "Last used · has termag · room to spare". */
export function reasonLine(reason: readonly string[]): string {
  return reason.join(' · ');
}

/** "memory 91% (limit 85%)" as a row says it: "memory 91%". */
const bare = (r: string) => r.replace(/\s*\(limit [^)]*\)$/, '');

/** A box's state in its row: Up, Asleep · wakes when you start, Starting, … */
export function boxStateWords(b: Pick<PlacementBox, 'status' | 'connected'>): string {
  switch (b.status) {
    case 'ready': return b.connected ? 'Up' : 'Offline';
    case 'stopped':
    case 'hibernated': return 'Asleep · wakes when you start';
    case 'starting': return 'Starting';
    case 'provisioning':
    case 'awaiting-agent': return 'Coming up';
    case 'stopping':
    case 'hibernating': return 'Going to sleep · wakes when you start';
    default: return b.status.replace(/-/g, ' ');
  }
}

/**
 * The line under a box's name in the picker: its state, then its sessions and
 * whether it has the repository; a hot box says why instead of its state.
 */
export function boxRowLine(b: PlacementBox, repoWords: string | null): string {
  const parts: string[] = [];
  if (b.heat === 'hot') parts.push(`Running hot: ${b.heatReasons.slice(0, 2).map(bare).join(', ')}`);
  else parts.push(boxStateWords(b));
  if (b.sessions > 0) parts.push(`${b.sessions} ${b.sessions === 1 ? 'session' : 'sessions'}`);
  if (b.hasRepos && repoWords) parts.push(repoWords);
  return parts.join(' · ');
}

/** The meter's value, 0 to 100: the load against the hot threshold, capped; null with nothing measured. */
export function meterPercent(load: number | null): number | null {
  return load === null ? null : Math.max(0, Math.min(100, Math.round(load * 100)));
}

/** The meter's colour: hot over the threshold, warm from 80% of it. */
export function meterTone(b: Pick<PlacementBox, 'heat'>): 'danger' | 'warning' | 'success' {
  return b.heat === 'hot' ? 'danger' : b.heat === 'warm' ? 'warning' : 'success';
}

/** Where New box comes from, in its row. */
export function newBoxSourceWords(source: 'pool' | 'cold'): string {
  return source === 'pool' ? 'A ready box from the pool' : 'A new launch · takes a few minutes';
}

/** The picker's footer: the default it follows, "Default: reuse a box". */
export function defaultWords(policy: BoxPlacementPolicy): string {
  return policy === 'fresh-first' ? 'Default: a fresh box' : 'Default: reuse a box';
}

/** "has termag", "has termag + termag-desktop", from the repositories asked about (owner/name). */
export function repoWordsFor(repos: readonly string[]): string | null {
  const names = repos.map(r => r.split('/').pop() ?? r).filter(Boolean);
  return names.length ? `has ${names.join(' + ')}` : null;
}

/**
 * What Auto resolves to now, among the boxes New session can launch on: the
 * recommended box, New box, or null while that isn't known yet: the
 * placement hasn't answered, or it named a box the box list doesn't have
 * (not loaded yet, or gone since, which asks the placement again). Never New
 * box for a box the server found, which would launch one for nothing. A failed
 * placement is New box (Send still works).
 */
export function autoChoice(i: { view: PlacementView | null; failed: boolean; boxIds: ReadonlySet<string>; newBox: string }): string | null {
  if (!i.view) return i.failed ? i.newBox : null;
  const rec = i.view.recommended;
  if (rec.kind === 'new') return i.newBox;
  return i.boxIds.has(rec.instanceId) ? rec.instanceId : null;
}

/**
 * The box pill's label: "Runs on: Auto" whatever Auto picked (the box and why
 * are in its tooltip and its dialog's Auto row: autoLine), or the box picked.
 */
export function pillLabel(i: { auto: boolean; resolvedName: string | null }): string {
  return i.auto ? 'Runs on: Auto' : `Runs on: ${i.resolvedName ?? 'New box'}`;
}

/**
 * Auto's line, in the dialog's Auto row and the pill's tooltip: the box it
 * picked and why, "dev · Last used · has termag" (the reason alone while the
 * box list hasn't named it), "Checking your boxes…" while the placement
 * loads, and null once it failed.
 */
export function autoLine(i: { view: PlacementView | null; failed: boolean; name: string | null }): string | null {
  if (!i.view) return i.failed ? null : 'Checking your boxes…';
  return [i.name, reasonLine(i.view.recommended.reason)].filter(Boolean).join(' · ');
}

/**
 * The query for a placement: the repositories as owner/name (a pasted URL is
 * left to the server to read), sorted so a reorder doesn't fetch again.
 */
export function placementKey(repos: readonly string[], size: string | null): string {
  return `${[...repos].sort().join(',')}|${size ?? ''}`;
}

/**
 * The note a session started on a hot box shows in its transcript (never a
 * gate): "build is running hot (memory
 * 91%). Auto would pick dev next time." Null when the box isn't hot.
 */
export function hotBoxNote(chosen: PlacementBox | undefined, view: PlacementView): string | null {
  if (!chosen || chosen.heat !== 'hot') return null;
  const why = chosen.heatReasons.slice(0, 2).map(bare).join(', ');
  const rec = view.recommended;
  const next = rec.kind === 'box' && rec.instanceId !== chosen.instanceId
    ? view.boxes.find(b => b.instanceId === rec.instanceId)?.name ?? null
    : 'a new box';
  return `${chosen.name} is running hot${why ? ` (${why})` : ''}.${next ? ` Auto would pick ${next} next time.` : ''}`;
}

// The compact picker (pages/chat/CompactPlacementPicker.tsx, under user-projects-enabled): one line a box, its state
// short on the right and the rest in its tooltip; the boxes that are up, then the asleep ones by last use, the
// most recent few shown and the rest folded.

/** Asleep, or going to sleep: starting a session wakes it. */
export function isAsleep(status: string): boolean {
  return status === 'stopped' || status === 'hibernated' || status === 'stopping' || status === 'hibernating';
}

const sessionsWord = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`;

/** A row's state, short: "Up · 1 session", "Asleep · 3 sessions", "Running hot". Asleep's "wakes when you start" is said once, by its group. */
export function boxRowShort(b: Pick<PlacementBox, 'status' | 'connected' | 'heat' | 'sessions'>): string {
  const state = b.heat === 'hot' ? 'Running hot' : isAsleep(b.status) ? 'Asleep' : boxStateWords(b);
  return b.sessions > 0 ? `${state} · ${sessionsWord(b.sessions)}` : state;
}

/** A row's tooltip, one line each: its state in full, why it's hot, its sessions, the repository, its load, when it was last used. */
export function boxRowTip(b: PlacementBox, repoWords: string | null, now: number, age: (ms: number) => string): string {
  const pct = meterPercent(b.load);
  const used = b.lastUsedAt ? Date.parse(b.lastUsedAt) : NaN;
  return [
    boxStateWords(b),
    b.heat === 'hot' && b.heatReasons.length ? `Running hot: ${b.heatReasons.slice(0, 2).map(bare).join(', ')}` : null,
    b.sessions > 0 ? sessionsWord(b.sessions) : 'No sessions',
    b.hasRepos && repoWords ? repoWords : null,
    pct !== null ? `Load: ${pct}% of running hot` : null,
    Number.isNaN(used) ? null : `Last used ${age(Math.max(0, now - used))} ago`,
  ].filter(Boolean).join('\n');
}

/** How many asleep boxes show before the rest fold under "N more asleep boxes"; one more than this never folds. */
export const ASLEEP_SHOWN = 4;
/** From how many boxes the picker offers a filter. */
export const FILTER_FROM = 8;

/**
 * The picker's two groups: the boxes that are up (and coming up), in the placement's order (cool first, hot
 * last), then the asleep ones, most recently used first. A filter matches names and shows every match; without
 * one, past ASLEEP_SHOWN asleep boxes the rest are folded, though the picked one always shows.
 */
export function pickerGroups<T extends Pick<PlacementBox, 'instanceId' | 'name' | 'status' | 'lastUsedAt'>>(
  rows: readonly T[], o: { expanded: boolean; filter: string; selected: string },
): { up: T[]; asleep: T[]; more: number } {
  const q = o.filter.trim().toLowerCase();
  const match = q ? rows.filter(r => r.name.toLowerCase().includes(q)) : [...rows];
  const at = (r: T) => { const t = r.lastUsedAt ? Date.parse(r.lastUsedAt) : NaN; return Number.isNaN(t) ? -Infinity : t; };
  const up = match.filter(r => !isAsleep(r.status));
  const asleep = match.filter(r => isAsleep(r.status)).sort((a, b) => at(b) - at(a));
  if (q || o.expanded || asleep.length <= ASLEEP_SHOWN + 1) return { up, asleep, more: 0 };
  const shown = asleep.slice(0, ASLEEP_SHOWN);
  const picked = asleep.find(r => r.instanceId === o.selected);
  if (picked && !shown.includes(picked)) shown.push(picked);
  return { up, asleep: shown, more: asleep.length - shown.length };
}

/**
 * The boxes a session is working on now, from the status map (keyed `instanceId|session`, utils/statusKey.ts):
 * Release isn't offered there, as it would cut a turn off mid-way.
 */
export function workingBoxIds(statusMap: Readonly<Record<string, { status: string }>>): Set<string> {
  const out = new Set<string>();
  for (const [key, s] of Object.entries(statusMap)) {
    const at = key.indexOf('|');
    if (s.status === 'working' && at > 0) out.add(key.slice(0, at));
  }
  return out;
}

/** What Release box… says goes with the box: its sessions, its checkouts, and anything not pushed. */
export function releaseLines(b: { name: string; sessions: number; checkouts: readonly string[] }): string[] {
  return [
    b.sessions > 0 ? `Its ${sessionsWord(b.sessions)} end, and their chats stay in Archived.` : 'It has no sessions.',
    b.checkouts.length ? `Its checkouts go: ${b.checkouts.join(', ')}.` : 'It has no checkouts.',
    `Anything not pushed on ${b.name} is lost.`,
  ];
}
