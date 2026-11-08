/**
 * Automatic box lifecycle: the pure decisions.
 * `boxLifecycle.ts` owns the sweep, the flag read and every write; this module
 * only decides, so the rules are unit-testable.
 *
 * A box hibernates on its own once it has been idle for its
 * `idleHibernateHours`. Only boxes launched hibernation-capable take part in
 * that setting: there is no plain-stop fallback for it, so a box that can't
 * hibernate keeps the setting (with a warning) and the sweep does not stop
 * it instead. The default window below is the exception. Idle means no
 * human input and no agent `working` status since `lastActivityAt`; an agent
 * waiting on its user counts as idle.
 *
 * A box hibernated for its `hibernatedTerminateDays` is terminated. That
 * limit is raised to the unsaved-work limit (90 days) unless the agent's scan
 * just before the hibernate found nothing; only a hibernated box is ever
 * terminated.
 *
 * A box with no `idleHibernateHours` gets
 * a default window (`box-idle-park-hours`, else IDLE_STOP_DEFAULT_HOURS) and
 * is plainly stopped, whether or not it can hibernate. Its owner is warned a
 * lead first (`box-idle-park-warn-minutes`), and the stop waits for the time
 * the warning promised. A box with its own `idleHibernateHours` keeps its
 * setting's meaning.
 *
 * Parking never hibernates (Park by stopping):
 * a box's own `idleHibernateHours` stop it once they are up,
 * with no warning (as their hibernate had none), whether or not it can
 * hibernate. Its
 * `hibernatedTerminateDays` then count from the stop: a `stopped` box with
 * `parkedAt` (stamped when an auto-park stop settles) is terminated like a
 * hibernated one, with the same unsaved-work limit.
 */

import { REFRESH_STOP_NOTE } from './boxPowerPolicy';


/** The idle window a box with no auto-park setting gets, unless BOX_IDLE_PARK_HOURS_FLAG says otherwise. */
export const IDLE_STOP_DEFAULT_HOURS = 2;
/** The default window in hours. */
export const BOX_IDLE_PARK_HOURS_FLAG = 'box-idle-park-hours';
/** How long before the default window's stop its owner is warned, in minutes. */
export const BOX_IDLE_PARK_WARN_MINUTES_FLAG = 'box-idle-park-warn-minutes';
export const DEFAULT_WARN_MINUTES = 120;
const MAX_WARN_MINUTES = 7 * 24 * 60;

/** Bounds of `idleHibernateHours`: an hour at least, thirty days at most. */
export const IDLE_HIBERNATE_MIN_HOURS = 1;
export const IDLE_HIBERNATE_MAX_HOURS = 720;

/** Bounds of `hibernatedTerminateDays`. */
export const TERMINATE_MIN_DAYS = 1;
export const TERMINATE_MAX_DAYS = 365;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/**
 * The limit a parked box with unsaved work, or with no current scan, waits
 * before an automatic terminate. It never shortens a longer own limit.
 */
export function unsavedWorkTerminateDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.BOX_UNSAVED_WORK_TERMINATE_DAYS, 90);
}

/**
 * The settings a box made for an ask gets at creation (`termag ask
 * --new-box`, boxLifecycle.applyAskBoxPolicy): no idle hours of its own, so
 * it is stopped by the default idle window and never
 * hibernated, since waking a hibernated ask box could hang in `starting`; and
 * no automatic terminate, so its owner removes it once its PRs are done.
 */
export function askBoxLifecycle(): LifecycleSettings {
  return { idleHibernateHours: null, hibernatedTerminateDays: null };
}

export interface LifecycleBox {
  userId: string | null;
  kind: string;
  status: string;
  ec2InstanceId: string | null;
  hibernationConfigured: boolean;
  rehibernatePending: boolean;
  idleHibernateHours: number | null;
  lastActivityAt: Date | null;
  readyAt: Date | null;
  createdAt: Date;
  /** When a warm-pool box was claimed; a pool box never gets readyAt. */
  claimedAt?: Date | null;
  /** When the box last came up (its agent's connect after a start): the start grace. */
  lastReadyAt?: Date | null;
  /** The default window's standing warning and the stop time it promised. */
  idleWarnedAt?: Date | null;
  idleParkAt?: Date | null;
  /** When the sweep last parked the box; an owner's start, or turning its own hours off, clears it. */
  autoParkedAt?: Date | null;
}

