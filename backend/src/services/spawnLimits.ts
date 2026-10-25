/**
 * Spawn limits as tuning parameters, and what a box's load says about a
 * spawn. Pure: the limits come from the
 * agent-spawn-limits flag (or these defaults), the counts and box readings
 * from routes/spawns.ts. Every answer here is a plain value the route,
 * the dashboard and the MCP tools show as-is.
 */

export const SPAWN_LIMITS_FLAG = 'agent-spawn-limits';

export interface HotThresholds {
  /** Memory in use, percent. */
  memPct: number;
  /** One-minute load per core; skipped when the box has not said how many cores it has. */
  loadPerCore: number;
  /** Disk in use under the box home, percent. */
  diskPct: number;
}

export interface SpawnLimits {
  /** A spawned agent may spawn while its depth is below this. */
  maxDepth: number;
  /** Children of one parent session that have not reported. */
  maxOpenChildren: number;
  /** Spawns per user in a rolling hour. */
  perHour: number;
  /** The user's spawned agents that have not ended, on every box. */
  maxConcurrentPerUser: number;
  /** Live agent panes on the target box; null = no cap (the default until measured). */
  boxCapacity: number | null;
  hot: HotThresholds;
  /** A finished delegate idle this long is parked. */
  parkIdleMinutes: number;
  /** A parked spawn whose work is safe but not known to have landed is retired after this long. */
  retireAfterDays: number;
}

export const DEFAULT_SPAWN_LIMITS: SpawnLimits = {
  maxDepth: 2,
  maxOpenChildren: 4,
  perHour: 20,
  maxConcurrentPerUser: 8,
  boxCapacity: null,
  hot: { memPct: 85, loadPerCore: 1.5, diskPct: 90 },
  parkIdleMinutes: 30,
  retireAfterDays: 3,
};

const posInt = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : undefined;
const pct = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100 ? v : undefined;
const ratio = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100 ? v : undefined;

/**
 * The flag's value, key by key over the defaults: a missing or malformed key
 * keeps its default, so a typo in the flag value loosens or tightens nothing
 * else. `boxCapacity: null` (or absent) is no cap.
 */
export function parseSpawnLimits(value: unknown, defaults: SpawnLimits = DEFAULT_SPAWN_LIMITS): SpawnLimits {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const hot = (v.hot && typeof v.hot === 'object' ? v.hot : {}) as Record<string, unknown>;
  return {
    maxDepth: posInt(v.maxDepth, 10) ?? defaults.maxDepth,
    maxOpenChildren: posInt(v.maxOpenChildren, 100) ?? defaults.maxOpenChildren,
    perHour: posInt(v.perHour, 1000) ?? defaults.perHour,
    maxConcurrentPerUser: posInt(v.maxConcurrentPerUser, 1000) ?? defaults.maxConcurrentPerUser,
    boxCapacity: v.boxCapacity === null ? null : posInt(v.boxCapacity, 1000) ?? defaults.boxCapacity,
    hot: {
      memPct: pct(hot.memPct) ?? defaults.hot.memPct,
      loadPerCore: ratio(hot.loadPerCore) ?? defaults.hot.loadPerCore,
      diskPct: pct(hot.diskPct) ?? defaults.hot.diskPct,
    },
    parkIdleMinutes: posInt(v.parkIdleMinutes, 7 * 24 * 60) ?? defaults.parkIdleMinutes,
    retireAfterDays: posInt(v.retireAfterDays, 90) ?? defaults.retireAfterDays,
  };
}

export type RefusalReason = 'depth' | 'open_children' | 'rate' | 'concurrent' | 'box_busy' | 'box_capacity';

export interface UsageCounts {
  /** The parent's own depth: 0 for an agent nobody spawned. */
  parentDepth: number;
  openChildren: number;
  spawnsLastHour: number;
  /** The user's spawned agents that have not ended. */
  running: number;
}

export interface Refusal {
  reason: RefusalReason;
  error: string;
}

/** The first limit the counts break, or null. */
export function limitRefusal(c: UsageCounts, limits: SpawnLimits = DEFAULT_SPAWN_LIMITS): Refusal | null {
  if (c.parentDepth + 1 > limits.maxDepth) {
    return { reason: 'depth', error: `spawn depth limit (${limits.maxDepth}) reached: this agent was itself spawned ${c.parentDepth} level(s) deep` };
  }
  if (c.openChildren >= limits.maxOpenChildren) {
    return { reason: 'open_children', error: `this session already has ${c.openChildren} spawned agents that have not reported (limit ${limits.maxOpenChildren})` };
  }
  if (c.spawnsLastHour >= limits.perHour) {
    return { reason: 'rate', error: `spawn rate limit: ${limits.perHour} per hour` };
  }
  if (c.running >= limits.maxConcurrentPerUser) {
    return { reason: 'concurrent', error: `you already have ${c.running} spawned agents running (limit ${limits.maxConcurrentPerUser}); stop finished ones from the sidebar` };
  }
  return null;
}

