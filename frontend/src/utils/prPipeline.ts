/**
 * Shared, pure helpers for the PR pipeline views (the dashboard's Pull
 * requests section and the phone's /m/prs): lane order, the one-line detail
 * each lane shows, and the "things I can act on now" count. The lanes
 * themselves are assigned server-side (backend services/prPipeline.ts).
 */
import type { PrLane, PrLaneId, PrPipelineResponse, PrRow } from '../services/api';
import { fmtAge } from './format';

/** The phone opens on the first non-empty lane in this order: what can be done from a phone first. */
export const PHONE_LANE_ORDER: PrLaneId[] = [
  'needs_my_review', 'ready_to_merge', 'checks', 'needs_approval',
  'merged_not_deployed', 'in_progress', 'needs_pr', 'deployed', 'merged',
];

/** Short labels for tabs and the lane strip. */
export const LANE_SHORT: Record<PrLaneId, string> = {
  in_progress: 'In progress',
  needs_pr: 'Needs PR',
  checks: 'Checks',
  needs_approval: 'Approval',
  needs_my_review: 'My review',
  ready_to_merge: 'Ready',
  merged_not_deployed: 'Not deployed',
  deployed: 'Deployed',
  merged: 'Merged',
};

/** Lanes 5 and 6: what the user can do something about right now. */
export const ACTIONABLE: PrLaneId[] = ['needs_my_review', 'ready_to_merge'];

export function lanesOf(res: PrPipelineResponse | null | undefined): PrLane[] {
  return res && res.connected ? res.lanes : [];
}

export function actionableCount(res: PrPipelineResponse | null | undefined): number {
  return lanesOf(res).filter(l => ACTIONABLE.includes(l.id)).reduce((n, l) => n + l.rows.length, 0);
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
      if (r.pendingChecks.length) return `running: ${list(r.pendingChecks)}`;
      return 'checks not green';
    case 'needs_approval':
      return r.waitingOn.length ? `waiting on ${list(r.waitingOn)}` : 'needs an approving review';
    case 'needs_my_review':
      return `by ${r.author ?? 'someone'}${r.requestedAt ? ` · asked ${ago(r.requestedAt, now)}` : ''}`;
    case 'ready_to_merge':
      return r.blockedBy ?? (r.badges.includes('auto-merge') ? 'auto-merge on' : 'approved and green');
    case 'merged_not_deployed': {
      const merged = `merged ${ago(r.mergedAt, now)}`;
      const d = r.deploy;
      if (d?.state === 'orchestrator_only') return `${merged} · on the orchestrator, ${d.boxesBehind} of ${d.boxes} boxes behind`;
      if (d?.state === 'unknown') return `${merged} · deploy state unknown`;
      return `${merged} · not on prod`;
    }
    case 'deployed': {
      const d = r.deploy;
      const unknown = d?.state === 'deployed' && d.boxesUnknown ? ` · ${d.boxesUnknown} box${d.boxesUnknown === 1 ? '' : 'es'} unverifiable` : '';
      return `on prod · merged ${ago(r.mergedAt, now)}${unknown}`;
    }
    case 'merged':
      return `merged ${ago(r.mergedAt, now)}`;
  }
}