/**
 * How long after it comes up a box is left alone, whoever started it: the
 * scheduler claims a woken automation run on a later tick, and the box
 * update pushed after the agent's hello is still running. Counted from the
 * connect that made the box ready, not the start request, so a slow resume
 * doesn't use it up while the box is still `starting`.
 */
export const START_GRACE_MS = 15 * 60 * 1000;

/**
 * Busy checks that stop holding a box once it has had no activity for
 * SOFT_BUSY_CAP_MS: load, an open SSH session and an open port forward can
 * be a forgotten process, editor window or `termag forward` (an HMR socket
 * stays open) as easily as unattended work.
 */
export const SOFT_BUSY_CHECKS: ReadonlySet<string> = new Set(['host-load', 'ssh', 'tunnels']);
export const SOFT_BUSY_CAP_MS = 7 * DAY_MS;

/** Whether this box can take part at all, whatever its settings. */
export function canAutoHibernate(box: Pick<LifecycleBox, 'userId' | 'kind' | 'ec2InstanceId' | 'hibernationConfigured'>): boolean {
  return box.kind === 'ec2' && !!box.userId && !!box.ec2InstanceId && box.hibernationConfigured;
}

/**
 * The moment the idle clock started: the last activity or the claim of a
 * warm-pool box, whichever is later, else when the box first came up.
 */
