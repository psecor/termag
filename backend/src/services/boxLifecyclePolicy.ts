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
 * Behind box-idle-stop-enabled only, a box with no `idleHibernateHours` gets
 * a default window of IDLE_STOP_DEFAULT_HOURS: it hibernates when it can and
 * is plainly stopped when it can't. A box with its own `idleHibernateHours`
 * keeps its setting's meaning whatever that flag says.
 */

export const BOX_AUTO_LIFECYCLE_FLAG = 'box-auto-lifecycle-enabled';
export const BOX_IDLE_STOP_FLAG = 'box-idle-stop-enabled';

/** The idle window box-idle-stop-enabled gives a box with no auto-park setting. */
export const IDLE_STOP_DEFAULT_HOURS = 2;

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

/** The settings a box made for an ask gets at creation (phase 2 of agent messaging). */
export function subagentLifecycleDefaults(env: NodeJS.ProcessEnv = process.env): LifecycleSettings {
  return {
    idleHibernateHours: 1,
    hibernatedTerminateDays: positiveIntEnv(env.BOX_SUBAGENT_HIBERNATED_TERMINATE_DAYS, 1),
  };
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
}

/** Whether this box can take part at all, whatever its settings. */
export function canAutoHibernate(box: Pick<LifecycleBox, 'userId' | 'kind' | 'ec2InstanceId' | 'hibernationConfigured'>): boolean {
  return box.kind === 'ec2' && !!box.userId && !!box.ec2InstanceId && box.hibernationConfigured;
}

/** The moment the idle clock started: the last activity, else when the box first came up. */
export function idleSince(box: Pick<LifecycleBox, 'lastActivityAt' | 'readyAt' | 'createdAt'>): Date {
  return box.lastActivityAt ?? box.readyAt ?? box.createdAt;
}

/** When the box is due to hibernate if nothing happens on it, or null when it never will. */
export function hibernateDueAt(box: LifecycleBox): Date | null {
  if (!canAutoHibernate(box) || !box.idleHibernateHours || box.status !== 'ready') return null;
  return new Date(idleSince(box).getTime() + box.idleHibernateHours * HOUR_MS);
}

export interface IdleFacts {
  nowMs: number;
  flagOn: boolean;
  /** Something that must not be interrupted runs on the box (a cloud runner session, an ask run). */
  busy: boolean;
  /** An agent on the box reports `working` right now. */
  working: boolean;
  /** box-idle-stop-enabled for this owner and box. Only read for a box with no `idleHibernateHours`. */
  idleStopOn?: boolean;
}

export type IdleSkip = 'not-eligible' | 'off' | 'not-ready' | 'refresh-pending' | 'flag-off' | 'busy' | 'working' | 'not-idle';
/** `stop` is only ever the default window's, on a box that can't hibernate. */
export type IdleDecision = { hibernate: true } | { stop: true } | { hibernate: false; reason: IdleSkip };

export function isIdleSkip(d: IdleDecision): d is { hibernate: false; reason: IdleSkip } {
  return 'reason' in d;
}

/** An owned EC2 box that can be plainly stopped. */
function canIdleStop(box: Pick<LifecycleBox, 'userId' | 'kind' | 'ec2InstanceId'>): boolean {
  return box.kind === 'ec2' && !!box.userId && !!box.ec2InstanceId;
}

/** When a box under the default window is due if nothing happens on it. */
export function defaultIdleDueAt(box: Pick<LifecycleBox, 'lastActivityAt' | 'readyAt' | 'createdAt'>): Date {
  return new Date(idleSince(box).getTime() + IDLE_STOP_DEFAULT_HOURS * HOUR_MS);
}

export function idleHibernateDecision(box: LifecycleBox, facts: IdleFacts): IdleDecision {
  if (!box.idleHibernateHours && facts.idleStopOn) return defaultWindowDecision(box, facts);
  if (!canAutoHibernate(box)) return { hibernate: false, reason: 'not-eligible' };
  if (!box.idleHibernateHours) return { hibernate: false, reason: 'off' };
  if (box.status !== 'ready') return { hibernate: false, reason: 'not-ready' };
  // The 60-day refresh hibernates it again on its own.
  if (box.rehibernatePending) return { hibernate: false, reason: 'refresh-pending' };
  if (!facts.flagOn) return { hibernate: false, reason: 'flag-off' };
  if (facts.busy) return { hibernate: false, reason: 'busy' };
  if (facts.working) return { hibernate: false, reason: 'working' };
  const due = hibernateDueAt(box)!;
  if (facts.nowMs < due.getTime()) return { hibernate: false, reason: 'not-idle' };
  return { hibernate: true };
}

/**
 * The box-idle-stop-enabled path: no `idleHibernateHours`, so the default
 * window applies, and box-auto-lifecycle-enabled is not consulted. The same
 * guards as the hibernate path; the action depends on whether it can hibernate.
 */
