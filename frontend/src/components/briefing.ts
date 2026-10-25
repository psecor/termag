/**
 * Pure logic behind BriefingCard: which state the
 * card is in, how often it polls, how a project id becomes a link, and the
 * stats strip. No React, no fetching — see briefing.test.ts.
 */
import type { BriefingContent, BriefingDismissal, BriefingKind, BriefingLatest, BriefingView, LedgerTotals } from '../services/api';
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

export const KIND_LABEL: Record<BriefingKind, string> = {
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

/** "owner/name#123" → its GitHub URL, or null. */
export function prHref(ref: string): string | null {
  const m = /^([\w.-]+\/[\w.-]+)#(\d{1,9})$/.exec(ref);
  return m ? `https://github.com/${m[1]}/pull/${m[2]}` : null;
}

/** "#123". */
export function prLabel(ref: string): string {
  const i = ref.lastIndexOf('#');
  return i >= 0 ? ref.slice(i) : ref;
}

/** Marks still running, by key. */
export function activeMarks(marks: BriefingDismissal[] | undefined, now: number = Date.now()): Map<string, BriefingDismissal> {
  return new Map((marks ?? []).filter(m => Date.parse(m.until) > now).map(m => [m.key, m]));
}

export interface Split<T> { shown: T[]; hidden: Array<T & { mark: BriefingDismissal }> }

/**
 * Items marked Done or deferred go to `hidden`, with their mark; the rest keep
 * their order. A Done pressed before this briefing was written does not hide
 * it: the ledger only lets a done item back once its session did something
 * new, so a newer briefing that lists it again means it is open again.
 */
export function splitMarked<T extends { key: string | null }>(
  items: T[], marks: ReadonlyMap<string, BriefingDismissal>, briefingCreatedAt?: string,
): Split<T> {
  const out: Split<T> = { shown: [], hidden: [] };
  const written = briefingCreatedAt ? Date.parse(briefingCreatedAt) : NaN;
  for (const it of items) {
    const m = it.key ? marks.get(it.key) : undefined;
    // Only a session's item comes back with new activity; a PR-only item or a
    // pattern stays done for the mark's whole span.
    const sessionKey = !!m && m.key.startsWith('open:') && !m.key.startsWith('open:pr:');
    const reopened = sessionKey && m.kind === 'done' && Number.isFinite(written) && Date.parse(m.createdAt) < written;
    if (m && !reopened) out.hidden.push({ ...it, mark: m }); else out.shown.push(it);
  }
  return out;
}

/** A Done, Defer or Bring back pressed here and not yet seen in a poll; mark null = brought back. */
export interface MarkOverride { key: string; mark: BriefingDismissal | null; settledAt: number | null }

/**
 * The server's marks with this tab's own changes on top, so a poll that left
 * before a click landed cannot undo it. An override stops applying once a poll
 * that started after its save has answered (`fetchedFrom`).
 */
export function overlayMarks(server: BriefingDismissal[] | undefined, overrides: MarkOverride[], fetchedFrom: number): BriefingDismissal[] {
  const out = new Map((server ?? []).map(m => [m.key, m]));
  for (const o of overrides) {
    if (o.settledAt !== null && fetchedFrom >= o.settledAt) continue;
    if (o.mark) out.set(o.key, o.mark); else out.delete(o.key);
  }
  return [...out.values()];
}

/**
 * Worked on bullets grouped by project and workstream, in the order the
 * briefing named them. Grouped by identity, not by label: two projects can
 * share a name on different boxes.
 */
export function groupWorkedOn(
  items: BriefingContent['workedOn'],
  projects: BriefingView['projects'],
): Array<{ label: string | null; projectId: string | null; workstream: string | null; items: BriefingContent['workedOn'] }> {
  const groups: Array<{ id: string; label: string | null; projectId: string | null; workstream: string | null; items: BriefingContent['workedOn'] }> = [];
  for (const it of items) {
    const known = !!it.projectId && !!projects[it.projectId];
    const id = known ? `${it.projectId}\u0000${it.workstream || 'main'}` : '';
    let g = groups.find(x => x.id === id);
    if (!g) { g = { id, label: sessionLabel(it.projectId, it.workstream, projects), projectId: it.projectId, workstream: it.workstream, items: [] }; groups.push(g); }
    g.items.push(it);
  }
  return groups.map(({ id: _id, ...g }) => g);
}

/** How many things the latest briefing left open and were not marked, for the phone's strip. */
export function openCount(data: BriefingLatest | null, now: number = Date.now()): number {
  const items = data?.latest?.content?.leftOpen ?? [];
  return splitMarked(items, activeMarks(data?.dismissals, now), data?.latest?.createdAt).shown.length;
}

/** When a mark lets its item back, in words: "tomorrow 09:00", "in 14 days". */
export function markLabel(m: BriefingDismissal, now: number = Date.now()): string {
  const ms = Date.parse(m.until) - now;
  if (m.kind === 'done') return 'done';
  if (ms <= 36 * 3_600_000) return `back in ${Math.max(1, Math.round(ms / 3_600_000))}h`;
  return `back in ${Math.round(ms / 86_400_000)} days`;
}

/** The browser's IANA timezone, or UTC when the platform cannot say. */
export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
