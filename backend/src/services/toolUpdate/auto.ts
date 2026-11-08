/**
 * Automatic tool updates (phase 3): which run, if
 * any, the sweep gives one box for one tool. Pure, so the table is a unit test
 * (auto.test.ts), as boxUpdateDecision is box-update's; autoRuns.ts gathers
 * the facts, writes the runs and hands them to the fleet pacer.
 *
 * In order: a box below the floor gets a `floor` run now, restart idle, and
 * force once it has been below that floor for the policy's forceAfterHours,
 * unless a floor run of that breach reached the box and failed: then it stays
 * idle until the breach ends. A
 * box resumed from hibernation, or started from stopped and behind
 * (coldStart.ts), gets a `resume` run on its first hello after it.
 * Otherwise a box gets at most one run in 24 hours, a `nightly` one, when
 * it is quiet: its activity clock an hour old and, where the owner's time zone
 * is known, the owner's night. A box due for 24 hours and never quiet in them
 * gets the nightly run anyway, restart idle. The tool-auto-update-schedule
 * flag can move the night, the 24 hours and the hour, per owner, for testing
 * (NightlySchedule); nothing else.
 */
import { compareToReference } from './fleet';
import type { ClaudeUpdateRestart } from '../claudeUpdatePolicy';
import type { RunTrigger } from './run';

const HOUR = 3600_000;
/** At most one nightly run per box and tool in this long. */
export const NIGHTLY_EVERY_MS = 24 * HOUR;
/** A box is quiet once its activity clock (Instance.lastActivityAt) is this old. */
export const QUIET_AFTER_MS = HOUR;
/** A box due this long and never quiet in it gets its nightly run anyway. */
export const NEVER_QUIET_MS = 24 * HOUR;
/** A box still below the floor this soon after a run is left for that run's report and inventory refresh. */
export const FLOOR_RETRY_MS = HOUR;
/**
 * A box no pass has looked at for this long (the tool's flag was off, no
 * leader ran) starts its nightly clock again at this pass, as its force clock
 * does (BREACH_GAP_MS; Bugbot on #1163).
 */
export const SEEN_GAP_MS = HOUR;

/** When the nightly clock of a box with no run starts: the first pass of an unbroken run of passes. */
export function nightlyClockStart(prev: { firstSeenAt: Date; lastSeenAt: Date | null } | null, now: Date): Date {
  if (!prev || !prev.lastSeenAt || now.getTime() - prev.lastSeenAt.getTime() > SEEN_GAP_MS) return now;
  return prev.firstSeenAt;
}

/** A run asked for that never reached the box: its trigger and when. */
export interface UnreachedAttempt { trigger: string; at: Date }

/** The longest a trigger backs off after runs that never reached the box. */
export const BACKOFF_MAX_MS = 24 * HOUR;

/**
 * Until when `trigger` waits after its unreached attempts (those since
 * `since`, when given: a resume counts only the ones for its own marker), or
 * null with none: `n` of them hold it min(2^(n-1), 24) hours after the newest.
 */
export function backoffUntil(attempts: readonly UnreachedAttempt[], trigger: string, since?: Date | null): number | null {
  const mine = attempts.filter(a => a.trigger === trigger && (!since || a.at.getTime() > since.getTime()));
  if (!mine.length) return null;
  const newest = Math.max(...mine.map(a => a.at.getTime()));
  return newest + Math.min(HOUR * 2 ** (mine.length - 1), BACKOFF_MAX_MS);
}

/** A floor run's row, as the sweep reads it to tell whether it brought the box to the floor. */
export interface FloorRunRow { requestedAt: Date; startedAt: Date | null; status: string; outcome: string | null; fromVersion: string | null; toVersion: string | null }

/**
 * Whether a floor run that reached the box left it below `floor`: it
 * reported `failed`; or it reported anything else (`updated`, `partial`,
 * `current`) with its resulting version (toVersion, else fromVersion) still
 * below the floor; or it started and never reported (`running` past its
 * stale age). A run still in flight is not counted: the sweep skips the box
 * for it already. A run that did bring the box to the floor ends the breach.
 */
export function failedFloorRun(r: FloorRunRow, floor: string, inFlight: boolean): boolean {
  if (!r.startedAt || inFlight) return false;
  if (r.outcome === 'failed') return true;
  if (!r.outcome) return r.status === 'running';
  return belowFloor(r.toVersion ?? r.fromVersion, floor);
}