export function idleSince(box: Pick<LifecycleBox, 'lastActivityAt' | 'readyAt' | 'createdAt' | 'claimedAt'>): Date {
  const latest = [box.lastActivityAt, box.claimedAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  return latest ?? box.readyAt ?? box.createdAt;
}

/**
 * The busy check that keeps the box up, or null. A check outside
 * SOFT_BUSY_CHECKS always holds; a soft one holds only while the box has
 * seen activity within SOFT_BUSY_CAP_MS.
 */
export function holdingCheck(busy: readonly string[], idleMs: number): string | null {
  return busy.find(check => !SOFT_BUSY_CHECKS.has(check) || idleMs <= SOFT_BUSY_CAP_MS) ?? null;
}

/** How a park powers the box down. The sweep only ever stops a box now; `hibernate` names an older park's. */
export type ParkAction = 'hibernate' | 'stop';

/** The idle hours a park went by, and whose they were: the box's own, or the default window's. */
export interface IdleLimit {
  hours: number;
  source: 'own' | 'default';
}

/** `box-idle-park-hours` made safe: whole hours within the setting's own bounds, else IDLE_STOP_DEFAULT_HOURS. */
export function idleStopHours(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= IDLE_HIBERNATE_MIN_HOURS && raw <= IDLE_HIBERNATE_MAX_HOURS
    ? raw : IDLE_STOP_DEFAULT_HOURS;
}

/**
 * The warning lead: `box-idle-park-warn-minutes` (whole minutes up to a
 * week, else two hours), but never more than half the window, so the
 * two-hour window is warned an hour ahead and a 72-hour one keeps 24 hours.
 */
export function warnLeadMs(rawMinutes: unknown, windowHours: number): number {
  const minutes = typeof rawMinutes === 'number' && Number.isInteger(rawMinutes) && rawMinutes >= 0 && rawMinutes <= MAX_WARN_MINUTES
    ? rawMinutes : DEFAULT_WARN_MINUTES;
  return Math.min(minutes * 60 * 1000, (windowHours * HOUR_MS) / 2);
}

export interface IdleFacts {
  nowMs: number;
  /**
   * The busy checks that report the box busy (a cloud runner session, an ask
   * run, an automation run, load, a box update): see holdingCheck.
   */
  busy: readonly string[];
  /** An agent on the box reports `working` right now. */
  working: boolean;
  /** The default window in hours (idleStopHours); IDLE_STOP_DEFAULT_HOURS when left out. */
  idleStopHours?: number;
  /** How long before a stop its owner is warned (warnLeadMs, of the window that applies); none when left out. */
  leadMs?: number;
}

export type IdleSkip = 'not-eligible' | 'not-ready' | 'refresh-pending' | 'just-started' | 'busy' | 'working' | 'not-idle' | 'warned';
/**
 * `stop` and `warn` are the default window's, or the box's own hours (a
 * plain stop: memory not kept). `warn` records the warning and the stop time it promises; a
 * `quiet` stop is the re-park of a box woken without its owner, which needs
 * no new warning.
 */
export type IdleDecision =
  | { stop: true; quiet?: boolean }
  | { warn: true; stopAt: Date }
  | { hibernate: false; reason: IdleSkip; check?: string };

export function isIdleSkip(d: IdleDecision): d is { hibernate: false; reason: IdleSkip; check?: string } {
  return 'reason' in d;
}

/** An owned EC2 box that can be plainly stopped. */
function canIdleStop(box: Pick<LifecycleBox, 'userId' | 'kind' | 'ec2InstanceId'>): boolean {
  return box.kind === 'ec2' && !!box.userId && !!box.ec2InstanceId;
}

/** When a box under the default window is due if nothing happens on it. */
export function defaultIdleDueAt(
  box: Pick<LifecycleBox, 'lastActivityAt' | 'readyAt' | 'createdAt' | 'claimedAt'>,
  hours: number = IDLE_STOP_DEFAULT_HOURS,
): Date {
  return new Date(idleSince(box).getTime() + hours * HOUR_MS);
}

/** How long past its promised stop time a warning still stands (a box held busy, a sweep that didn't run). */
export const WARNING_STALE_AFTER_MS = HOUR_MS;

/**
 * The stop time the box's warning promised, while it stands: sent in this
 * idle stretch (activity since makes it stale), promising no earlier than the
 * current due time (a longer window makes it stale), and not more than
 * WARNING_STALE_AFTER_MS past. Null when there is none, so the box is warned
 * again before any stop.
 */
export function standingWarning(
  box: Pick<LifecycleBox, 'lastActivityAt' | 'readyAt' | 'createdAt' | 'claimedAt' | 'idleWarnedAt' | 'idleParkAt'>,
  due: Date,
  nowMs: number,
): Date | null {
  const { idleWarnedAt, idleParkAt } = box;
  if (!idleWarnedAt || !idleParkAt) return null;
  if (idleWarnedAt.getTime() < idleSince(box).getTime()) return null;
  if (idleParkAt.getTime() < due.getTime()) return null;
  if (nowMs > idleParkAt.getTime() + WARNING_STALE_AFTER_MS) return null;
  return idleParkAt;
}

/**
 * Whether the box came up without its owner (a start without markInUse,
 * which is what clears autoParkedAt: a reviewer's wake that didn't take, a
 * start from outside termag) and nothing has moved its clock since the sweep
 * parked it. An automation's wake moves the clock (its andSet), so a box it
 * woke never reads as untouched. Such a box goes back down with no new
 * warning: its owner was told when it was parked.
 */
export function untouchedSinceAutoPark(box: Pick<LifecycleBox, 'autoParkedAt' | 'lastActivityAt'>): boolean {
  if (!box.autoParkedAt) return false;
  return !box.lastActivityAt || box.lastActivityAt.getTime() <= box.autoParkedAt.getTime();
}

/**
 * Why a box that is otherwise due stays up: the start grace, a busy check
 * that holds, or an agent working. Both paths ask the same questions.
 */
function heldUp(box: LifecycleBox, facts: IdleFacts): IdleDecision | null {
  if (box.lastReadyAt && facts.nowMs - box.lastReadyAt.getTime() < START_GRACE_MS) return { hibernate: false, reason: 'just-started' };
  const check = holdingCheck(facts.busy, facts.nowMs - idleSince(box).getTime());
  if (check) return { hibernate: false, reason: 'busy', check };
  if (facts.working) return { hibernate: false, reason: 'working' };
  return null;
}

export function idleHibernateDecision(box: LifecycleBox, facts: IdleFacts): IdleDecision {
  if (!box.idleHibernateHours) return defaultWindowDecision(box, facts, facts.idleStopHours ?? IDLE_STOP_DEFAULT_HOURS);
  // Its own hours park it by a stop: any box that can be stopped.
  return ownStopDecision(box, facts, box.idleHibernateHours);
}

/**
 * Its own hours: a plain stop once they are up,
 * with no warning, as an own-hours hibernate has none. The owner chose those
 * hours, so a box parking on them is expected. The same guards as the other paths.
 */
function ownStopDecision(box: LifecycleBox, facts: IdleFacts, hours: number): IdleDecision {
  if (!canIdleStop(box)) return { hibernate: false, reason: 'not-eligible' };
  if (box.status !== 'ready') return { hibernate: false, reason: 'not-ready' };
  if (box.rehibernatePending) return { hibernate: false, reason: 'refresh-pending' };
  const held = heldUp(box, facts);
  if (held) return held;
  if (facts.nowMs < defaultIdleDueAt(box, hours).getTime()) return { hibernate: false, reason: 'not-idle' };
  return { stop: true };
}

/**
 * A park by a plain stop after `hours` idle, warned first: no `idleHibernateHours`, so the default
 * window applies. The same
 * guards as the hibernate path. The action is always a plain stop, including
 * for a box that could have hibernated.
 */
function defaultWindowDecision(box: LifecycleBox, facts: IdleFacts, hours: number): IdleDecision {
  if (!canIdleStop(box)) return { hibernate: false, reason: 'not-eligible' };
  if (box.status !== 'ready') return { hibernate: false, reason: 'not-ready' };
  if (box.rehibernatePending) return { hibernate: false, reason: 'refresh-pending' };
  const held = heldUp(box, facts);
  if (held) return held;
  if (untouchedSinceAutoPark(box)) return { stop: true, quiet: true };
  const due = defaultIdleDueAt(box, hours);
  const leadMs = facts.leadMs ?? 0;
  if (facts.nowMs < due.getTime() - leadMs) return { hibernate: false, reason: 'not-idle' };
  const promised = standingWarning(box, due, facts.nowMs);
  if (!promised) return { warn: true, stopAt: new Date(Math.max(due.getTime(), facts.nowMs + leadMs)) };
  if (facts.nowMs < promised.getTime()) return { hibernate: false, reason: 'warned' };
  return { stop: true };
}

/**
 * When the default window will stop the box as things stand, or null when
 * it can't: for a box woken without its owner and untouched since its
 * auto-park, as soon as its start grace is over (the quiet re-park); else a
 * standing warning's promised time; else the due time or a lead after the
 * warning, whichever is later (a box past its due time is warned first, and
 * not before its start grace is over). Null while a refresh is pending. A
 * busy check or a working agent, which only the sweep sees, can hold the
 * box past it.
 */
export function idleStopAtFor(box: LifecycleBox, hours: number, leadMs: number, nowMs: number): Date | null {
  if (!canIdleStop(box) || box.status !== 'ready' || box.rehibernatePending) return null;
  const graceOverMs = Math.max(nowMs, box.lastReadyAt ? box.lastReadyAt.getTime() + START_GRACE_MS : nowMs);
  if (untouchedSinceAutoPark(box)) return new Date(graceOverMs);
  const due = defaultIdleDueAt(box, hours);
  return standingWarning(box, due, nowMs) ?? new Date(Math.max(due.getTime(), graceOverMs + leadMs));
}

export interface LifecycleSettings {
  idleHibernateHours: number | null;
  hibernatedTerminateDays: number | null;
}

const SETTING_BOUNDS: Record<keyof LifecycleSettings, { min: number; max: number; unit: string }> = {
  idleHibernateHours: { min: IDLE_HIBERNATE_MIN_HOURS, max: IDLE_HIBERNATE_MAX_HOURS, unit: 'hours' },
  hibernatedTerminateDays: { min: TERMINATE_MIN_DAYS, max: TERMINATE_MAX_DAYS, unit: 'days' },
};

/**
 * Validate a settings body. Every key is optional and a missing key leaves
 * the setting alone; null turns it off. Unknown keys are refused so a typo
 * doesn't silently do nothing.
 */
export function parseLifecycleSettings(body: unknown): { settings: Partial<LifecycleSettings> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Expected a JSON object' };
  const settings: Partial<LifecycleSettings> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(SETTING_BOUNDS, key)) return { error: `Unknown setting: ${key}` };
    const name = key as keyof LifecycleSettings;
    const { min, max, unit } = SETTING_BOUNDS[name];
    if (value === null) { settings[name] = null; continue; }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return { error: `${name} must be null or a whole number of ${unit} from ${min} to ${max}` };
    }
    settings[name] = value;
  }
  return { settings };
}

