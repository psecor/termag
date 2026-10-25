// Review groups in the PR overlay:
// pure helpers for the card, the rows it takes out of the lists, the pills on
// rows elsewhere, and the PR a user types to add one.

import type { PrGroupMember, PrGroupMemberInput, PrGroupSuggestion, PrPipelineResponse, PrReviewGroup, PrRow, PrWorkstreamLink } from '../services/api';
import { LANE_SHORT, isReviewLane, rowDetail } from './prPipeline';
import { GITHUB_PR_URL } from './review';

/** The views that carry the cards: a grouped row shows only in its card there. */
export const CARD_VIEWS = ['needs_you', 'needs_my_review'] as const;
export const isCardView = (view: string): boolean => (CARD_VIEWS as readonly string[]).includes(view);

/** Where a PR typed without an owner is looked for, after the repositories the lanes know. */
export const DEFAULT_OWNER = 'example-org';

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
/** A row's group key: its repository lowercased, as the backend stores members. */
export const groupKey = (r: Pick<PrRow, 'kind' | 'repo' | 'number'>): string | null =>
  r.kind === 'pr' && r.repo && r.number != null ? keyOf(r.repo, r.number) : null;

export function groupsOf(res: PrPipelineResponse | null | undefined): PrReviewGroup[] {
  return res && res.connected ? res.groups ?? [] : [];
}
export const openGroups = (res: PrPipelineResponse | null | undefined) => groupsOf(res).filter(g => !g.closedAt);
export const closedGroups = (res: PrPipelineResponse | null | undefined) => groupsOf(res).filter(g => g.closedAt);

/** Each open group's members by key: the group and the member's place in it (1-based), for pills and the list filter. */
export function groupPlaces(res: PrPipelineResponse | null | undefined): Map<string, { group: PrReviewGroup; index: number }> {
  const out = new Map<string, { group: PrReviewGroup; index: number }>();
  for (const group of openGroups(res)) {
    group.members.forEach((m, i) => out.set(keyOf(m.repo, m.number), { group, index: i + 1 }));
  }
  return out;
}

/** The pill on a grouped row outside the card views: "Desktop bridge 2/5". */
export function groupPill(place: { group: PrReviewGroup; index: number } | undefined): string | null {
  return place ? `${place.group.name} ${place.index}/${place.group.members.length}` : null;
}

/** Rows of every member, for selecting one: a member no lane lists has a row built for the card. */
export function memberRows(res: PrPipelineResponse | null | undefined): PrRow[] {
  return groupsOf(res).flatMap(g => g.members.map(m => m.row).filter((r): r is PrRow => r !== null));
}

const isYours = (m: Pick<PrGroupMember, 'author'>, viewer: string | null) =>
  !!viewer && !!m.author && m.author.toLowerCase() === viewer.toLowerCase();

/**
 * The members left to review: not
 * checked off, and not your own PR, which waits on other people and is
 * checked off only once merged or closed. One not asked of you counts: you
 * added it to review it.
 */
export function toReview(group: PrReviewGroup, viewer: string | null): PrGroupMember[] {
  return group.members.filter(m => !m.checked && !isYours(m, viewer));
}

/** The first member left to review: the one Review next opens, never your own PR. */
export function nextMember(group: PrReviewGroup, viewer: string | null): PrGroupMember | null {
  return toReview(group, viewer)[0] ?? null;
}

/** "4 of 5 to review"; "done" once every member is checked off; "nothing left to review" while only yours wait. */
export function groupProgress(group: PrReviewGroup, viewer: string | null): string {
  if (group.members.length === 0) return 'no pull requests yet';
  if (group.done) return 'done';
  const left = toReview(group, viewer).length;
  return left === 0 ? 'nothing left to review' : `${left} of ${group.members.length} to review`;
}

/**
 * What Review all with Devin starts:
 * one Devin session over the members left to review, in order, in one pane
 * (a workstream has one, and the members usually share it). The pane is the
 * first such member's review target, else the first any member of the group
 * has: the prompt passes each PR's own --repo, so any checkout can hold the
 * review.
 * None left, or no member with somewhere to review from: why not.
 */
export function groupReviewPlan(group: PrReviewGroup, viewer: string | null):
  { members: PrGroupMember[]; target: PrWorkstreamLink } | { reason: string } {
  const members = toReview(group, viewer);
  if (members.length === 0) return { reason: 'Nothing left to review in this group' };
  // A pane of a member left to review first, else any member's (one checked off, or yours): the
  // prompt passes each PR's --repo, so any checkout holds the review (Bugbot, #668).
  // `pane` covers every member (a merged one's or your own row has no reviewTarget: Devin, #668).
  const paneOf = (m: PrGroupMember) => m.pane ?? m.row?.reviewTarget ?? null;
  const target = [...members, ...group.members].map(paneOf).find((t): t is PrWorkstreamLink => t !== null);
  if (!target) return { reason: 'No checkout to review from: make a project for one of these repositories' };
  return { members, target };
}

