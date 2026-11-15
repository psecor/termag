/**
 * Runs on: Auto: which box a New session goes on when
 * the person doesn't pick one, and why, in words. Pure: routes/boxPlacement.ts
 * reads the boxes, their samples, the person's checkouts and the warm pool,
 * and this decides. Heat is spawn's (services/spawnLimits.ts boxHeat and
 * boxSlotsLeft, against the agent-spawn-limits thresholds), so the two never
 * disagree about which box is busy.
 *
 * Reuse first, the first that applies:
 *   1. an up box that isn't hot and has the repo set, most recently used first;
 *   2. your last box (the one your most recently active session is on), up and not hot;
 *   3. another up box that isn't hot, coolest first;
 *   4. a box of yours that is asleep (stopped or hibernated) or already waking,
 *      the repo set first: it wakes at Send;
 *   5. New box: from the warm pool when one is free, else a cold launch.
 * Fresh first: New box, with your boxes still listed.
 */
import { boxHeat, boxSlotsLeft, type BoxReading, type SpawnLimits } from './spawnLimits';

export const BOX_PLACEMENT_FLAG = 'box-placement-enabled';
export const BOX_PLACEMENT_POLICY_FLAG = 'box-placement-policy';

export const PLACEMENT_POLICIES = ['reuse-first', 'fresh-first'] as const;
export type PlacementPolicy = typeof PLACEMENT_POLICIES[number];
export const DEFAULT_PLACEMENT_POLICY: PlacementPolicy = 'reuse-first';

export function isPlacementPolicy(v: unknown): v is PlacementPolicy {
  return typeof v === 'string' && (PLACEMENT_POLICIES as readonly string[]).includes(v);
}

/** Up, once its agent is connected now too: `ready` only says it connected once (PlacementBoxInput.connected). */
export const UP_STATUSES: readonly string[] = ['ready'];
/** On its way up: a launch, an external box's first connect, or a start. Never started twice. */
export const WAKING_STATUSES: readonly string[] = ['provisioning', 'awaiting-agent', 'starting'];
/** Asleep: a start wakes it (services/boxPowerPolicy.ts POWER_TRANSITIONS start). */
export const ASLEEP_STATUSES: readonly string[] = ['stopped', 'hibernated'];
/** On its way down: it is started again once it is down. */
export const GOING_DOWN_STATUSES: readonly string[] = ['stopping', 'hibernating'];
/** Every status a box is listed under in the picker; failed, terminated, quarantined and the pools' are not. */
export const LISTED_STATUSES: readonly string[] = [...UP_STATUSES, ...WAKING_STATUSES, ...ASLEEP_STATUSES, ...GOING_DOWN_STATUSES];

export type Heat = 'ok' | 'warm' | 'hot' | 'unknown';

export interface PlacementBoxInput {
  reading: BoxReading;
  /** What agent-spawn-limits serves for this owner on this box. */
  limits: SpawnLimits;
  status: string;
  /**
   * Its agent is connected now. A `ready` box whose agent dropped can't take a
   * session (the create answers that the agent is offline), so it is never up
   * here and never Auto's pick; it stays listed.
   */
  connected: boolean;
  /** Whether a start would be taken: an EC2 box with an instance (canStartBox in the browser). */
  startable: boolean;
  /** The person's sessions on it: their non-archived projects there. */
  sessions: number;
  /** A checkout of the requested repositories on it, most recently active first; null when none. */
  checkoutProjectId: string | null;
  /** When the person last used a session on it; null when never. */
  lastUsedAt: Date | null;
}

export interface PlacementInput {
  policy: PlacementPolicy;
  policySource: 'personal' | 'org';
  boxes: readonly PlacementBoxInput[];
  /** The requested repositories' names (the part after the owner), for "has termag + termag-desktop". */
  repoNames: readonly string[];
  /** A warm-pool box is free for the size: New box would be claimed, not launched. */
  poolFree: boolean;
  now: number;
}

export interface PlacementBoxView {
  instanceId: string;
  name: string;
  status: string;
  /** Its agent is connected now; a `ready` box that isn't is offline. */
  connected: boolean;
  heat: Heat;
  /** boxHeat's, hot first: "memory 91% (limit 85%)"; and a full box's capacity. */
  heatReasons: string[];
  /** The tightest of memory, disk and load against its hot threshold (1 is the threshold); null with no recent sample. */
  load: number | null;
  sessions: number;
  hasRepos: boolean;
  checkoutProjectId: string | null;
  lastUsedAt: string | null;
}

export type Recommended =
  | { kind: 'box'; instanceId: string; reason: string[] }
  | { kind: 'new'; source: 'pool' | 'cold'; reason: string[] };

export interface PlacementView {
  policy: PlacementPolicy;
  policySource: 'personal' | 'org';
  recommended: Recommended;
  boxes: PlacementBoxView[];
  newBox: { source: 'pool' | 'cold' };
}

/** The box's heat now: hot over a threshold or at its agent capacity, warm at 80% of one, unknown with no recent sample. */
export function heatOf(b: PlacementBoxInput, now: number): { heat: Heat; reasons: string[] } {
  const h = boxHeat(b.reading, b.limits, now);
  const full = boxSlotsLeft(b.reading, b.limits) === 0
    ? [`at its agent capacity (${b.reading.liveAgents}/${b.limits.boxCapacity})`] : [];
  if (h.hot.length || full.length) return { heat: 'hot', reasons: [...h.hot, ...full, ...h.warm] };
  if (h.unknown) return { heat: 'unknown', reasons: [] };
  if (h.warm.length) return { heat: 'warm', reasons: h.warm };
  return { heat: 'ok', reasons: [] };
}

