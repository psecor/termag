/**
 * Every "is this heavy / stale?" level in one place. The sidebar badges and the
 * dashboard's Attention section read the same numbers so they flip together.
 */
import { THERMO_MAX_MS, THERMO_MID_MS } from './worktime';

// Context tokens (cumulative input pressure as reported by the agent's scanner).
export const CONTEXT_WARN_TOKENS = 500_000;
export const CONTEXT_DANGER_TOKENS = 1_000_000;

export type ContextLevel = 'ok' | 'warn' | 'danger';
export function contextLevel(tokens: number | null | undefined): ContextLevel {
  if (tokens == null) return 'ok';
  if (tokens >= CONTEXT_DANGER_TOKENS) return 'danger';
  if (tokens >= CONTEXT_WARN_TOKENS) return 'warn';
  return 'ok';
}

// An agent sitting in `waiting` (approval / input) this long deserves a nudge.
export const WAITING_WARN_MS = 30 * 60_000;
export const WAITING_CRIT_MS = 2 * 3_600_000;

// A live tmux session with no activity this long is probably forgotten.
export const IDLE_NOTICE_MS = 2 * 3_600_000;
export const IDLE_WARN_MS = 24 * 3_600_000;

// Today's tokens vs the trailing median of active days.
export const TOKEN_BURN_WARN_RATIO = 2;
export const TOKEN_BURN_CRIT_RATIO = 3;
export const TOKEN_BURN_MIN_TOKENS = 1_000_000; // absolute floor so quiet users never trip it
export const TRAILING_MEDIAN_DAYS = 14;
export const MIN_DAYS_FOR_MEDIAN = 3;

// Agent working time on one project today.
export const EFFORT_NOTICE_MS = THERMO_MID_MS; // 4h
export const EFFORT_WARN_MS = THERMO_MAX_MS;   // 8h
