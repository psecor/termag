// The schedule part of the automation form: presets a
// person picks from, the 5-field cron each one means, and the words for a
// cron the server normalised. Pure, so the dialog and the page share it.

export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';

export const PRESETS: { id: SchedulePreset; label: string }[] = [
  { id: 'hourly', label: 'Every hour' },
  { id: 'daily', label: 'Every day at…' },
  { id: 'weekdays', label: 'Weekdays at…' },
  { id: 'weekly', label: 'Every week on…' },
  { id: 'custom', label: 'Custom cron' },
];

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface PresetInput {
  preset: SchedulePreset;
  /** HH:MM, 24-hour, for daily, weekdays and weekly. */
  time: string;
  /** 0 (Sunday) to 6, for weekly. */
  weekday: number;
  /** The expression itself, for custom. */
  cron: string;
}

// What a `type="time"` input yields: HH:MM, or HH:MM:SS (seconds are ignored; a schedule is to the minute).
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/;

/** The cron a preset means, or null when its fields are not filled in. */
export function presetToCron(i: PresetInput): string | null {
  if (i.preset === 'custom') return i.cron.trim() || null;
  if (i.preset === 'hourly') return '0 * * * *';
  const m = TIME.exec(i.time.trim());
  if (!m) return null;
  const minute = Number(m[2]);
  const hour = Number(m[1]);
  switch (i.preset) {
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': return `${minute} ${hour} * * ${Math.min(Math.max(i.weekday, 0), 6)}`;
  }
  return null;
}

/** The preset a stored cron came from, so the edit form opens on it rather than on "Custom". */
export function cronToPreset(cron: string): PresetInput {
  const f = cron.trim().split(/\s+/);
  const time = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (f.length === 5 && /^\d+$/.test(f[0]) && f[2] === '*' && f[3] === '*') {
    if (f[1] === '*' && f[0] === '0' && f[4] === '*') return { preset: 'hourly', time: '09:00', weekday: 1, cron };
    if (/^\d+$/.test(f[1])) {
      if (f[4] === '*') return { preset: 'daily', time: time(f[1], f[0]), weekday: 1, cron };
      if (f[4] === '1-5') return { preset: 'weekdays', time: time(f[1], f[0]), weekday: 1, cron };
      if (/^[0-6]$/.test(f[4])) return { preset: 'weekly', time: time(f[1], f[0]), weekday: Number(f[4]), cron };
    }
  }
  return { preset: 'custom', time: '09:00', weekday: 1, cron };
}

/** A cron in words where its shape is a preset's; the expression itself otherwise. */
export function describeSchedule(cron: string, timezone: string): string {
  const p = cronToPreset(cron);
  const tz = timezone ? ` (${timezone})` : '';
  switch (p.preset) {
    case 'hourly': return 'every hour';
    case 'daily': return `every day at ${p.time}${tz}`;
    case 'weekdays': return `weekdays at ${p.time}${tz}`;
    case 'weekly': return `every ${WEEKDAYS[p.weekday]} at ${p.time}${tz}`;
    default: return `cron ${cron}${tz}`;
  }
}

/** The browser's zone, or UTC when it cannot say. */
export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** "Mon 09:00" (this week) or "20 Oct 09:00": a run or occurrence as the sidebar and the run table name it. */
export function occurrenceShort(iso: string, timezone: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = { timeZone: timezone || undefined, hour: '2-digit', minute: '2-digit', hour12: false };
  const near = Math.abs(d.getTime() - now.getTime()) < 6 * 24 * 60 * 60_000;
  try {
    if (near) return new Intl.DateTimeFormat('en-GB', { ...opts, weekday: 'short' }).format(d).replace(',', '');
    return new Intl.DateTimeFormat('en-GB', { ...opts, day: 'numeric', month: 'short' }).format(d).replace(',', '');
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** "in 2h", "in 3d", "now": how far off an occurrence is. */
export function untilLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

export const RUN_STATE_LABEL: Record<string, string> = {
  pending: 'waiting for the box', running: 'running', done: 'done', blocked: 'blocked', needs_input: 'needs input', failed: 'failed', skipped: 'skipped',
};

/** The sidebar subtitle under an automation: next run, then the last run's state. */
export function automationSubtitle(a: { nextRunAt: string | null; enabled: boolean; pausedReason: string | null; lastRun: { state: string; finishedAt: string | null; startedAt: string | null; reasonLabel: string | null } | null }, timezone: string, now: Date = new Date()): string {
  if (a.pausedReason) return `paused: ${a.pausedReason === 'consecutive_failures' ? 'kept failing' : a.pausedReason === 'box_gone' ? 'the box is gone' : a.pausedReason}`;
  const parts: string[] = [];
  if (!a.enabled) parts.push('off');
  else if (a.nextRunAt) parts.push(`next ${occurrenceShort(a.nextRunAt, timezone, now)}`);
  if (a.lastRun) {
    const when = a.lastRun.finishedAt ?? a.lastRun.startedAt;
    const label = RUN_STATE_LABEL[a.lastRun.state] ?? a.lastRun.state;
    parts.push(a.lastRun.state === 'skipped' && a.lastRun.reasonLabel ? `skipped: ${a.lastRun.reasonLabel}` : `last ${label}${when ? ` ${agoLabel(when, now)}` : ''}`);
  }
  return parts.join(' · ');
}

export function agoLabel(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
