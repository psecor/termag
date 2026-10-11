// The phone inbox: one row per (project, workstream)
// with an agent workflow, grouped by attention — Needs you, Working, Idle —
// plus the user's Recents. Pure so the grouping is unit-testable; the Inbox
// page feeds it ProjectContext state and the Recents hook's rows.
import type { AgentStatus, AgentStatusValue, CloudSession, Project } from '../types';
import { cloudDotStatus, cloudLiveStatus, isActiveCloudSession } from '../utils/cloudSessions';
import type { RecentRow } from '../services/api';
import { runningProviderForSource } from '../providers/registry';
import { sessionName } from '../utils/sessionName';
import { statusKey } from '../utils/statusKey';
import { recentsBucket, RecentsBucket } from '../utils/recents';

export type InboxGroupId = 'needs-you' | 'sessions' | 'recents';
/** Within the Sessions tab: the working rows lead, the idle ones follow. */
export type SessionsSection = 'working' | 'idle';

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
  /** Recents only: when the user last opened this session. */
  lastVisitedAt?: string;
  bucket?: RecentsBucket;
  /** Sessions only: which part of the tab the row sits in. */
  section?: SessionsSection;
}

export interface InboxGroup {
  id: InboxGroupId;
  label: string;
  rows: InboxRow[];
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
      });
    }
  }
  return rows;
}

const ts = (s: string | null | undefined): number => (s ? Date.parse(s) : 0);

// Within "Needs you": approvals before questions, then the one waiting
// longest first — it has been blocked the longest.
function byWaiting(a: InboxRow, b: InboxRow): number {
  const ra = a.waitingReason === 'approval' ? 0 : 1;
  const rb = b.waitingReason === 'approval' ? 0 : 1;
  if (ra !== rb) return ra - rb;
  return ts(a.updatedAt) - ts(b.updatedAt);
}
// Elsewhere: pinned first, then most recently active first.
function byActivity(a: InboxRow, b: InboxRow): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return ts(b.updatedAt) - ts(a.updatedAt);
}

export interface BuildInboxOptions {
  recents?: RecentRow[] | null;
  recentsLimit?: number;
  now?: number;
  /** The owner's active cloud sessions; absent or empty adds no rows. */
  cloudSessions?: CloudSession[] | null;
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
    });
  }
  return rows;
}

export function buildInbox(
  projects: Project[],
  statusMap: Record<string, AgentStatus | undefined>,
  username: string,
  opts: BuildInboxOptions = {},
): InboxGroup[] {
  const rows = [...buildRows(projects, statusMap, username), ...buildCloudRows(opts.cloudSessions, statusMap)];
  const needsYou = rows.filter(r => r.status === 'waiting').sort(byWaiting);
  const working = rows.filter(r => r.status === 'working').sort(byActivity);
  const idle = rows.filter(r => r.status === 'idle' || r.status === 'not_running').sort(byActivity);

  const groups: InboxGroup[] = [];
  if (needsYou.length) groups.push({ id: 'needs-you', label: 'Needs you', rows: needsYou });
  // One Sessions tab (2026-10-08, after use: Working and Idle as separate
  // tabs meant a tap to see what else was running): the working rows in a
  // section at the top, the idle ones below.
  const sessions: InboxRow[] = [
    ...working.map(r => ({ ...r, section: 'working' as const })),
    ...idle.map(r => ({ ...r, section: 'idle' as const })),
  ];
  if (sessions.length) groups.push({ id: 'sessions', label: 'Sessions', rows: sessions });

  // Recents: the sessions the user opened most recently, minus the rows in
  // Needs you and the Working section. An idle row may appear in both
  // Sessions and Recents on purpose: Recents is a different lens (where you
  // were, not what the agent is doing). Rows are looked up by key so the
  // live status comes from statusMap, not from the (older) visits payload.
  const byKey = new Map(rows.map(r => [r.key, r]));
  const above = new Set([...needsYou, ...working].map(r => r.key));
  const now = opts.now ?? Date.now();
  const limit = opts.recentsLimit ?? 10;
  const recents: InboxRow[] = [];
  for (const rr of opts.recents ?? []) {
    if (recents.length >= limit) break;
    if (rr.archived) continue;
    const key = rowKey(rr.projectId, rr.workstream || 'main');
    if (above.has(key)) continue;
    const live = byKey.get(key);
    if (!live) continue;
    recents.push({ ...live, lastVisitedAt: rr.lastVisitedAt, bucket: recentsBucket(Date.parse(rr.lastVisitedAt), now) });
  }
  if (recents.length) groups.push({ id: 'recents', label: 'Recents', rows: recents });
  return groups;
}

/** Tab order at the top of the inbox; every group has a tab even when empty. */
export const INBOX_GROUPS: Array<{ id: InboxGroupId; label: string }> = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'recents', label: 'Recents' },
];

export function isInboxGroupId(x: unknown): x is InboxGroupId {
  return INBOX_GROUPS.some(g => g.id === x);
}

/**
 * A group id from the URL or localStorage, with the two tabs that merged
 * into Sessions (`working`, `idle`) mapped onto it so an old bookmark or a
 * remembered pick still lands somewhere sensible. Anything else is null.
 */
export function normalizeGroupId(x: unknown): InboxGroupId | null {
  if (isInboxGroupId(x)) return x;
  return x === 'working' || x === 'idle' ? 'sessions' : null;
}

export const SECTION_LABEL: Record<SessionsSection, string> = { working: 'Working', idle: 'Idle' };

/** How many rows of the Sessions tab are working: the number its tab shows. */
export function workingCount(group: InboxGroup | undefined): number {
  return group?.rows.filter(r => r.section === 'working').length ?? 0;
}

/**
 * Which tab to open when the user has not chosen one (or the chosen one is
 * empty): the first non-empty group in tab order, so the phone opens on
 * whatever needs attention; Recents when nothing is live at all.
 */
export function defaultGroup(groups: InboxGroup[], preferred?: InboxGroupId | null): InboxGroupId {
  const nonEmpty = new Set(groups.filter(g => g.rows.length > 0).map(g => g.id));
  if (preferred && nonEmpty.has(preferred)) return preferred;
  for (const g of INBOX_GROUPS) if (nonEmpty.has(g.id)) return g.id;
  return preferred ?? 'recents';
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
