/**
 * Shared, pure helpers for the PR pipeline views (the dashboard's Pull
 * requests section and the phone's /m/prs): lane order, the one-line detail
 * each lane shows, and the "things I can act on now" count. The lanes
 * themselves are assigned server-side (backend services/prPipeline.ts).
 */
import type { PrDeployPipeline, PrLane, PrLaneId, PrMergeMethod, PrOverview, PrPipelineResponse, PrReviewEvent, PrRow } from '../services/api';
import { fmtAge } from './format';

/** The phone opens on the first non-empty lane in this order: what can be done from a phone first. */
export const PHONE_LANE_ORDER: PrLaneId[] = [
  'needs_my_review', 'ready_to_merge', 'checks', 'needs_approval', 'team_review',
  'merged_not_deployed', 'in_progress', 'needs_pr', 'deployed', 'merged',
];

/** The two lanes of review requests: asked of you by name, and asked only of a team you are on. */
export const REVIEW_LANES: PrLaneId[] = ['needs_my_review', 'team_review'];
export const isReviewLane = (lane: PrLaneId): boolean => REVIEW_LANES.includes(lane);

/** Short labels for tabs and the lane strip. */
export const LANE_SHORT: Record<PrLaneId, string> = {
  in_progress: 'In progress',
  needs_pr: 'Needs PR',
  checks: 'Checks',
  needs_approval: 'Approval',
  needs_my_review: 'My review',
  team_review: 'Team reviews',
  ready_to_merge: 'Ready',
  merged_not_deployed: 'Not deployed',
  deployed: 'Deployed',
  merged: 'Other merges',
};

/** A tab's tooltip, where its name alone could mislead. */
export const LANE_HINT: Partial<Record<PrLaneId, string>> = {
  needs_my_review: 'Review requests that name you. These are what the PRs count counts.',
  team_review: 'Review requests that reach you only through a team you are on. Not in Needs you or its count.',
  merged: 'Merges termag does not deploy: other repositories, and termag merges into a branch other than main. Not a total: termag merges into main are under Not deployed and Deployed.',
};

/** Lanes built from the merged-PR search, which only reaches back a fixed window. */
const WINDOWED: PrLaneId[] = ['deployed', 'merged'];

/**
 * A lane's tab label. Deployed and Other merges only hold the last N days of
 * merges, so they say so ("Deployed 14d"); without the window (an older
 * backend) the plain label stands.
 */
export function laneTabLabel(id: PrLaneId, res: PrPipelineResponse | null | undefined): string {
  const days = res && res.connected ? res.mergedWindowDays : undefined;
  return days && WINDOWED.includes(id) ? `${LANE_SHORT[id]} ${days}d` : LANE_SHORT[id];
}

/** Lanes 5 and 6: lanes whose every row is the user's to act on (the phone's highlighted tabs). */
export const ACTIONABLE: PrLaneId[] = ['needs_my_review', 'ready_to_merge'];

/**
 * Why a row needs the user, or null: anything they can act on now. A review
 * asked of them, their PR ready to merge, their PR with red checks (not a
 * draft), a merge conflict, changes requested, or a pushed branch with no PR.
 * Waiting on others (approval, running checks) and a deploy that runs by
 * itself do not count. This is what the status-strip tile, the phone inbox
 * and the PR overlay's "Needs you" lane all count.
 */
/** Red checks: named ones, or a red rollup whose names GitHub did not list. */
export function checksRed(r: Pick<PrRow, 'failingChecks' | 'checksFailed'>): boolean {
  return r.failingChecks.length > 0 || r.checksFailed === true;
}

