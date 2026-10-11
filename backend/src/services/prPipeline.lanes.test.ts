import { describe, it, expect } from 'vitest';
import {
  TERMAG_REPO, assignLanes, authoredLane, branchLane, deployState, groupByLane, linkWorkstream, mergedLane, prKey,
  touchesBoxes, LANES, type BranchState, type LinkableWorkstream, type MergedPr, type OpenPr, type PipelineInput,
} from './prPipeline';

function open(over: Partial<OpenPr> = {}): OpenPr {
  return {
    repo: TERMAG_REPO, number: 1, title: 't', url: 'u', author: 'me', isDraft: false,
    headRefName: 'feat', baseRefName: 'main', updatedAt: '2026-10-09T00:00:00Z',
    reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMerge: false,
    checkRollup: 'SUCCESS', checks: [], requestedReviewers: [],
    ...over,
  };
}

function merged(over: Partial<MergedPr> = {}): MergedPr {
  return {
    repo: TERMAG_REPO, number: 2, title: 'm', url: 'u', author: 'me', headRefName: 'done', baseRefName: 'main',
    mergedAt: '2026-10-08T00:00:00Z', mergedBy: 'me', mergeCommit: 'a'.repeat(40), files: [],
    ...over,
  };
}

const ws = (branch: string, over: Partial<LinkableWorkstream> = {}): LinkableWorkstream =>
  ({ projectId: 'p1', projectName: 'termag', workstream: branch, branch, repo: null, ...over });

function input(over: Partial<PipelineInput> = {}): PipelineInput {
  return { viewer: 'me', authored: [], reviewRequested: [], merged: [], deploys: new Map(), branches: [], workstreams: [], ...over };
}

