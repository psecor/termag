// The redesigned sidebar's Sort (a View option,
// user-projects-enabled): Created, the order it has always had, or Recent
// activity. Created is what the list's code sorts by: a session's
// Workstream.lastActiveAt, which is set when the session is made and never
// moved, so newest first; a project by its checkouts' activity; a status in
// its fixed order and a space by name. Recent activity puts each session by
// its own activity, newest first, and each group by its most recently active
// session, in every grouping. Pinned (a working set the person chose) and
// Needs you (longest wait first, so a new one joins at the end and nothing
// moves) keep their own orders.
//
// A session's activity is the newest of when it started, when its last turn
// ended (AgentStatus.stoppedAt) and the time its card shows (when it entered
// its status, AgentStatus.statusSince), these two once it has a status of its
// own; its project's time only when it has none of them, so a sibling's
// activity never lifts it (#1812's rule). Not running's time is when its box
// parked or its process went, not anything done in it, so it doesn't count. A
// working session is active now: working ones come first, the one that most
// recently started working (or was started) first, so two of them don't trade
// places on every status write.
//
// A list that reorders under the pointer is hard to use, so ProjectsList holds
// its order while it's in use (useSteadyOrder.ts): holdOrder keeps the order
// shown and slots in what's new. Pure, so it's tested on its own.

export type SidebarSort = 'created' | 'recent';
export const SIDEBAR_SORTS: readonly SidebarSort[] = ['created', 'recent'];
export const DEFAULT_SIDEBAR_SORT: SidebarSort = 'created';

/** How recently a session was active: a working one is active now; `at` is in ms, -Infinity when unknown. */
export interface Activity { working: boolean; at: number }

export interface ActivityFacts {
  /** Its state, as its mark says (chat/rowState.ts): working is active now, and not running's time isn't activity. */
  state: 'working' | 'off' | 'other';
  /** When it started (its Workstream.lastActiveAt), in ms. */
  startedAt: number | null;
  /**
   * Its own status, in ms: the time its card shows and when its last turn ended. Null with none: a
   * row without one carries its project's time, which is a sibling's.
   */
  status: { since: number | null; stoppedAt: number | null } | null;
  /** Its project's time (any of its sessions'), in ms: only for a session with no time of its own. */
  projectAt: number | null;
}

const known = (t: number | null | undefined): t is number => t != null && Number.isFinite(t);

export function activityOf(f: ActivityFacts): Activity {
  const own = [f.startedAt, f.status?.stoppedAt, f.state === 'off' ? null : f.status?.since].filter(known);
  const at = own.length ? Math.max(...own) : known(f.projectAt) ? f.projectAt : -Infinity;
  return { working: f.state === 'working', at };
}

/**
 * Most recent first: a working session, then the newer time. Between two working sessions that's the one that
 * started working (or was started) later: `at` is then its working status's time, which doesn't move while it works.
 * 0 for a tie, which keeps the order given.
 */
export function compareActivity(a: Activity, b: Activity): number {
  if (a.working !== b.working) return a.working ? -1 : 1;
  if (a.at === b.at) return 0;
  return a.at > b.at ? -1 : 1;
}

/** The rows, most recently active first; a tie keeps its order (the sort is stable). */
export function sortByActivity<R>(rows: readonly R[], of: (row: R) => Activity): R[] {
  const keyed = rows.map(r => ({ r, a: of(r) }));
  return keyed.sort((x, y) => compareActivity(x.a, y.a)).map(x => x.r);
}

/** The most recent of the rows' activity; null for none. */
export function newestActivity<R>(rows: readonly R[], of: (row: R) => Activity): Activity | null {
  let best: Activity | null = null;
  for (const r of rows) {
    const a = of(r);
    if (!best || compareActivity(a, best) < 0) best = a;
  }
  return best;
}

export interface GroupSortOptions<G> {
  /** Kept above the rest, in their own order (a pinned project). */
  first?: (group: G) => boolean;
  /** Kept below the rest, in their own order (No space). */
  last?: (group: G) => boolean;
  /** A group with no session listed: its own time (an empty project's), in ms; null puts it after those with one. */
  emptyAt?: (group: G) => number | null;
}

/** Groups by their most recently active session; a tie, and a group with no time at all, keep the order given. */
export function sortGroupsByActivity<G, R>(
  groups: readonly G[],
  rowsOf: (group: G) => readonly R[],
  of: (row: R) => Activity,
  opts: GroupSortOptions<G> = {},
): G[] {
  const keyOf = (g: G): Activity => newestActivity(rowsOf(g), of) ?? { working: false, at: opts.emptyAt?.(g) ?? -Infinity };
  const band = (g: G) => (opts.first?.(g) ? 0 : opts.last?.(g) ? 2 : 1);
  const keyed = groups.map(g => ({ g, band: band(g), a: keyOf(g) }));
  return keyed.sort((x, y) => x.band - y.band || compareActivity(x.a, y.a)).map(x => x.g);
}

/**
 * `live` in `held`'s order: each key `held` has keeps its place there, and a
 * key it lacks goes right after the key before it in `live` (first, with none
 * before it). A key gone from `live` is dropped. No `held`: `live` as it is.
 */
export function holdOrder(live: readonly string[], held: readonly string[] | null | undefined): string[] {
  if (!held) return [...live];
  const rank = new Map(held.map((k, i) => [k, i]));
  const kept = live.filter(k => rank.has(k)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const k of live) {
    if (rank.has(k)) anchor = k;
    else after.set(anchor, [...(after.get(anchor) ?? []), k]);
  }
  const out = [...(after.get(null) ?? [])];
  for (const k of kept) out.push(k, ...(after.get(k) ?? []));
  return out;
}

/** The list's order: its groups' keys, and each group's sessions' keys. */
export interface ListOrder { groups: readonly string[]; rows: Readonly<Record<string, readonly string[]>> }

/** holdOrder for the groups and for each group's rows. */
export function holdListOrder(live: ListOrder, held: ListOrder | null): ListOrder {
  if (!held) return live;
  const rows: Record<string, string[]> = {};
  for (const [g, keys] of Object.entries(live.rows)) rows[g] = holdOrder(keys, held.rows[g]);
  return { groups: holdOrder(live.groups, held.groups), rows };
}

const sameKeys = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((k, i) => k === b[i]));

export function sameListOrder(a: ListOrder | null, b: ListOrder | null): boolean {
  if (a === b) return true;
  if (!a || !b || !sameKeys(a.groups, b.groups)) return false;
  const ga = Object.keys(a.rows);
  if (ga.length !== Object.keys(b.rows).length) return false;
  return ga.every(g => sameKeys(a.rows[g], b.rows[g]));
}