/**
 * Why a settings change is refused for this box, or null. A box that can't
 * hibernate still takes the setting; it only gets a warning (`lifecycleWarning`).
 */
export function lifecycleSettingsError(
  box: Pick<LifecycleBox, 'status'>,
  _settings: Partial<LifecycleSettings>,
): string | null {
  if (box.status === 'terminated') return 'This box is terminated';
  return null;
}

export const CANNOT_HIBERNATE_WARNING =
  "This box (or its image) can't hibernate, so auto-park does nothing on it. It is never stopped or terminated instead.";

/**
 * What the lifecycle view reads the default window's two number flags as,
 * for this owner and box.
 */
export interface IdleStopOptions {
  /** idleStopHours of `box-idle-park-hours`. */
  idleStopHours?: number;
  /** `box-idle-park-warn-minutes`, as read. */
  warnMinutes?: unknown;
  /** The box hosts an enabled automation, so the sweep never terminates it (terminateDecision). */
  hostsAutomation?: boolean;
}

/**
 * The warning to show next to a lifecycle setting that will not park the box,
 * or null. Parking by a stop needs no hibernation, so every setting runs on a
 * box that can be stopped; only one that can't (not an owned EC2 box) is warned.
 */
export function lifecycleWarning(
  box: Pick<LifecycleBox, 'userId' | 'kind' | 'ec2InstanceId' | 'hibernationConfigured' | 'idleHibernateHours'>
    & { hibernatedTerminateDays: number | null },
): string | null {
  const on = box.idleHibernateHours != null || box.hibernatedTerminateDays != null;
  if (!on || canAutoHibernate(box) || canIdleStop(box)) return null;
  return CANNOT_HIBERNATE_WARNING;
}

