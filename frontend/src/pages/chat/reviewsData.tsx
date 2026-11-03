// What the reviews UI reads, loaded once for the
// page as simpleData.tsx is: the lab's PR pipeline (GET /api/prs, re-read on
// the PR-changed event and every minute), every agent review the sessions'
// statuses carry (the lab's review panes), and each review session's live
// state, folded into the queue (chat/reviews.ts). Off, nothing is read.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { FLAGS, useFlag } from '../../flags';
import { prsApi, type PrPipelineResponse, type PrRow, type PrWorkstreamLink } from '../../services/api';
import { PRS_CHANGED_EVENT } from '../../utils/prPipeline';
import { sessionName } from '../../utils/sessionName';
import { statusKey } from '../../utils/statusKey';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { chatRowState } from '../../chat/rowState';
import { rowKey } from '../../mobile/inbox';
import { prShort, reviewQueue, sidebarItems, type AgentReview, type PostedRound, type QueueItem, type ReviewQueue, type SessionState } from '../../chat/reviews';
import { usePolled } from '../dashboard/useDashboardData';
import { useChatChrome } from './chatChrome';
import { useSimpleData } from './simpleData';

export interface ReviewsData {
  on: boolean;
  prs: PrPipelineResponse | null;
  loading: boolean;
  /** GET /api/prs failed with nothing read yet: not an empty queue. */
  failed: boolean;
  queue: ReviewQueue;
  agentReviews: readonly AgentReview[];
  /** Review sessions the queue doesn't list (moreReviewSessions): under Reviews too. */
  more: readonly QueueItem[];
  /** Review sessions, by sidebar row key: they show under Reviews, not in their space. */
  sessionKeys: ReadonlySet<string>;
  refresh: () => void;
}

const EMPTY: ReviewQueue = { items: [], deferred: [], grouped: [], reviewed: [], groups: [], viewer: null, needYou: 0 };
const NO_KEYS: ReadonlySet<string> = new Set();
const Ctx = createContext<ReviewsData>({ on: false, prs: null, loading: false, failed: false, queue: EMPTY, more: [], agentReviews: [], sessionKeys: NO_KEYS, refresh: () => {} });

/** Reviews are on: the flag, under the chrome refresh. */
export function useReviewsOn(): boolean {
  const on = useFlag(FLAGS.simpleUiReviews, false);
  const { refresh } = useChatChrome();
  return on && refresh === true;
}