export function needsYou(r: PrRow): string | null {
  if (r.lane === 'needs_my_review') return 'review asked of you';
  if (r.lane === 'ready_to_merge') return r.badges.includes('conflict') ? 'merge conflict' : 'ready to merge';
  if (r.lane === 'needs_pr') return 'pushed, no pull request';
  const own = r.lane === 'checks' || r.lane === 'needs_approval';
  if (!own) return null;
  if (r.badges.includes('conflict')) return 'merge conflict';
  if (r.badges.includes('changes-requested')) return 'changes requested';
  if (r.lane === 'checks' && checksRed(r) && !r.badges.includes('draft')) return 'checks failing';
  return null;
}

// The order "Needs you" lists rows in: what unblocks someone else first.
const NEEDS_YOU_ORDER: PrLaneId[] = ['needs_my_review', 'ready_to_merge', 'checks', 'needs_approval', 'needs_pr'];

function allNeedsYouRows(res: PrPipelineResponse | null | undefined): { row: PrRow; why: string }[] {
  const out: { row: PrRow; why: string }[] = [];
  for (const id of NEEDS_YOU_ORDER) {
    for (const row of lanesOf(res).find(l => l.id === id)?.rows ?? []) {
      const why = needsYou(row);
      if (why) out.push({ row, why });
    }
  }
  return out;
}

/**
 * Every row that needs the user and is not deferred, with why, most pressing
 * lane first (newest first within one).
 */
export function needsYouRows(res: PrPipelineResponse | null | undefined, now = Date.now()): { row: PrRow; why: string }[] {
  const deferred = deferrals(res, now);
  return allNeedsYouRows(res).filter(e => !deferred.has(rowParam(e.row)));
}

// ── Deferring a row ────────────────

/** The user's running deferrals, by row key (rowParam), as the epoch ms they end. */
export function deferrals(res: PrPipelineResponse | null | undefined, now: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!res?.connected) return out;
  for (const d of res.deferred ?? []) {
    const until = Date.parse(d.until);
    if (Number.isFinite(until) && until > now) out.set(d.key, until);
  }
  return out;
}

/** When a deferred row comes back, for its list line: "back in 23h". */
export function deferredText(until: number, now: number): string {
  return `deferred · back in ${fmtAge(Math.max(0, until - now))}`;
}

/** The view's rows split into shown and deferred, as `{ row, why }` (the deferred ones' why says when they return). */
export function splitDeferred(entries: { row: PrRow; why: string }[], res: PrPipelineResponse | null | undefined, now: number): {
  shown: { row: PrRow; why: string }[];
  deferred: { row: PrRow; why: string; until: number }[];
} {
  const map = deferrals(res, now);
  const shown: { row: PrRow; why: string }[] = [];
  const deferred: { row: PrRow; why: string; until: number }[] = [];
  for (const e of entries) {
    const until = map.get(rowParam(e.row));
    if (until === undefined) shown.push(e);
    else deferred.push({ ...e, until });
  }
  return { shown, deferred };
}

/** Every row of the view, deferred or not ("Needs you" or one lane). */
export function viewEntries(view: PrsView, res: PrPipelineResponse | null | undefined, now: number): { row: PrRow; why: string }[] {
  if (view === 'needs_you') return allNeedsYouRows(res);
  return (lanesOf(res).find(l => l.id === view)?.rows ?? []).map(row => ({ row, why: rowDetail(row, now) }));
}

export function lanesOf(res: PrPipelineResponse | null | undefined): PrLane[] {
  return res && res.connected ? res.lanes : [];
}

/**
 * A review asked of the user by name (2026-10-22: what the counts count). A
 * request only to a team they are on is listed in Needs you, not counted; an
 * older backend's row, without the flag, counts.
 */
export function asksForMyReview(r: PrRow): boolean {
  return r.lane === 'needs_my_review' && r.askedYou !== false;
}

/**
 * How many PRs ask the user by name for a review and are not deferred: the
 * number on the PRs tile, the phone inbox, the overlay's Needs you tab and
 * the TUI (tui/src/prs.ts prCount). Needs you still lists everything that
 * needs the user; only these are counted.
 */
