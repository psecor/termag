// The phone home list: one row per (project,
// workstream) with an agent workflow, in one list ordered by attention —
// needs you, running, reviewing, the rest — under a strip of counts. Pure so
// the ordering is unit-testable; the Inbox page feeds it ProjectContext state.
import type { AgentStatus, AgentStatusValue, CloudSession, Project, SessionReview } from '../types';
import { cloudDotStatus, cloudLiveStatus, isActiveCloudSession } from '../utils/cloudSessions';
import type { RecentRow } from '../services/api';
import { runningProviderForSource } from '../providers/registry';
import { sessionName } from '../utils/sessionName';
import { statusKey } from '../utils/statusKey';
import { recentsBucket, RecentsBucket } from '../utils/recents';
import { ringStateFor, RingState } from '../utils/reviewRing';

/** Where a row sits in the home list, in list order. */
export type HomeBand = 'attention' | 'running' | 'reviewing' | 'other';
/** The three counts across the top, each also a filter on the list. */
export type HomeFilter = 'attention' | 'running' | 'reviewing';

export interface InboxRow {
  key: string;                       // `${projectId}|${workstream}`
  projectId: string;
  projectName: string;
  workstream: string;
  owner: string;                     // unix user whose tmux holds the session
  shared: boolean;                   // the viewer is a collaborator, not the owner
  provider: string | null;
  instanceId: string | null;
  /** 'cloud': a Claude Code cloud session on a box; projectId is its key, url its page on claude.ai. */
  kind: 'normal' | 'metaterm' | 'cloud';
  url?: string | null;
  pinned: boolean;
  status: AgentStatusValue;
  waitingReason: AgentStatus['waitingReason'];
  /** Last status write; the row's "how long in this state" clock. */
  updatedAt: string | null;
  message: string | null;
  contextTokens: number | null;
  rateLimited: string | null;
  /** The Devin review pane's state, riding the agent session's status. */
  review: SessionReview | null;
  /** The review ring the desktop would show: null = nothing to look at. */
  ring: RingState | null;
  band: HomeBand;
  /** Recent sessions only: when the user last opened this session. */
  lastVisitedAt?: string;
  bucket?: RecentsBucket;
}

export function rowKey(projectId: string, workstream: string): string {
  return `${projectId}|${workstream}`;
}

/**
 * The agent provider for one workstream. What is actually running wins: a
 * workstream branched off a Claude project can run pi, and the
 * project's workflow row still says Claude — parsing that pane with the
 * Claude grammar turned every line into muted "system" text (see
 * runningProviderForSource for which sources count). Otherwise: the
 * workstream's own agent workflow, else the project's.
 */
export function providerFor(project: Project, workstreamId: string | undefined, liveSource?: string | null): string | null {
  const live = runningProviderForSource(liveSource);
  if (live) return live;
  const ws = workstreamId ? project.workflows.find(w => w.type === 'agent' && w.workstreamId === workstreamId) : undefined;
  const any = project.workflows.find(w => w.type === 'agent');
  return ws?.provider ?? any?.provider ?? null;
}

export function buildRows(projects: Project[], statusMap: Record<string, AgentStatus | undefined>, username: string): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const p of projects) {
    if (p.archived || !p.workflows.some(w => w.type === 'agent')) continue;
    const owner = p.ownerUsername ?? username;
    const workstreams = p.workstreams.filter(ws => !ws.archived);
    const list = workstreams.length > 0 ? workstreams : [{ id: undefined, name: 'main' }];
    for (const ws of list) {
      const session = sessionName(owner, p.name, 'agent', ws.name);
      const st = statusMap[statusKey(p.instanceId, session)];
      rows.push({
        key: rowKey(p.id, ws.name),
        projectId: p.id,
        projectName: p.name,
        workstream: ws.name,
        owner,
        shared: p.role === 'collaborator',
        provider: providerFor(p, ws.id, st?.source),
        instanceId: p.instanceId ?? null,
        kind: p.kind ?? 'normal',
        pinned: Boolean(p.pinned),
        status: st?.status ?? 'not_running',
        waitingReason: st?.waitingReason ?? null,
        updatedAt: st?.updatedAt ?? p.lastActiveAt ?? null,
        message: st?.message?.trim() || null,
        contextTokens: st?.contextTokens ?? null,
        rateLimited: st?.rateLimited ?? null,
        ...reviewFields(st?.status ?? 'not_running', st?.review),
      });
    }
  }
  return rows;
}

/**
 * The band, by the first rule that holds: the agent or Devin needs an answer,
 * or a finished review has not been looked at (user decision 2026-10-11:
 * that counts as needing you) → attention; the agent works → running; Devin
 * reviews → reviewing; anything else → other.
 */
export function bandFor(status: AgentStatusValue, ring: RingState | null): HomeBand {
  if (status === 'waiting' || ring === 'waiting' || ring === 'done') return 'attention';
  if (status === 'working') return 'running';
  if (ring === 'reviewing') return 'reviewing';
  return 'other';
}