/** The group as POST /projects/:id/review takes it, for the plan's members. */
export function groupReviewBody(group: PrReviewGroup, members: PrGroupMember[]): { name: string; members: PrGroupMemberInput[] } {
  return { name: group.name, members: memberInputs(members) };
}

/** "5 PRs · 2 repos". */
export function groupSize(group: PrReviewGroup): string {
  const repos = new Set(group.members.map(m => m.repo.toLowerCase())).size;
  const n = group.members.length;
  return `${n} PR${n === 1 ? '' : 's'} · ${repos} repo${repos === 1 ? '' : 's'}`;
}

const YOUR_REVIEW: Record<string, string> = {
  APPROVED: 'approved by you',
  CHANGES_REQUESTED: 'you asked for changes',
  COMMENTED: 'you reviewed it',
};

/** A member's status line in the card. */
export function memberStatus(m: PrGroupMember, viewer: string | null, now: number): string {
  switch (m.state) {
    case 'unknown': return 'could not read it from GitHub';
    case 'missing': return 'not on GitHub (or not visible to you)';
    case 'merged': return 'merged';
    case 'closed': return 'closed without merging';
  }
  // Open: checked off by your review (the backend's rule), else why it waits.
  if (m.checked) return YOUR_REVIEW[m.yourReview ?? ''] ?? 'you reviewed it';
  if (m.askedYou) return m.yourReview ? 'asks for your review again' : 'needs your review';
  if (isYours(m, viewer) && m.row && !isReviewLane(m.row.lane)) return `yours · ${LANE_SHORT[m.row.lane]}: ${rowDetail(m.row, now)}`;
  return `by ${m.author ?? 'someone'} · not asked of you`;
}

/** The members as the group routes take them, in this order. */
export function memberInputs(members: Pick<PrGroupMember, 'repo' | 'number' | 'note'>[]): PrGroupMemberInput[] {
  return members.map(m => ({ repo: m.repo, number: m.number, note: m.note }));
}

/**
 * A PR typed into Add a PR: a pasted URL, `owner/name#N`, or `name#N` the
 * way rows are labelled (the owner from a repository the lanes know by that
 * name, else DEFAULT_OWNER). Null when it is none of those.
 */
export function parseGroupPr(raw: string, knownRepos: string[] = []): { repo: string; number: number } | null {
  const s = raw.trim();
  const url = GITHUB_PR_URL.exec(s);
  if (url) {
    const [, , , owner, name] = s.split('/');
    return { repo: `${owner}/${name}`, number: Number(url[1]) };
  }
  const full = /^([\w.-]+)\/([\w.-]+)#(\d{1,9})$/.exec(s);
  if (full) return { repo: `${full[1]}/${full[2]}`, number: Number(full[3]) };
  const short = /^([\w.-]+)#(\d{1,9})$/.exec(s);
  if (short) {
    const known = knownRepos.find(r => r.split('/')[1]?.toLowerCase() === short[1].toLowerCase());
    return { repo: known ?? `${DEFAULT_OWNER}/${short[1]}`, number: Number(short[2]) };
  }
  return null;
}

/** The label a member shows, as rows are labelled: "termag#646". */
export function memberLabel(m: Pick<PrGroupMember, 'repo' | 'number'>): string {
  return `${m.repo.split('/')[1] ?? m.repo}#${m.number}`;
}

// ── Suggested groups (phase 3) ───────────────────────────────────────────────

export function suggestionsOf(res: PrPipelineResponse | null | undefined): PrGroupSuggestion[] {
  return res && res.connected ? res.suggestions ?? [] : [];
}

const WHY: Record<PrGroupSuggestion['reason'], string> = {
  stack: 'one is based on another\'s branch',
  references: 'their descriptions name each other',
  both: 'stacked, and their descriptions name each other',
};
/** "3 PRs · their descriptions name each other". */
export function suggestionWhy(s: PrGroupSuggestion): string {
  return `${s.members.length} PR${s.members.length === 1 ? '' : 's'} · ${WHY[s.reason]}`;
}

/**
 * Accepting a suggestion: a new group of its members, or with a target, the
 * target's members with these after them (the group routes take the whole list).
 */
export function acceptSuggestion(s: PrGroupSuggestion, groups: PrReviewGroup[]):
  { create: { name: string; members: PrGroupMemberInput[] } } | { set: { id: string; members: PrGroupMemberInput[] } } | { gone: true } {
  const members = s.members.map(m => ({ repo: m.repo, number: m.number, note: null }));
  if (!s.target) return { create: { name: s.name, members } };
  const g = groups.find(x => x.id === s.target!.id);
  if (!g) return { gone: true };
  return { set: { id: g.id, members: [...memberInputs(g.members), ...members] } };
}

/** Moves the item at `from` to `to`, for reordering. */
export function moved<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}