/**
 * What the agent's `unsaved-work` scan says about a parked box:
 * - `clean`: a scan found nothing, and nothing happened on the box after it;
 * - `unsaved`: a scan found work that exists only on this box, or failed;
 * - `unknown`: no scan, or activity after the last one (a manual hibernate,
 *   an agent too old to scan).
 * Only `clean` lets a box go at its own limit.
 */
export type UnsavedWorkState = 'clean' | 'unsaved' | 'unknown';

export interface TerminateBox extends LifecycleBox {
  parkedAt: Date | null;
  hibernatedTerminateDays: number | null;
  unsavedWork: unknown;
  unsavedWorkCheckedAt: Date | null;
}

/** A scan with no findings, no unreadable repo, no kept checkout and no error. */
export function isCleanScan(scan: unknown): boolean {
  if (!scan || typeof scan !== 'object' || Array.isArray(scan)) return false;
  const s = scan as Record<string, unknown>;
  return !('error' in s)
    && Array.isArray(s.repos) && s.repos.length === 0
    && Array.isArray(s.errors) && s.errors.length === 0
    && s.keptCheckouts === 0;
}

export function unsavedWorkState(box: Pick<TerminateBox, 'unsavedWork' | 'unsavedWorkCheckedAt' | 'lastActivityAt'>): UnsavedWorkState {
  const checkedAt = box.unsavedWorkCheckedAt;
  if (!checkedAt || box.unsavedWork == null) return 'unknown';
  if (box.lastActivityAt && box.lastActivityAt.getTime() > checkedAt.getTime()) return 'unknown';
  return isCleanScan(box.unsavedWork) ? 'clean' : 'unsaved';
}

/** Days parked before the terminate: the box's own limit, raised to the unsaved-work limit unless the box is clean. */
export function effectiveTerminateDays(box: TerminateBox, unsavedLimitDays: number): number | null {
  if (box.hibernatedTerminateDays == null) return null;
  if (unsavedWorkState(box) === 'clean') return box.hibernatedTerminateDays;
  return Math.max(box.hibernatedTerminateDays, unsavedLimitDays);
}

/**
 * Whether the box is parked the way its terminate limit counts: hibernated
 * (a box that can hibernate, parked before parking became a stop), or
 * stopped with `parkedAt` set, which only an auto-park's stop settling stamps.
 */
function parkedForTerminate(box: TerminateBox): boolean {
  if (!box.parkedAt || box.rehibernatePending) return false;
  if (box.status === 'hibernated') return canAutoHibernate(box);
  return box.status === 'stopped' && canIdleStop(box);
}

