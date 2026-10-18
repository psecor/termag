// Pure helpers for the admin view of Claude Code cloud sessions
//. No fetching, no React; see
// adminCloud.test.ts. The owner's own helpers are in cloudSessions.ts.
import type { AdminRange, CloudCounts, CloudReport, HostPressure, PipelineBox } from '../services/adminApi';

/**
 * "ada · Claude Cloud 3": the session's name is a per-owner ordinal, so the
 * admin table, which mixes owners, prefixes it with the owner.
 */
export function adminCloudName(owner: string, name: string): string {
  return `${owner} · ${name}`;
}

/**
 * The tmux column. `alive` is null when the box did not answer the probe,
 * which is also when a run cannot be told live from gone: say which.
 */
export function tmuxLabel(alive: boolean | null, boxConnected: boolean): 'live' | 'gone' | 'box offline' | 'no answer' {
  if (alive === true) return 'live';
  if (alive === false) return 'gone';
  return boxConnected ? 'no answer' : 'box offline';
}

/** The orchestrator polls Anthropic every few seconds; a last poll this old means it is wedged, not idle. */
export const POLL_STALE_MS = 2 * 60_000;

export function pollStale(lastPollIso: string | null, now: number): boolean {
  if (!lastPollIso) return false;
  const t = Date.parse(lastPollIso);
  return Number.isFinite(t) && now - t > POLL_STALE_MS;
}

/** "2 running · 1 starting", or '' with nothing open: a table cell. */
export function cloudCountCell(c: CloudCounts | null | undefined): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.running) parts.push(`${c.running} running`);
  if (c.starting) parts.push(`${c.starting} starting`);
  return parts.join(' · ');
}

/** The KPI's small print: what is not yet running and what could not be placed. */
export function cloudKpiNote(c: CloudCounts & { queued: number }): string {
  return `${c.starting} starting · ${c.queued} queued`;
}

/** The recent-ends window the Cloud tab reads for a range preset: the route caps days at 30. */
export function daysForRange(range: AdminRange): number {
  return range === 'today' ? 1 : range === '7d' ? 7 : 30;
}

/** Hours from slot-seconds, one decimal, for chart rows and cells. */
export function slotHours(seconds: number): number {
  return Math.round(seconds / 360) / 10;
}

/** The keys of every stacked series across the report's rows, sorted by total descending so the legend reads largest first. */
export function stackKeys(rows: ReadonlyArray<Record<string, number>>): string[] {
  const totals = new Map<string, number>();
  for (const r of rows) for (const [k, v] of Object.entries(r)) totals.set(k, (totals.get(k) ?? 0) + v);
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

/** One chart row per report row: the label, sessions, runs, slot-hours, and the two stacks flattened for recharts. */
export function reportChartRows(report: CloudReport): Array<Record<string, number | string>> {
  return report.rows.map(r => ({ label: r.label, sessions: r.sessions, runs: r.runs, slotHours: slotHours(r.slotSeconds), ...r.ends, ...Object.fromEntries(Object.entries(r.refusals).map(([k, v]) => [`refusal:${k}`, v])) }));
}

/** "p50 42s · p95 3m 10s (7)" or "no samples". */
export function fmtPercentiles(p: { p50: number | null; p95: number | null; samples: number }, fmt: (s: number) => string): string {
  if (p.samples === 0 || p.p50 == null || p.p95 == null) return 'no samples';
  return `p50 ${fmt(p.p50)} · p95 ${fmt(p.p95)} (${p.samples})`;
}

/** The share of a box's runs that posted one signal, as a percentage string, or '—' with no runs. */
export function pipelineShare(b: PipelineBox, field: 'withStarted' | 'withEnded' | 'withPlatform' | 'withTitle'): string {
  if (b.runs === 0) return '—';
  return `${Math.round((b[field] / b.runs) * 100)}%`;
}

/**
 * A box whose runs never posted `started` runs a wrapper from before the
 * runner hooks; one with lost runs and no end report never posts `ended`.
 * The one-line verdict for the pipeline table.
 */
export function pipelineVerdict(b: PipelineBox): string {
  if (b.runs === 0) return 'no runs';
  const closed = b.runs - b.open;
  if (b.withStarted === 0) return 'never posts started: pull and reconcile';
  if (closed > 0 && b.withEnded === 0) return 'never posts ended: wrapper predates the report';
  if (b.lost > 0) return `${b.lost} lost`;
  if (b.withTitle === 0 && closed > 0) return 'no titles: hooks not updated';
  return 'ok';
}

/** "93% disk · 14% mem · load 11.8", or '' without a sample. */
export function pressureCell(h: HostPressure | null | undefined): string {
  if (!h) return '';
  const parts = [
    h.diskUsedPct != null ? `${h.diskUsedPct}% disk` : '',
    h.memUsedPct != null ? `${h.memUsedPct}% mem` : '',
    h.load1 != null ? `load ${h.load1}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** The admin-table class for a pressure cell: bad at 95% disk, warn at 85% disk or 90% memory. */
export function pressureClass(h: HostPressure | null | undefined): '' | 'admin-warn' | 'admin-bad' {
  if (!h) return '';
  if ((h.diskUsedPct ?? 0) >= 95) return 'admin-bad';
  if ((h.diskUsedPct ?? 0) >= 85 || (h.memUsedPct ?? 0) >= 90) return 'admin-warn';
  return '';
}

/** "8.0 GB", "512 MB"; '—' for null. */
export function fmtBytesShort(b: number | null | undefined): string {
  if (b == null) return '—';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`;
  return `${b} B`;
}

/** "3d behind", "current", or "unknown" for an agent that did not say what it runs. */
export function agentAgeLabel(agentCommit: string | null, agentCommitAt: string | null, target: { commit: string | null; imageCreatedAt: string | null } | null, now: number): string {
  if (!agentCommit) return 'unknown';
  if (target?.commit && agentCommit === target.commit) return 'current';
  if (!agentCommitAt) return target?.commit ? 'behind' : 'no date';
  const ref = target?.imageCreatedAt ? Date.parse(target.imageCreatedAt) : now;
  const days = Math.max(0, Math.floor((ref - Date.parse(agentCommitAt)) / 86_400_000));
  return target?.commit ? `${days}d behind` : `${days}d old`;
}

/** The admin-table class for an update outcome. */
export function updateOutcomeClass(outcome: string | null | undefined): '' | 'admin-ok' | 'admin-warn' | 'admin-bad' {
  switch (outcome) {
    case 'updated': return 'admin-ok';
    case 'failed': return 'admin-bad';
    case 'deferred': return 'admin-warn';
    default: return '';
  }
}
