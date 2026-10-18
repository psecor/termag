// Pure helpers over the owner's Claude Code cloud sessions
//: how the sidebar, dashboard and mobile inbox
// read a session's state, its dot, and its grouping by box. No fetching, no
// React; see cloudSessions.test.ts.
import type { AgentStatus, AgentStatusValue, CloudSession, CloudSessionState } from '../types';
import { statusKey } from './statusKey';

export const ACTIVE_CLOUD_STATES: ReadonlySet<CloudSessionState> = new Set(['queued', 'starting', 'running']);

export function isActiveCloudSession(s: CloudSession): boolean {
  return ACTIVE_CLOUD_STATES.has(s.state);
}

/** What the row says when the first prompt has not arrived (or the box predates the title post). */
export const UNTITLED = 'untitled session';

/** The part after the fixed name: the owner's or the first prompt's title. */
export function cloudTitle(s: CloudSession): string {
  return s.title ?? UNTITLED;
}

/** "Claude Cloud 3 · Fix the auth bug", or just the name when there is no title yet. */
export function cloudLabel(s: Pick<CloudSession, 'name' | 'title'>): string {
  return s.title ? `${s.name} · ${s.title}` : s.name;
}

/**
 * The live status behind a cloud session's dot. A running session reads the
 * status map under (box, runner tmux name), as a project pane does; a session
 * the box has not reported as started yet, or a queued one, has no pane to
 * read and shows as not running.
 */
export function cloudDotStatus(s: CloudSession, statusMap: Record<string, AgentStatus | undefined>): AgentStatusValue {
  if (s.state !== 'running' || !s.current?.sessionName) return 'not_running';
  return statusMap[statusKey(s.current.instanceId, s.current.sessionName)]?.status ?? 'idle';
}

export function cloudLiveStatus(s: CloudSession, statusMap: Record<string, AgentStatus | undefined>): AgentStatus | undefined {
  if (!s.current?.sessionName) return undefined;
  return statusMap[statusKey(s.current.instanceId, s.current.sessionName)];
}

const STATE_LABEL: Record<CloudSessionState, string> = {
  queued: 'queued', starting: 'starting', running: 'running', ended: 'ended', lost: 'lost',
};

/** A short label for the state, with the reason where there is one: "ended · completed", "lost", "queued". */
export function cloudStateLabel(s: Pick<CloudSession, 'state' | 'exitReason'>): string {
  if (s.state === 'ended' && s.exitReason) return `ended · ${s.exitReason}`;
  return STATE_LABEL[s.state];
}

/** The client surface, for a badge: web, desktop, iOS, Android, CLI, routine. */
export function platformLabel(p: string | null): string | null {
  if (!p) return null;
  const map: Record<string, string> = {
    web_claude_ai: 'web', desktop_app: 'desktop', ios: 'iOS', android: 'Android',
    claude_code_cli: 'CLI', scheduled_trigger: 'routine', claude_in_slack: 'Slack', 'claude-in-slack': 'Slack',
  };
  return map[p] ?? p;
}

/** Active sessions by the box their current run is on; queued ones (no run) under `queued`. */
export function cloudByBox(sessions: readonly CloudSession[]): { byBox: Map<string, CloudSession[]>; queued: CloudSession[] } {
  const byBox = new Map<string, CloudSession[]>();
  const queued: CloudSession[] = [];
  for (const s of sessions) {
    if (!isActiveCloudSession(s)) continue;
    if (s.state === 'queued' || !s.current) { queued.push(s); continue; }
    const list = byBox.get(s.current.instanceId) ?? [];
    list.push(s);
    byBox.set(s.current.instanceId, list);
  }
  for (const list of byBox.values()) list.sort((a, b) => a.current!.slot - b.current!.slot);
  queued.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { byBox, queued };
}

/** The byBox entries whose box is not in the current box list (terminated under a live runner). */
export function cloudElsewhere(byBox: Map<string, CloudSession[]>, knownBoxIds: ReadonlySet<string>): CloudSession[] {
  return [...byBox.entries()].filter(([id]) => !knownBoxIds.has(id)).flatMap(([, l]) => l);
}

/** "· 2 cloud" for a box row's meta, or '' with none. */
export function cloudCountLabel(n: number): string {
  return n > 0 ? `${n} cloud` : '';
}

export function fmtDurationSec(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
