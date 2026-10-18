import type { AutoTerminatedBox, Instance } from '../types';

/** The choices the Auto-park dialog offers; null is off. The API takes any whole hour from 1 to 720. */
export const IDLE_HIBERNATE_CHOICES: ReadonlyArray<number | null> = [null, 1, 2, 4, 8, 24];

/** Days hibernated before an automatic terminate; null is off. The API takes any whole day from 1 to 365. */
export const TERMINATE_DAY_CHOICES: ReadonlyArray<number | null> = [null, 1, 7, 14, 30, 90];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shown in the dialog before saving; the server sends its own copy as `lifecycle.warning` once the setting is on. */
export const CANNOT_HIBERNATE_TEXT =
  "This box (or its image) can't hibernate, so auto-park does nothing on it. It is never stopped or terminated instead.";

export function idleChoiceLabel(hours: number | null): string {
  if (hours === null) return 'Off';
  return hours === 1 ? 'After 1 hour idle' : `After ${hours} hours idle`;
}

export function terminateChoiceLabel(days: number | null): string {
  if (days === null) return 'Never';
  return days === 1 ? 'After 1 day hibernated' : `After ${days} days hibernated`;
}

/** The choices with the box's current value in them, when it is one the list doesn't have (set from the CLI). */
function choicesWith(base: ReadonlyArray<number | null>, current: number | null): Array<number | null> {
  const choices = [...base];
  if (current !== null && !choices.includes(current)) {
    choices.push(current);
    choices.sort((a, b) => (a ?? 0) - (b ?? 0));
  }
  return choices;
}

export function idleChoicesFor(current: number | null): Array<number | null> {
  return choicesWith(IDLE_HIBERNATE_CHOICES, current);
}

export function terminateChoicesFor(current: number | null): Array<number | null> {
  return choicesWith(TERMINATE_DAY_CHOICES, current);
}

/**
 * Whether the box menu offers Auto-park: the flag is on and the box is live.
 * A box that can't hibernate gets it too, with a warning, so hibernation is
 * never a precondition for the setting.
 */
export function offersAutoHibernate(box: Pick<Instance, 'lifecycle' | 'status'>, flagOn: boolean): boolean {
  return flagOn && !!box.lifecycle && box.status !== 'terminated';
}

const shortDate = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

interface TerminateSchedule {
  due: Date;
  /** Why the date is later than the box's own setting, when the unsaved-work check moved it. */
  keptFor: 'unsaved' | 'unknown' | null;
}

function terminateSchedule(lc: NonNullable<Instance['lifecycle']>): TerminateSchedule | null {
  if (!lc.terminateDueAt || !lc.parkedAt || !lc.hibernatedTerminateDays) return null;
  const due = new Date(lc.terminateDueAt);
  const stretched = due.getTime() - new Date(lc.parkedAt).getTime() > lc.hibernatedTerminateDays * DAY_MS;
  const keptFor = stretched && (lc.unsavedWork === 'unsaved' || lc.unsavedWork === 'unknown') ? lc.unsavedWork : null;
  return { due, keptFor };
}

/**
 * When a parked box will be terminated, and why later than its own setting
 * when the unsaved-work check stretched it. Null when nothing is scheduled.
 */
export function terminateNoteText(
  lc: NonNullable<Instance['lifecycle']>,
  formatDate: (d: Date) => string = shortDate,
): string | null {
  const schedule = terminateSchedule(lc);
  if (!schedule) return null;
  const text = `Terminates on ${formatDate(schedule.due)}.`;
  if (schedule.keptFor === 'unsaved') return `${text} Kept longer: it has work that isn't pushed anywhere.`;
  if (schedule.keptFor === 'unknown') return `${text} Kept longer: it couldn't be checked for unpushed work.`;
  return text;
}

/**
 * The full lifecycle sentence for a box row, or null. A setting that can't
 * fire says so first; what already happened (an automatic hibernate) and the
 * scheduled terminate show while the box is still parked; the settings
 * themselves show on a ready box.
 */
export function lifecycleNoteText(
  box: Pick<Instance, 'lifecycle' | 'status'>,
  formatDate: (d: Date) => string = shortDate,
): string | null {
  const lc = box.lifecycle;
  if (!lc) return null;
  if (lc.warning) return lc.warning;
  if (box.status === 'hibernated' || box.status === 'hibernating') {
    const parts = [lc.note, box.status === 'hibernated' ? terminateNoteText(lc, formatDate) : null].filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }
  if (box.status !== 'ready') return null;
  const days = lc.hibernatedTerminateDays;
  const terminate = days ? `terminates after ${days} ${days === 1 ? 'day' : 'days'} hibernated` : null;
  if (lc.idleHibernateHours) {
    return `Hibernates automatically after ${lc.idleHibernateHours} h idle${terminate ? `, and ${terminate}` : ''}.`;
  }
  if (terminate) return `${terminate[0].toUpperCase()}${terminate.slice(1)}.`;
  return null;
}

/**
 * The box row's note: a few words that fit the sidebar on one line, with the
 * full sentence (`lifecycleNoteText`) as its tooltip.
 */
export function lifecycleNote(
  box: Pick<Instance, 'lifecycle' | 'status'>,
  formatDate: (d: Date) => string = shortDate,
): { text: string; title: string } | null {
  const title = lifecycleNoteText(box, formatDate);
  const lc = box.lifecycle;
  if (!title || !lc) return null;
  if (lc.warning) return { text: "Auto-park can't run here", title };
  if (box.status === 'ready') {
    const hours = lc.idleHibernateHours;
    const days = lc.hibernatedTerminateDays;
    if (hours && days) return { text: `Park ${hours} h · terminate ${days} d`, title };
    if (hours) return { text: `Auto-park after ${hours} h idle`, title };
    return { text: `Terminate after ${days} d parked`, title };
  }
  const schedule = box.status === 'hibernated' ? terminateSchedule(lc) : null;
  if (schedule) {
    const why = schedule.keptFor === 'unsaved' ? ' · unpushed' : schedule.keptFor === 'unknown' ? ' · unchecked' : '';
    return { text: `Terminates ${formatDate(schedule.due)}${why}`, title };
  }
  return { text: 'Auto-parked', title };
}

/** The Boxes-section line for a box the sweep terminated recently. */
export function autoTerminatedText(box: AutoTerminatedBox): string {
  return `"${box.name}": ${box.lifecycleNote ?? 'Terminated automatically.'}`;
}
