// The lobby's PR pills and count, from GET /api/cli/v1/prs (the PR pipeline;
// a device sign-in only). The rules mirror
// frontend/src/utils/worktreePrs.ts (pillTone, phonePills) and
// frontend/src/utils/prPipeline.ts (needsYou, actionableCount), kept as a copy
// for the same reason as types.ts.

export type PrLaneId =
  | 'in_progress' | 'needs_pr' | 'checks' | 'needs_approval' | 'needs_my_review'
  | 'ready_to_merge' | 'merged_not_deployed' | 'deployed' | 'merged';

/** The fields of the pipeline's PrRow the lobby reads. */
export interface PrRow {
  kind: 'pr' | 'branch';
  lane: PrLaneId;
  repo: string | null;
  number: number | null;
  title: string;
  url: string | null;
  headRefName: string;
  baseRefName?: string | null;
  badges: string[];
  failingChecks: string[];
  checksFailed?: boolean;
  mergedAt: string | null;
  workstream: { projectId: string; workstream: string } | null;
}

export type PrsResponse =
  | { connected: false }
  | {
    connected: true;
    lanes: { id: PrLaneId; rows: PrRow[] }[];
    deferred?: { key: string; until: string }[];
    earlier?: { repo: string; number: number; workstream: { projectId: string; workstream: string }; at: string | null }[];
  };

export type PillTone = 'act' | 'bad' | 'good' | 'wait' | 'merged' | 'branch' | 'past';

export interface Pill {
  key: string;
  label: string;
  tone: PillTone;
  /** What `o` shows: the PR, or for a pushed branch GitHub's page to open one. */
  url: string | null;
}

const NO_PILL: PrLaneId[] = ['in_progress'];
const PAST_LANES: PrLaneId[] = ['deployed', 'merged'];
const TONE_ORDER: PillTone[] = ['act', 'bad', 'good', 'wait', 'branch', 'merged', 'past'];
const NEEDS_YOU_LANES: PrLaneId[] = ['needs_my_review', 'ready_to_merge', 'checks', 'needs_approval', 'needs_pr'];

export function workstreamKey(projectId: string, workstream: string): string {
  return `${projectId}/${workstream}`;
}

export function rowKey(r: Pick<PrRow, 'kind' | 'repo' | 'number' | 'headRefName'>): string {
  return r.kind === 'pr' ? `${r.repo}#${r.number}` : `${r.repo ?? ''}:${r.headRefName}`;
}

function checksRed(r: PrRow): boolean {
  return r.failingChecks.length > 0 || r.checksFailed === true;
}

/** Anything the user can act on now: frontend needsYou. */
export function needsYou(r: PrRow): boolean {
  if (r.lane === 'needs_my_review' || r.lane === 'ready_to_merge' || r.lane === 'needs_pr') return true;
  if (r.lane !== 'checks' && r.lane !== 'needs_approval') return false;
  if (r.badges.includes('conflict') || r.badges.includes('changes-requested')) return true;
  return r.lane === 'checks' && checksRed(r) && !r.badges.includes('draft');
}

export function pillTone(r: PrRow, deferred: boolean): PillTone {
  if (PAST_LANES.includes(r.lane)) return 'past';
  if (r.lane === 'merged_not_deployed') return 'merged';
  if (r.kind === 'branch') return 'branch';
  if (r.lane === 'checks' && r.failingChecks.length && !r.badges.includes('draft')) return 'bad';
  if (r.lane === 'ready_to_merge' && !r.badges.includes('conflict')) return 'good';
  return needsYou(r) && !deferred ? 'act' : 'wait';
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

function pillUrl(r: PrRow): string | null {
  if (r.kind === 'pr') return r.url;
  if (!r.repo || !REPO.test(r.repo)) return null;
  return r.baseRefName
    ? `https://github.com/${r.repo}/compare/${refPath(r.baseRefName)}...${refPath(r.headRefName)}?expand=1`
    : `https://github.com/${r.repo}/tree/${refPath(r.headRefName)}`;
}

function deferredKeys(res: Extract<PrsResponse, { connected: true }>, now: number): Set<string> {
  return new Set((res.deferred ?? []).filter(d => Date.parse(d.until) > now).map(d => d.key));
}

/**
 * Each workstream's pills, most pressing first, as on the phone header: the
 * live ones only, or when it has none its newest past PR (deployed or merged,
 * then an earlier stored link), which still says what the worktree was for.
 */
export function lobbyPills(res: PrsResponse | null, now: number): Map<string, Pill[]> {
  const out = new Map<string, Pill[]>();
  if (!res?.connected) return out;
  const deferred = deferredKeys(res, now);
  const past = new Map<string, { pill: Pill; at: string }[]>();
  for (const lane of res.lanes) {
    if (NO_PILL.includes(lane.id)) continue;
    for (const r of lane.rows) {
      if (!r.workstream) continue;
      const k = workstreamKey(r.workstream.projectId, r.workstream.workstream);
      const pill: Pill = { key: rowKey(r), label: r.kind === 'pr' ? `#${r.number}` : 'no PR', tone: pillTone(r, deferred.has(rowKey(r))), url: pillUrl(r) };
      const into = pill.tone === 'past' ? null : (out.get(k) ?? []);
      if (into) {
        if (!into.some(p => p.key === pill.key)) into.push(pill);
        out.set(k, into);
      } else if (r.kind === 'pr') {
        past.set(k, [...(past.get(k) ?? []), { pill, at: r.mergedAt ?? '' }]);
      }
    }
  }
  for (const e of res.earlier ?? []) {
    const k = workstreamKey(e.workstream.projectId, e.workstream.workstream);
    const pill: Pill = { key: `${e.repo}#${e.number}`, label: `#${e.number}`, tone: 'past', url: `https://github.com/${e.repo}/pull/${e.number}` };
    past.set(k, [...(past.get(k) ?? []), { pill, at: e.at ?? '' }]);
  }
  for (const pills of out.values()) pills.sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone));
  for (const [k, list] of past) {
    if (out.get(k)?.length) continue;
    out.set(k, [list.sort((a, b) => b.at.localeCompare(a.at))[0].pill]);
  }
  return out;
}

/** What needs the user and is not deferred: the web tile's and the phone inbox's count. */
export function prCount(res: PrsResponse | null, now: number): number {
  if (!res?.connected) return 0;
  const deferred = deferredKeys(res, now);
  let n = 0;
  for (const lane of res.lanes) {
    if (!NEEDS_YOU_LANES.includes(lane.id)) continue;
    for (const r of lane.rows) if (needsYou(r) && !deferred.has(rowKey(r))) n++;
  }
  return n;
}

export const PILL_COLOR: Record<PillTone, { color: string; dim: boolean }> = {
  act: { color: 'yellow', dim: false },
  bad: { color: 'red', dim: false },
  good: { color: 'green', dim: false },
  wait: { color: 'white', dim: false },
  branch: { color: 'gray', dim: false },
  merged: { color: 'gray', dim: true },
  past: { color: 'gray', dim: true },
};