export function myReviewCount(res: PrPipelineResponse | null | undefined, now = Date.now(), keep: (r: PrRow) => boolean = () => true): number {
  return needsYouRows(res, now).filter(e => asksForMyReview(e.row) && keep(e.row)).length;
}

/** The lane to open on: the first non-empty one in `order`, else the first. */
export function firstNonEmpty(lanes: PrLane[], order: PrLaneId[]): PrLaneId {
  for (const id of order) if (lanes.find(l => l.id === id)?.rows.length) return id;
  return order[0];
}

export function rowLabel(r: PrRow): string {
  if (r.kind === 'branch') return r.repo ? `${r.repo.split('/')[1]} · ${r.headRefName}` : r.headRefName;
  return `${r.repo?.split('/')[1] ?? r.repo}#${r.number}`;
}

export function rowKey(r: PrRow): string {
  return r.kind === 'branch' ? `b:${r.workstream?.projectId}:${r.workstream?.workstream}` : `${r.repo}#${r.number}`;
}

function list(names: string[], max = 3): string {
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

function ago(at: string | null, now: number): string {
  if (!at) return '';
  const t = Date.parse(at);
  return Number.isFinite(t) ? `${fmtAge(Math.max(0, now - t))} ago` : '';
}

/** The lane-specific detail line under a row's title. */
export function rowDetail(r: PrRow, now: number): string {
  switch (r.lane) {
    case 'in_progress':
      return r.badges.includes('dirty') ? 'uncommitted changes' : 'commits not pushed';
    case 'needs_pr':
      return `pushed${r.at ? `, last commit ${ago(r.at, now)}` : ''} · no pull request${r.badges.includes('dirty') ? ' · uncommitted changes' : ''}`;
    case 'checks':
      if (r.badges.includes('draft')) return 'draft';
      if (r.failingChecks.length) return `failing: ${list(r.failingChecks)}`;
      if (r.checksFailed) return 'checks failing';
      if (r.pendingChecks.length) return `running: ${list(r.pendingChecks)}`;
      return 'checks not green';
    case 'needs_approval':
      return r.waitingOn.length ? `waiting on ${list(r.waitingOn)}` : 'needs an approving review';
    case 'needs_my_review':
    case 'team_review':
      return `by ${r.author ?? 'someone'}${r.requestedAt ? ` · asked ${ago(r.requestedAt, now)}` : ''}`;
    case 'ready_to_merge':
      return r.blockedBy ?? (r.badges.includes('auto-merge') ? 'auto-merge on' : 'approved and green');
    case 'merged_not_deployed': {
      const merged = `merged ${ago(r.mergedAt, now)}`;
      const d = r.deploy;
      if (d?.state === 'unknown') return `${merged} · deploy state unknown`;
      if (d?.state === 'not_deployed' && d.baked === true) return `${merged} · baked, rolling out`;
      if (d?.state === 'not_deployed' && d.baked === false) return `${merged} · waiting for a bake`;
      return `${merged} · not on prod`;
    }
    case 'deployed': {
      const d = r.deploy;
      const unknown = (d?.state === 'deployed' || d?.state === 'orchestrator_only') && d.boxesUnknown ? ` · ${d.boxesUnknown} box${d.boxesUnknown === 1 ? '' : 'es'} unverifiable` : '';
      const behind = boxesBehindText(r);
      return `on prod · merged ${ago(r.mergedAt, now)}${behind ? ` · ${behind}` : ''}${unknown}`;
    }
    case 'merged':
      return `merged ${ago(r.mergedAt, now)}`;
  }
}

/**
 * A deployed box-side merge some of the viewer's own boxes do not run yet
 * ("2 of your 3 boxes behind"): on prod, so in Deployed, but those boxes pick
 * it up only when their agent updates. Null when nothing is behind.
 */
export function boxesBehindText(r: Pick<PrRow, 'deploy'>): string | null {
  const d = r.deploy;
  if (d?.state !== 'orchestrator_only' || d.boxesBehind <= 0) return null;
  return `${d.boxesBehind} of your ${d.boxes} box${d.boxes === 1 ? '' : 'es'} behind`;
}

// ── The overview dialog (pages/dashboard/PrOverviewDialog.tsx) ───────────────

/** The review form's choices, in the order GitHub's own form shows them. */
export const REVIEW_EVENTS: { id: PrReviewEvent; label: string; done: string }[] = [
  { id: 'COMMENT', label: 'Comment', done: 'Comment posted' },
  { id: 'APPROVE', label: 'Approve', done: 'Approved' },
  { id: 'REQUEST_CHANGES', label: 'Request changes', done: 'Changes requested' },
];

/** GitHub takes an approval without text, a comment or change request only with some. */
export function canSubmitReview(event: PrReviewEvent, body: string): boolean {
  return event === 'APPROVE' || body.trim().length > 0;
}

/** A review state as a verb phrase: "bob approved". */
export function reviewStateLabel(state: string): string {
  switch (state) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'requested changes';
    case 'COMMENTED': return 'commented';
    case 'DISMISSED': return 'was dismissed';
    case 'PENDING': return 'has a pending draft';
    default: return state.toLowerCase();
  }
}