function reviewFields(status: AgentStatusValue, review: SessionReview | null | undefined): Pick<InboxRow, 'review' | 'ring' | 'band'> {
  const ring = ringStateFor(review);
  return { review: review ?? null, ring, band: bandFor(status, ring) };
}

const ts = (s: string | null | undefined): number => (s ? Date.parse(s) : 0);

// Within attention: approvals, then the agent's questions, then Devin's
// questions, then finished reviews; the one waiting longest first in each.
function attentionRank(r: InboxRow): number {
  if (r.status === 'waiting') return r.waitingReason === 'approval' ? 0 : 1;
  return r.ring === 'waiting' ? 2 : 3;
}
function attentionSince(r: InboxRow): number {
  if (r.status === 'waiting') return ts(r.updatedAt);
  return ts(r.ring === 'done' ? (r.review?.doneAt ?? r.review?.at) : r.review?.at);
}
function byAttention(a: InboxRow, b: InboxRow): number {
  const d = attentionRank(a) - attentionRank(b);
  return d !== 0 ? d : attentionSince(a) - attentionSince(b);
}
// Elsewhere: pinned first, then (in other) idle before not running, then the
// most recently active first.
function byActivity(a: InboxRow, b: InboxRow): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.band === 'other' && a.status !== b.status) {
    if (a.status === 'idle') return -1;
    if (b.status === 'idle') return 1;
  }
  return ts(b.updatedAt) - ts(a.updatedAt);
}

const BAND_ORDER: Record<HomeBand, number> = { attention: 0, running: 1, reviewing: 2, other: 3 };

export function sortHome(rows: InboxRow[]): InboxRow[] {
  return [...rows].sort((a, b) =>
    BAND_ORDER[a.band] - BAND_ORDER[b.band] || (a.band === 'attention' ? byAttention(a, b) : byActivity(a, b)));
}

export interface BuildHomeOptions {
  /** The owner's active cloud sessions; absent or empty adds no rows. */
  cloudSessions?: CloudSession[] | null;
}

export interface HomeCounts {
  /** Rows in the attention band. */
  attention: number;
  /** Agents working. */
  running: number;
  /** Devin reviews in progress, whatever the agent beside them is doing. */
  reviewing: number;
}

export interface Home {
  rows: InboxRow[];
  counts: HomeCounts;
}

/** Does a row count towards (and pass) one of the strip's filters? */
export function matchesFilter(row: InboxRow, f: HomeFilter): boolean {
  if (f === 'attention') return row.band === 'attention';
  if (f === 'running') return row.status === 'working';
  return row.ring === 'reviewing';
}

export function buildHome(
  projects: Project[],
  statusMap: Record<string, AgentStatus | undefined>,
  username: string,
  opts: BuildHomeOptions = {},
): Home {
  const rows = sortHome([...buildRows(projects, statusMap, username), ...buildCloudRows(opts.cloudSessions, statusMap)]);
  const count = (f: HomeFilter) => rows.filter(r => matchesFilter(r, f)).length;
  return { rows, counts: { attention: count('attention'), running: count('running'), reviewing: count('reviewing') } };
}

/**
 * The home counts' words, on the phone and on the desktop status strip.
 * `short` is the same word cut to fit a quarter of a 180px sidebar.
 */
export const HOME_FILTERS: Array<{ id: HomeFilter; label: string; short: string; title: string; empty: string }> = [
  { id: 'attention', label: 'waiting', short: 'wait', title: 'Sessions waiting on you', empty: 'Nothing is waiting on you.' },
  { id: 'running', label: 'running', short: 'run', title: 'Agents running', empty: 'No agent is running.' },
  { id: 'reviewing', label: 'reviewing', short: 'review', title: 'Reviews in progress', empty: 'No review in progress.' },
];

/**
 * The filter in the URL (?f=). The retired inbox tab ids (?g=) map onto the
 * nearest filter so an old bookmark lands somewhere sensible; Recents moved
 * to the Search tab and maps to no filter.
 */
export function parseFilter(f: string | null, g?: string | null): HomeFilter | null {
  if (f === 'attention' || f === 'running' || f === 'reviewing') return f;
  if (g === 'needs-you') return 'attention';
  if (g === 'working') return 'running';
  return null;
}

/**
 * The recent sessions for the Search tab: the user's latest visits, each
 * carrying the live row so its status comes from statusMap, not the (older)
 * visits payload. Archived or no-longer-listed sessions are dropped.
 */
export function recentSessions(rows: InboxRow[], recents: RecentRow[] | null | undefined, now: number, limit = 10): InboxRow[] {
  const byKey = new Map(rows.map(r => [r.key, r]));
  const out: InboxRow[] = [];
  for (const rr of recents ?? []) {
    if (out.length >= limit) break;
    if (rr.archived) continue;
    const live = byKey.get(rowKey(rr.projectId, rr.workstream || 'main'));
    if (!live) continue;
    out.push({ ...live, lastVisitedAt: rr.lastVisitedAt, bucket: recentsBucket(Date.parse(rr.lastVisitedAt), now) });
  }
  return out;
}

