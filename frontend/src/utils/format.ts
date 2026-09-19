import type { UsageDayData } from '../services/api';

export const EMPTY_USAGE_DAY: UsageDayData = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 };

/** Total tokens in a usage day: input + output + cache read + cache create. */
export function dayTokens(d: UsageDayData): number {
  return d.input + d.output + d.cacheRead + d.cacheCreate;
}

/** "999" | "12k" | "1.5M" */
export function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "3h 14m" | "14m" */
export function fmtDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** "3h14" | "3h" | "14m" — for tight spots (thermometer footer, axis ticks). */
export function fmtDurationShort(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h${mins > 0 ? mins : ''}`;
  return `${mins}m`;
}

/** "3d 4h" | "4h 12m" | "12m" | "<1m" — for "idle for …" / "waiting ≥ …" ages. */
export function fmtAge(ms: number): string {
  if (ms < 60_000) return '<1m';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${mins > 0 ? ` ${mins}m` : ''}`;
  return `${mins}m`;
}
