import type { AutoTerminatedBox, Instance } from '../types';

/** The choices the Auto-park dialog offers; null is off. The API takes any whole hour from 1 to 720. */
export const IDLE_HIBERNATE_CHOICES: ReadonlyArray<number | null> = [null, 1, 2, 4, 8, 24];

/** Days parked before an automatic terminate; null is off. The API takes any whole day from 1 to 365. */
export const TERMINATE_DAY_CHOICES: ReadonlyArray<number | null> = [null, 1, 7, 14, 30, 90];

const DAY_MS = 24 * 60 * 60 * 1000;

export function idleChoiceLabel(hours: number | null): string {
  if (hours === null) return 'Off';
  return hours === 1 ? 'After 1 hour idle' : `After ${hours} hours idle`;
}

/** Counted from when auto-park stopped the box. */
export function terminateChoiceLabel(days: number | null): string {
  if (days === null) return 'Never';
  return days === 1 ? 'After 1 day parked' : `After ${days} days parked`;
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

/** Whether the row dates a terminate: a stopped box, or one hibernated before parking became a stop. */
function datesTerminate(box: Pick<Instance, 'lifecycle' | 'status'>): boolean {
  return box.status === 'hibernated' || box.status === 'stopped';
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

/** "1 h 40 m", "25 min", "3 days": how long until a warned park. */
export function untilText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} m` : `${hours} h`;
}

/** The standing warning's park time, when the box has one: what the row counts down to and Keep running cancels. */
export function warnedParkAt(box: Pick<Instance, 'lifecycle' | 'status'>): Date | null {
  const lc = box.lifecycle;
  // `starting`: the stuck-start warning, for a box whose agent never connected.
  if ((box.status !== 'ready' && box.status !== 'starting') || !lc?.warnedAt || !lc.parkAt) return null;
  return new Date(lc.parkAt);
}

/**
 * The full lifecycle sentence for a box row, or null. A setting that can't
 * fire says so first; what already happened (an automatic hibernate, or a
 * plain idle stop) shows while the box is still down; the scheduled
 * terminate is added only on a parked (stopped or hibernated) box; the
 * settings themselves show on a ready box.
 */
export function lifecycleNoteText(
  box: Pick<Instance, 'lifecycle' | 'status'>,
  formatDate: (d: Date) => string = shortDate,
): string | null {
  const lc = box.lifecycle;
  if (!lc) return null;
  const warned = warnedParkAt(box);
  if (box.status === 'starting' && warned) {
    return `Stops at ${warned.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}: `
      + "its agent hasn't connected since it was started. Restarting the agent keeps it up.";
  }
  if (lc.warning) return lc.warning;
  if (box.status === 'hibernated' || box.status === 'hibernating' || box.status === 'stopped' || box.status === 'stopping') {
    const parts = [lc.note, datesTerminate(box) ? terminateNoteText(lc, formatDate) : null].filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }
  if (box.status !== 'ready') return null;
  if (warned && lc.idleLimitHours) {
    const stops = lc.parkAction === 'stop';
    const window = `${lc.idleLimitHours} h${lc.idleLimitSource === 'default' ? ' (the default)' : ''}`;
    return `${stops ? 'Stops' : 'Hibernates'} at ${warned.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} unless someone uses it: `
      + `nothing has happened on it for ${window}. Keep running restarts the clock.`;
  }
  const days = lc.hibernatedTerminateDays;
  const terminate = days ? `terminates after ${days} ${days === 1 ? 'day' : 'days'} parked` : null;
  if (lc.idleHibernateHours) {
    return `Stops automatically after ${lc.idleHibernateHours} h idle${terminate ? `, and ${terminate}` : ''}.`;
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
  nowMs: number = Date.now(),
): { text: string; title: string; keepRunning?: boolean } | null {
  const title = lifecycleNoteText(box, formatDate);
  const lc = box.lifecycle;
  if (!title || !lc) return null;
  const warned = warnedParkAt(box);
  if (warned) {
    const stops = lc.parkAction === 'stop';
    // Past the promised time the box is held busy, or the next sweep hasn't come: it is due, not a minute away (Devin on #622).
    const text = warned.getTime() <= nowMs
      ? `Due to ${stops ? 'stop' : 'hibernate'} now`
      : `${stops ? 'Stops' : 'Hibernates'} in ${untilText(warned.getTime() - nowMs)}`;
    // Keep running needs a running box; a stuck one is kept by its agent coming back.
    return { text, title, keepRunning: box.status === 'ready' };
  }
  if (lc.warning) return { text: "Auto-park can't run here", title };
  if (box.status === 'ready') {
    const hours = lc.idleHibernateHours;
    const days = lc.hibernatedTerminateDays;
    if (hours && days) return { text: `Park ${hours} h · terminate ${days} d`, title };
    if (hours) return { text: `Auto-park after ${hours} h idle`, title };
    return { text: `Terminate after ${days} d parked`, title };
  }
  const schedule = datesTerminate(box) ? terminateSchedule(lc) : null;
  if (schedule) {
    const why = schedule.keptFor === 'unsaved' ? ' · unpushed' : schedule.keptFor === 'unknown' ? ' · unchecked' : '';
    return { text: `Terminates ${formatDate(schedule.due)}${why}`, title };
  }
  if (box.status === 'stopped' || box.status === 'stopping') return { text: 'Auto-stopped', title };
  return { text: 'Auto-parked', title };
}

/** The Boxes-section line for a box the sweep terminated recently. */
export function autoTerminatedText(box: AutoTerminatedBox): string {
  return `"${box.name}": ${box.lifecycleNote ?? 'Terminated automatically.'}`;
}