/** When a parked box is due to be terminated, or null when it never will be as things stand. */
export function terminateDueAt(box: TerminateBox, unsavedLimitDays: number): Date | null {
  if (!parkedForTerminate(box)) return null;
  const days = effectiveTerminateDays(box, unsavedLimitDays);
  return days == null ? null : new Date(box.parkedAt!.getTime() + days * DAY_MS);
}

export type TerminateSkip = 'not-eligible' | 'off' | 'not-parked' | 'not-due' | 'hosts-automation';
export type TerminateDecision = { terminate: true; days: number } | { terminate: false; reason: TerminateSkip };

/**
 * Only ever a box that is hibernated right now, or one auto-park stopped,
 * and has been past its limit. Never one that hosts an enabled automation
 * (`hostsAutomation`): terminating it archives the automation's project with
 * it, so the automation vanishes with nobody told (babysit-1027,
 * 2026-10-30). Its owner disables or moves the automation first.
 */
export function terminateDecision(
  box: TerminateBox,
  facts: { nowMs: number; unsavedLimitDays: number; hostsAutomation?: boolean },
): TerminateDecision {
  if (!canAutoHibernate(box) && !canIdleStop(box)) return { terminate: false, reason: 'not-eligible' };
  if (box.hibernatedTerminateDays == null) return { terminate: false, reason: 'off' };
  if (!parkedForTerminate(box)) return { terminate: false, reason: 'not-parked' };
  const due = terminateDueAt(box, facts.unsavedLimitDays)!;
  if (facts.nowMs < due.getTime()) return { terminate: false, reason: 'not-due' };
  if (facts.hostsAutomation) return { terminate: false, reason: 'hosts-automation' };
  return { terminate: true, days: effectiveTerminateDays(box, facts.unsavedLimitDays)! };
}

/**
 * What the box list and the settings route show: the settings, whether the
 * box can take part, when it hibernates or is terminated if left alone, what
 * the unsaved-work scan said, and the last note.
 */
export interface LifecycleView {
  canAutoHibernate: boolean;
  idleHibernateHours: number | null;
  hibernatedTerminateDays: number | null;
  /** Always null: nothing hibernates a box any more. Kept for older clients. */
  hibernateDueAt: null;
  terminateDueAt: string | null;
  parkedAt: string | null;
  /** Only for a parked box: whether its own terminate limit applies (`clean`) or the long one. */
  unsavedWork: UnsavedWorkState | null;
  note: string | null;
  /** Set when a setting is on but the box can't hibernate. */
  warning: string | null;
  /**
   * When the sweep will next park the box as things stand, and how: its own
   * hours and the default window
   * both stop it. Null when neither applies.
   */
  parkAt: string | null;
  parkAction: ParkAction | null;
  /** The idle hours in effect: the box's own, or the default window's. */
  idleLimitHours: number | null;
  idleLimitSource: 'own' | 'default' | null;
  /** When the owner was warned about the default window's stop, while that warning stands. */
  warnedAt: string | null;
  /** When the sweep last parked it, until its owner starts it. */
  autoParkedAt: string | null;
  /**
   * Always true: parking only ever stops a box. Kept in the view because a
   * termag CLI from before box-park-stop-enabled was removed reads it to say
   * "stop" and "parked"; without it, that CLI would say "hibernate".
   */
  parkStop: true;
}

