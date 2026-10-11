import { describe, it, expect } from 'vitest';
import type { PrLane, PrRow } from '../services/api';
import { actionableCount, firstNonEmpty, PHONE_LANE_ORDER, rowDetail, rowLabel } from './prPipeline';

const NOW = Date.parse('2026-10-09T12:00:00Z');

function row(over: Partial<PrRow>): PrRow {
  return {
    kind: 'pr', lane: 'checks', repo: 'example-org/termag', number: 1, title: 't', url: 'u', author: 'me',
    headRefName: 'feat', baseRefName: 'main', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null,
    ...over,
  };
}

const lane = (id: PrLane['id'], rows: PrRow[] = []): PrLane => ({ id, label: id, rows });

describe('rowDetail', () => {
  it('names failing checks before running ones', () => {
    expect(rowDetail(row({ failingChecks: ['Bugbot'], pendingChecks: ['ci'] }), NOW)).toBe('failing: Bugbot');
    expect(rowDetail(row({ pendingChecks: ['a', 'b', 'c', 'd'] }), NOW)).toBe('running: a, b, c +1');
  });
  it('says who a review is from and when it was asked', () => {
    expect(rowDetail(row({ lane: 'needs_my_review', author: 'alice', requestedAt: '2026-10-09T10:00:00Z' }), NOW)).toBe('by alice · asked 2h ago');
  });
  it('describes deploy states', () => {
    const merged = { mergedAt: '2026-10-09T09:00:00Z' };
    expect(rowDetail(row({ lane: 'merged_not_deployed', ...merged, deploy: { state: 'not_deployed' } }), NOW)).toBe('merged 3h ago · not on prod');
    expect(rowDetail(row({ lane: 'merged_not_deployed', ...merged, deploy: { state: 'orchestrator_only', boxesBehind: 2, boxesUnknown: 0, boxes: 5 } }), NOW))
      .toBe('merged 3h ago · on the orchestrator, 2 of 5 boxes behind');
    expect(rowDetail(row({ lane: 'deployed', ...merged, deploy: { state: 'deployed', boxes: 4, boxesUnknown: 1 } }), NOW))
      .toBe('on prod · merged 3h ago · 1 box unverifiable');
  });
  it('a pushed branch with uncommitted changes says so', () => {
    expect(rowDetail(row({ kind: 'branch', lane: 'needs_pr', badges: ['dirty'], at: '2026-10-09T11:00:00Z' }), NOW))
      .toBe('pushed, last commit 1h ago · no pull request · uncommitted changes');
  });
  it('prefers what blocks a merge', () => {
    expect(rowDetail(row({ lane: 'ready_to_merge', blockedBy: 'merge conflict', badges: ['auto-merge'] }), NOW)).toBe('merge conflict');
    expect(rowDetail(row({ lane: 'ready_to_merge', badges: ['auto-merge'] }), NOW)).toBe('auto-merge on');
  });
});

describe('labels and counts', () => {
  it('labels PRs by repo#number and branches by repo · branch', () => {
    expect(rowLabel(row({ number: 280 }))).toBe('termag#280');
    expect(rowLabel(row({ kind: 'branch', number: null, headRefName: 'wip' }))).toBe('termag · wip');
  });
  it('counts lanes 5 and 6 only', () => {
    const res = { connected: true as const, viewer: 'me', prod: { sha: null, source: 'unknown' as const }, boxes: 0, fetchedAt: '', notes: [],
      lanes: [lane('needs_my_review', [row({}), row({})]), lane('ready_to_merge', [row({})]), lane('checks', [row({})])] };
    expect(actionableCount(res)).toBe(3);
    expect(actionableCount({ connected: false })).toBe(0);
    expect(actionableCount(null)).toBe(0);
  });
  it('opens on the first non-empty lane in phone order', () => {
    expect(firstNonEmpty([lane('checks', [row({})]), lane('needs_my_review')], PHONE_LANE_ORDER)).toBe('checks');
    expect(firstNonEmpty([], PHONE_LANE_ORDER)).toBe('needs_my_review');
  });
});
