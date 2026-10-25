/**
 * The card's charts, from the
 * database only: your time against the agents' per day for the last week,
 * tokens per day, and the window's time per project. Stored on the briefing
 * row, so an old briefing shows the charts it was written with.
 *
 * Pure. Day keys follow their tables: worktime days are server-local, token
 * days UTC (the same keys on a UTC server, which production is).
 */
import type { BriefingCharts } from './types';

export const CHART_DAYS = 7;
export const CHART_PROJECTS = 8;

export interface ChartInput {
  /** The CHART_DAYS day keys, oldest first. */
  days: string[];
  /** Worktime rows over those days, already resolved to projects. */
  worktime: Array<{ date: string; provider: string; totalMs: number; projectId: string | null }>;
  tokensByDay: Array<{ date: string; tokens: number }>;
  /** Worktime rows of the window's days only, for the per-project bars. */
  windowWorktime: Array<{ provider: string; totalMs: number; projectId: string | null }>;
  projectNames: ReadonlyMap<string, string>;
}

/** The `n` day keys ending at `last` ("YYYY-MM-DD"), oldest first. */
export function dayKeysEnding(last: string, n: number = CHART_DAYS): string[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

export function buildCharts(input: ChartInput): BriefingCharts {
  const byDay = new Map(input.days.map(d => [d, { day: d, humanMs: 0, agentMs: 0, tokens: 0 }]));
  for (const r of input.worktime) {
    const d = byDay.get(r.date);
    if (!d) continue;
    if (r.provider === 'human') d.humanMs += r.totalMs; else d.agentMs += r.totalMs;
  }
  for (const t of input.tokensByDay) {
    const d = byDay.get(t.date);
    if (d) d.tokens += t.tokens;
  }

  const byProject = new Map<string, { projectId: string; name: string; humanMs: number; agentMs: number }>();
  for (const r of input.windowWorktime) {
    if (!r.projectId) continue;
    const name = input.projectNames.get(r.projectId);
    if (!name) continue;
    let p = byProject.get(r.projectId);
    if (!p) { p = { projectId: r.projectId, name, humanMs: 0, agentMs: 0 }; byProject.set(r.projectId, p); }
    if (r.provider === 'human') p.humanMs += r.totalMs; else p.agentMs += r.totalMs;
  }

  return {
    days: input.days.map(d => byDay.get(d)!),
    projects: [...byProject.values()]
      .filter(p => p.humanMs + p.agentMs > 0)
      .sort((a, b) => (b.humanMs + b.agentMs) - (a.humanMs + a.agentMs))
      .slice(0, CHART_PROJECTS),
  };
}