export function lifecycleView(
  box: TerminateBox & { lifecycleNote: string | null },
  unsavedLimitDays: number = unsavedWorkTerminateDays(),
  options?: IdleStopOptions,
  nowMs: number = Date.now(),
): LifecycleView {
  // The park fields say what the sweep will do: own hours stop the box.
  const ownStop = box.idleHibernateHours != null && canIdleStop(box);
  const defaultWindow = box.idleHibernateHours == null && canIdleStop(box);
  const stopHours = ownStop ? box.idleHibernateHours! : options?.idleStopHours ?? IDLE_STOP_DEFAULT_HOURS;
  // Own hours stop with no warning, so no lead and no standing warning.
  const stopAt = defaultWindow ? idleStopAtFor(box, stopHours, warnLeadMs(options?.warnMinutes, stopHours), nowMs)
    : ownStop ? idleStopAtFor({ ...box, idleWarnedAt: null, idleParkAt: null }, stopHours, 0, nowMs) : null;
  const warned = stopAt && defaultWindow ? standingWarning(box, defaultIdleDueAt(box, stopHours), nowMs) : null;
  // A start clears every warning (requestPower), so one on a `starting` box is stuckStartPass's.
  const stuckStopAt = box.status === 'starting' && box.idleWarnedAt && box.idleParkAt ? box.idleParkAt : null;
  const terminateAt = options?.hostsAutomation ? null : terminateDueAt(box, unsavedLimitDays);
  const parked = !!box.parkedAt && (box.status === 'hibernated' || box.status === 'stopped');
  return {
    canAutoHibernate: canAutoHibernate(box),
    idleHibernateHours: box.idleHibernateHours,
    hibernatedTerminateDays: box.hibernatedTerminateDays,
    hibernateDueAt: null,
    terminateDueAt: terminateAt ? terminateAt.toISOString() : null,
    parkedAt: box.parkedAt ? box.parkedAt.toISOString() : null,
    unsavedWork: parked ? unsavedWorkState(box) : null,
    note: box.lifecycleNote,
    warning: lifecycleWarning(box),
    parkAt: (stopAt ?? stuckStopAt)?.toISOString() ?? null,
    parkAction: stopAt || stuckStopAt ? 'stop' : null,
    idleLimitHours: ownStop ? box.idleHibernateHours : defaultWindow ? stopHours : null,
    idleLimitSource: ownStop ? 'own' : defaultWindow ? 'default' : null,
    warnedAt: (warned || stuckStopAt) && box.idleWarnedAt ? box.idleWarnedAt.toISOString() : null,
    autoParkedAt: box.autoParkedAt ? box.autoParkedAt.toISOString() : null,
    parkStop: true,
  };
}

const AUTO_HIBERNATE_PREFIX = 'Hibernated automatically after ';
/** What autoStopNote and stuckStartNote (STUCK_START_NOTE_PREFIX) both start with. */
const AUTO_STOP_PREFIX = 'Stopped automatically';

export function autoHibernateNote(hours: number): string {
  return `${AUTO_HIBERNATE_PREFIX}${hours} h idle. Start it to resume where you left off.`;
}

/** Not the hibernate note's prefix: isSweepStopped tells a box the sweep stopped by it. */
export function autoStopNote(hours: number): string {
  return `${AUTO_STOP_PREFIX} after ${hours} h idle. Start it to get its sessions back.`;
}

/**
 * Whether a box's note says the idle sweep hibernated it. The note is set
 * right after the sweep's hibernate and cleared by any start that marks the
 * box in use and by the owner's own stop or hibernate (requestPower
 * `byOwner`), so on a hibernated box it marks one the sweep parked and its
 * owner hasn't touched since. (A reviewer's wake keeps it, so a resume that
 * doesn't take can be woken again; once the box is up, its status says so.)
 */
export function isAutoHibernateNote(note: string | null | undefined): boolean {
  return typeof note === 'string' && note.startsWith(AUTO_HIBERNATE_PREFIX);
}

/**
 * Whether a stopped box is one the sweep stopped and its owner hasn't touched
 * since: it has `parkedAt` (stamped when a sweep's stop settles) and still
 * carries a sweep's stop note (its own hours or the default window
 * `autoStopNote`, a stuck start `stuckStartNote`, the 60-day refresh
 * `REFRESH_STOP_NOTE`). An owner's own stop clears the note and their start
 * clears both, so a box stopped by hand never is. A preview-share reviewer
 * may wake such a box (previewShareRules.guestWakeRefusal).
 */
export function isSweepStopped(box: { parkedAt?: Date | null; lifecycleNote: string | null }): boolean {
  const note = box.lifecycleNote;
  if (!box.parkedAt || typeof note !== 'string') return false;
  return note.startsWith(AUTO_STOP_PREFIX) || note === REFRESH_STOP_NOTE;
}

/** The note the sweep leaves on a box it stopped because it never came up. */
export function stuckStartNote(startedAt: Date): string {
  return `${STUCK_START_NOTE_PREFIX}it was started at ${startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC and its agent never connected. `
    + 'Start it again, or terminate it if that keeps happening.';
}

/** The prefix of stuckStartNote, which marks a box the sweep tried to stop because it never came up. */
export const STUCK_START_NOTE_PREFIX = 'Stopped automatically: ';