/** A resume marker older than this is not a resume any more: the nightly run covers the box. */
export const RESUME_MARKER_MAX_MS = 24 * HOUR;
/** A resume backed off this close to its marker's end gets one last attempt first (Devin on #1163). */
export const RESUME_LAST_CHANCE_MS = HOUR;

/**
 * Until when a resume waits after its marker's unreached attempts: their
 * backoff, but never past the marker's last hour, so a resume backed off for
 * long still gets one attempt before RESUME_MARKER_MAX_MS ends it. Once that
 * last attempt is made, its backoff applies as it is.
 */
export function resumeHold(attempts: readonly UnreachedAttempt[], marker: Date | null): number | null {
  const until = backoffUntil(attempts, 'resume', marker);
  if (until === null || !marker) return until;
  const lastChance = marker.getTime() + RESUME_MARKER_MAX_MS - RESUME_LAST_CHANCE_MS;
  const triedLast = attempts.some(a => a.trigger === 'resume' && a.at.getTime() >= lastChance);
  return triedLast ? until : Math.min(until, lastChance);
}

/**
 * Whether a resume marker still asks for a run: it is under a day old and no
 * run of the tool came after it (that run already updated what the resume
 * brought back). A marker left while the flag was off is spent this way too.
 */
export function resumePending(marker: Date | null, lastRunAt: Date | null, now: number): boolean {
  if (!marker || now - marker.getTime() >= RESUME_MARKER_MAX_MS) return false;
  return !lastRunAt || lastRunAt.getTime() < marker.getTime();
}

/** The owner's night, in their own zone: from this hour, inclusive... */
export const NIGHT_FROM_HOUR = 0;
/** ...to this one, exclusive. */
export const NIGHT_TO_HOUR = 6;

/**
 * When the nightly runs go, per owner: the night window (in the owner's
 * zone; it may wrap past midnight), the time between nightly runs and the
 * quiet time. The tool-auto-update-schedule flag can move them, to watch
 * nightly runs in the daytime ("Automatic: testing
 * the nightly runs in the daytime"); floor and resume runs, the force clock, the
 * backoffs and the pacer never read it.
 */
export interface NightlySchedule { nightFromHour: number; nightToHour: number; everyMs: number; quietMs: number }
export const DEFAULT_NIGHTLY_SCHEDULE: NightlySchedule = Object.freeze({ nightFromHour: NIGHT_FROM_HOUR, nightToHour: NIGHT_TO_HOUR, everyMs: NIGHTLY_EVERY_MS, quietMs: QUIET_AFTER_MS });
export const SCHEDULE_FLAG = 'tool-auto-update-schedule';
/** The interval's bounds, in hours, and the quiet time's, in minutes. */
export const SCHEDULE_EVERY_HOURS = { min: 1, max: 168 } as const;
export const SCHEDULE_QUIET_MINUTES = { min: 10, max: 1440 } as const;

const hourOfDay = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : undefined);
const within = (v: unknown, b: { min: number; max: number }): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= b.min && v <= b.max ? v : undefined);

/**
 * The flag's value over today's schedule, field by field: `nightFromHour`,
 * `nightToHour` (whole hours 0..23), `everyHours` (1..168), `quietMinutes`
 * (10..1440). A missing or invalid field keeps its default; a window whose
 * start equals its end (after the defaults fill in) keeps the default window.
 * Anything not an object is the default schedule.
 */
export function parseNightlySchedule(value: unknown): NightlySchedule {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_NIGHTLY_SCHEDULE;
  let from = hourOfDay(v.nightFromHour) ?? d.nightFromHour;
  let to = hourOfDay(v.nightToHour) ?? d.nightToHour;
  if (from === to) { from = d.nightFromHour; to = d.nightToHour; }
  const every = within(v.everyHours, SCHEDULE_EVERY_HOURS);
  const quiet = within(v.quietMinutes, SCHEDULE_QUIET_MINUTES);
  return {
    nightFromHour: from,
    nightToHour: to,
    everyMs: every === undefined ? d.everyMs : every * HOUR,
    quietMs: quiet === undefined ? d.quietMs : quiet * 60_000,
  };
}

/** Which of today's values a schedule moves: the window, the interval, the quiet time. */
export function scheduleOverrides(s: NightlySchedule): { window: boolean; every: boolean; quiet: boolean } {
  const d = DEFAULT_NIGHTLY_SCHEDULE;
  return { window: s.nightFromHour !== d.nightFromHour || s.nightToHour !== d.nightToHour, every: s.everyMs !== d.everyMs, quiet: s.quietMs !== d.quietMs };
}