/**
 * The Search tab's instant filter: every whitespace-separated term must hit
 * the project, workstream, owner, provider, status message or review PR
 * (`312` or `#312`), case-insensitively. Keeps the home order.
 */
export function searchRows(rows: InboxRow[], query: string): InboxRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean).map(t => t.replace(/^#(?=\d)/, ''));
  if (terms.length === 0) return [];
  return rows.filter(r => {
    const hay = [r.projectName, r.workstream, r.owner, r.provider ?? '', r.message ?? '', r.review?.pr != null ? String(r.review.pr) : '']
      .join('\n').toLowerCase();
    return terms.every(t => hay.includes(t));
  });
}

/**
 * One row per active cloud session. A running one reads the status map under
 * its runner's tmux name, as a project pane does; queued and starting ones
 * have no pane yet and sit in Idle with their state as the preview.
 */
export function buildCloudRows(sessions: CloudSession[] | null | undefined, statusMap: Record<string, AgentStatus | undefined>): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const s of sessions ?? []) {
    if (!isActiveCloudSession(s)) continue;
    const st = cloudLiveStatus(s, statusMap);
    rows.push({
      key: `cloud|${s.key}`,
      projectId: s.key,
      projectName: s.name,
      workstream: 'main',
      owner: '',
      shared: false,
      provider: 'claude',
      instanceId: s.current?.instanceId ?? null,
      kind: 'cloud',
      url: s.url,
      pinned: false,
      status: cloudDotStatus(s, statusMap),
      waitingReason: st?.waitingReason ?? null,
      // A queued row's clock is time queued, not time since the latest re-offer.
      updatedAt: st?.updatedAt ?? (s.state === 'queued' ? (s.queuedSince ?? s.lastSeenAt) : s.lastSeenAt),
      message: s.state === 'queued' ? (s.queuedReason ?? 'queued: no box yet') : s.state === 'starting' ? 'starting on ' + (s.current?.boxName ?? 'a box') : (st?.message?.trim() || s.title || null),
      contextTokens: st?.contextTokens ?? null,
      rateLimited: st?.rateLimited ?? null,
      ...reviewFields(cloudDotStatus(s, statusMap), null),
    });
  }
  return rows;
}

/** Glyph per status, same shapes the TUI uses (emoji width is unreliable). */
export const STATUS_GLYPH: Record<AgentStatusValue, string> = {
  working: '●',
  waiting: '◐',
  idle: '○',
  not_running: '·',
};

export function waitingLabel(reason: AgentStatus['waitingReason']): string {
  if (reason === 'approval') return 'Needs approval';
  if (reason === 'user_input') return 'Asked you a question';
  return 'Waiting';
}

/** The words beside a row's glyph: what state it is in, so the colour is not the only signal. */
export function statusLabel(row: Pick<InboxRow, 'status' | 'waitingReason' | 'ring' | 'review'>): string {
  const pr = row.review?.pr != null ? ` #${row.review.pr}` : '';
  if (row.status === 'waiting') return waitingLabel(row.waitingReason);
  if (row.ring === 'waiting') return 'Devin needs you';
  if (row.ring === 'done') return `Review ready${pr}`;
  if (row.status === 'working') return 'Running';
  if (row.ring === 'reviewing') return `Reviewing${pr}`;
  return row.status === 'idle' ? 'Ready' : 'Not running';
}

/**
 * When the row entered the state it shows, for its clock: a review-led row's
 * state is the review's (a review that finished a minute ago reads "1m",
 * whatever the agent beside it last did), as in attention sorting.
 */
export function stateSince(row: Pick<InboxRow, 'status' | 'ring' | 'review' | 'updatedAt'>): string | null {
  if (!opensReview(row)) return row.updatedAt;
  return (row.ring === 'done' ? row.review?.doneAt : null) ?? row.review?.at ?? row.updatedAt;
}

/** The conversation a row opens: its workstream, on the review tab when the row is about its review. */
export function conversationHref(row: Pick<InboxRow, 'projectId' | 'workstream' | 'status' | 'ring'>): string {
  const q = new URLSearchParams();
  if (row.workstream !== 'main') q.set('ws', row.workstream);
  if (opensReview(row)) q.set('role', 'review');
  const qs = q.toString();
  return `/m/p/${encodeURIComponent(row.projectId)}${qs ? `?${qs}` : ''}`;
}

/**
 * A row whose state is about its review opens the review tab, not the agent.
 * A waiting agent wins (2026-10-11): its question blocks work, so the row
 * opens the agent and the RV badge says a review waits too.
 */
export function opensReview(row: Pick<InboxRow, 'status' | 'ring'>): boolean {
  if (row.ring === 'waiting' || row.ring === 'done') return row.status !== 'waiting';
  return row.ring === 'reviewing' && row.status !== 'waiting' && row.status !== 'working';
}