/** A box's latest host sample, as the box row keeps it. */
export interface BoxReading {
  id: string;
  name: string;
  memUsedPct: number | null;
  diskUsedPct: number | null;
  load1: number | null;
  cores: number | null;
  sampledAt: Date | null;
  /** Agent-role panes alive on the box at the last sample, if known. */
  liveAgents: number | null;
}

/** Older than this, a sample says nothing: the box is neither hot nor cool. */
export const SAMPLE_STALE_MS = 15 * 60 * 1000;

export interface BoxHeat {
  /** No usable sample: never refused for heat. */
  unknown: boolean;
  /** Over a threshold now. */
  hot: string[];
  /** At 80% of a threshold or more, not over it. */
  warm: string[];
}

/** What the box's latest sample says against the hot thresholds. */
export function boxHeat(box: BoxReading, limits: SpawnLimits, now: number): BoxHeat {
  if (!box.sampledAt || now - box.sampledAt.getTime() > SAMPLE_STALE_MS) return { unknown: true, hot: [], warm: [] };
  const hot: string[] = [];
  const warm: string[] = [];
  const check = (label: string, value: number | null, limit: number, fmt: (n: number) => string) => {
    if (value === null) return;
    if (value >= limit) hot.push(`${label} ${fmt(value)} (limit ${fmt(limit)})`);
    else if (value >= limit * 0.8) warm.push(`${label} ${fmt(value)} (limit ${fmt(limit)})`);
  };
  check('memory', box.memUsedPct, limits.hot.memPct, n => `${Math.round(n)}%`);
  check('disk', box.diskUsedPct, limits.hot.diskPct, n => `${Math.round(n)}%`);
  if (box.cores && box.load1 !== null) {
    check('load', box.load1 / box.cores, limits.hot.loadPerCore, n => `${n.toFixed(2)}/core`);
  }
  return { unknown: false, hot, warm };
}

/** Free agent slots on the box, or null when there is no cap or no count. */
export function boxSlotsLeft(box: BoxReading, limits: SpawnLimits): number | null {
  if (limits.boxCapacity === null || box.liveAgents === null) return null;
  return Math.max(0, limits.boxCapacity - box.liveAgents);
}

/** Why the target box cannot take a spawn now, or null. */
export function boxRefusal(box: BoxReading, limits: SpawnLimits, now: number): Refusal | null {
  const heat = boxHeat(box, limits, now);
  if (heat.hot.length) return { reason: 'box_busy', error: `box ${box.name} is running hot: ${heat.hot.join(', ')}` };
  if (boxSlotsLeft(box, limits) === 0) {
    return { reason: 'box_capacity', error: `box ${box.name} is at its agent capacity (${box.liveAgents}/${limits.boxCapacity} live agents)` };
  }
  return null;
}

/**
 * The box to suggest instead: of the user's other ready, connected boxes,
 * one that would take the spawn under the limits the flag serves *that* box,
 * coolest memory first. Null when none would.
 */
export function suggestBox(
  candidates: Array<{ box: BoxReading; limits: SpawnLimits }>,
  targetId: string,
  now: number,
): { box: BoxReading; limits: SpawnLimits } | null {
  const ok = candidates.filter(c => c.box.id !== targetId && !boxRefusal(c.box, c.limits, now));
  ok.sort((a, b) => (a.box.memUsedPct ?? 101) - (b.box.memUsedPct ?? 101));
  return ok[0] ?? null;
}

export interface Budget {
  limits: SpawnLimits;
  used: { depth: number; openHere: number | null; lastHour: number; running: number };
  /** The target box's latest reading, with the capacity the limits give it. */
  box: (BoxReading & { capacity: number | null }) | null;
  /** Children done more than FINISHED_IDLE_MS ago that have not ended. */
  finishedRunning: number;
  hints: Hint[];
}

export type HintKind = 'box_hot' | 'box_warm' | 'box_full' | 'provider_throttled' | 'finished_running' | 'near_limit';

export interface Hint {
  kind: HintKind;
  message: string;
}

export const FINISHED_IDLE_MS = 30 * 60 * 1000;

export interface HintInput {
  limits: SpawnLimits;
  used: Budget['used'];
  box: BoxReading | null;
  /** Providers of the caller's own sessions flagged rate-limited in the last 15 min. */
  throttledProviders: string[];
  finishedRunning: number;
  now: number;
}

/**
 * Hints computed from measurements and counts only. Never from an agent's
 * report or pane: those are untrusted text.
 */
