// Pure helpers for "Recents" — the sessions (project × workstream) the user
// most recently opened. Shared by the sidebar switcher and the dashboard
// section; kept free of React so grouping/filtering can be unit-tested.
import type { RecentRow } from '../services/api';

export const RECENTS_DEFAULT_LIMIT = 10;

/** Workspace URL that opens a session (URL is the source of truth for the active project). */
export function recentHref(row: Pick<RecentRow, 'projectId' | 'workstream'>): string {
  const ws = row.workstream && row.workstream !== 'main' ? `&ws=${encodeURIComponent(row.workstream)}` : '';
  return `/?project=${encodeURIComponent(row.projectId)}${ws}`;
}

export type RecentsBucket = 'Today' | 'Yesterday' | 'Earlier';

/** Local-calendar bucket for a timestamp relative to `now`. */
export function recentsBucket(ts: number, now: number): RecentsBucket {
  const d = new Date(ts); const n = new Date(now);
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(n) - dayStart(d)) / 86_400_000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return 'Earlier';
}

/** Group rows (already newest-first) into Today / Yesterday / Earlier, omitting empty buckets. */
export function groupRecentsByDay(rows: RecentRow[], now: number): Array<{ label: RecentsBucket; rows: RecentRow[] }> {
  const order: RecentsBucket[] = ['Today', 'Yesterday', 'Earlier'];
  const map = new Map<RecentsBucket, RecentRow[]>();
  for (const r of rows) {
    const b = recentsBucket(Date.parse(r.lastVisitedAt), now);
    (map.get(b) ?? map.set(b, []).get(b)!).push(r);
  }
  return order.filter(b => map.has(b)).map(b => ({ label: b, rows: map.get(b)! }));
}

export interface SwitcherFilter {
  /** Drop archived projects (the switcher is for jumping, not browsing). */
  includeArchived?: boolean;
  /** Case-insensitive substring over project name and workstream. */
  query?: string;
  /** Drop the MetaTerm control-tower singleton. */
  includeMetaterm?: boolean;
}

export function filterRecents(rows: RecentRow[], f: SwitcherFilter = {}): RecentRow[] {
  const q = (f.query ?? '').trim().toLowerCase();
  return rows.filter(r => {
    if (!f.includeArchived && r.archived) return false;
    if (!f.includeMetaterm && r.kind === 'metaterm') return false;
    if (q && !`${r.projectName} ${r.workstream}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Is this row the session currently open in the workspace? */
export function isCurrentRecent(row: Pick<RecentRow, 'projectId' | 'workstream'>, activeProjectId: string | null, activeWorkstream: string): boolean {
  return row.projectId === activeProjectId && (row.workstream || 'main') === (activeWorkstream || 'main');
}

/** Secondary line: what the agent has been doing lately (the user asked for agent activity, not visit counts). */
export function agentActivityLabel(row: Pick<RecentRow, 'status' | 'lastActiveAt'>, now: number, fmtAge: (ms: number) => string): string {
  const age = now - Date.parse(row.lastActiveAt);
  const since = Number.isFinite(age) && age >= 0 ? fmtAge(age) : null;
  switch (row.status) {
    case 'working': return 'agent working now';
    case 'waiting': return 'agent waiting on you';
    case 'idle': return since ? `agent idle · active ${since} ago` : 'agent idle';
    default: return since ? `agent not running · last active ${since} ago` : 'agent not running';
  }
}
