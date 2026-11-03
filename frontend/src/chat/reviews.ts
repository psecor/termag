// PR reviews in the simple UI: the review queue
// the sidebar's Reviews section and the Reviews page draw, built from the
// lab's PR pipeline (GET /api/prs: its review lanes, review groups and
// deferrals) and what termag knows of each review: a review session on a
// checkout of the PR, an agent review in a session's review pane (the lab's
// Review with Devin), and the rounds the user posted. Pure, for the tests.
import type { PrGroupMember, PrPipelineResponse, PrReviewGroup, PrRow, PrWorkstreamLink } from '../services/api';
import { deferrals, lanesOf, rowParam } from '../utils/prPipeline';

/** Where a PR stands for the user, in the order the queue shows them. */
/** Reviewed is the finished ones (approved, or the PR merged or closed): folded at the page's foot, never counted. */
export type QueueSection = 'your-call' | 'pushed' | 'to-review' | 'reviewing' | 'waiting' | 'team' | 'reviewed';
export const SECTION_ORDER: readonly QueueSection[] = ['your-call', 'pushed', 'to-review', 'reviewing', 'waiting', 'team'];
export const SECTION_NAME: Record<QueueSection, string> = {
  'your-call': 'Your call',
  pushed: 'Changed since your review',
  'to-review': 'To review',
  reviewing: 'Reviewing',
  waiting: 'Waiting on the author',
  team: 'Asks your team',
  reviewed: 'Reviewed',
};
/** The sections that need the user now: what the sidebar counts. */
export const NEEDS_YOU: readonly QueueSection[] = ['your-call', 'pushed'];

/**
 * What the sidebar's Reviews section lists: what needs the user, what a reviewer
 * is reading, and every review session, whatever its section, since a review
 * session is listed here instead of in its space (reviewsData's sessionKeys
 * hides exactly these, so none is left with no row at all).
 */
export function sidebarItems(q: Pick<ReviewQueue, 'items' | 'grouped' | 'deferred'>): QueueItem[] {
  // A grouped request's row is its card on the Reviews page, and a deferred one's is folded away, but a review
  // session on either still lives here: a deferral hides a request, not a session.
  const session = (i: QueueItem) => i.session != null;
  return [...q.items.filter(i => NEEDS_YOU.includes(i.section) || i.section === 'reviewing' || session(i)), ...q.grouped.filter(session), ...q.deferred.filter(session)];
}

/** An agent review (the lab's review pane) of a PR, as the agent session's status carries it. */
export interface AgentReview {
  projectId: string;
  workstream: string;
  /** The pane's tmux session: slot 1 is the review role's own name. */
  session: string | null;
  number: number;
  url: string | null;
  reviewer: string;
  state: 'reviewing' | 'waiting' | 'done' | 'exited';
  /** Done and looked at since. */
  seen: boolean;
  /** When its state last changed, as the review sweep read it (the server's clock); absent from an older backend. */
  at?: string | null;
}

/** A review session's live state, as the sidebar's row has it. */
export type SessionState = 'working' | 'approval' | 'unread' | 'done' | 'error' | 'off';

/** What the user posted on a PR, and on which head (services/prReviewRounds.ts). */
export interface PostedRound {
  repo: string;
  number: number;
  round: number;
  headSha: string;
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
  comments: number;
  postedAt: string;
  /** The PR's title and author when it was posted (absent from an older backend). */
  title?: string;
  author?: string | null;
  /** What the user posted in the rounds before this one, oldest first. */
  earlier?: Array<{ round: number; headSha?: string; event: PostedRound['event']; comments: number; postedAt: string }>;
  /** The PR as GitHub has it now, where it could be read. */
  now: { state: 'open' | 'merged' | 'closed'; headSha: string | null; askedAgain: boolean; title: string; author: string | null; url: string } | null;
}

export interface QueueItem {
  /** owner/name#n */
  key: string;
  repo: string;
  number: number;
  title: string;
  author: string | null;
  url: string | null;
  section: QueueSection;
  /** The line under the title, in parts. */
  why: string[];
  /** When the row's state began, for its age. */
  at: string | null;
  row: PrRow | null;
  /** The review session on a checkout of the PR (the lab's "New workstream for #N"). */
  session: PrWorkstreamLink | null;
  agent: AgentReview | null;
  round: PostedRound | null;
  /** Ends a deferral (epoch ms). */
  deferredUntil: number | null;
}

export interface QueueGroup {
  group: PrReviewGroup;
  /** Members left to review, the viewer's own left out. */
  left: number;
}