export function ReviewsDataProvider({ children }: { children: React.ReactNode }) {
  const on = useReviewsOn();
  const { user } = useAuth();
  const { projects, statusMap } = useProjects();
  const { rows, live, setupOf, unseen } = useSimpleData();
  const prs = usePolled<PrPipelineResponse | null>(() => (on ? prsApi.list() : Promise.resolve(null)), 60_000, { deps: [on] });
  const { refresh } = prs;
  useEffect(() => {
    if (!on) return;
    window.addEventListener(PRS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PRS_CHANGED_EVENT, refresh);
  }, [on, refresh]);

  // Every review pane the sweep knows, from each workstream's agent status.
  const agentReviews = useMemo(() => {
    if (!on) return [];
    const out: AgentReview[] = [];
    for (const p of projects) {
      const owner = p.ownerUsername ?? user?.unixUsername ?? '';
      for (const w of p.workstreams ?? []) {
        const st = statusMap[statusKey(p.instanceId, sessionName(owner, p.name, 'agent', w.name))];
        const list = st?.reviews?.length ? st.reviews : st?.review ? [st.review] : [];
        for (const r of list) {
          if (r.pr == null) continue;
          const seen = r.state === 'done' && !!r.seenAt && (!r.doneAt || Date.parse(r.seenAt) >= Date.parse(r.doneAt));
          out.push({ projectId: p.id, workstream: w.name, session: r.session ?? null, number: r.pr, url: r.url, reviewer: reviewerName(r.reviewer), state: r.state, seen, at: r.at ?? null });
        }
      }
    }
    return out;
  }, [on, projects, statusMap, user?.unixUsername]);

  const byRow = useMemo(() => new Map(rows.map(r => [r.key, r])), [rows]);
  const sessionState = useCallback((link: PrWorkstreamLink): SessionState | null => {
    const r = byRow.get(rowKey(link.projectId, link.workstream));
    if (!r) return null;
    const kind = chatRowState(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId), unseen.has(r.key)).kind;
    return kind === 'working' ? 'working' : kind === 'approval' ? 'approval' : kind === 'unread' ? 'unread' : kind === 'error' ? 'error' : kind === 'off' ? 'off' : 'done';
  }, [byRow, live, setupOf, unseen]);

  const data = prs.data;
  // Each read: old marks are tidied away (their links don't decide it, see pruneReviewMarks).
  useEffect(() => { pruneReviewMarks(); }, [data]);
  const marksAt = useSyncExternalStore(subscribeMarks, () => marksVersion, () => 0);
  const rounds = (data && data.connected ? (data as { reviewRounds?: PostedRound[] }).reviewRounds : undefined) ?? [];
  const queue = useMemo(
    () => (on ? reviewQueue({ prs: data, now: Date.now(), sessionState, agentReviews, rounds }) : EMPTY),
    [on, data, sessionState, agentReviews, rounds],
  );
  // The review sessions the queue doesn't list, joined to its items where they're on the same PR.
  const joined = useMemo(
    () => (on ? joinReviewSessions(queue, moreReviewSessions(queue, data, Date.now(), marks, sessionState)) : { queue, more: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- marksAt: the marks changed
    [on, queue, data, sessionState, marksAt],
  );
  const { more } = joined;
  const sessionKeys = useMemo(() => {
    const keys = new Set<string>();
    // Only what the Reviews section lists leaves its space (chat/reviews.ts sidebarItems, and the more).
    for (const it of [...sidebarItems(joined.queue), ...more]) if (it.session) keys.add(rowKey(it.session.projectId, it.session.workstream));
    return keys.size ? keys : NO_KEYS;
  }, [joined.queue, more]);
  const value = useMemo(
    () => ({ on, prs: data, loading: data === null && prs.loading, failed: on && data === null && prs.error != null, queue: joined.queue, more, agentReviews, sessionKeys, refresh }),
    [on, data, prs.loading, prs.error, joined.queue, more, agentReviews, sessionKeys, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReviewsData(): ReviewsData {
  return useContext(Ctx);
}

/**
 * Review sessions this browser started (ReviewMenu's startSession), by project and workstream, kept in it: a session
 * on a PR no lane lists (a pasted or ⌘K PR, or one that has left them) is known as a review only by its mark. A mark
 * stands while a read lists the session's manual link to the PR, in a lane or in `earlier`, and for its first two
 * minutes, before a read can; a session unlinked or moved after that isn't a review, and its mark is forgotten.
 */
const MARKS_KEY = 'termag.reviews.sessions';
const FRESH_MS = 120_000;
export interface ReviewMark { repo: string; number: number; title: string; author: string | null; url: string | null; session: PrWorkstreamLink; at: number }
type Marks = Record<string, ReviewMark>;
function loadMarks(): Marks {
  try { return JSON.parse(localStorage.getItem(MARKS_KEY) ?? '{}') as Marks; } catch { return {}; }
}
let marks: Marks = typeof localStorage === 'undefined' ? {} : loadMarks();
let marksVersion = 0;
const markListeners = new Set<() => void>();
function saveMarks(next: Marks) {
  marks = next;
  try { localStorage.setItem(MARKS_KEY, JSON.stringify(next)); } catch { /* this page only */ }
  marksVersion++;
  for (const fn of markListeners) fn();
}
// Another tab's marks: read again when it writes them, and before every write here, so neither tab writes over the
// other's with what it loaded.
const currentMarks = (): Marks => (typeof localStorage === 'undefined' ? marks : loadMarks());
const subscribeMarks = (fn: () => void) => {
  markListeners.add(fn);
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === MARKS_KEY) { marks = loadMarks(); marksVersion++; fn(); } };
  window.addEventListener('storage', onStorage);
  return () => { markListeners.delete(fn); window.removeEventListener('storage', onStorage); };
};

export function markReviewSession(session: PrWorkstreamLink, pr: { repo: string; number: number; title: string; author: string | null; url: string | null }) {
  saveMarks({ ...currentMarks(), [rowKey(session.projectId, session.workstream)]: { ...pr, session, at: Date.now() } });
}

/** The manual links a read lists, by session: a lane's row (with the row), else `earlier`'s. */
function manualLinks(prs: PrPipelineResponse | null): Map<string, { repo: string; number: number; row: PrRow | null; session: PrWorkstreamLink }> {
  const out = new Map<string, { repo: string; number: number; row: PrRow | null; session: PrWorkstreamLink }>();
  if (!prs || !prs.connected) return out;
  for (const r of prs.lanes.flatMap(l => l.rows)) {
    if (r.linkedBy !== 'manual' || !r.workstream || !r.repo || r.number == null) continue;
    const k = rowKey(r.workstream.projectId, r.workstream.workstream);
    if (!out.has(k)) out.set(k, { repo: r.repo, number: r.number, row: r, session: r.workstream });
  }
  for (const e of prs.earlier ?? []) {
    const k = rowKey(e.workstream.projectId, e.workstream.workstream);
    if (e.source === 'manual' && !out.has(k)) out.set(k, { repo: e.repo, number: e.number, row: null, session: e.workstream });
  }
  return out;
}
const samePr = (a: { repo: string; number: number }, b: { repo: string; number: number }) => a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();

const MARK_DAYS = 30;
const MAX_MARKS = 200;
/**
 * Tidies the marks: past 30 days, or past the newest 200. Never on what a read lists: a mark past its first two
 * minutes counts only while its link is listed (moreReviewSessions), and a read that failed to list the links (the
 * server answers none then) must not look like every session unlinked.
 */
export function pruneReviewMarks(now = Date.now()): void {
  const current = currentMarks();
  const keep = Object.fromEntries(Object.entries(current)
    .filter(([, m]) => now - m.at < MARK_DAYS * 86_400_000)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_MARKS));
  if (Object.keys(keep).length !== Object.keys(current).length) saveMarks(keep);
}

/**
 * Review sessions the queue doesn't list, so they're under Reviews too, as every review session is: a manual link in
 * any lane to a PR that isn't yours (a session on a checkout of someone else's PR, started from its page: mine,
 * merged, checks), one in `earlier` that this browser marked, and a mark in its first two minutes. A workstream on
 * your own PR is never one, nor a link this browser can't tell is a review.
 */
export function moreReviewSessions(queue: ReviewQueue, prs: PrPipelineResponse | null, now = Date.now(), marked: Marks = marks,
  stateOf?: (link: PrWorkstreamLink) => SessionState | null): QueueItem[] {
  // A finished review (Reviewed) is listed too: it goes back to its space, its session still tied to the PR.
  const listed = new Set([...queue.items, ...queue.deferred, ...queue.grouped, ...queue.reviewed]
    .flatMap(i => (i.session ? [rowKey(i.session.projectId, i.session.workstream)] : [])));
  const viewer = prs && prs.connected ? prs.viewer.toLowerCase() : null;
  // Never a review of your own PR, however it's known: a lane's row, or the author the mark recorded.
  const yours = (author: string | null | undefined) => !!viewer && !!author && author.toLowerCase() === viewer;
  const item = (pr: { repo: string; number: number; title: string; author: string | null; url: string | null }, row: PrRow | null, session: PrWorkstreamLink): QueueItem => {
    const state = stateOf?.(session) ?? null;
    const section = state === 'working' ? 'reviewing' : state === 'approval' ? 'your-call' : 'waiting';
    const why = [pr.author ?? 'someone', state === 'approval' ? 'the reviewer needs an answer' : 'your review session'];
    // Keyed by its session as well as its PR: two review sessions on one PR are two rows.
    const key = `${pr.repo}#${pr.number}@${rowKey(session.projectId, session.workstream)}`;
    return { key, repo: pr.repo, number: pr.number, title: pr.title, author: pr.author, url: pr.url, section, why, at: null, row, session, agent: null, round: null, deferredUntil: null };
  };
  const out = new Map<string, QueueItem>();
  for (const [k, l] of manualLinks(prs)) {
    if (listed.has(k)) continue;
    const mark = marked[k] && samePr(marked[k], l) ? marked[k] : null;
    const author = l.row?.author ?? mark?.author ?? null;
    // A lane's row says whose PR it is; `earlier` doesn't, so only this browser's own mark makes one a review.
    if (yours(author) || (!l.row && !mark)) continue;
    out.set(k, item({
      repo: l.repo, number: l.number, title: l.row?.title ?? mark?.title ?? prShort(l.repo, l.number), author,
      url: l.row?.url ?? mark?.url ?? `https://github.com/${l.repo}/pull/${l.number}`,
    }, l.row, l.session));
  }
  for (const [k, m] of Object.entries(marked)) {
    if (listed.has(k) || out.has(k) || now - m.at >= FRESH_MS || yours(m.author)) continue;
    out.set(k, item(m, null, m.session));
  }
  return [...out.values()];
}

/**
 * The queue with the more joined in: a review session on a PR the queue lists without one (an agent review put it
 * there first) is that item's session, so a PR has one row; one on a PR whose item has another session keeps its
 * own row, keyed by its session.
 */
export function joinReviewSessions(queue: ReviewQueue, more: QueueItem[]): { queue: ReviewQueue; more: QueueItem[] } {
  const rest: QueueItem[] = [];
  const attach = new Map<string, QueueItem>();
  const lower = (k: string) => k.toLowerCase();
  const pr = (i: QueueItem) => lower(`${i.repo}#${i.number}`);
  const all = [...queue.items, ...queue.deferred, ...queue.grouped];
  for (const m of more) {
    // The more are keyed by session too (moreReviewSessions), so they never share a key: matched here by PR.
    const item = all.find(i => pr(i) === pr(m));
    if (item && !item.session && !attach.has(lower(item.key))) attach.set(lower(item.key), m);
    else rest.push(m);
  }
  if (attach.size === 0) return { queue, more: rest };
  const join = (list: QueueItem[]) => list.map(i => {
    const m = attach.get(lower(i.key));
    return m ? { ...i, session: m.session, row: i.row ?? m.row } : i;
  });
  return { queue: { ...queue, items: join(queue.items), deferred: join(queue.deferred), grouped: join(queue.grouped) }, more: rest };
}

/** The review a session is for (a review session on a checkout of the PR), or null: the queue's, else the more. */
export function useReviewOf(projectId: string | null | undefined, workstream: string): QueueItem | null {
  const { on, queue, more } = useContext(Ctx);
  return useMemo(() => {
    if (!on || !projectId) return null;
    const here = (i: QueueItem) => i.session?.projectId === projectId && i.session.workstream === workstream;
    return [...queue.items, ...queue.deferred, ...queue.grouped, ...queue.reviewed].find(here) ?? more.find(here) ?? null;
  }, [on, projectId, workstream, queue, more]);
}

const REVIEWER_NAME: Record<string, string> = { devin: 'Devin', claude: 'Claude', cursor: 'Cursor', pi: 'pi' };
export function reviewerName(id: string | null | undefined): string {
  return REVIEWER_NAME[id ?? 'devin'] ?? (id ?? 'Devin');
}