/** A schedule as the [TOOL-AUTO] log line names it: `window 15–17, every 2 h, quiet 10 min`. */
export function scheduleText(s: NightlySchedule): string {
  return `window ${s.nightFromHour}–${s.nightToHour}, every ${s.everyMs / HOUR} h, quiet ${s.quietMs / 60_000} min`;
}

export type AutoSkip =
  | 'auto-off' | 'update-off' | 'offline' | 'settling' | 'not-capable' | 'run-in-flight'
  | 'floor-just-ran' | 'floor-failing' | 'backing-off' | 'current' | 'ran-recently' | 'not-quiet';
/** Why a run was made: the runs list and the MCP summary show it. */
export type AutoReason = 'below-floor' | 'below-floor-force' | 'below-floor-force-held' | 'resumed' | 'started' | 'quiet' | 'never-quiet' | 'no-sessions';
export type AutoDecision =
  | { run: true; trigger: Extract<RunTrigger, 'floor' | 'resume' | 'nightly'>; restart: ClaudeUpdateRestart; reason: AutoReason }
  | { run: false; skip: AutoSkip };

export interface AutoFacts {
  /** The tool's auto for the owner and the box: its policy's mode auto (gate.ts). */
  autoOn: boolean;
  /** Its enabled (mode not off), the prerequisite: off, a run would get restart none. */
  updateOn: boolean;
  /** The box is ready and its agent connected. */
  connected: boolean;
  /** It connected under a minute ago, outside its own hello pass: left for that pass (HELLO_SETTLE_MS). */
  settling: boolean;
  /** Its agent announces the tool's update capability. */
  capable: boolean;
  /** A run of the tool is in flight on it (run.ts isInFlight, or held by the pacer). */
  inFlight: boolean;
  /** The tool's version in the box's inventory; null when it has none or cannot read it. */
  version: string | null;
  /** The floor of the box's own policy. */
  floor: string;
  /**
   * What a current box runs, when it can be known here: the policy's exact
   * target, or the version the tool's latest is pinned to (the Cursor agent's
   * newest pinned build, pi's newest pinned version, components.ts
   * latestReference). Null for a channel the box resolves itself (npm's
   * latest), where only the box can tell.
   */
  reference: string | null;
  /** The policy's restart: `none` (Codex's and the Cursor agent's default) means no automatic run restarts a session. */
  policyRestart: ClaudeUpdateRestart;
  /**
   * The tool runs in no session (components.ts providers is empty: gh). Its
   * run stops nothing, so it needs no quiet window, never forces, and a
   * resume (sessions back on old binaries) asks nothing of it.
   */
  sessionless: boolean;
  /**
   * A floor breach may escalate to `force` after forceAfterHours. Off for a
   * tool whose force would restart everything at once (Node: the agent, and
   * every node-based session with #1166); its floor runs stay `idle`.
   */
  mayForce: boolean;
  forceAfterHours: number;
  /** Since when the sweep has seen the box below this floor (tool_auto_update_states). */
  breachSince: Date | null;
  /**
   * The box was resumed from hibernation (not a refresh resume), or started
   * from stopped (`resumeKind`), and has said hello since, with no run of the
   * tool after it (resumePending).
   */
  resumed: boolean;
  /**
   * Which start `resumed` is: a hibernation resume (the default), whose
   * sessions came back on the binaries they had, or a cold start
   * (coldStart.ts), whose sessions all died with the stop and which only
   * needs a run where the tool is behind.
   */
  resumeKind?: 'hibernation' | 'cold-start';
  /**
   * The newest run of the tool that reached the box (its policy fetch started
   * it), of any trigger but the runner guard's: the day's run. A run that
   * never reached the box (expired unsent, as after a leader restart; Bugbot
   * on #1163) is not one, nor is a refused one, which may never have been
   * sent (Devin on #1163): both are only attempts (`unreached`).
   */
  lastRunAt: Date | null;
  /**
   * The runs asked for since lastRunAt that never reached the box (expired
   * unsent, or refused): each trigger backs off on its own, 1 h, 2 h, 4 h, …
   * up to a day after its newest (backoffUntil), and a run that reaches the
   * box starts them over (#1163).
   */
  unreached: readonly UnreachedAttempt[];
  /**
   * When each of this tool's floor runs that reached the box and left it
   * below the floor was asked for (failedFloorRun): a floor run that fails
   * for a reason a retry can't fix (the box's installer can't get the floor's
   * version) backs off like an unreached one, 1 h, 2 h, 4 h, … up to a day,
   * instead of failing every hour. Counted only within the breach being timed.
   */
  failedFloorRuns: readonly Date[];
  /** Its run restarts the termag agent whatever its restart says (Node): no daytime fallback for it without the owner's night to go by. */
  restartsAgent?: boolean;
  /** The box's resume marker, when `resumed`: an unsent attempt from before it does not hold its resume run. */
  resumedAt?: Date | null;
  /** When the sweep first saw the box with the flag on, in an unbroken run of passes (nightlyClockStart): the nightly clock of a box with no run. */
  firstSeenAt: Date;
  lastActivityAt: Date | null;
  /** The owner's IANA zone (User.timeZone), when known. */
  timeZone: string | null;
  /** The owner's nightly schedule (tool-auto-update-schedule); today's (DEFAULT_NIGHTLY_SCHEDULE) when absent. */
  schedule?: NightlySchedule;
}