function defaultWindowDecision(box: LifecycleBox, facts: IdleFacts): IdleDecision {
  if (!canIdleStop(box)) return { hibernate: false, reason: 'not-eligible' };
  if (box.status !== 'ready') return { hibernate: false, reason: 'not-ready' };
  if (box.rehibernatePending) return { hibernate: false, reason: 'refresh-pending' };
  if (facts.busy) return { hibernate: false, reason: 'busy' };
  if (facts.working) return { hibernate: false, reason: 'working' };
  if (facts.nowMs < defaultIdleDueAt(box).getTime()) return { hibernate: false, reason: 'not-idle' };
  return canAutoHibernate(box) ? { hibernate: true } : { stop: true };
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
 * The same box once `box-idle-stop-enabled` applies: no `idleHibernateHours`,
 * so the default window stops it. It is still never terminated.
 */
export const CANNOT_HIBERNATE_IDLE_STOP_WARNING =
  "This box (or its image) can't hibernate, so auto-park does nothing on it. It is stopped after 2 hours idle, and it is never terminated.";

/**
 * The warning to show next to a lifecycle setting that will not park the box,
 * or null. `idleStopOn` is `box-idle-stop-enabled` for this owner and box;
 * omit it, or leave it false, and the warning stays the flag-off sentence.
 */
export function lifecycleWarning(
  box: Pick<LifecycleBox, 'userId' | 'kind' | 'ec2InstanceId' | 'hibernationConfigured' | 'idleHibernateHours'>
    & { hibernatedTerminateDays: number | null },
  options?: { idleStopOn?: boolean },
): string | null {
  const on = box.idleHibernateHours != null || box.hibernatedTerminateDays != null;
  if (!on || canAutoHibernate(box)) return null;
  // Own idle hours still mean "hibernate or nothing". The default window
  // only applies when those hours are unset, and only to a box that can be stopped.
  if (options?.idleStopOn && box.idleHibernateHours == null && canIdleStop(box)) {
    return CANNOT_HIBERNATE_IDLE_STOP_WARNING;
  }
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

/** When a parked box is due to be terminated, or null when it never will be as things stand. */
export function terminateDueAt(box: TerminateBox, unsavedLimitDays: number): Date | null {
  if (!canAutoHibernate(box) || box.status !== 'hibernated' || !box.parkedAt || box.rehibernatePending) return null;
  const days = effectiveTerminateDays(box, unsavedLimitDays);
  return days == null ? null : new Date(box.parkedAt.getTime() + days * DAY_MS);
}

export type TerminateSkip = 'not-eligible' | 'off' | 'not-parked' | 'flag-off' | 'not-due';
export type TerminateDecision = { terminate: true; days: number } | { terminate: false; reason: TerminateSkip };

/** Only ever a box that is hibernated right now and has been past its limit. */
export function terminateDecision(
  box: TerminateBox,
  facts: { nowMs: number; flagOn: boolean; unsavedLimitDays: number },
): TerminateDecision {
  if (!canAutoHibernate(box)) return { terminate: false, reason: 'not-eligible' };
  if (box.hibernatedTerminateDays == null) return { terminate: false, reason: 'off' };
  if (box.status !== 'hibernated' || !box.parkedAt || box.rehibernatePending) return { terminate: false, reason: 'not-parked' };
  if (!facts.flagOn) return { terminate: false, reason: 'flag-off' };
  const due = terminateDueAt(box, facts.unsavedLimitDays)!;
  if (facts.nowMs < due.getTime()) return { terminate: false, reason: 'not-due' };
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
  hibernateDueAt: string | null;
  terminateDueAt: string | null;
  parkedAt: string | null;
  /** Only for a parked box: whether its own terminate limit applies (`clean`) or the long one. */
  unsavedWork: UnsavedWorkState | null;
  note: string | null;
  /** Set when a setting is on but the box can't hibernate. */
  warning: string | null;
}

export function lifecycleView(
  box: TerminateBox & { lifecycleNote: string | null },
  unsavedLimitDays: number = unsavedWorkTerminateDays(),
  options?: { idleStopOn?: boolean },
): LifecycleView {
  const due = hibernateDueAt(box);
  const terminateAt = terminateDueAt(box, unsavedLimitDays);
  const parked = box.status === 'hibernated' && !!box.parkedAt;
  return {
    canAutoHibernate: canAutoHibernate(box),
    idleHibernateHours: box.idleHibernateHours,
    hibernatedTerminateDays: box.hibernatedTerminateDays,
    hibernateDueAt: due ? due.toISOString() : null,
    terminateDueAt: terminateAt ? terminateAt.toISOString() : null,
    parkedAt: box.parkedAt ? box.parkedAt.toISOString() : null,
    unsavedWork: parked ? unsavedWorkState(box) : null,
    note: box.lifecycleNote,
    warning: lifecycleWarning(box, options),
  };
}

const AUTO_HIBERNATE_PREFIX = 'Hibernated automatically after ';

export function autoHibernateNote(hours: number): string {
  return `${AUTO_HIBERNATE_PREFIX}${hours} h idle. Start it to resume where you left off.`;
}

/** Not the hibernate note's prefix, so a reviewer can't wake a box the sweep stopped. */
export function autoStopNote(hours: number): string {
  return `Stopped automatically after ${hours} h idle. Start it to get its sessions back.`;
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

export function autoTerminateNote(days: number): string {
  return `Terminated automatically after ${days} ${days === 1 ? 'day' : 'days'} hibernated.`;
}
