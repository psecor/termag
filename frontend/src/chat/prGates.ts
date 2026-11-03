// A session's pull request under the chrome refresh:
// which PR row is the session's (the full UI's PR pipeline, GET /api/prs), and the
// gates in front of its merge, from the PR's overview (GET /api/prs/:repo/:number):
// its checks, termag's three Cursor agents, its review and its conflicts. Pure.
import type { PrOverview, PrPipelineResponse, PrRow } from '../services/api';
import { lanesOf } from '../utils/prPipeline';

export type GateStatus = 'pass' | 'fail' | 'running' | 'waiting';
export interface Gate { key: string; name: string; status: GateStatus; detail: string }

/**
 * The session's PR: a row linked to this project and workstream, an open PR
 * before a merged one and a PR before a bare branch, newest first. Null when
 * there is none.
 */
export function sessionPr(res: PrPipelineResponse | null | undefined, projectId: string, workstream: string): PrRow | null {
  const rows = lanesOf(res).flatMap(l => l.rows)
    .filter(r => r.kind === 'pr' && r.repo && r.number != null && r.workstream?.projectId === projectId && r.workstream.workstream === workstream);
  if (rows.length === 0) return null;
  const rank = (r: PrRow) => (r.mergedAt ? 1 : 0);
  const at = (r: PrRow) => (r.at ? Date.parse(r.at) : 0);
  return [...rows].sort((a, b) => rank(a) - rank(b) || at(b) - at(a))[0];
}

/** termag's agents, by the check name each posts as. */
const AGENTS: ReadonlyArray<{ key: string; name: string; prefix: string }> = [
  { key: 'bugbot', name: 'Bugbot', prefix: 'Cursor Bugbot' },
  { key: 'security', name: 'Security agent', prefix: 'Cursor Security Agent' },
  { key: 'approval', name: 'Approval agent', prefix: 'Cursor Approval Agent' },
];

const checkStatus = (s: PrOverview['checks'][number]['state']): GateStatus => (s === 'passed' ? 'pass' : s === 'failed' ? 'fail' : 'running');
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * GitHub's review decision, or, where it gives none (no review rule on the
 * branch), the reviewers' latest reviews: a change request outweighs approvals.
 */
function reviewOutcome(pr: Pick<PrOverview, 'reviewDecision' | 'reviews'>): 'APPROVED' | 'CHANGES_REQUESTED' | null {
  if (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED') return pr.reviewDecision;
  if (pr.reviewDecision) return null;
  const latest = new Map<string, string>();
  for (const r of [...(pr.reviews ?? [])].sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''))) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') latest.set(r.author ?? '', r.state);
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  return states.includes('APPROVED') ? 'APPROVED' : null;
}

export function prGates(pr: Pick<PrOverview, 'checks' | 'reviewDecision' | 'reviews' | 'mergeable' | 'mergeStateStatus' | 'requestedReviewers'>): Gate[] {
  const gates: Gate[] = [];
  const agentChecks = new Set<string>();
  const agents: Gate[] = [];
  for (const a of AGENTS) {
    const check = pr.checks.find(c => c.name.startsWith(a.prefix));
    if (!check) continue;
    agentChecks.add(check.name);
    const status = checkStatus(check.state);
    agents.push({ key: a.key, name: a.name, status, detail: status === 'pass' ? 'Passed' : status === 'fail' ? 'Failed' : 'Running' });
  }
  const rest = pr.checks.filter(c => !agentChecks.has(c.name));
  const failed = rest.filter(c => c.state === 'failed').length;
  const pending = rest.filter(c => c.state === 'pending').length;
  gates.push(failed > 0
    ? { key: 'checks', name: 'Checks', status: 'fail', detail: `${failed} of ${rest.length} failing` }
    : pending > 0
      ? { key: 'checks', name: 'Checks', status: 'running', detail: `${plural(pending, 'check')} running` }
      : { key: 'checks', name: 'Checks', status: 'pass', detail: rest.length === 0 ? 'None' : `${plural(rest.length, 'check')} passed` });
  gates.push(...agents);
  const waitingOn = pr.requestedReviewers.length > 0 ? `Waiting on ${pr.requestedReviewers.join(', ')}` : 'Needs an approval';
  const review = reviewOutcome(pr);
  gates.push(review === 'APPROVED'
    ? { key: 'review', name: 'Review', status: 'pass', detail: 'Approved' }
    : review === 'CHANGES_REQUESTED'
      ? { key: 'review', name: 'Review', status: 'fail', detail: 'Changes requested' }
      : { key: 'review', name: 'Review', status: 'waiting', detail: waitingOn });
  const conflicted = pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY';
  gates.push(conflicted
    ? { key: 'conflicts', name: 'Conflicts', status: 'fail', detail: 'Merge conflict' }
    : pr.mergeable === 'MERGEABLE'
      ? { key: 'conflicts', name: 'Conflicts', status: 'pass', detail: 'None' }
      : { key: 'conflicts', name: 'Conflicts', status: 'waiting', detail: 'Not known yet' });
  return gates;
}