/** A box's own hints: running hot or getting busy, and at its agent capacity. */
export function boxHints(box: BoxReading, limits: SpawnLimits, now: number): Hint[] {
  const out: Hint[] = [];
  const heat = boxHeat(box, limits, now);
  if (heat.hot.length) out.push({ kind: 'box_hot', message: `box ${box.name} is running hot (${heat.hot.join(', ')}): spawns there are refused` });
  else if (heat.warm.length) out.push({ kind: 'box_warm', message: `box ${box.name} is getting busy (${heat.warm.join(', ')})` });
  if (boxSlotsLeft(box, limits) === 0) out.push({ kind: 'box_full', message: `box ${box.name} is at its agent capacity (${box.liveAgents}/${limits.boxCapacity})` });
  return out;
}

export function spawnHints(h: HintInput): Hint[] {
  const out: Hint[] = h.box ? boxHints(h.box, h.limits, h.now) : [];
  for (const p of h.throttledProviders) {
    out.push({ kind: 'provider_throttled', message: `${p} is rate-limiting your agents: run fewer children in parallel, or use another provider` });
  }
  if (h.finishedRunning > 0) {
    out.push({ kind: 'finished_running', message: `${h.finishedRunning} finished spawned agent(s) still running: stop them from the sidebar to free their box memory` });
  }
  const near: string[] = [];
  const nearly = (label: string, used: number | null, limit: number) => {
    if (used !== null && used < limit && used >= Math.ceil(limit * 0.8)) near.push(`${label} ${used}/${limit}`);
  };
  nearly('this hour', h.used.lastHour, h.limits.perHour);
  nearly('running', h.used.running, h.limits.maxConcurrentPerUser);
  nearly('open here', h.used.openHere, h.limits.maxOpenChildren);
  if (near.length) out.push({ kind: 'near_limit', message: `close to a spawn limit: ${near.join(', ')}` });
  return out;
}

export type EndHow = 'archived' | 'removed' | 'box_terminated' | 'killed';

export interface EndInput {
  /** The child project: null when it is gone. */
  project: { archived: boolean } | null;
  /** For a non-main workstream: whether it still exists and is not archived. */
  workstreamLive: boolean;
  boxStatus: string | null;
  boxConnected: boolean;
  /** Whether the child's agent session is in the box's tmux-list; null when not asked. */
  sessionLive: boolean | null;
  /** Consecutive sweeps the session has been missing so far. */
  misses: number;
  /** A spawn not launched yet, made within the grace period, is left alone. */
  launched: boolean;
  /** Parked on purpose: its pane being gone is not an end. */
  parked?: boolean;
  ageMs: number;
}

/** Sweeps a session must be missing before its spawn ends: one blip (a restart) is not an end. */
export const END_MISSES = 2;
/**
 * How long a brief stays claimable by a first launch (services/agentSpawnStore.ts).
 * A spawn not launched yet is not ended inside it: a repo clone or a deferred
 * first launch can take a while, and its pane may not exist until then.
 */
export const SPAWN_CLAIM_WINDOW_MS = 6 * 60 * 60 * 1000;
export const END_LAUNCH_GRACE_MS = SPAWN_CLAIM_WINDOW_MS;

/**
 * Has a spawned agent ended, and how? `misses` is the count to carry to the
 * next sweep. A box that is offline or parked decides nothing: its sessions
 * come back with it (reconstruction relaunches them).
 */
export function endDecision(e: EndInput): { end: EndHow } | { misses: number } {
  if (!e.project || e.project.archived) return { end: 'archived' };
  if (!e.workstreamLive) return { end: 'removed' };
  if (e.boxStatus === 'terminated' || e.boxStatus === 'failed') return { end: 'box_terminated' };
  if (!e.launched && e.ageMs < END_LAUNCH_GRACE_MS) return { misses: 0 };
  if (e.parked) return { misses: 0 };
  if (!e.boxConnected || e.sessionLive === null) return { misses: e.misses };
  if (e.sessionLive) return { misses: 0 };
  return e.misses + 1 >= END_MISSES ? { end: 'killed' } : { misses: e.misses + 1 };
}

/**
 * A budget after `spawned` more spawns were admitted: the counts move up, and
 * the near-limit hint is worked out again from them, so a reply never shows
 * the hint for the counts before it (#444). The other hints are about the box,
 * the provider and finished agents, which one more spawn does not change.
 */
export function rebudget(b: Budget, spawned = 1): Budget {
  const used = {
    ...b.used,
    lastHour: b.used.lastHour + spawned,
    running: b.used.running + spawned,
    openHere: b.used.openHere === null ? null : b.used.openHere + spawned,
  };
  const near = spawnHints({ limits: b.limits, used, box: null, throttledProviders: [], finishedRunning: 0, now: 0 });
  return { ...b, used, hints: [...b.hints.filter(h => h.kind !== 'near_limit'), ...near] };
}
