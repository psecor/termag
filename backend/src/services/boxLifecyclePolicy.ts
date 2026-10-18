/**
 * Automatic box lifecycle: the pure decisions.
 * `boxLifecycle.ts` owns the sweep, the flag read and every write; this module
 * only decides, so the rules are unit-testable.
 *
 * A box hibernates on its own once it has been idle for its
 * `idleHibernateHours`. Only boxes launched hibernation-capable take part:
 * there is no plain-stop or terminate fallback, so a box that can't hibernate
 * keeps its setting (with a warning) and is never touched. Idle means no
 * human input and no agent `working` status since `lastActivityAt`; an agent
 * waiting on its user counts as idle.
 *
 * A box hibernated for its `hibernatedTerminateDays` is terminated. That
 * limit is raised to the unsaved-work limit (90 days) unless the agent's scan
 * just before the hibernate found nothing; only a hibernated box is ever
 * terminated.
 */

export const BOX_AUTO_LIFECYCLE_FLAG = 'box-auto-lifecycle-enabled';

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

/** The settings a subagent sandbox box gets at creation (phase 2 of agent messaging). */
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
}

export type IdleSkip = 'not-eligible' | 'off' | 'not-ready' | 'refresh-pending' | 'flag-off' | 'busy' | 'working' | 'not-idle';
export type IdleDecision = { hibernate: true } | { hibernate: false; reason: IdleSkip };

export function idleHibernateDecision(box: LifecycleBox, facts: IdleFacts): IdleDecision {
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

/** The warning to show next to a lifecycle setting that will never fire, or null. */
export function lifecycleWarning(
  box: Pick<LifecycleBox, 'userId' | 'kind' | 'ec2InstanceId' | 'hibernationConfigured' | 'idleHibernateHours'>
    & { hibernatedTerminateDays: number | null },
): string | null {
  const on = box.idleHibernateHours != null || box.hibernatedTerminateDays != null;
  return on && !canAutoHibernate(box) ? CANNOT_HIBERNATE_WARNING : null;
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
  /** Set when a setting is on but the box can't hibernate, so it will never fire. */
  warning: string | null;
}

export function lifecycleView(
  box: TerminateBox & { lifecycleNote: string | null },
  unsavedLimitDays: number = unsavedWorkTerminateDays(),
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
    warning: lifecycleWarning(box),
  };
}

export function autoHibernateNote(hours: number): string {
  return `Hibernated automatically after ${hours} h idle. Start it to resume where you left off.`;
}

export function autoTerminateNote(days: number): string {
  return `Terminated automatically after ${days} ${days === 1 ? 'day' : 'days'} hibernated.`;
}