/** One line for a PR's checks, and whether it reads as good, waiting or bad. */
export function checksSummary(checks: PrOverview['checks']): { text: string; tone: 'good' | 'wait' | 'bad' } {
  if (checks.length === 0) return { text: 'no checks', tone: 'good' };
  const failed = checks.filter(c => c.state === 'failed').map(c => c.name);
  const pending = checks.filter(c => c.state === 'pending').map(c => c.name);
  if (failed.length) return { text: `failing: ${list(failed)}`, tone: 'bad' };
  if (pending.length) return { text: `running: ${list(pending)}`, tone: 'wait' };
  return { text: `${checks.length} check${checks.length === 1 ? '' : 's'} passed`, tone: 'good' };
}

/** GitHub's names for the merge buttons. */
export const MERGE_METHOD_LABEL: Record<PrMergeMethod, string> = {
  SQUASH: 'Squash and merge',
  MERGE: 'Create a merge commit',
  REBASE: 'Rebase and merge',
};

/**
 * What the merge panel offers, from GitHub's mergeStateStatus: whether Merge
 * now is worth trying, a reason when not (or a caveat when it is), and whether
 * auto-merge can be turned on. GitHub refuses auto-merge on a PR that can merge
 * now ("clean status"), so the two are offered the other way round.
 */
export function mergeReadiness(pr: Pick<PrOverview, 'isDraft' | 'mergeable' | 'mergeStateStatus' | 'autoMerge' | 'mergeSettings'>): {
  canMergeNow: boolean;
  note: string | null;
  canEnableAuto: boolean;
} {
  const auto = (ok: boolean) => ok && pr.mergeSettings.autoMergeAllowed && !pr.autoMerge && pr.mergeSettings.methods.length > 0;
  if (pr.mergeSettings.methods.length === 0) return { canMergeNow: false, note: 'this repository allows no merge method termag knows', canEnableAuto: false };
  if (pr.isDraft) return { canMergeNow: false, note: 'draft: mark it ready for review on GitHub first', canEnableAuto: false };
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return { canMergeNow: false, note: 'merge conflict: resolve it first', canEnableAuto: false };
  switch (pr.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { canMergeNow: true, note: null, canEnableAuto: false };
    case 'UNSTABLE':
      return { canMergeNow: true, note: 'some non-required checks are failing', canEnableAuto: false };
    case 'BLOCKED':
      return { canMergeNow: false, note: 'blocked: it still needs an approval or required checks', canEnableAuto: auto(true) };
    case 'BEHIND':
      return { canMergeNow: false, note: 'the branch is behind its base: update it first', canEnableAuto: auto(true) };
    default:
      return { canMergeNow: true, note: 'GitHub has not worked out whether it can merge yet', canEnableAuto: auto(true) };
  }
}