/**
 * Whether `version` is below `floor`; false when either cannot be compared,
 * which is never a reason to update blind. A dated build compares by its day,
 * as the box's recipe does (fleet.ts compareToReference).
 */
export function belowFloor(version: string | null, floor: string): boolean {
  const c = version ? compareToReference(version, floor, true) : null;
  return c !== null && c < 0;
}

/** The box already runs what an update would install: at or ahead of a known reference. Unknown is not current. */
export function isCurrent(version: string | null, reference: string | null): boolean {
  if (!version || !reference) return false;
  const c = compareToReference(version, reference);
  return c !== null && c >= 0;
}

/** The hour of the day `now` is in `timeZone`, 0..23, or null for a zone this runtime does not know. */
export function localHour(now: number, timeZone: string): number | null {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now);
    const n = Number.parseInt(h, 10);
    return Number.isInteger(n) ? n % 24 : null;
  } catch {
    return null;
  }
}

/** Whether `hour` is in the window [from, to), which wraps past midnight when `from` is later than `to` (22 to 4). */
export function inWindow(hour: number, from: number, to: number): boolean {
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * It is the night in `timeZone` (the schedule's window, 00:00–06:00 by
 * default); with no zone (or one this runtime does not know), any hour is.
 */
export function isNight(now: number, timeZone: string | null, schedule: NightlySchedule = DEFAULT_NIGHTLY_SCHEDULE): boolean {
  if (!timeZone) return true;
  const h = localHour(now, timeZone);
  return h === null || inWindow(h, schedule.nightFromHour, schedule.nightToHour);
}

/** The activity clock is the quiet time old (an hour by default), or the box has none. */
export function isQuiet(now: number, lastActivityAt: Date | null, quietMs: number = QUIET_AFTER_MS): boolean {
  return !lastActivityAt || now - lastActivityAt.getTime() >= quietMs;
}

/** From when the box is due a nightly run: the schedule's interval (24 hours) after its last run, and never before the sweep first saw it. */
export function nightlyDueAt(f: Pick<AutoFacts, 'lastRunAt' | 'firstSeenAt' | 'schedule'>): number {
  const first = f.firstSeenAt.getTime();
  const every = (f.schedule ?? DEFAULT_NIGHTLY_SCHEDULE).everyMs;
  return f.lastRunAt ? Math.max(f.lastRunAt.getTime() + every, first) : first;
}

/**
 * The sweep's decision for one box and one tool. The skips come first, in
 * fleet.ts hostRefusal's order (the flags, offline, not capable, a run in
 * flight), so an automatic run is refused for exactly what a manual one is.
 */
export function autoUpdateDecision(f: AutoFacts, now: number): AutoDecision {
  const d = decide(f, now);
  // A policy that says restart none is obeyed by every automatic run: it updates the binary and stops nothing.
  // A tool with no sessions has nothing to restart either.
  return d.run && (f.policyRestart === 'none' || f.sessionless) ? { ...d, restart: 'none' } : d;
}

const held = (until: number | null, now: number) => until !== null && now < until;

function decide(f: AutoFacts, now: number): AutoDecision {
  if (!f.autoOn) return { run: false, skip: 'auto-off' };
  if (!f.updateOn) return { run: false, skip: 'update-off' };
  if (!f.connected) return { run: false, skip: 'offline' };
  if (f.settling) return { run: false, skip: 'settling' };
  if (!f.capable) return { run: false, skip: 'not-capable' };
  if (f.inFlight) return { run: false, skip: 'run-in-flight' };

  if (belowFloor(f.version, f.floor)) {
    // A run that reached the box this last hour: its report and the inventory refresh come first.
    if (f.lastRunAt && now - f.lastRunAt.getTime() < FLOOR_RETRY_MS) return { run: false, skip: 'floor-just-ran' };
    // Only this breach's own attempts: a new or raised floor (no force clock yet), or one restarted after
    // the box could not take a run, starts its backoff over (Devin on #1163). The minute's slack is the
    // run row's own clock against the pass's.
    const floorSince = f.breachSince ? new Date(f.breachSince.getTime() - 60_000) : new Date(now);
    // A floor run that reached the box and failed backs off with the unreached ones. Only the time between
    // runs grows: the force clock is the breach's own (breachSince), so a failure never brings force sooner.
    const failing = f.failedFloorRuns.filter(at => at.getTime() > floorSince.getTime());
    const attempts = [...f.unreached, ...failing.map(at => ({ trigger: 'floor', at }))];
    if (held(backoffUntil(attempts, 'floor', floorSince), now)) return { run: false, skip: failing.length ? 'floor-failing' : 'backing-off' };
    const since = (f.breachSince ?? new Date(now)).getTime();
    const due = f.mayForce && !f.sessionless && now - since >= f.forceAfterHours * HOUR;
    if (!due) return { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor' };
    // And a failure never brings force at all: force stops busy sessions, and it can't fix an installer that
    // fails anyway. Any failed floor run of this breach holds it: a run that brings the box to the floor ends
    // the breach, so within one every floor run that reached the box and reported has failed. Unreached
    // attempts are not failures and hold nothing. A raised floor or a new breach starts the force clock over.
    if (failing.length) return { run: true, trigger: 'floor', restart: 'idle', reason: 'below-floor-force-held' };
    return { run: true, trigger: 'floor', restart: 'force', reason: 'below-floor-force' };
  }
  // A resume installs only: the owner has just woken the box and is using it, so its sessions pick
  // the new version up when they next start (#1163). Its own unreached attempts, for
  // this marker, back off; a box below the floor got its floor run above.
  // A cold start asks only for a tool that is behind: one already at or past a known reference has
  // nothing to install, and its sessions start on that binary anyway (the nightly rules then apply).
  // Nor of a tool whose run restarts the termag agent whatever its restart says (Node): the owner has
  // just started the box and is using it, and the agent has just rebuilt its sessions (Bugbot on #1304).
  const cold = f.resumeKind === 'cold-start';
  if (f.resumed && !f.sessionless && !(cold && (f.restartsAgent || isCurrent(f.version, f.reference)))) {
    if (held(resumeHold(f.unreached, f.resumedAt ?? null), now)) return { run: false, skip: 'backing-off' };
    return { run: true, trigger: 'resume', restart: 'none', reason: cold ? 'started' : 'resumed' };
  }
  // A box on what an update would install (the newest pin, or ahead of it) has nothing to gain from a nightly run.
  if (isCurrent(f.version, f.reference)) return { run: false, skip: 'current' };

  // From here on the nightly run: the owner's schedule moves its window, interval and quiet time.
  const schedule = f.schedule ?? DEFAULT_NIGHTLY_SCHEDULE;
  const dueAt = nightlyDueAt(f);
  if (now < dueAt) return { run: false, skip: 'ran-recently' };
  if (held(backoffUntil(f.unreached, 'nightly'), now)) return { run: false, skip: 'backing-off' };
  // Nothing to wait for: the quiet window protects sessions, and this tool has none.
  if (f.sessionless) return { run: true, trigger: 'nightly', restart: 'none', reason: 'no-sessions' };
  if (isQuiet(now, f.lastActivityAt, schedule.quietMs) && isNight(now, f.timeZone, schedule)) return { run: true, trigger: 'nightly', restart: 'idle', reason: 'quiet' };
  // Never quiet for a day: only the quiet condition is relaxed. It keeps the owner's night, and installs
  // only, so no session is stopped mid-day; floor runs cover the security case (#1163).
  // A tool whose run restarts the agent anyway (Node) needs a known night for it.
  if (now - dueAt >= NEVER_QUIET_MS && isNight(now, f.timeZone, schedule) && !(f.restartsAgent && !f.timeZone)) {
    return { run: true, trigger: 'nightly', restart: 'none', reason: 'never-quiet' };
  }
  return { run: false, skip: 'not-quiet' };
}

/** Which decisions go first when the pacer has fewer slots than boxes due: a forced floor run, then the floor (force held or not), a resume, the overdue, the nightly, then a sessionless tool's run. */
const PRIORITY: Record<AutoReason, number> = { 'below-floor-force': 0, 'below-floor-force-held': 1, 'below-floor': 1, resumed: 2, started: 2, 'never-quiet': 3, quiet: 4, 'no-sessions': 5 };
export const byPriority = (a: { reason: AutoReason }, b: { reason: AutoReason }) => PRIORITY[a.reason] - PRIORITY[b.reason];

/** Skips that mean the box cannot take a run at all just now: the force clock does not run through them. */
export const UNABLE: readonly AutoSkip[] = ['update-off', 'offline', 'not-capable'];

/** A breach the sweep has not looked at for this long (its flag was off, no leader ran) starts its force clock again. */
export const BREACH_GAP_MS = HOUR;

/** `seenAt`: the last pass that saw the box below this floor. */
export interface Breach { floor: string; since: Date | null; seenAt: Date | null }
/** What happened to a box below the floor in this pass: a floor run was queued, it could not take one, or neither. */
export type BreachEvent = 'attempted' | 'unable' | 'other';

/**
 * The breach record after this pass. Null when the box is not below the floor
 * (or its version cannot be read). The force clock (`since`) starts at the
 * first floor run queued for this floor and restarts when the box cannot take
 * a run (offline, not capable, updates off), so `force` comes only after
 * forceAfterHours of `idle` attempts in a row (Bugbot on #1163). A raised
 * floor is a new breach, and so is one no pass looked at for BREACH_GAP_MS
 * (the tool's flag was off, no leader ran): every pass stamps `seenAt`.
 */
export function breachAfter(prev: Breach | null, version: string | null, floor: string, event: BreachEvent, now: Date): Breach | null {
  if (!belowFloor(version, floor)) return null;
  const continuous = !!prev && prev.floor === floor && !!prev.seenAt && now.getTime() - prev.seenAt.getTime() <= BREACH_GAP_MS;
  const since = continuous ? prev!.since : null;
  if (event === 'unable') return { floor, since: null, seenAt: now };
  if (event === 'attempted' && !since) return { floor, since: now, seenAt: now };
  return { floor, since, seenAt: now };
}

/** The force clock a pass reads before it decides: the stored one, if it is this floor's and unbroken. */
export function liveBreachSince(prev: Breach | null, floor: string, now: number): Date | null {
  if (!prev || prev.floor !== floor || !prev.seenAt || now - prev.seenAt.getTime() > BREACH_GAP_MS) return null;
  return prev.since;
}

/** The reason as the runs list shows it, and as the run's `reason` column keeps it. */
export function reasonText(reason: AutoReason, f: Pick<AutoFacts, 'version' | 'floor' | 'breachSince' | 'timeZone' | 'schedule'>, now: number): string {
  const s = f.schedule ?? DEFAULT_NIGHTLY_SCHEDULE;
  const moved = scheduleOverrides(s);
  // A schedule the flag moved says so, so a test run is never mistaken for a real night's.
  const night = moved.window ? `the owner's test window ${s.nightFromHour}–${s.nightToHour}` : "the owner's night";
  const quietFor = moved.quiet ? `${s.quietMs / 60_000} min` : 'an hour';
  const every = moved.every ? `; test interval ${s.everyMs / HOUR} h` : '';
  switch (reason) {
    case 'below-floor': return `${f.version} is below the floor ${f.floor}`;
    case 'below-floor-force': {
      const h = f.breachSince ? Math.floor((now - f.breachSince.getTime()) / HOUR) : 0;
      return `${f.version} has been below the floor ${f.floor} for ${h} h: force`;
    }
    case 'below-floor-force-held': {
      const h = f.breachSince ? Math.floor((now - f.breachSince.getTime()) / HOUR) : 0;
      return `${f.version} has been below the floor ${f.floor} for ${h} h; force held: its floor runs are failing`;
    }
    case 'resumed': return 'resumed from hibernation: installs only, sessions pick it up when they next start';
    case 'started': return 'started from stopped: installs only, sessions pick it up when they next start';
    case 'quiet': return (f.timeZone ? `quiet for ${quietFor}, ${night} (${f.timeZone})` : `quiet for ${quietFor} (no time zone for the owner)`) + every;
    case 'never-quiet': return `due for 24 h and never quiet: in ${night}${moved.window && f.timeZone ? ` (${f.timeZone})` : ''}, installs only${every}`;
    case 'no-sessions': return `due, and it runs in no session, so no quiet window to wait for${every}`;
  }
}
