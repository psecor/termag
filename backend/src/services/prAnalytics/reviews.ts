/**
 * Review metrics: pure,
 * over PRs and their reviews as queries.ts loads them, so the rules are tested
 * without a database.
 *
 *   A review is one person on one PR in the window, however many times they
 *   submitted. Reviewers are people (reviewerClass human), never the PR's
 *   author or the person it is credited to.
 *   A deciding approval is the last human approval before a merge.
 *   The approval agent is the `cursor` bot's APPROVED reviews; Bugbot posts as
 *   the same login but only comments.
 */
import { classifyAuthor, type ClassifyLists } from './classify';
import { distribution, percentile, type Distribution } from './stats';
import type { PrNode } from './sync';

/** Bot logins whose approvals are an approval agent's (compared without `[bot]`). */
export const APPROVAL_AGENT_LOGINS = ['cursor'];
export const REVIEW_DAYS = Number(process.env.PR_ANALYTICS_REVIEW_DAYS ?? 90);
/** A PR that waited this long since ready before anyone reviewed it is stale. */
export const STALE_DAYS = 3;
/**
 * Reviews (the first ones) and conversation comments (the last ones) read per
 * PR. A PR with more reviews than this is left out of what needs all of them
 * (the agent split, deciding approvals), like a PR never read; comments are
 * counted over the ones read.
 */
export const REVIEW_PAGE = 100;
export const COMMENT_PAGE = 100;
/** Weeks of trend the review history supports. */
export const REVIEW_TREND_MAX_WEEKS = 13;

/**
 * A review an agent wrote through a person's account: Devin signs its reviews
 * "Reviewed by Devin" when it posts with someone's token (termag's own reviews
 * do). Only the class is stored, never the body.
 */
const AGENT_REVIEW_BODY = /\bReviewed by Devin\b/i;

const lower = (s: string) => s.trim().toLowerCase();
const base = (s: string) => lower(s).replace(/\[bot\]$/, '');

// ---- Ingest: what a PR node contributes ----

export interface ReviewRow { id: string; reviewerLogin: string; reviewerClass: string; state: string; submittedAt: Date; comments: number }

/** The PR's submitted reviews, for github_pr_reviews. Pending reviews have no submittedAt and are skipped. */
export function reviewRows(n: PrNode, lists: ClassifyLists): ReviewRow[] {
  return (n.reviews?.nodes ?? []).filter(r => r?.id && r.submittedAt).map(r => ({
    id: r.id,
    reviewerLogin: lower(r.author?.login ?? ''),
    reviewerClass: AGENT_REVIEW_BODY.test(r.body ?? '') ? 'agent' : classifyAuthor(r.author?.login ?? '', r.author?.__typename ?? '', lists),
    state: r.state,
    submittedAt: new Date(r.submittedAt!),
    comments: r.comments?.totalCount ?? 0,
  }));
}

/** The github_prs columns the review metrics read; null when the node carries no reviews (old fixtures). */
export function reviewFields(n: PrNode, lists: ClassifyLists, now = new Date()) {
  if (!n.reviews) return null;
  const events = n.timelineItems?.nodes ?? [];
  // Events come oldest first; the last ready event is when the PR was last marked ready.
  const ready = events.filter(e => e?.__typename === 'ReadyForReviewEvent' && e.createdAt).pop()?.createdAt;
  const reviewRequests = events.filter(e => e?.__typename === 'ReviewRequestedEvent' && e.createdAt && e.requestedReviewer).map(e => {
    const r = e.requestedReviewer!;
    return { who: r.__typename === 'Team' ? `team:${lower(r.slug ?? '')}` : lower(r.login ?? ''), at: e.createdAt! };
  }).filter(r => r.who && r.who !== 'team:');
  const people = (n.comments?.nodes ?? []).filter(c => classifyAuthor(c.author?.login ?? '', c.author?.__typename ?? '', lists) === 'human').length;
  return {
    readyAt: new Date(ready ?? n.createdAt),
    reviewRequests,
    comments: n.comments?.totalCount ?? 0,
    humanComments: people,
    reviewCount: n.reviews.totalCount ?? n.reviews.nodes.length,
    reviewsReadAt: now,
  };
}

// ---- Metrics ----

export interface RPr {
  id: string; repo: string; author: string; credited: string | null;
  readyAt: Date | null; createdAt: Date; mergedAt: Date | null;
  comments: number; humanComments: number;
  /** All its reviews are stored: read, and no more than REVIEW_PAGE of them. */
  reviewsRead: boolean;
  /** Review requests: a login, or 'team:<slug>'. */
  requests: Array<{ who: string; at: Date }>;
}
export interface RReview { prId: string; login: string; cls: string; state: string; submittedAt: Date; comments: number }

