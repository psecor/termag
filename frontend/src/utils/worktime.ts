import type { WorktimeResponse, WorktimeDay } from '../services/api';
import { PROVIDERS, ProviderConfig } from '../providers/registry';

/** The pseudo-provider under which the user's own typing time is banked. */
export const HUMAN = 'human';

// Thermometer calibration. Fill heights use MAX (8h = full tube); the % readouts
// divide by MID (4h = "100%"). Two denominators on purpose.
export const THERMO_MAX_MS = 8 * 3_600_000;
export const THERMO_MID_MS = 4 * 3_600_000;

// Series colors for signals that aren't a provider.
export const SWITCH_COLOR = '#5eead4'; // teal — project switches
export const WARP_COLOR = '#a78bfa';   // purple — flow/hyperspace
export const CTX_COLOR = '#58a6ff';    // blue — context fallback when a project has no color

export type WtDayData = Record<string, WorktimeDay>; // provider → { totalMs, sessions }

/** Sum totalMs across all providers for one day */
export function dayMs(dw: WtDayData | undefined): number {
  if (!dw) return 0;
  return Object.values(dw).reduce((s, v) => s + v.totalMs, 0);
}

/** Sum agent (non-human) totalMs for one day */
export function agentDayMs(dw: WtDayData | undefined): number {
  if (!dw) return 0;
  return Object.entries(dw).filter(([k]) => k !== HUMAN).reduce((s, [, v]) => s + v.totalMs, 0);
}

/** Merge worktime from multiple date strings (handles UTC/local overlap) */
export function mergeWtDays(wt: WorktimeResponse, dates: string[]): WtDayData {
  const merged: WtDayData = {};
  for (const dt of dates) {
    const dw = wt.days[dt];
    if (!dw) continue;
    for (const [pid, v] of Object.entries(dw)) {
      if (!merged[pid]) merged[pid] = { totalMs: 0, sessions: 0 };
      merged[pid].totalMs += v.totalMs;
      merged[pid].sessions += v.sessions;
    }
  }
  return merged;
}

/** Providers that have worktime data in the response (includes `human`). */
export function activeWtProviders(wt: WorktimeResponse): ProviderConfig[] {
  const seen = new Set<string>();
  for (const dw of Object.values(wt.days)) {
    for (const pid of Object.keys(dw)) seen.add(pid);
  }
  return Object.values(PROVIDERS).filter(p => seen.has(p.id));
}

export function fillGradient(pct: number, color: { base: string; bright: string }): string {
  if (pct <= 50) return color.base;
  const midPoint = (50 / pct) * 100;
  return `linear-gradient(to top, ${color.base} 0%, ${color.base} ${midPoint}%, ${color.bright} 100%)`;
}
