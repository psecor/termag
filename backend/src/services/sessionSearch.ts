/**
 * Pane-text search across every session the caller may reach:
 * what MetaTerm's list_sessions + capture_pane do,
 * done once on the server. The session list is the one GET /api/sessions
 * serves; each live pane is re-checked with assertSessionAccess (the same
 * gate as the capture route), captured plain through its owner's agent with
 * bounded concurrency and a per-pane timeout, then matched
 * case-insensitively. Capture text is UNTRUSTED terminal output: it is
 * returned as data and never interpreted.
 */
import { sendForProject, type ProjectHost } from './agentRegistry';
import { projectSessionAccess, SESSION_ROLES, type SessionRole } from './sessionAccess';

export const SEARCH_DEFAULT_ROLES: SessionRole[] = ['agent', 'ctrl', 'review'];
export const SEARCH_MIN_QUERY = 2;
export const SEARCH_MAX_QUERY = 200;
export const SEARCH_DEFAULT_LINES = 500;
const MAX_PANES = 60;           // panes captured per search; the rest are reported as skipped
const CONCURRENCY = 6;
const CAPTURE_TIMEOUT_MS = 5_000;
const MAX_MATCHES = 5;          // per pane, newest first
const CONTEXT_LINES = 1;
const MAX_LINE_CHARS = 240;

export interface SearchMatch {
  /** 1-based line in the captured scrollback. */
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface SessionHit {
  projectId: string;
  projectName: string;
  owner: string;
  access: string;
  workstream: string;
  role: string;
  session: string;
  status: string;
  /** All matching lines in the capture; `matches` holds at most a few. */
  matchCount: number;
  matches: SearchMatch[];
}

export interface SearchResult {
  query: string;
  lines: number;
  roles: string[];
  /** Panes captured and searched. */
  searched: number;
  /** Panes that could not be read: the owner's agent is offline, or the capture timed out or was denied. */
  unreachable: number;
  /** Live panes not searched because of the per-search cap. */
  skipped: number;
  /** Newest mention first: the pane whose latest match sits lowest in its scrollback leads. */
  hits: SessionHit[];
}

/** The fields of a GET /api/sessions row the search reads. */
export interface SearchableRow {
  projectId: string;
  projectName: string;
  owner: string;
  access: string;
  workstream: string;
  role: string;
  session: string;
  connected: boolean;
  alive: boolean;
  status: string;
}

export interface SearchDeps {
  listRows: (userId: string) => Promise<SearchableRow[]>;
  /**
   * The project's access check, once per project per search: resolves to a
   * per-pane check returning the host and rebuilt session name. Either step
   * throws (SessionAccessError) when the caller may not read the pane.
   */
  accessProject: (userId: string, projectId: string) => Promise<(role: string, workstream: string) => { host: ProjectHost; session: string }>;
  capture: (host: ProjectHost, session: string, lines: number) => Promise<string>;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function clip(text: string, at: number, len: number): string {
  if (text.length <= MAX_LINE_CHARS) return text;
  const start = Math.max(0, Math.min(at - Math.floor((MAX_LINE_CHARS - len) / 2), text.length - MAX_LINE_CHARS));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + MAX_LINE_CHARS)}${start + MAX_LINE_CHARS < text.length ? '…' : ''}`;
}

/**
 * The lines of `content` containing `query` (case-insensitive, as a phrase),
 * newest (lowest) first, with a line of context each side. Pure.
 */
export function findMatches(content: string, query: string, max = MAX_MATCHES): { count: number; matches: SearchMatch[]; lastLine: number; totalLines: number } {
  const needle = query.trim().toLowerCase();
  const lines = content.replace(ANSI, '').split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const matches: SearchMatch[] = [];
  let count = 0;
  let lastLine = 0;
  if (!needle) return { count, matches, lastLine, totalLines: lines.length };
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].toLowerCase().indexOf(needle);
    if (at < 0) continue;
    count++;
    if (!lastLine) lastLine = i + 1;
    if (matches.length >= max) continue;
    matches.push({
      line: i + 1,
      text: clip(lines[i], at, needle.length),
      before: lines.slice(Math.max(0, i - CONTEXT_LINES), i).map(l => clip(l, 0, 0)),
      after: lines.slice(i + 1, i + 1 + CONTEXT_LINES).map(l => clip(l, 0, 0)),
    });
  }
  return { count, matches, lastLine, totalLines: lines.length };
}

/** Parse `roles=agent,ctrl`; unknown names are dropped, empty means the default set. */
export function parseRoles(raw: unknown): SessionRole[] {
  if (typeof raw !== 'string' || !raw.trim()) return SEARCH_DEFAULT_ROLES;
  const picked = new Set(raw.split(',').map(s => s.trim()));
  // In SESSION_ROLES order, so `ctrl,agent` and `agent,ctrl` are one search (and one cache entry).
  const roles = SESSION_ROLES.filter(r => picked.has(r));
  return roles.length ? roles : SEARCH_DEFAULT_ROLES;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function searchSessions(
  userId: string,
  query: string,
  opts: { lines?: number; roles?: SessionRole[] },
  deps: SearchDeps,
): Promise<SearchResult> {
  const lines = opts.lines ?? SEARCH_DEFAULT_LINES;
  const roles = opts.roles ?? SEARCH_DEFAULT_ROLES;
  const inRoles = (await deps.listRows(userId)).filter(r => (roles as string[]).includes(r.role));
  // A row is alive only when its agent answered tmux-list, so panes behind an
  // offline agent never look alive: count those as unreachable here, or a
  // stopped box would silently shrink "searched N panes".
  const offline = inRoles.filter(r => !r.connected).length;
  let failed = 0;
  const live = inRoles.filter(r => r.connected && r.alive);
  const panes = live.slice(0, MAX_PANES);
  const projects = new Map<string, ReturnType<SearchDeps['accessProject']>>();
  const found: Array<SessionHit & { fromBottom: number }> = [];
  await pool(panes, CONCURRENCY, async (row) => {
    try {
      let project = projects.get(row.projectId);
      if (!project) { project = deps.accessProject(userId, row.projectId); projects.set(row.projectId, project); }
      const a = (await project)(row.role, row.workstream);
      const content = await deps.capture(a.host, a.session, lines);
      const m = findMatches(content, query);
      if (m.count === 0) return;
      found.push({
        projectId: row.projectId, projectName: row.projectName, owner: row.owner, access: row.access,
        workstream: row.workstream, role: row.role, session: a.session, status: row.status,
        matchCount: m.count, matches: m.matches, fromBottom: m.totalLines - m.lastLine,
      });
    } catch {
      failed++;
    }
  });
  found.sort((a, b) => a.fromBottom - b.fromBottom || b.matchCount - a.matchCount);
  return {
    query: query.trim(), lines, roles,
    searched: panes.length - failed, unreachable: offline + failed, skipped: live.length - panes.length,
    hits: found.map(({ fromBottom: _omit, ...h }) => h),
  };
}

/** Production wiring: the access gate and the owner's agent's plain capture. */
export const liveSearchDeps = (listRows: SearchDeps['listRows']): SearchDeps => ({
  listRows,
  accessProject: projectSessionAccess,
  capture: async (host, session, lines) => {
    const r = await sendForProject(host, 'tmux-capture', { sessionName: session, lines, styled: false }, CAPTURE_TIMEOUT_MS);
    return typeof r?.content === 'string' ? r.content : '';
  },
});