const isSelf = (pr: RPr, login: string) => login === pr.author || (!!pr.credited && login === pr.credited);
const byPerson = (pr: RPr | undefined, r: RReview) => !!pr && r.cls === 'human' && !!r.login && !isSelf(pr, r.login);
const isAgentApproval = (r: RReview) => r.state === 'APPROVED' && r.cls !== 'human' && APPROVAL_AGENT_LOGINS.includes(base(r.login));
const inWin = (d: Date | null, since: Date, until: Date) => !!d && d >= since && d < until;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** p50/p95/max over every value, zeros included (comments per PR). */
function spread(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  return { prs: v.length, p50: round1(percentile(v, 0.5)), p95: round1(percentile(v, 0.95)), max: v.length ? v[v.length - 1] : 0 };
}

interface Pair { prId: string; login: string; approved: boolean; changes: boolean; comments: number }

/** One entry per person per PR with a review in the window. DISMISSED counts as neither approval nor changes. */
function pairsIn(prs: Map<string, RPr>, reviews: RReview[], since: Date, until: Date): Map<string, Pair> {
  const pairs = new Map<string, Pair>();
  for (const r of reviews) {
    if (!inWin(r.submittedAt, since, until) || !byPerson(prs.get(r.prId), r)) continue;
    const k = `${r.prId} ${r.login}`;
    const p = pairs.get(k) ?? { prId: r.prId, login: r.login, approved: false, changes: false, comments: 0 };
    pairs.set(k, p);
    if (r.state === 'APPROVED') p.approved = true;
    if (r.state === 'CHANGES_REQUESTED') p.changes = true;
    p.comments += r.comments;
  }
  return pairs;
}

export type ApprovalKind = 'agentOnly' | 'humanAndAgent' | 'humanOnly' | 'none';

/** How a merged PR was approved: approvals submitted by the merge only. */
function approvalKind(pr: RPr, reviews: RReview[]): ApprovalKind {
  let human = false; let agent = false;
  for (const r of reviews) {
    if (r.submittedAt > pr.mergedAt!) continue;
    if (r.state === 'APPROVED' && byPerson(pr, r)) human = true;
    else if (isAgentApproval(r)) agent = true;
  }
  return human ? (agent ? 'humanAndAgent' : 'humanOnly') : agent ? 'agentOnly' : 'none';
}

export interface ReviewWindow {
  days: number;
  reviews: number;
  /** Reviews per reviewer; `contributors` is the number of reviewers. */
  distribution: Distribution;
  approved: number; changesRequested: number; commentOnly: number;
  inlineComments: number;
  /** PRs merged in the window: comments by people per PR, and the share bots wrote. */
  mergedComments: { prs: number; p50: number; p95: number; max: number; botShare: number | null };
  agent: AgentSplit;
}

export interface AgentSplit {
  /** Repos in the group where the agent has approved at least once. */
  repos: number;
  merged: number;
  agentOnly: number; humanAndAgent: number; humanOnly: number; none: number;
  /** Merged PRs in those repos whose reviews were never read, or were more than REVIEW_PAGE (left out above). */
  unread: number;
}

function index(prs: RPr[], reviews: RReview[]) {
  const byId = new Map(prs.map(p => [p.id, p]));
  const byPr = new Map<string, RReview[]>();
  for (const r of reviews) byPr.set(r.prId, [...(byPr.get(r.prId) ?? []), r]);
  return { byId, byPr };
}

function agentSplit(prs: RPr[], byPr: Map<string, RReview[]>, since: Date, until: Date, agentRepos: Set<string>): AgentSplit {
  const out: AgentSplit = { repos: agentRepos.size, merged: 0, agentOnly: 0, humanAndAgent: 0, humanOnly: 0, none: 0, unread: 0 };
  for (const pr of prs) {
    if (!inWin(pr.mergedAt, since, until) || !agentRepos.has(pr.repo)) continue;
    if (!pr.reviewsRead) { out.unread++; continue; }
    out.merged++;
    out[approvalKind(pr, byPr.get(pr.id) ?? [])]++;
  }
  return out;
}

export function reviewWindow(prs: RPr[], reviews: RReview[], since: Date, until: Date, agentRepos: Set<string>): ReviewWindow {
  const { byId, byPr } = index(prs, reviews);
  const pairs = [...pairsIn(byId, reviews, since, until).values()];
  const perPerson = new Map<string, number>();
  for (const p of pairs) perPerson.set(p.login, (perPerson.get(p.login) ?? 0) + 1);

  const human: number[] = []; let bot = 0; let people = 0;
  for (const pr of prs) {
    if (!inWin(pr.mergedAt, since, until) || !pr.reviewsRead) continue;
    // Only the last COMMENT_PAGE comments were classed, so the bot count is over those.
    let h = pr.humanComments; let b = Math.max(0, Math.min(pr.comments, COMMENT_PAGE) - pr.humanComments);
    for (const r of byPr.get(pr.id) ?? []) { if (r.cls === 'human') h += r.comments; else b += r.comments; }
    human.push(h); people += h; bot += b;
  }
  return {
    days: Math.round((until.getTime() - since.getTime()) / 86_400_000),
    reviews: pairs.length,
    distribution: distribution([...perPerson.values()]),
    approved: pairs.filter(p => p.approved).length,
    changesRequested: pairs.filter(p => p.changes).length,
    commentOnly: pairs.filter(p => !p.approved && !p.changes).length,
    inlineComments: pairs.reduce((s, p) => s + p.comments, 0),
    mergedComments: { ...spread(human), botShare: people + bot ? bot / (people + bot) : null },
    agent: agentSplit(prs, byPr, since, until, agentRepos),
  };
}

