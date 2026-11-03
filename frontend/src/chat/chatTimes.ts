// When things happened in an SDK chat, in the viewer's own timezone: a reply's
// end ("18:14", "27 Oct 18:14" on another day), a tool call's duration and
// end, a run's span, and the live counter on a call still running. The times
// are the ones the stream and the transcript carry (chat/sdkChat.ts stamps
// them on the items), never the box's or the server's zone. termag keeps no
// display timezone of its own (the briefing schedule's zone is when the
// briefing runs), so the zone is the browser's.
import { formatDuration } from './sdkChat';

/** The viewer's timezone: the browser's, or UTC when it can't say. */
export function viewerTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** A time as milliseconds, or null for no time or one that doesn't parse. */
export function timeMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function parts(ms: number, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options }).formatToParts(ms)) out[p.type] = p.value;
  return out;
}

const dayOf = (ms: number, timeZone: string) => {
  const p = parts(ms, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
};

/**
 * The zone's short name: "PDT", "CET", "BST", else its offset ("GMT+5:30").
 * en-US names America's zones, en-GB Europe's; each gives an offset for the rest.
 */
export function zoneName(ms: number, timeZone: string): string {
  const name = (locale: string) => new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
    .formatToParts(ms).find(p => p.type === 'timeZoneName')?.value ?? '';
  const us = name('en-US');
  if (us && !/^GMT[+-]/.test(us)) return us;
  const gb = name('en-GB');
  return gb && !/^GMT[+-]/.test(gb) ? gb : us || timeZone;
}

/** "18:14" today, "27 Oct 18:14" on another day this year, "27 Oct 2025, 18:14" before that. */
export function shortTime(iso: string, now: number = Date.now(), timeZone: string = viewerTimeZone()): string {
  const ms = timeMs(iso);
  if (ms == null) return '';
  const p = parts(ms, timeZone, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const hm = `${p.hour}:${p.minute}`;
  if (dayOf(ms, timeZone) === dayOf(now, timeZone)) return hm;
  if (p.year === parts(now, timeZone, { year: 'numeric' }).year) return `${p.day} ${p.month} ${hm}`;
  return `${p.day} ${p.month} ${p.year}, ${hm}`;
}

/** "28 Oct 2026, 18:14:05 PDT": the hover's full timestamp, naming the zone. */
export function fullTime(iso: string, timeZone: string = viewerTimeZone()): string {
  const ms = timeMs(iso);
  if (ms == null) return '';
  const p = parts(ms, timeZone, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}:${p.second} ${zoneName(ms, timeZone)}`;
}

/**
 * A span's full times: "28 Oct 2026, 18:02:11 – 18:14:05 PDT" within a day,
 * both in full across days (or zone changes).
 */
export function fullSpan(startIso: string, endIso: string, timeZone: string = viewerTimeZone()): string {
  const a = timeMs(startIso);
  const b = timeMs(endIso);
  if (a == null || b == null) return '';
  const start = fullTime(startIso, timeZone);
  const end = fullTime(endIso, timeZone);
  if (dayOf(a, timeZone) !== dayOf(b, timeZone) || zoneName(a, timeZone) !== zoneName(b, timeZone)) return `${start} – ${end}`;
  const p = parts(b, timeZone, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${start.slice(0, start.lastIndexOf(' '))} – ${p.hour}:${p.minute}:${p.second} ${zoneName(b, timeZone)}`;
}

/** The live counter's words: "12s", "12m", "1h 5m". Coarser than formatDuration, so it ticks quietly. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** How long from one time to another, or null when either is missing (or the clocks disagree). */
export function spanMs(startIso: string | null | undefined, endIso: string | null | undefined): number | null {
  const a = timeMs(startIso);
  const b = timeMs(endIso);
  return a == null || b == null || b < a ? null : b - a;
}

/** "4s", "11m 54s": a span's duration, as the reply meta writes one. */
export function spanText(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  const ms = spanMs(startIso, endIso);
  return ms == null ? null : formatDuration(ms);
}

/** "18:02–18:14" (or with days, "27 Oct 23:58 – 28 Oct 00:03"): a run's span, short. */
export function shortSpan(startIso: string, endIso: string, now: number = Date.now(), timeZone: string = viewerTimeZone()): string {
  const a = shortTime(startIso, now, timeZone);
  const b = shortTime(endIso, now, timeZone);
  const sameDay = timeMs(startIso) != null && timeMs(endIso) != null && dayOf(timeMs(startIso)!, timeZone) === dayOf(timeMs(endIso)!, timeZone);
  if (a === b) return a;
  if (sameDay) {
    const p = parts(timeMs(endIso)!, timeZone, { hour: '2-digit', minute: '2-digit' });
    return `${a}–${p.hour}:${p.minute}`;
  }
  return `${a} – ${b}`;
}