export interface RosterEntry {
  name: string;
  kind: 'user' | 'team';
  /** The reviewer's latest review state, or REQUESTED while asked and not yet answered. */
  state: string;
  /** Asked and not answered: re-requesting does nothing on GitHub, only a comment nudges. */
  pending: boolean;
  /** Preselected for Re-request: answered, but not with an approval. */
  pick: boolean;
}

/** Everyone involved in reviewing the viewer's PR: who answered (and how), and who is still asked. */
export function reviewerRoster(pr: Pick<PrOverview, 'reviews' | 'requestedUsers' | 'requestedTeams' | 'author'>): RosterEntry[] {
  const out: RosterEntry[] = [];
  const pendingUsers = new Set(pr.requestedUsers.map(u => u.toLowerCase()));
  for (const r of pr.reviews) {
    if (!r.author || r.author.toLowerCase() === pr.author?.toLowerCase() || pendingUsers.has(r.author.toLowerCase())) continue;
    if (out.some(e => e.name.toLowerCase() === r.author!.toLowerCase())) continue;
    out.push({ name: r.author, kind: 'user', state: r.state, pending: false, pick: r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED' });
  }
  for (const u of pr.requestedUsers) out.push({ name: u, kind: 'user', state: 'REQUESTED', pending: true, pick: false });
  for (const t of pr.requestedTeams) out.push({ name: t, kind: 'team', state: 'REQUESTED', pending: true, pick: false });
  return out;
}

/** The @-mention of a roster entry: a team is mentioned as org/slug. */
export function mention(e: Pick<RosterEntry, 'name' | 'kind'>, repo: string): string {
  return e.kind === 'team' ? `@${repo.split('/')[0]}/${e.name}` : `@${e.name}`;
}

/** The ping comment's starting text: the reviewers still asked, else the picked ones. */
export function pingText(roster: RosterEntry[], picked: Set<string>, repo: string): string {
  const pending = roster.filter(e => e.pending);
  const who = (pending.length ? pending : roster.filter(e => picked.has(e.name))).map(e => mention(e, repo));
  if (who.length === 0) return '';
  return `${who.join(' ')} friendly ping: this is ready for a review when you have a moment. Thanks!`;
}

/** A git ref as a URL path: each segment encoded, the slashes between them kept (GitHub's own links do this). */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/**
 * GitHub's "Open a pull request" form for a pushed branch with no PR: the
 * compare view with the form expanded. Null for anything but a Needs a PR
 * branch row with a known repository.
 */
export function compareUrl(r: Pick<PrRow, 'kind' | 'lane' | 'repo' | 'headRefName' | 'baseRefName'>): string | null {
  if (r.kind !== 'branch' || r.lane !== 'needs_pr' || !r.repo || !/^[\w.-]+\/[\w.-]+$/.test(r.repo) || !r.headRefName || !r.baseRefName) return null;
  return `https://github.com/${r.repo}/compare/${refPath(r.baseRefName)}...${refPath(r.headRefName)}?expand=1`;
}

/**
 * The Not deployed lane's one line about getting there, and whether "Bake &
 * deploy now" is worth offering: only when a merge is not on the orchestrator
 * and not known to be in the newest image, and no bake is already running (a
 * second one would bake the same main). A merge on the orchestrator is in
 * Deployed, with its boxes behind as a note (boxesBehindText).
 */
export function deployStage(rows: PrRow[], d: PrDeployPipeline | undefined, now: number): { text: string; offerBake: boolean; runUrl: string | null } {
  const waiting = rows.filter(r => r.lane === 'merged_not_deployed');
  const notOnProd = waiting.filter(r => r.deploy?.state === 'not_deployed');
  const unbaked = notOnProd.filter(r => r.deploy?.state === 'not_deployed' && r.deploy.baked === false).length;
  const bakeUnknown = notOnProd.filter(r => r.deploy?.state === 'not_deployed' && r.deploy.baked == null).length;
  const run = d?.bakes?.[0] ?? null;
  if (run) {
    const started = run.createdAt ? ` ${ago(run.createdAt, now)}` : '';
    return { text: `A bake of main is ${run.status === 'in_progress' ? 'running' : 'queued'} (started${started || ' just now'}); it deploys itself when it finishes.`, offerBake: false, runUrl: run.url };
  }
  if (unbaked > 0) {
    return { text: `${unbaked === waiting.length ? 'Not' : `${unbaked} of ${waiting.length} not`} in a baked image yet. main is baked every 3 h when it changed, and each bake deploys itself.`, offerBake: true, runUrl: null };
  }
  const automatic = 'Deploys are automatic: main is baked every 3 h when it changed, and each bake deploys itself.';
  if (bakeUnknown > 0) return { text: automatic, offerBake: true, runUrl: null };
  const parts: string[] = [];
  if (notOnProd.length > 0) {
    const baked = d?.image?.createdAt ? ` (baked ${ago(d.image.createdAt, now)})` : '';
    parts.push(`In the newest orchestrator image${baked}: rolling out, or its deploy was skipped while another ran.`);
  }
  return { text: parts.length ? parts.join(' ') : automatic, offerBake: false, runUrl: null };
}

/** How long a dispatched bake waits to show up in the run list before the button comes back. */
export const BAKE_PENDING_MS = 3 * 60_000;

/**
 * Whether a bake this screen started is still on its way to the run list: not
 * yet listed, and started recently. Once its run is listed (or the window has
 * passed) the caller forgets it, so a later "Bake & deploy now" is offered again.
 */
export function bakePending(startedAt: number | null, runListed: boolean, now: number): boolean {
  return startedAt !== null && !runListed && now - startedAt < BAKE_PENDING_MS;
}

/**
 * What a PR row's overview button is for, named by lane: the dialog is the same
 * everywhere (dashboard row button, phone action sheet). `primary` rows are the
 * ones where the dialog holds the next step.
 */
export function rowAction(r: Pick<PrRow, 'lane' | 'failingChecks' | 'checksFailed'>): { label: string; title: string; primary: boolean } {
  if (isReviewLane(r.lane)) return { label: 'Review', title: 'Read it and review it here', primary: true };
  if (r.lane === 'ready_to_merge') return { label: 'Merge', title: 'Merge it, or turn auto-merge on, here', primary: true };
  if (r.lane === 'checks' && checksRed(r)) return { label: 'Re-run', title: 'See what failed and re-run the failed jobs', primary: true };
  if (r.lane === 'needs_approval') return { label: 'Ping', title: 'Re-request reviews, or ping reviewers in a comment', primary: true };
  return { label: 'Overview', title: 'Description, files and reviews', primary: false };
}

// ── The PR overlay's URL (components/PrsOverlay.tsx) ─────────────────────────

/** `?prs=<view>` opens the overlay on a view: "needs_you" or a lane id. */
export type PrsView = 'needs_you' | PrLaneId;
export const PRS_PARAM = 'prs';
/** `&pr=<owner/name#n>`, or `<owner/name:branch>` for a branch row, selects one row. */
export const PR_PARAM = 'pr';
/** `&prs_repo=<owner/name>` keeps the overlay to one repository; without it every repository shows. */
export const PRS_REPO_PARAM = 'prs_repo';

/** Whether a row passes the repo filter (null: no filter). */
export function inRepo(r: Pick<PrRow, 'repo'>, repo: string | null): boolean {
  return repo === null || r.repo === repo;
}

/**
 * The search string with the overlay's repo filter set (null clears it). The
 * selected row is dropped too, so the pane moves to the filtered view's first.
 */
export function prsRepoSearch(current: string, repo: string | null): string {
  const q = new URLSearchParams(current);
  q.delete(PR_PARAM);
  if (repo) q.set(PRS_REPO_PARAM, repo); else q.delete(PRS_REPO_PARAM);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function isPrsView(v: string | null): v is PrsView {
  return v === 'needs_you' || (v !== null && PHONE_LANE_ORDER.includes(v as PrLaneId));
}

/** A row's key in the overlay's URL. */
/**
 * Whether a row has a PR overview (PrOverviewDialog) to open: a pull request
 * with its repository and number. A pushed branch with no PR has none. One
 * rule for /m/prs's rows and the conversation header's pills, so the two agree.
 */
export function hasOverview(r: Pick<PrRow, 'kind' | 'repo' | 'number'>): boolean {
  return r.kind === 'pr' && !!r.repo && r.number != null;
}

export function rowParam(r: Pick<PrRow, 'kind' | 'repo' | 'number' | 'headRefName'>): string {
  return r.kind === 'pr' ? `${r.repo}#${r.number}` : `${r.repo ?? ''}:${r.headRefName}`;
}

/**
 * The search string that opens (or moves) the overlay, keeping the page's own
 * parameters (the workspace's project and workstream) and the repo filter:
 * pass the current search, get the next one. `view: null` closes it.
 */
export function prsSearch(current: string, view: PrsView | null, pr?: string | null): string {
  const q = new URLSearchParams(current);
  if (view === null) { q.delete(PRS_PARAM); q.delete(PR_PARAM); q.delete(PRS_REPO_PARAM); }
  else {
    q.set(PRS_PARAM, view);
    if (pr) q.set(PR_PARAM, pr); else q.delete(PR_PARAM);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Fired on window after the overlay changes a PR on GitHub, so the status-strip tile re-reads at once. */
export const PRS_CHANGED_EVENT = 'termag:prs-changed';

/** The backend's `{ error }` for a failed request, else the fallback (an offline browser, a proxy page). */
export function apiErrorText(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : fallback;
}

/**
 * The sidebar's PRs tile (components/StatusStrip.tsx). Shown when GitHub is
 * connected, and also when the list has never loaded: then a "!" and the
 * reason, because hiding it looked exactly like "not connected". After one
 * good answer a failed refresh keeps the last counts (usePolled keeps data).
 */
/**
 * Older than this, a PR answer is out of date. The backend reads GitHub at
 * most a minute apart and serves its last read for up to 10 minutes while a
 * new one fails, and the browser keeps showing the last answer it got, so a
 * count can otherwise sit unchanged and confident long after GitHub moved on
 * (a PR merged meanwhile, 2026-10-23).
 */
export const PRS_STALE_MS = 5 * 60_000;

/**
 * Why an answer that did load may be out of date, for a tile's or a link's
 * tooltip: GitHub was last read more than PRS_STALE_MS ago, or the latest
 * refresh failed. null when it is current.
 */
export function prsStale(data: { connected?: boolean; fetchedAt?: string } | null | undefined, error: unknown, now = Date.now()): string | null {
  if (!data?.connected) return null;
  const read = data.fetchedAt ? Date.parse(data.fetchedAt) : NaN;
  const age = Number.isFinite(read) ? Math.max(0, now - read) : null;
  const old = age !== null && age > PRS_STALE_MS;
  if (!old && error == null) return null;
  const when = age === null ? 'Last read from GitHub a while ago' : `Last read from GitHub ${fmtAge(age)} ago`;
  const why = error != null ? `: refreshing failed (${apiErrorText(error, 'GitHub did not answer.')})` : '';
  return `${when}${why}. This may be out of date.`;
}

export function prsTileView(
  data: { connected?: boolean; fetchedAt?: string } | null | undefined, error: unknown, count: number, now = Date.now(),
): { show: false } | { show: true; failed: boolean; stale: boolean; text: string; zero: boolean; title: string } {
  const failed = data == null && error != null;
  if (!failed && !data?.connected) return { show: false };
  if (failed) return { show: true, failed, stale: false, text: '!', zero: false, title: `Could not list your pull requests: ${apiErrorText(error, 'GitHub did not answer.')}` };
  const title = 'Pull requests asking you by name for a review. Needs you also lists team review requests and your own PRs to merge or fix.';
  const stale = prsStale(data, error, now);
  // Out of date: the number stays, marked with "?" and dimmed, the tooltip saying why.
  if (stale) return { show: true, failed, stale: true, text: `${count}?`, zero: count === 0, title: `${stale} ${title}` };
  return { show: true, failed, stale: false, text: String(count), zero: count === 0, title };
}

// ── Finding a PR (⌘K's Pull requests, components/SearchPalette.tsx) ─────────

/**
 * Every row in every lane matching `query`, best first: a number (`28280`,
 * `#28280`) finds PRs whose number starts with it; `name#N` (`terraform#28280`,
 * `example-org/terraform#28280`, the way rows are labelled) and a pasted
 * pull-request URL also need the repository: its name, or with an owner its
 * full name, starts with `name`. Other words must all appear somewhere in the
 * row (repo, number, title, branch, author, lane, workstream). Exact number
 * hits first, then lane order (what can be acted on first), then newest. Deferred rows are included: a search should find
 * what was put off. `repo` (the overlay's filter) applies before the limit,
 * so a filtered search is not cut short by matches elsewhere.
 */
export function searchPrRows(res: PrPipelineResponse | null | undefined, query: string, limit = 8, repo: string | null = null): PrRow[] {
  const url = query.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i);
  const q = (url ? `${url[1]}#${url[2]}` : query).trim().toLowerCase();
  if (!q) return [];
  // `name#N` splits into a repository to match and a number; a lone `#` says
  // nothing (every PR's haystack holds one).
  const words: string[] = [];
  const repos: string[] = [];
  for (const w of q.split(/\s+/)) {
    const named = w.match(/^([^#\s]+)#(\d*)$/);
    if (named) { repos.push(named[1]); if (named[2]) words.push(named[2]); }
    else if (w && w !== '#') words.push(w);
  }
  if (words.length === 0 && repos.length === 0) return [];
  const inNamedRepo = (r: PrRow) => {
    const full = (r.repo ?? '').toLowerCase();
    const name = full.split('/')[1] ?? full;
    return repos.every(p => (p.includes('/') ? full : name).startsWith(p));
  };
  const nums = words.filter(w => /^#?\d+$/.test(w)).map(w => w.replace('#', ''));
  const seen = new Set<string>();
  const hits: { row: PrRow; exact: boolean; lane: number; at: number }[] = [];
  for (const l of lanesOf(res)) for (const r of l.rows) {
    const key = rowParam(r);
    if (seen.has(key) || !inRepo(r, repo) || !inNamedRepo(r)) continue;
    const n = r.number != null ? String(r.number) : null;
    const exact = n !== null && nums.includes(n);
    const hay = [r.repo, n !== null ? `#${n}` : '', r.title, r.headRefName, r.author, LANE_SHORT[r.lane], l.label, r.workstream?.projectName, r.workstream?.workstream]
      .filter(Boolean).join(' ').toLowerCase();
    // A number matches the start of the PR's number (typing 2828 already finds #28280), not digits in a title or branch.
    const ok = words.every(w => (/^#?\d+$/.test(w) ? n !== null && n.startsWith(w.replace('#', '')) : hay.includes(w)));
    if (!ok) continue;
    seen.add(key);
    const at = Date.parse(r.requestedAt ?? r.mergedAt ?? r.at ?? '');
    // A lane the order does not know yet sorts last, not first.
    const lane = PHONE_LANE_ORDER.indexOf(r.lane);
    hits.push({ row: r, exact, lane: lane < 0 ? PHONE_LANE_ORDER.length : lane, at: Number.isFinite(at) ? at : 0 });
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || a.lane - b.lane || b.at - a.at);
  return hits.slice(0, limit).map(h => h.row);
}
