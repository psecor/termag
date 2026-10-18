/**
 * The sidebar's PR pills: for
 * each workstream, the pull requests its branch is in, from the PR pipeline's
 * own link (backend services/prPipeline.ts linkWorkstream: same repository and
 * branch) read the other way round. A pill opens the PR overlay on its row.
 *
 * A merged PR keeps a grey pill until it is on prod. After that, and for the
 * PRs a workstream worked on before the lanes' window (the stored links the
 * response sends as `earlier`), a faint "past" pill reminds what the worktree
 * did: last in line, so it is the first to go when the row runs out of room.
 * Branches with nothing pushed get none. A PR the agent has just opened shows
 * from its milestone until the pipeline's next read lists it.
 */
import type { PrPipelineResponse, PrRow } from '../services/api';
import type { SessionMilestone } from '../types';
import { compareUrl, deferrals, hasOverview, isPrsView, needsYou, prsSearch, rowDetail, rowLabel, rowParam, type PrsView } from './prPipeline';
import { PR_PROMPT_TTL_MS } from './prPrompt';

export type PillTone = 'act' | 'bad' | 'good' | 'wait' | 'merged' | 'branch' | 'past';

export interface WorktreePill {
  /** The overlay's row key (prPipeline rowParam), or the PR URL for a provisional pill. */
  key: string;
  label: string;
  tone: PillTone;
  title: string;
  /** Opens the overlay here; null for a provisional pill, which links to GitHub. */
  view: PrsView | null;
  href: string | null;
}

const NO_PILL: PrRow['lane'][] = ['in_progress'];
const PAST_LANES: PrRow['lane'][] = ['deployed', 'merged'];
const TONE_ORDER: PillTone[] = ['act', 'bad', 'good', 'wait', 'branch', 'merged', 'past'];
/** Past pills per workstream, newest first: a reminder, not a history. */
export const MAX_PAST = 5;

export function worktreeKey(projectId: string, workstream: string): string {
  return `${projectId}\u0000${workstream}`;
}

/** A row's colour: yours to act on, red checks, ready, waiting on others, merged, or a branch with no PR. */
export function pillTone(r: PrRow, deferred: boolean): PillTone {
  if (PAST_LANES.includes(r.lane)) return 'past';
  if (r.lane === 'merged_not_deployed') return 'merged';
  if (r.kind === 'branch') return 'branch';
  if (r.lane === 'checks' && r.failingChecks.length && !r.badges.includes('draft')) return 'bad';
  if (r.lane === 'ready_to_merge' && !r.badges.includes('conflict')) return 'good';
  return needsYou(r) && !deferred ? 'act' : 'wait';
}

function pillFor(r: PrRow, deferred: boolean, now: number): WorktreePill {
  const detail = `${rowDetail(r, now)}${deferred ? ' · deferred' : ''}`;
  return {
    key: rowParam(r),
    label: r.kind === 'pr' ? `#${r.number}` : 'no PR',
    tone: pillTone(r, deferred),
    title: r.kind === 'pr' ? `${rowLabel(r)} · ${r.title}\n${detail}` : `${r.headRefName}: ${detail}`,
    // A lane the overlay has no tab for still opens it: the overlay finds the row by key in any lane.
    view: isPrsView(r.lane) ? r.lane : 'needs_you',
    href: null,
  };
}

const byTone = (a: WorktreePill, b: WorktreePill) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone);

/** Every linked workstream's pills, most pressing first. */
export function worktreePills(res: PrPipelineResponse | null | undefined, now: number): Map<string, WorktreePill[]> {
  const out = new Map<string, WorktreePill[]>();
  if (!res?.connected) return out;
  const deferred = deferrals(res, now);
  for (const lane of res.lanes) {
    if (NO_PILL.includes(lane.id) || PAST_LANES.includes(lane.id)) continue;
    for (const r of lane.rows) {
      if (!r.workstream) continue;
      const k = worktreeKey(r.workstream.projectId, r.workstream.workstream);
      const pills = out.get(k) ?? [];
      if (!pills.some(p => p.key === rowParam(r))) pills.push(pillFor(r, deferred.has(rowParam(r)), now));
      out.set(k, pills);
    }
  }
  // Past pills, newest first after the rest: the lanes' merges, then the earlier links.
  const past = new Map<string, { pill: WorktreePill; at: string }[]>();
  const addPast = (k: string, pill: WorktreePill, at: string | null) => {
    if (out.get(k)?.some(p => p.key.toLowerCase() === pill.key.toLowerCase())) return;
    const list = past.get(k) ?? [];
    if (!list.some(e => e.pill.key.toLowerCase() === pill.key.toLowerCase())) list.push({ pill, at: at ?? '' });
    past.set(k, list);
  };
  for (const lane of res.lanes) {
    if (!PAST_LANES.includes(lane.id)) continue;
    for (const r of lane.rows) {
      if (r.workstream && r.kind === 'pr') addPast(worktreeKey(r.workstream.projectId, r.workstream.workstream), pillFor(r, false, now), r.mergedAt);
    }
  }
  for (const e of res.earlier ?? []) {
    addPast(worktreeKey(e.workstream.projectId, e.workstream.workstream), earlierPill(e), e.at);
  }
  for (const pills of out.values()) pills.sort(byTone);
  for (const [k, list] of past) {
    list.sort((a, b) => b.at.localeCompare(a.at));
    out.set(k, [...(out.get(k) ?? []), ...list.slice(0, MAX_PAST).map(e => e.pill)]);
  }
  return out;
}