/**
 * Whether to stop again a box whose stuck-start stop didn't take: EC2
 * accepted the stop but never stopped it, so the power sweep wrote it back
 * to `ready` after the stop timeout, still with no agent. It still carries
 * the stuck-start note, which the first connect of its agent drops
 * (instanceLifecycle connectUpdate), so the note on a ready box means no
 * agent has come since. The owner was warned before the first try, so it is
 * stopped again with no new warning (Bugbot on #623). The idle sweep leaves
 * such a box to this retry.
 */
export function stuckStopRetryDecision(
  box: Pick<LifecycleBox, 'status' | 'userId' | 'kind' | 'ec2InstanceId' | 'idleWarnedAt'>
    & { lifecycleNote: string | null; lastConnectedAt?: Date | null },
  facts: { agentConnected: boolean; busy: readonly string[] },
): boolean {
  if (box.status !== 'ready' || !canIdleStop(box) || facts.agentConnected || facts.busy.length) return false;
  return stuckStopPending(box);
}

/**
 * Whether the box still carries a stuck-start stop that didn't take: the
 * note, and no agent connect since the warning that came before that stop.
 * The connect normally drops the note, but one that lost its status guard
 * only stamps `lastConnectedAt`, and that is enough to say the box came up
 * (Bugbot on #623).
 */
export function stuckStopPending(
  box: Pick<LifecycleBox, 'idleWarnedAt'> & { lifecycleNote: string | null; lastConnectedAt?: Date | null },
): boolean {
  if (!isStuckStartNote(box.lifecycleNote) || !box.idleWarnedAt) return false;
  return !box.lastConnectedAt || box.lastConnectedAt.getTime() < box.idleWarnedAt.getTime();
}

/** Whether a box's note marks a stop the stuck-start pass made (stuckStartNote). */
export function isStuckStartNote(note: string | null | undefined): boolean {
  return typeof note === 'string' && note.startsWith(STUCK_START_NOTE_PREFIX);
}

/** How many start timeouts a box may stay `starting` with no agent before the sweep stops it. */
export const STUCK_START_TIMEOUTS = 2;

export type StuckStartDecision =
  | { act: 'none'; reason: 'not-stuck' | 'busy' | 'warned'; check?: string }
  | { act: 'warn'; stopAt: Date }
  | { act: 'stop' };

/**
 * What to do with a box in `starting`. It is stuck once it was started at
 * least STUCK_START_TIMEOUTS start timeouts ago and its agent has not
 * connected since (a connect would have made it ready): it bills and termag
 * can't reach it. A hibernation resume that never gets its network back is
 * the known case (docs/box-hibernation.md). Someone may still be on it over
 * SSH, which only the missing agent could report, so the owner is warned a
 * lead first, as for an idle park, and any busy check holds it (Devin on
 * #623). A warning counts for this start only if it came after it.
 */
export function stuckStartDecision(
  box: Pick<LifecycleBox, 'status' | 'userId' | 'kind' | 'ec2InstanceId' | 'idleWarnedAt' | 'idleParkAt'>,
  facts: {
    nowMs: number; startRequestedAt: number | null; agentConnected: boolean;
    startTimeoutMs: number; leadMs: number; busy: readonly string[];
  },
): StuckStartDecision {
  const none = (reason: 'not-stuck' | 'warned'): StuckStartDecision => ({ act: 'none', reason });
  if (box.status !== 'starting' || !canIdleStop(box) || facts.agentConnected || facts.startRequestedAt === null) return none('not-stuck');
  if (facts.nowMs - facts.startRequestedAt < STUCK_START_TIMEOUTS * facts.startTimeoutMs) return none('not-stuck');
  if (facts.busy.length) return { act: 'none', reason: 'busy', check: facts.busy[0] };
  const warnedForThisStart = !!box.idleWarnedAt && !!box.idleParkAt && box.idleWarnedAt.getTime() >= facts.startRequestedAt;
  if (!warnedForThisStart) return { act: 'warn', stopAt: new Date(facts.nowMs + facts.leadMs) };
  if (facts.nowMs < box.idleParkAt!.getTime()) return none('warned');
  return { act: 'stop' };
}

export function autoTerminateNote(days: number): string {
  return `Terminated automatically after ${days} ${days === 1 ? 'day' : 'days'} parked.`;
}
