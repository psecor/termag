import { describe, expect, it } from 'vitest';
import type { PrOverview, PrPipelineResponse, PrRow } from '../services/api';
import { prGates, sessionPr } from './prGates';

type Checks = PrOverview['checks'];
const pr = (over: Partial<PrOverview> = {}) => ({
  checks: [] as Checks, reviewDecision: null, reviews: [] as PrOverview['reviews'], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', requestedReviewers: [] as string[], ...over,
});
const gate = (gates: ReturnType<typeof prGates>, key: string) => gates.find(g => g.key === key);

describe('prGates', () => {
  it("splits termag's agents out of the checks and reads each", () => {
    const gates = prGates(pr({
      checks: [
        { name: 'frontend', state: 'passed' }, { name: 'backend', state: 'pending' },
        { name: 'Cursor Bugbot', state: 'failed' },
        { name: 'Cursor Security Agent: Termag Security Reviewer', state: 'passed' },
        { name: 'Cursor Approval Agent: Termag Pull Request Router and Approver', state: 'pending' },
      ],
    }));
    expect(gates.map(g => [g.name, g.status, g.detail])).toEqual([
      ['Checks', 'running', '1 check running'],
      ['Bugbot', 'fail', 'Failed'],
      ['Security agent', 'pass', 'Passed'],
      ['Approval agent', 'running', 'Running'],
      ['Review', 'waiting', 'Needs an approval'],
      ['Conflicts', 'pass', 'None'],
    ]);
  });

  it('fails the checks on any failure, passes them when all pass, and says None for none', () => {
    expect(gate(prGates(pr({ checks: [{ name: 'a', state: 'failed' }, { name: 'b', state: 'pending' }] })), 'checks'))
      .toMatchObject({ status: 'fail', detail: '1 of 2 failing' });
    expect(gate(prGates(pr({ checks: [{ name: 'a', state: 'passed' }, { name: 'b', state: 'passed' }] })), 'checks'))
      .toMatchObject({ status: 'pass', detail: '2 checks passed' });
    expect(gate(prGates(pr()), 'checks')).toMatchObject({ status: 'pass', detail: 'None' });
    expect(gate(prGates(pr()), 'bugbot')).toBeUndefined();
  });

  it("reads the reviewers' latest reviews where GitHub gives no decision", () => {
    const at = (m: number) => `2026-10-27T00:0${m}:00Z`;
    expect(gate(prGates(pr({ reviews: [{ author: 'bob', state: 'CHANGES_REQUESTED', submittedAt: at(1) }, { author: 'ada', state: 'APPROVED', submittedAt: at(2) }] })), 'review'))
      .toMatchObject({ status: 'fail', detail: 'Changes requested' });
    expect(gate(prGates(pr({ reviews: [{ author: 'bob', state: 'CHANGES_REQUESTED', submittedAt: at(1) }, { author: 'bob', state: 'APPROVED', submittedAt: at(2) }] })), 'review'))
      .toMatchObject({ status: 'pass' });
    expect(gate(prGates(pr({ reviews: [{ author: 'bob', state: 'COMMENTED', submittedAt: at(1) }] })), 'review')).toMatchObject({ status: 'waiting' });
    // GitHub's own decision wins when there is one.
    expect(gate(prGates(pr({ reviewDecision: 'REVIEW_REQUIRED', reviews: [{ author: 'bob', state: 'APPROVED', submittedAt: at(1) }] })), 'review'))
      .toMatchObject({ status: 'waiting' });
  });

  it('reads the review and the conflicts', () => {
    expect(gate(prGates(pr({ reviewDecision: 'APPROVED' })), 'review')).toMatchObject({ status: 'pass', detail: 'Approved' });
    expect(gate(prGates(pr({ reviewDecision: 'CHANGES_REQUESTED' })), 'review')).toMatchObject({ status: 'fail' });
    expect(gate(prGates(pr({ requestedReviewers: ['ada', 'grace'] })), 'review')).toMatchObject({ status: 'waiting', detail: 'Waiting on ada, grace' });
    expect(gate(prGates(pr({ mergeable: 'CONFLICTING' })), 'conflicts')).toMatchObject({ status: 'fail', detail: 'Merge conflict' });
    expect(gate(prGates(pr({ mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' })), 'conflicts')).toMatchObject({ status: 'fail' });
    expect(gate(prGates(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })), 'conflicts')).toMatchObject({ status: 'waiting' });
  });
});

const row = (over: Partial<PrRow>): PrRow => ({
  kind: 'pr', lane: 'mine', repo: 'example-org/termag', number: 1, title: 't', url: null, author: null, headRefName: 'h', baseRefName: 'main',
  at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [], blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null,
  workstream: { projectId: 'p1', workstream: 'main' }, requestedAt: null, reviewTarget: null, ...over,
} as PrRow);
const res = (rows: PrRow[]) => ({ connected: true, lanes: [{ id: 'mine', label: 'Mine', rows }] } as unknown as PrPipelineResponse);

describe('sessionPr', () => {
  it("is the session's open PR before a merged one, newest first, and null for none", () => {
    const rows = [
      row({ number: 1, mergedAt: '2026-10-20T00:00:00Z', at: '2026-10-27T00:00:00Z' }),
      row({ number: 2, at: '2026-10-25T00:00:00Z' }),
      row({ number: 3, at: '2026-10-26T00:00:00Z' }),
      row({ number: 4, workstream: { projectId: 'p1', workstream: 'feat' } as PrRow['workstream'] }),
      row({ number: 5, kind: 'branch' }),
    ];
    expect(sessionPr(res(rows), 'p1', 'main')?.number).toBe(3);
    expect(sessionPr(res(rows), 'p1', 'feat')?.number).toBe(4);
    expect(sessionPr(res(rows), 'p2', 'main')).toBeNull();
    expect(sessionPr(null, 'p1', 'main')).toBeNull();
  });
});