/** A PR the workstream worked on before the lanes' window: only its number is known, so it links to GitHub. */
function earlierPill(e: { repo: string; number: number }): WorktreePill {
  return {
    key: `${e.repo}#${e.number}`,
    label: `#${e.number}`,
    tone: 'past',
    title: `${e.repo.split('/')[1]}#${e.number} · worked on here earlier`,
    view: null,
    href: `https://github.com/${e.repo}/pull/${e.number}`,
  };
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/**
 * A PR the workstream's agent just opened (the `pr_created` milestone), until
 * the pipeline lists it: the pipeline is memoized for a minute, the milestone
 * arrives over the status socket at once. Null when there is nothing to add.
 */
export function provisionalPill(m: SessionMilestone | null | undefined, listed: WorktreePill[], now: number): WorktreePill | null {
  if (!m || m.kind !== 'pr_created' || !m.url) return null;
  const at = Date.parse(m.at);
  if (!Number.isFinite(at) || now - at > PR_PROMPT_TTL_MS) return null;
  const match = PR_URL.exec(m.url);
  if (!match) return null;
  const [, repo, n] = match;
  // A past pill for it does not count as listed: the live "just opened" one wins (withProvisional drops the grey one).
  if (listed.some(p => p.tone !== 'past' && p.key.toLowerCase() === `${repo}#${n}`.toLowerCase())) return null;
  return {
    key: m.url,
    label: `#${n}`,
    tone: 'wait',
    title: `${repo.split('/')[1]}#${n} · just opened\nThe PR list shows it within a minute.`,
    view: null,
    href: m.url,
  };
}

/** A workstream's pills with the provisional one in its place by colour, so it never hides an amber or red one behind "+1". */
export function withProvisional(listed: WorktreePill[], fresh: WorktreePill | null): WorktreePill[] {
  if (!fresh) return listed;
  // The provisional pill's key is its URL; a past pill's is owner/name#n.
  const m = PR_URL.exec(fresh.key);
  const freshKey = m ? `${m[1]}#${m[2]}`.toLowerCase() : null;
  return [...listed.filter(p => !(p.tone === 'past' && p.key.toLowerCase() === freshKey)), fresh].sort(byTone);
}

/** Where a pill's click goes: the overlay's search string, or a GitHub URL for a provisional or earlier pill. */
export function pillTarget(p: WorktreePill, currentSearch: string): { search: string } | { href: string } | null {
  if (p.view) return { search: prsSearch(currentSearch, p.view, p.key) };
  return p.href ? { href: p.href } : null;
}

/**
 * The phone header's pills (pages/mobile/HeaderPrPills.tsx): the live ones
 * only, with no room for a history. A workstream with nothing live keeps its
 * newest past pill, which still says what the worktree was for.
 */
export function phonePills(pills: WorktreePill[]): WorktreePill[] {
  const live = pills.filter(p => p.tone !== 'past');
  return live.length ? live : pills.slice(0, 1);
}

/**
 * Where a tap on a phone header pill goes: the overview for a listed PR; for
 * a pushed branch, GitHub's compare page to open one (its branch page when the
 * compare URL cannot be made); GitHub for a pill the lanes do not list. Null
 * only when there is nowhere to go.
 */
export function phonePillTarget(p: WorktreePill, row: PrRow | null): { overview: PrRow } | { href: string } | null {
  if (row && hasOverview(row)) return { overview: row };
  if (row) {
    const href = compareUrl(row) ?? (row.repo ? `https://github.com/${row.repo}/tree/${encodeURIComponent(row.headRefName)}` : p.href);
    return href ? { href } : null;
  }
  return p.href ? { href: p.href } : null;
}
