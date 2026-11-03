// The words and links of the bug-report pages (AdminBugs.tsx),
// pure so they are tested without rendering.
import type { BugEvent, BugFilters, BugReport } from '../../services/adminApi';

/** One history line: "triaged", "marked a duplicate of bug1", "linked …", "cleared the link", with the note. */
export function eventText(e: Pick<BugEvent, 'status' | 'duplicateOfId' | 'linkUrl' | 'note'>): string {
  const parts: string[] = [];
  if (e.status === 'duplicate' && e.duplicateOfId) parts.push(`marked a duplicate of ${e.duplicateOfId}`);
  else if (e.status) parts.push(`set ${e.status}`);
  if (e.linkUrl === '') parts.push('cleared the link');
  else if (e.linkUrl) parts.push(`linked ${e.linkUrl}`);
  const what = parts.join(', ') || 'noted';
  return e.note ? `${what}: ${e.note}` : what;
}

/** The ask thread's or session's chat in the simple UI, when the report names its project. */
export function sessionHref(r: Pick<BugReport, 'projectId' | 'workstream'>): string | null {
  if (!r.projectId) return null;
  const ws = r.workstream && r.workstream !== 'main' ? `?ws=${encodeURIComponent(r.workstream)}` : '';
  return `/chat/p/${encodeURIComponent(r.projectId)}${ws}`;
}

/** "#912" for a GitHub PR or issue URL, else the URL. */
export function linkLabel(url: string): string {
  const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)$/);
  return m ? `${m[1]}${m[2] === 'pull' ? ' PR' : ''} #${m[3]}` : url;
}

/** The list's filters as URL search params and back, so a filtered list is a link. */
export function filtersFromSearch(params: URLSearchParams): BugFilters {
  const f: BugFilters = {};
  for (const k of ['status', 'area', 'severity', 'q'] as const) {
    const v = params.get(k);
    if (v) f[k] = v;
  }
  return f;
}

export function searchFromFilters(f: BugFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}