export interface Reviewer {
  login: string;
  reviews: number; approved: number; changesRequested: number; commentOnly: number; inlineComments: number;
  /** PRs merged in the window where theirs was the last human approval before the merge. */
  decidingApprovals: number;
  /**
   * Median hours from the latest request naming them to their first review
   * after it, over their reviews in the window. A team request isn't asking
   * them, and a review nobody asked for is volunteered: neither is timed.
   */
  medianHoursToFirstReview: number | null;
  /** Reviews they were asked for by name (the ones timed above). */
  askedReviews: number;
  /** PRs they were the first person to review, after the PR had waited STALE_DAYS since ready. */
  stalePickups: number;
  authorsHelped: number;
}

/**
 * When they were asked by name and when they answered, or null: their first
 * review after the first request naming them, timed from the latest request
 * before that review (a re-request restarts the clock). A review before any
 * request (on the draft, volunteered) doesn't stop a later ask being timed.
 */
function askedAt(pr: RPr, login: string, mine: number[]): { asked: number; answered: number } | null {
  const named = pr.requests.filter(q => q.who === login).map(q => q.at.getTime());
  if (!named.length) return null;
  const answered = mine.filter(t => t >= Math.min(...named)).sort((a, b) => a - b)[0];
  if (answered == null) return null;
  return { asked: Math.max(...named.filter(t => t <= answered)), answered };
}

export function topReviewers(prs: RPr[], reviews: RReview[], since: Date, until: Date): Reviewer[] {
  const { byId, byPr } = index(prs, reviews);
  const out = new Map<string, Reviewer & { hours: number[]; authors: Set<string> }>();
  const get = (login: string) => {
    let r = out.get(login);
    if (!r) { r = { login, reviews: 0, approved: 0, changesRequested: 0, commentOnly: 0, inlineComments: 0, decidingApprovals: 0, medianHoursToFirstReview: null, askedReviews: 0, stalePickups: 0, authorsHelped: 0, hours: [], authors: new Set() }; out.set(login, r); }
    return r;
  };
  for (const p of pairsIn(byId, reviews, since, until).values()) {
    const pr = byId.get(p.prId)!;
    const r = get(p.login);
    r.reviews++; r.inlineComments += p.comments;
    if (p.approved) r.approved++;
    if (p.changes) r.changesRequested++;
    if (!p.approved && !p.changes) r.commentOnly++;
    r.authors.add(pr.credited ?? pr.author);
    const people = (byPr.get(p.prId) ?? []).filter(x => byPerson(pr, x));
    const mine = people.filter(x => x.login === p.login).map(x => x.submittedAt.getTime());
    const first = Math.min(...mine);
    const asked = askedAt(pr, p.login, mine);
    if (asked) { r.askedReviews++; r.hours.push((asked.answered - asked.asked) / 3_600_000); }
    const firstAny = Math.min(...people.map(x => x.submittedAt.getTime()));
    if (first === firstAny && first - (pr.readyAt ?? pr.createdAt).getTime() >= STALE_DAYS * 86_400_000) r.stalePickups++;
  }
  for (const pr of prs) {
    if (!inWin(pr.mergedAt, since, until) || !pr.reviewsRead) continue;
    const last = (byPr.get(pr.id) ?? [])
      .filter(r => r.state === 'APPROVED' && r.submittedAt <= pr.mergedAt! && byPerson(pr, r))
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())[0];
    if (last) get(last.login).decidingApprovals++;
  }
  return [...out.values()].map(({ hours, authors, ...r }) => ({
    ...r,
    authorsHelped: authors.size,
    medianHoursToFirstReview: hours.length ? round1(percentile([...hours].sort((a, b) => a - b), 0.5)) : null,
  })).sort((a, b) => b.reviews - a.reviews || b.decidingApprovals - a.decidingApprovals || a.login.localeCompare(b.login));
}

export interface ReviewWeek { week: string; reviews: number; reviewers: number; agentOnly: number; humanApproved: number; unapproved: number }

/** Monday-UTC weeks from `start` (a Monday) to `now`, the last one partial. */
export function reviewTrend(prs: RPr[], reviews: RReview[], start: Date, now: Date, agentRepos: Set<string>): ReviewWeek[] {
  const weeks: ReviewWeek[] = [];
  for (let w = start.getTime(); w <= now.getTime(); w += 7 * 86_400_000) {
    const until = new Date(Math.min(w + 7 * 86_400_000, now.getTime() + 1));
    const r = reviewWindow(prs, reviews, new Date(w), until, agentRepos);
    weeks.push({
      week: new Date(w).toISOString().slice(0, 10), reviews: r.reviews, reviewers: r.distribution.contributors,
      agentOnly: r.agent.agentOnly, humanApproved: r.agent.humanOnly + r.agent.humanAndAgent, unapproved: r.agent.none,
    });
  }
  return weeks;
}
