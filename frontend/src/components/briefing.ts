/**
 * Pure logic behind BriefingCard: which state the
 * card is in, how often it polls, how a project id becomes a link, and the
 * stats strip. No React, no fetching — see briefing.test.ts.
 */
import type { BriefingContent, BriefingLatest, BriefingView, LedgerTotals } from '../services/api';
import { fmtDurationShort } from '../utils/format';

export type CardState = 'loading' | 'never' | 'running' | 'ready';

/** loading: no answer yet. never: no briefing at all. running: one is being composed. */
export function cardState(data: BriefingLatest | null): CardState {
  if (!data) return 'loading';
  if (data.pending?.status === 'running') return 'running';
  if (!data.latest && !data.pending) return 'never';
  return 'ready';
}

export const POLL_RUNNING_MS = 5_000;
export const POLL_IDLE_MS = 60_000;

export function pollInterval(state: CardState): number {
  return state === 'running' ? POLL_RUNNING_MS : POLL_IDLE_MS;
}

/** The error to show above the latest content: a pending run that was skipped or failed. */
export function pendingProblem(data: BriefingLatest | null): string | null {
  const p = data?.pending;
  if (!p || (p.status !== 'skipped' && p.status !== 'failed')) return null;
  const what = p.status === 'skipped' ? 'The last briefing was skipped' : 'The last briefing failed';
  return p.error ? `${what}: ${p.error}` : `${what}.`;
}

/** Falls back to a local rendering of since → until when the server sent no label. */
export function windowLabel(w: BriefingView['window'], locale?: string): string {
  if (w.label && w.label.trim()) return w.label;
  const fmt = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString(locale, { timeZone: w.tz || undefined, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {
      return d.toLocaleString(locale);
    }
  };
  return `${fmt(w.since)} to ${fmt(w.until)}`;
}

/** How a window is introduced; mirrors windowPrefix in backend/src/services/briefing/window.ts. */
export function windowPrefix(basis: BriefingView['window']['basis']): string {
  switch (basis) {
    case 'first':
    case 'stale': return 'Since the start of yesterday';
    case 'capped': return 'The last 7 days';
    case 'explicit': return 'Reviewed';
    default: return 'Since your last briefing';
  }
}

/** The heading line, shown before anything else on every surface. */
export function windowHeading(view: BriefingView): string {
  return `${windowPrefix(view.window.basis)} · ${windowLabel(view.window)}`;
}

/** When it finished, in the briefing's own zone so it reads with the window label. */
export function finishedLabel(view: Pick<BriefingView, 'finishedAt' | 'window'>, locale?: string): string | null {
  if (!view.finishedAt) return null;
  const d = new Date(view.finishedAt);
  if (Number.isNaN(d.getTime())) return null;
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return d.toLocaleString(locale, { ...opts, timeZone: view.window.tz || undefined });
  } catch {
    return d.toLocaleString(locale, opts);
  }
}

export type LinkMode = 'desktop' | 'mobile';

/**
 * Where a carry-over or suggestion links: the session in the workspace (or the
 * phone's conversation). Null when the item names no project, or a project the
 * server did not resolve (deleted, or no longer reachable).
 */
export function sessionHref(
  projectId: string | null,
  workstream: string | null,
  projects: BriefingView['projects'],
  mode: LinkMode = 'desktop',
): string | null {
  if (!projectId || !projects[projectId]) return null;
  const ws = workstream && workstream !== 'main' ? workstream : null;
  if (mode === 'mobile') return `/m/p/${encodeURIComponent(projectId)}${ws ? `?ws=${encodeURIComponent(ws)}` : ''}`;
  return `/?project=${encodeURIComponent(projectId)}${ws ? `&ws=${encodeURIComponent(ws)}` : ''}`;
}

/** "termag · feat-x", or "termag" for main, or null when the project is unknown. */
export function sessionLabel(projectId: string | null, workstream: string | null, projects: BriefingView['projects']): string | null {
  const p = projectId ? projects[projectId] : undefined;
  if (!p) return null;
  return workstream && workstream !== 'main' ? `${p.name} · ${workstream}` : p.name;
}

export const KIND_LABEL: Record<BriefingContent['carryovers'][number]['kind'], string> = {
  question: 'QUESTION',
  decision: 'DECISION',
  action: 'ACTION',
  blocked: 'BLOCKED',
};

export interface StatTile { id: string; label: string; value: string }

export function statTiles(stats: LedgerTotals | null): StatTile[] {
  if (!stats) return [];
  return [
    { id: 'agent', label: 'Agent time', value: fmtDurationShort(stats.agentMs) },
    { id: 'human', label: 'Your time', value: fmtDurationShort(stats.humanMs) },
    { id: 'sessions', label: 'Sessions touched', value: String(stats.sessionsTouched) },
    { id: 'waiting', label: 'Waiting now', value: String(stats.waitingNow) },
    { id: 'prs', label: 'PRs needing attention', value: String(stats.prsNeedingAttention) },
    { id: 'kept', label: 'Kept checkouts', value: String(stats.keptCheckouts) },
  ];
}

/** How many things the latest briefing left open, for the phone's strip. */
export function openCount(data: BriefingLatest | null): number {
  return data?.latest?.content?.carryovers.length ?? 0;
}

/** The browser's IANA timezone, or UTC when the platform cannot say. */
export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
