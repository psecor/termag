/**
 * PR analytics arithmetic: pure.
 */

export const WINDOWS = [1, 7, 30] as const;
export type WindowDays = typeof WINDOWS[number];
export const VIEWS = ['credited', 'humans', 'all'] as const;
/** credited: humans plus agent PRs credited to them (default); humans: human-authored only; all: every author, bots included. */
export type View = typeof VIEWS[number];
export const BASES = ['merged', 'opened'] as const;
export type Basis = typeof BASES[number];

export interface Distribution { contributors: number; p50: number; p95: number; mean: number; max: number }

/** Linear-interpolated percentile over sorted values, as Postgres percentile_cont. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** PRs per person over the people with at least one PR. */
export function distribution(perPerson: number[]): Distribution {
  const v = perPerson.filter(n => n > 0).sort((a, b) => a - b);
  if (!v.length) return { contributors: 0, p50: 0, p95: 0, mean: 0, max: 0 };
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    contributors: v.length,
    p50: round(percentile(v, 0.5)),
    p95: round(percentile(v, 0.95)),
    mean: round(v.reduce((s, n) => s + n, 0) / v.length),
    max: v[v.length - 1],
  };
}

/** Median of a list (PR sizes in the contributor table). */
export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? Math.round(percentile(v, 0.5)) : 0;
}

export function parseChoice<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T | null {
  if (raw === undefined || raw === '') return fallback;
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? raw as T : null;
}