export interface ReviewQueue {
  items: QueueItem[];
  deferred: QueueItem[];
  /** Requests a group's card shows instead of a row: the sidebar still lists one with a review session. */
  grouped: QueueItem[];
  /** Finished reviews, newest first: they keep their session tied to the PR once it leaves the lanes. */
  reviewed: QueueItem[];
  groups: QueueGroup[];
  viewer: string | null;
  /** How many need the user: the sidebar's count. */
  needYou: number;
}

export const prKey = (repo: string, number: number) => `${repo}#${number}`;

/** Whether the user approved the PR in this round or a later one: in its latest posted round or any before it. */
/** The same commit: GitHub's full SHA and a reviewer's short one, in either case. */
export function sameHead(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const n = Math.max(7, Math.min(a.length, b.length));
  return a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

/**
 * The rounds the user posted on a PR that were of `head`: a card's, or a follow-up's. Matched by the head, not the
 * round number, which a reviewer may well give again (round 1, after an approve and an ask again).
 */
export function postedAt(rounds: readonly PostedRound[], repo: string, number: number, head: string | null | undefined) {
  return rounds.filter(r => r.repo.toLowerCase() === repo.toLowerCase() && r.number === number)
    .flatMap(r => [r, ...(r.earlier ?? [])]).filter(x => sameHead(x.headSha, head));
}

/** An approval the user posted of this head. */
export function approvedSince(rounds: readonly PostedRound[], repo: string, number: number, head: string | null | undefined): boolean {
  return postedAt(rounds, repo, number, head).some(x => x.event === 'APPROVE');
}
/** "termag#804", the way rows are labelled. */
export const prShort = (repo: string, number: number) => `${repo.split('/')[1] ?? repo}#${number}`;

export interface QueueInputs {
  prs: PrPipelineResponse | null | undefined;
  now: number;
  /** A linked review session's live state; null when there is no such row. */
  sessionState?: (link: PrWorkstreamLink) => SessionState | null;
  agentReviews?: readonly AgentReview[];
  rounds?: readonly PostedRound[];
}

const REVIEW_LANES = new Set(['needs_my_review', 'team_review']);

/** The queue, every item in exactly one section. */
export function reviewQueue({ prs, now, sessionState, agentReviews = [], rounds = [] }: QueueInputs): ReviewQueue {
  const viewer = prs && prs.connected ? prs.viewer : null;
  const defer = deferrals(prs, now);
  const items = new Map<string, QueueItem>();
  // A PR is one item: the first put (an agent review's first), with a review session put after it attached.
  // Keyed without case: an agent review's repo is its URL's, a round's is stored lowercase, a row's is GitHub's own.
  const put = (it: QueueItem) => {
    const k = it.key.toLowerCase();
    const was = items.get(k);
    if (!was) items.set(k, it);
    else if (!was.session && it.session) items.set(k, { ...was, session: it.session });
  };

  const rows = lanesOf(prs).filter(l => REVIEW_LANES.has(l.id)).flatMap(l => l.rows)
    .filter((r): r is PrRow & { repo: string; number: number } => r.kind === 'pr' && !!r.repo && r.number != null);
  const byKey = new Map(rows.map(r => [prKey(r.repo, r.number), r]));
  // Any lane's row: an agent review can be of the user's own PR, and a PR you reviewed can be listed only
  // under merged or mine, neither of them a review lane. Keyed lowercase, as the rounds are.
  const anyRow = new Map(lanesOf(prs).flatMap(l => l.rows)
    .filter((r): r is PrRow & { repo: string; number: number } => r.kind === 'pr' && !!r.repo && r.number != null)
    .map(r => [prKey(r.repo.toLowerCase(), r.number), r]));
  // A PR that left the lanes (you reviewed it) keeps its stored link to the review session: a manual one.
  const earlier = new Map((prs && prs.connected ? prs.earlier ?? [] : []).filter(e => e.source === 'manual').map(e => [prKey(e.repo.toLowerCase(), e.number), e.workstream]));
  const latestRound = new Map<string, PostedRound>();
  const finished: QueueItem[] = [];
  // Finished reviews no one asked for again: a review lane can still list one (GitHub keeps a team's request after
  // any verdict), and it stays finished rather than coming back as a request.
  const settled = new Set<string>();
  for (const r of rounds) {
    const k = prKey(r.repo.toLowerCase(), r.number);
    const was = latestRound.get(k);
    if (!was || r.round > was.round) latestRound.set(k, r);
  }

  // Agent reviews first: a PR can have one whatever its lane, the user's own included.
  for (const a of agentReviews) {
    const repo = repoOfUrl(a.url);
    if (!repo) continue;
    const key = prKey(repo, a.number);
    const row = byKey.get(key) ?? null;
    const base = itemBase(key, repo, a.number, row, anyRow.get(prKey(repo.toLowerCase(), a.number)));
    if (a.state === 'reviewing') put({ ...base, section: 'reviewing', agent: a, why: [`${a.reviewer} is reading it`] });
    else if (a.state === 'waiting') put({ ...base, section: 'your-call', agent: a, why: [`${a.reviewer} needs an answer`] });
    else if (a.state === 'done' && !a.seen) put({ ...base, section: 'your-call', agent: a, why: [`${a.reviewer}'s review is ready`] });
  }

  // What the user posted: waiting on the author, or changed since.
  for (const [key, r] of latestRound) {
    const row = rows.find(x => x.repo.toLowerCase() === r.repo.toLowerCase() && x.number === r.number) ?? null;
    // The head couldn't be read (a GitHub blip): the round stands on what's known, open at the head it was posted
    // on and asked again only by a request newer than it (the lanes say), rather than dropping out and letting a
    // request GitHub kept after it come back as a new one.
    const now = r.now ?? {
      state: 'open' as const, headSha: null, askedAgain: !!row?.requestedAt && Date.parse(row.requestedAt) > Date.parse(r.postedAt),
      title: row?.title ?? r.title ?? prShort(r.repo, r.number), author: row?.author ?? r.author ?? null, url: row?.url ?? `https://github.com/${r.repo}/pull/${r.number}`,
    };
    const base = { ...itemBase(row ? prKey(row.repo, row.number) : key, row?.repo ?? r.repo, r.number, row), title: row?.title ?? now.title, author: row?.author ?? now.author, url: row?.url ?? now.url, round: { ...r, now } };
    // A review session is one the user started on the PR (a manual link), as on the rows' path below:
    // a session of theirs that merely has the PR's branch checked out is not.
    // Its row in a review lane, else in any lane (a merged PR, one of yours), else its stored link.
    const linked = row ?? anyRow.get(key) ?? null;
    const session = (linked?.workstream && linked.linkedBy === 'manual' ? linked.workstream : null) ?? earlier.get(key) ?? null;
    const changed = (now.headSha && now.headSha !== r.headSha) || now.askedAgain;
    const state = session && sessionState ? sessionState(session) : null;
    if (r.event === 'APPROVE' || now.state !== 'open') {
      const end = now.state === 'open' ? [] : [now.state];
      finished.push({ ...base, session, section: 'reviewed', why: [`you ${eventWord(r.event)}`, ...end], at: r.postedAt });
      if (!now.askedAgain) settled.add(key);
      continue;
    }
    if (changed) {
      put({ ...base, session, section: state === 'working' ? 'reviewing' : 'pushed', why: [now.askedAgain ? 'asked for your review again' : 'pushed since your review', `round ${r.round + 1}`], at: row?.requestedAt ?? null });
    } else {
      put({ ...base, session, section: 'waiting', why: [`you ${eventWord(r.event)}`, `${r.comments} ${r.comments === 1 ? 'comment' : 'comments'}`], at: r.postedAt });
    }
  }

  for (const r of rows) {
    if (settled.has(prKey(r.repo.toLowerCase(), r.number))) continue;
    const key = prKey(r.repo, r.number);
    const base = itemBase(key, r.repo, r.number, r);
    const session = r.workstream && r.linkedBy === 'manual' ? r.workstream : null;
    const state = session && sessionState ? sessionState(session) : null;
    const asks = r.lane === 'needs_my_review' && r.askedYou !== false;
    if (state === 'working') { put({ ...base, session, section: 'reviewing', why: [r.author ?? 'someone', 'the reviewer is reading it'] }); continue; }
    if (state === 'approval') { put({ ...base, session, section: 'your-call', why: [r.author ?? 'someone', 'the reviewer needs an answer'] }); continue; }
    // A review that failed (a rate limit, a crash) isn't one waiting to be posted: it needs you for another reason.
    if (session && state === 'error') { put({ ...base, session, section: 'your-call', why: [r.author ?? 'someone', 'the review stopped on an error'] }); continue; }
    if (session && (state === 'unread' || state === 'done')) { put({ ...base, session, section: 'your-call', why: [r.author ?? 'someone', 'reviewed', 'nothing posted yet'] }); continue; }
    put({ ...base, session, section: asks ? 'to-review' : 'team', why: [r.author ?? 'someone', asks ? 'asks you' : 'asks your team'] });
  }

  const all = [...items.values()];
  const shown: QueueItem[] = [];
  const deferred: QueueItem[] = [];
  for (const it of all) {
    const until = it.row ? defer.get(rowParam(it.row)) : undefined;
    // A deferral hides a request, never a review that needs you.
    if (until !== undefined && (it.section === 'to-review' || it.section === 'team')) deferred.push({ ...it, deferredUntil: until });
    else shown.push(it);
  }
  const groups = openGroupsOf(prs).map(group => ({ group, left: leftToReview(group, viewer).length }));
  // A grouped PR is shown in its group's card, not twice.
  // Lowercased: groups keep members as stored (lowercase), lane rows in GitHub's own case.
  const grouped = new Set(groups.flatMap(g => g.group.members.map(m => prKey(m.repo.toLowerCase(), m.number))));
  const folded = (it: QueueItem) => grouped.has(prKey(it.repo.toLowerCase(), it.number)) && (it.section === 'to-review' || it.section === 'team');
  const ungrouped = shown.filter(it => !folded(it));
  return {
    items: sortQueue(ungrouped),
    grouped: shown.filter(folded),
    deferred,
    // An approved PR asked again is a request once more, not a finished review.
    reviewed: finished.filter(it => !items.has(it.key.toLowerCase())).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
    groups,
    viewer,
    needYou: ungrouped.filter(it => NEEDS_YOU.includes(it.section)).length,
  };
}

/**
 * A group's members left to review: open, not checked off, and not yours. The card's "N of M to review",
 * Review next and Review all together all go by it, so none counts or opens a closed PR the others skip.
 */
export function leftToReview(group: PrReviewGroup, viewer: string | null): PrGroupMember[] {
  // GitHub logins compare without case, as the lab's own counts do.
  const mine = (author: string | null) => !!viewer && !!author && author.toLowerCase() === viewer.toLowerCase();
  return group.members.filter(m => m.state === 'open' && !m.checked && !mine(m.author));
}

function itemBase(key: string, repo: string, number: number, row: PrRow | null, meta: PrRow | null = row): Omit<QueueItem, 'section' | 'why'> {
  return {
    key, repo, number,
    title: meta?.title ?? `${prShort(repo, number)}`,
    author: meta?.author ?? null,
    url: meta?.url ?? `https://github.com/${repo}/pull/${number}`,
    at: row?.requestedAt ?? row?.at ?? null,
    row, session: null, agent: null, round: null, deferredUntil: null,
  };
}

function openGroupsOf(prs: PrPipelineResponse | null | undefined): PrReviewGroup[] {
  return prs && prs.connected ? (prs.groups ?? []).filter(g => !g.closedAt && !g.done) : [];
}

function sortQueue(items: QueueItem[]): QueueItem[] {
  const order = new Map(SECTION_ORDER.map((s, i) => [s, i]));
  // Oldest request first within a section: it has waited longest.
  return [...items].sort((a, b) => (order.get(a.section)! - order.get(b.section)!) || (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0));
}

function eventWord(e: PostedRound['event']): string {
  return e === 'REQUEST_CHANGES' ? 'requested changes' : e === 'APPROVE' ? 'approved' : 'commented';
}


/** owner/name of a GitHub PR URL, or null. */
export function repoOfUrl(url: string | null | undefined): string | null {
  const m = url ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/.exec(url) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

// ── Routes and links ───────────────────────────────────────────────────────

/** A PR's page in the simple UI. */
export function prPath(repo: string, number: number): string {
  const [owner, name] = repo.split('/');
  return `/chat/pr/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}`;
}

/**
 * A PR named the ways people paste one: a GitHub URL, owner/name#N, or a
 * termag path that mirrors GitHub's (`/chat/gh/<owner>/<name>/pull/<n>`, so
 * swapping github.com for termag in the address bar opens the review here).
 */
export function parsePrRef(raw: string): { repo: string; number: number } | null {
  const s = raw.trim();
  const url = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i.exec(s);
  if (url) return { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) };
  const path = /\/gh\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(s);
  if (path) return { repo: `${path[1]}/${path[2]}`, number: Number(path[3]) };
  const ref = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s);
  if (ref) return { repo: `${ref[1]}/${ref[2]}`, number: Number(ref[3]) };
  return null;
}

const ORGS = 'org:example-org org:example-team';
const Q: Partial<Record<QueueSection, string>> = {
  'to-review': `is:open is:pr user-review-requested:@me ${ORGS}`,
  team: `is:open is:pr review-requested:@me -user-review-requested:@me ${ORGS}`,
  waiting: `is:open is:pr reviewed-by:@me -review-requested:@me -author:@me ${ORGS}`,
};

/** The same list on GitHub, so the queue can be checked against it. */
export function githubListUrl(section: QueueSection): string | null {
  const q = Q[section];
  return q ? `https://github.com/pulls?q=${encodeURIComponent(q)}` : null;
}
