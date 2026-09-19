/**
 * Pure helpers over the per-project part of UsageResponse. Testable (.ts).
 *
 * Colors follow the ENTITY: a project keeps its own color; a project without one
 * gets a stable hue from a hash of its id, so filtering the range never repaints
 * survivors. "Other" and "Unattributed" are fixed greys.
 */
import type { UsageResponse, UsageDayData } from '../../services/api';
import { dayTokens, EMPTY_USAGE_DAY } from '../../utils/format';

export const OTHER_COLOR = '#6e7681';
export const UNATTRIBUTED_COLOR = '#484f58';
export const OTHER_ID = '__other';
export const UNATTRIBUTED_ID = '__unattributed';

// Fallback hues for projects without a color, chosen apart in hue at a
// mid lightness so adjacent slots stay distinguishable on the dark surface.
const FALLBACK = ['#2f81f7', '#3fb950', '#d29922', '#db61a2', '#a371f7', '#39c5cf', '#f0883e', '#8b949e'];

export function stableColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

export interface ProjectSeries {
  id: string;        // projectId, OTHER_ID or UNATTRIBUTED_ID
  label: string;
  color: string;
  days: Record<string, UsageDayData>;
  total: number;     // tokens over the range
}

function sumInto(target: Record<string, UsageDayData>, days: Record<string, UsageDayData>, dates: string[]): void {
  for (const d of dates) {
    const v = days[d];
    if (!v) continue;
    const t = target[d] ?? (target[d] = { ...EMPTY_USAGE_DAY });
    t.input += v.input; t.output += v.output; t.cacheRead += v.cacheRead; t.cacheCreate += v.cacheCreate; t.calls += v.calls;
  }
}
const rangeTotal = (days: Record<string, UsageDayData>, dates: string[]) =>
  dates.reduce((s, d) => s + dayTokens(days[d] ?? EMPTY_USAGE_DAY), 0);

/**
 * Group the response's (project × workstream) entries by project, rank by
 * tokens over `dates`, keep the top N, fold the rest into "Other", and append
 * "Unattributed" when non-zero. Series with zero tokens in range are dropped.
 */
export function projectSeries(usage: UsageResponse, dates: string[], top = 8): ProjectSeries[] {
  const byProject = new Map<string, ProjectSeries>();
  for (const p of usage.projects ?? []) {
    let s = byProject.get(p.projectId);
    if (!s) {
      s = { id: p.projectId, label: p.name, color: p.color ?? stableColor(p.projectId), days: {}, total: 0 };
      byProject.set(p.projectId, s);
    }
    sumInto(s.days, p.days, dates);
  }
  const ranked = [...byProject.values()]
    .map(s => ({ ...s, total: rangeTotal(s.days, dates) }))
    .filter(s => s.total > 0)
    .sort((a, b) => b.total - a.total);
  const out = ranked.slice(0, top);
  const rest = ranked.slice(top);
  if (rest.length) {
    const other: ProjectSeries = { id: OTHER_ID, label: `Other (${rest.length})`, color: OTHER_COLOR, days: {}, total: 0 };
    for (const s of rest) sumInto(other.days, s.days, dates);
    other.total = rangeTotal(other.days, dates);
    out.push(other);
  }
  if (usage.unattributed) {
    const total = rangeTotal(usage.unattributed, dates);
    if (total > 0) {
      const days: Record<string, UsageDayData> = {};
      sumInto(days, usage.unattributed, dates);
      out.push({ id: UNATTRIBUTED_ID, label: 'Unattributed', color: UNATTRIBUTED_COLOR, days, total });
    }
  }
  return out;
}

/** Tokens per projectId over `dates` (all workstreams summed). */
export function projectTokensInRange(usage: UsageResponse | null, dates: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of usage?.projects ?? []) {
    const t = rangeTotal(p.days, dates);
    if (t > 0) out.set(p.projectId, (out.get(p.projectId) ?? 0) + t);
  }
  return out;
}

export function unattributedInRange(usage: UsageResponse | null, dates: string[]): number {
  return usage?.unattributed ? rangeTotal(usage.unattributed, dates) : 0;
}

/**
 * The project responsible for at least `minShare` of today's ATTRIBUTED tokens,
 * or null when no single project dominates (or nothing is attributed).
 */
export function dominantProjectToday(
  usage: UsageResponse | null,
  todayUTC: string,
  minShare = 0.5,
): { projectId: string; name: string; color: string | null; share: number; tokens: number } | null {
  if (!usage?.projects?.length) return null;
  const totals = new Map<string, { name: string; color: string | null; tokens: number }>();
  let all = 0;
  for (const p of usage.projects) {
    const t = dayTokens(p.days[todayUTC] ?? EMPTY_USAGE_DAY);
    if (t <= 0) continue;
    all += t;
    const cur = totals.get(p.projectId) ?? { name: p.name, color: p.color, tokens: 0 };
    cur.tokens += t;
    totals.set(p.projectId, cur);
  }
  if (all <= 0) return null;
  let best: { projectId: string; name: string; color: string | null; tokens: number } | null = null;
  for (const [projectId, v] of totals) if (!best || v.tokens > best.tokens) best = { projectId, ...v };
  if (!best) return null;
  const share = best.tokens / all;
  return share >= minShare ? { ...best, share } : null;
}

/** Hosts still reporting the old (unattributable) agent schema. */
export function oldSchemaHosts(usage: UsageResponse | null): string[] {
  return (usage?.hosts ?? []).filter(h => h.schema === 1).map(h => h.name);
}