/** The tightest of memory, disk and load per core against its threshold, or null with no usable sample. */
export function loadOf(b: PlacementBoxInput, now: number): number | null {
  const r = b.reading;
  if (!r.sampledAt || boxHeat(r, b.limits, now).unknown) return null;
  const parts: number[] = [];
  if (r.memUsedPct !== null) parts.push(r.memUsedPct / b.limits.hot.memPct);
  if (r.diskUsedPct !== null) parts.push(r.diskUsedPct / b.limits.hot.diskPct);
  if (r.cores && r.load1 !== null) parts.push(r.load1 / r.cores / b.limits.hot.loadPerCore);
  return parts.length ? Math.round(Math.max(...parts) * 100) / 100 : null;
}

/** "memory 72% (limit 85%)" as the reason says it: "memory 72%". */
const bare = (reason: string) => reason.replace(/\s*\(limit [^)]*\)$/, '');

/** "has termag", "has termag + termag-desktop"; null with no repository asked for. */
export function hasReposWords(names: readonly string[]): string | null {
  return names.length ? `has ${names.join(' + ')}` : null;
}

const NEW_WORDS = { pool: 'a ready box from the pool', cold: 'a new box · takes a few minutes' } as const;

function heatWords(heat: { heat: Heat; reasons: string[] }): string {
  if (heat.heat === 'warm') return `busy: ${heat.reasons.map(bare).join(', ')}`;
  if (heat.heat === 'unknown') return 'no recent reading';
  return 'room to spare';
}

/**
 * Decide. Every box the person has that can take a session is listed, hot
 * ones last (they stay pickable); the recommendation follows the policy.
 */
export function placeSession(i: PlacementInput): PlacementView {
  const source = i.poolFree ? 'pool' : 'cold';
  // Only an up box's sample says anything: one asleep, offline or on its way has none worth reading.
  const isUp = (b: PlacementBoxInput) => UP_STATUSES.includes(b.status) && b.connected;
  const rows = i.boxes.map(b => isUp(b)
    ? { b, heat: heatOf(b, i.now), load: loadOf(b, i.now) }
    : { b, heat: { heat: 'unknown' as Heat, reasons: [] as string[] }, load: null });
  const used = (r: typeof rows[number]) => r.b.lastUsedAt?.getTime() ?? -Infinity;
  const byRecent = (a: typeof rows[number], c: typeof rows[number]) => used(c) - used(a);
  const lastBox = rows.filter(r => r.b.lastUsedAt).sort(byRecent)[0] ?? null;
  const repos = hasReposWords(i.repoNames);
  const up = rows.filter(r => isUp(r.b));
  const cool = up.filter(r => r.heat.heat !== 'hot');

  const boxPick = (r: typeof rows[number], state: string): Recommended => ({
    kind: 'box',
    instanceId: r.b.reading.id,
    reason: [r === lastBox ? 'Last used' : null, r.b.checkoutProjectId ? repos : null, state].filter((w): w is string => !!w),
  });
  const newPick = (lead: string | null): Recommended => ({ kind: 'new', source, reason: [lead, NEW_WORDS[source]].filter((w): w is string => !!w) });

  let recommended: Recommended;
  if (i.policy === 'fresh-first') {
    recommended = newPick('your default is a fresh box');
  } else {
    const withRepos = cool.filter(r => r.b.checkoutProjectId).sort(byRecent)[0];
    const last = lastBox && cool.includes(lastBox) ? lastBox : undefined;
    // Coolest first; a box with no recent reading counts as not hot, after the ones that have one.
    const coolest = [...cool].sort((a, c) => (a.load ?? Infinity) - (c.load ?? Infinity))[0];
    const upPick = withRepos ?? last ?? coolest;
    const sleeping = rows
      .filter(r => (ASLEEP_STATUSES.includes(r.b.status) && r.b.startable) || WAKING_STATUSES.includes(r.b.status))
      .sort((a, c) => Number(!!c.b.checkoutProjectId) - Number(!!a.b.checkoutProjectId) || byRecent(a, c))[0];
    if (upPick) recommended = boxPick(upPick, heatWords(upPick.heat));
    else if (sleeping) recommended = boxPick(sleeping, ASLEEP_STATUSES.includes(sleeping.b.status) ? 'asleep · wakes when you start' : 'waking up');
    else recommended = newPick(up.length ? 'your boxes are busy' : null);
  }

  // Up and cool first, then waking, then asleep, offline and going down, then hot; recent first within each.
  const rank = (r: typeof rows[number]) => r.heat.heat === 'hot' ? 3
    : isUp(r.b) ? 0 : WAKING_STATUSES.includes(r.b.status) ? 1 : 2;
  const boxes = [...rows].sort((a, c) => rank(a) - rank(c) || byRecent(a, c)).map(r => ({
    instanceId: r.b.reading.id,
    name: r.b.reading.name,
    status: r.b.status,
    connected: r.b.connected,
    heat: r.heat.heat,
    heatReasons: r.heat.reasons,
    load: r.load,
    sessions: r.b.sessions,
    hasRepos: !!r.b.checkoutProjectId,
    checkoutProjectId: r.b.checkoutProjectId,
    lastUsedAt: r.b.lastUsedAt?.toISOString() ?? null,
  }));
  return { policy: i.policy, policySource: i.policySource, recommended, boxes, newBox: { source } };
}

/**
 * A project's repository set as lower-case owner/name keys, sorted, for
 * comparing with what New session asked for: one repository's project, or a
 * multi-repo project's repos. Null for a project with no repository.
 */
export function repoSetKey(keys: ReadonlyArray<string | null>): string | null {
  const ok = keys.filter((k): k is string => !!k).map(k => k.toLowerCase());
  return ok.length ? [...new Set(ok)].sort().join(' ') : null;
}