describe('authoredLane', () => {
  it('puts drafts in checks whatever their checks say', () => {
    expect(authoredLane(open({ isDraft: true, reviewDecision: 'APPROVED' }))).toBe('checks');
  });
  it('keeps a PR in checks while anything is running or red', () => {
    for (const r of ['PENDING', 'EXPECTED', 'FAILURE', 'ERROR']) expect(authoredLane(open({ checkRollup: r }))).toBe('checks');
  });
  it('treats no checks at all as green', () => {
    expect(authoredLane(open({ checkRollup: null }))).toBe('ready_to_merge');
  });
  it('green and waiting on a human is needs_approval', () => {
    expect(authoredLane(open({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe('needs_approval');
    expect(authoredLane(open({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('needs_approval');
  });
  it('green and approved, or no review required, is ready_to_merge', () => {
    expect(authoredLane(open({ reviewDecision: 'APPROVED' }))).toBe('ready_to_merge');
    expect(authoredLane(open({ reviewDecision: null }))).toBe('ready_to_merge');
  });
  it('a conflict does not move a PR, it badges it', () => {
    const rows = assignLanes(input({ authored: [open({ reviewDecision: 'APPROVED', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })] }));
    expect(rows[0].lane).toBe('ready_to_merge');
    expect(rows[0].badges).toContain('conflict');
    expect(rows[0].blockedBy).toBe('merge conflict');
  });
});

describe('mergedLane and deployState', () => {
  it('other repositories stop at merged', () => {
    expect(mergedLane(merged({ repo: 'example-org/webapp' }), { state: 'deployed', boxes: 0, boxesUnknown: 0 })).toBe('merged');
  });
  it('termag merges are deployed only when the state says so', () => {
    expect(mergedLane(merged(), null)).toBe('merged_not_deployed');
    expect(mergedLane(merged(), { state: 'not_deployed' })).toBe('merged_not_deployed');
    expect(mergedLane(merged(), { state: 'orchestrator_only', boxesBehind: 1, boxesUnknown: 0, boxes: 3 })).toBe('merged_not_deployed');
    expect(mergedLane(merged(), { state: 'deployed', boxes: 0, boxesUnknown: 0 })).toBe('deployed');
  });
  it('unknown prod commit is unknown, not deployed', () => {
    expect(deployState(null, false, []).state).toBe('unknown');
  });
  it('not in prod is not deployed, whatever the boxes run', () => {
    expect(deployState(false, true, [true, true])).toEqual({ state: 'not_deployed' });
  });
  it('an orchestrator-only change is deployed once prod has it', () => {
    expect(deployState(true, false, [false])).toEqual({ state: 'deployed', boxes: 0, boxesUnknown: 0 });
  });
  it('a box-side change waits for every box that can answer', () => {
    expect(deployState(true, true, [true, false, null])).toEqual({ state: 'orchestrator_only', boxesBehind: 1, boxesUnknown: 1, boxes: 3 });
    expect(deployState(true, true, [true, null])).toEqual({ state: 'deployed', boxes: 2, boxesUnknown: 1 });
  });
  it('a truncated file list counts as box-side', () => {
    expect(touchesBoxes(['backend/src/index.ts'], true)).toBe(true);
  });
  it('termag merges into anything but main stop at merged', () => {
    expect(mergedLane(merged({ baseRefName: 'release-1' }), { state: 'deployed', boxes: 0, boxesUnknown: 0 })).toBe('merged');
    const rows = assignLanes(input({ merged: [merged({ baseRefName: 'stacked-base' })], deploys: new Map([[prKey(TERMAG_REPO, 2), { state: 'not_deployed' }]]) }));
    expect(rows[0]).toMatchObject({ lane: 'merged', deploy: null });
  });
  it('agent/ and deploy/ are box-side', () => {
    expect(touchesBoxes(['agent/agent.js'])).toBe(true);
    expect(touchesBoxes(['deploy/termag-reconcile'])).toBe(true);
    expect(touchesBoxes(['backend/src/index.ts', 'docs/agent/x.md'])).toBe(false);
  });
});

describe('branchLane', () => {
  const b = (over: Partial<BranchState>): BranchState => ({
    repo: TERMAG_REPO, branch: 'feat', baseBranch: 'main', aheadOfBase: 0, pushed: false, dirty: false, lastCommitAt: null,
    workstream: { projectId: 'p1', projectName: 'termag', workstream: 'feat' }, ...over,
  });
  it('a checkout with no GitHub origin never shows', () => {
    expect(branchLane(b({ repo: null, branch: 'master', dirty: true }))).toBeNull();
  });
  it('the base branch never shows', () => {
    expect(branchLane(b({ branch: 'main', aheadOfBase: 3, dirty: true }))).toBeNull();
  });
  it('pushed and ahead is needs_pr', () => {
    expect(branchLane(b({ pushed: true, aheadOfBase: 2 }))).toBe('needs_pr');
  });
  it('local commits or uncommitted changes are in_progress', () => {
    expect(branchLane(b({ aheadOfBase: 2 }))).toBe('in_progress');
    expect(branchLane(b({ dirty: true }))).toBe('in_progress');
  });
  it('an uncountable base shows the branch rather than dropping it', () => {
    expect(branchLane(b({ pushed: true, aheadOfBase: null }))).toBe('needs_pr');
    expect(branchLane(b({ aheadOfBase: null }))).toBe('in_progress');
    expect(branchLane(b({ branch: 'main', aheadOfBase: null }))).toBeNull();
  });
  it('nothing past base and clean is nothing', () => {
    expect(branchLane(b({ pushed: true }))).toBeNull();
  });
  it('a branch with a PR is not shown again', () => {
    const rows = assignLanes(input({
      authored: [open({ headRefName: 'feat' })],
      merged: [merged({ headRefName: 'old' })],
      branches: [b({ aheadOfBase: 1 }), b({ branch: 'old', aheadOfBase: 1 }), b({ branch: 'new', aheadOfBase: 1 })],
    }));
    expect(rows.filter(r => r.kind === 'branch').map(r => r.headRefName)).toEqual(['new']);
  });
  it('a squash-merged branch older than the merged window is not a Needs a PR', () => {
    const rows = assignLanes(input({
      branches: [b({ branch: 'shipped', pushed: true, aheadOfBase: 4 }), b({ branch: 'fresh', pushed: true, aheadOfBase: 1 })],
      mergedHeads: new Set([`${TERMAG_REPO}:shipped`]),
    }));
    expect(rows.map(r => r.headRefName)).toEqual(['fresh']);
  });
});

describe('linkWorkstream', () => {
  it('links a unique branch match', () => {
    expect(linkWorkstream(TERMAG_REPO, 'feat', 'main', [ws('feat'), ws('other')])).toEqual({ projectId: 'p1', projectName: 'termag', workstream: 'feat' });
  });
  it('refuses to guess between two', () => {
    expect(linkWorkstream(TERMAG_REPO, 'feat', 'main', [ws('feat'), ws('feat', { projectId: 'p2' })])).toBeNull();
  });
  it('prefers a workstream whose repository is known to match', () => {
    const got = linkWorkstream(TERMAG_REPO, 'feat', 'main', [ws('feat'), ws('feat', { projectId: 'p2', repo: 'Example-Org/termag' })]);
    expect(got?.projectId).toBe('p2');
  });
  it('never links on a known other repository', () => {
    expect(linkWorkstream(TERMAG_REPO, 'feat', 'main', [ws('feat', { repo: 'example-org/webapp' })])).toBeNull();
  });
  it('never links base branches', () => {
    expect(linkWorkstream(TERMAG_REPO, 'main', 'main', [ws('main')])).toBeNull();
    expect(linkWorkstream(TERMAG_REPO, 'release', 'release', [ws('release')])).toBeNull();
  });
});

describe('assignLanes', () => {
  it('review requests go to needs_my_review, never the viewer\'s own', () => {
    const rows = assignLanes(input({
      reviewRequested: [open({ number: 5, author: 'someone', requestedReviewers: ['me', 'termag-team'] }), open({ number: 6, author: 'me' })],
    }));
    expect(rows.map(r => [r.number, r.lane])).toEqual([[5, 'needs_my_review']]);
    expect(rows[0].waitingOn).toEqual(['me', 'termag-team']);
  });
  it('a PR in two searches appears once, as authored', () => {
    const rows = assignLanes(input({ authored: [open({ number: 7 })], reviewRequested: [open({ number: 7, author: 'someone' })] }));
    expect(rows).toHaveLength(1);
    expect(rows[0].lane).toBe('ready_to_merge');
  });
  it('carries failing and pending check names', () => {
    const rows = assignLanes(input({ authored: [open({
      checkRollup: 'FAILURE',
      checks: [{ name: 'Bugbot', state: 'failed' }, { name: 'ci', state: 'pending' }, { name: 'lint', state: 'passed' }],
    })] }));
    expect(rows[0]).toMatchObject({ lane: 'checks', failingChecks: ['Bugbot'], pendingChecks: ['ci'] });
  });
  it('attaches deploy state to termag merges only', () => {
    const deploy = { state: 'deployed', boxes: 0, boxesUnknown: 0 } as const;
    const rows = assignLanes(input({
      merged: [merged(), merged({ repo: 'example-org/webapp', number: 3 })],
      deploys: new Map([[prKey(TERMAG_REPO, 2), deploy], [prKey('example-org/webapp', 3), deploy]]),
    }));
    expect(rows.find(r => r.number === 2)).toMatchObject({ lane: 'deployed', deploy });
    expect(rows.find(r => r.number === 3)).toMatchObject({ lane: 'merged', deploy: null });
  });
  it('links rows to workstreams and sorts newest first', () => {
    const rows = assignLanes(input({
      authored: [open({ number: 1, updatedAt: '2026-10-01T00:00:00Z' }), open({ number: 2, headRefName: 'x', updatedAt: '2026-10-05T00:00:00Z' })],
      workstreams: [ws('feat')],
    }));
    expect(rows.map(r => r.number)).toEqual([2, 1]);
    expect(rows[1].workstream?.workstream).toBe('feat');
    expect(rows[0].workstream).toBeNull();
  });
  it('review rows carry where Devin would run', () => {
    const rows = assignLanes(input({
      reviewRequested: [
        open({ number: 5, author: 'someone', headRefName: 'their-branch', requestedAt: '2026-10-08T00:00:00Z' }),
        open({ number: 6, author: 'someone', repo: 'example-org/webapp', headRefName: 'x' }),
      ],
      workstreams: [ws('main', { repo: TERMAG_REPO }), ws('feat', { repo: TERMAG_REPO })],
    }));
    expect(rows.find(r => r.number === 5)).toMatchObject({
      requestedAt: '2026-10-08T00:00:00Z', reviewTarget: { projectId: 'p1', workstream: 'main' },
    });
    expect(rows.find(r => r.number === 6)?.reviewTarget).toBeNull();
  });
  it('groupByLane returns every lane in order', () => {
    const lanes = groupByLane(assignLanes(input({ authored: [open()] })));
    expect(lanes.map(l => l.id)).toEqual(LANES.map(l => l.id));
    expect(lanes.find(l => l.id === 'ready_to_merge')?.rows).toHaveLength(1);
  });
});
