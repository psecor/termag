import { describe, it, expect } from 'vitest';
import {
  isMilestoneExpired, MILESTONE_TTL_MS, milestoneForSharedViewer, milestoneOnReading, parseMilestoneBody,
} from './milestone';

describe('parseMilestoneBody', () => {
  it('accepts a PR-created milestone with a GitHub PR url', () => {
    expect(parseMilestoneBody({ session: 'me-proj-agent', kind: 'pr_created', url: 'https://github.com/org/repo/pull/171' }))
      .toEqual({ session: 'me-proj-agent', kind: 'pr_created', url: 'https://github.com/org/repo/pull/171' });
  });

  it('accepts pr_merged and a missing url', () => {
    expect(parseMilestoneBody({ session: 's', kind: 'pr_merged' })).toEqual({ session: 's', kind: 'pr_merged', url: null });
    expect(parseMilestoneBody({ session: 's', kind: 'pr_merged', url: null })).toEqual({ session: 's', kind: 'pr_merged', url: null });
  });

  it('drops a url that is not a GitHub PR link rather than rendering it', () => {
    expect(parseMilestoneBody({ session: 's', kind: 'pr_created', url: 'https://evil.example/x' })).toEqual({ session: 's', kind: 'pr_created', url: null });
    expect(parseMilestoneBody({ session: 's', kind: 'pr_created', url: 'javascript:alert(1)' })).toEqual({ session: 's', kind: 'pr_created', url: null });
    expect(parseMilestoneBody({ session: 's', kind: 'pr_created', url: 'https://github.com/org/repo/issues/3' })).toEqual({ session: 's', kind: 'pr_created', url: null });
  });

  it('rejects bad shapes', () => {
    expect(parseMilestoneBody(null)).toHaveProperty('error');
    expect(parseMilestoneBody({ kind: 'pr_created' })).toHaveProperty('error');
    expect(parseMilestoneBody({ session: 's', kind: 'deployed' })).toHaveProperty('error');
    expect(parseMilestoneBody({ session: 's', kind: 'pr_created', url: 7 })).toHaveProperty('error');
  });
});

describe('isMilestoneExpired', () => {
  const at = new Date(1_000_000_000_000);
  it('expires exactly at the TTL', () => {
    expect(isMilestoneExpired({ at }, at.getTime() + MILESTONE_TTL_MS - 1)).toBe(false);
    expect(isMilestoneExpired({ at }, at.getTime() + MILESTONE_TTL_MS)).toBe(true);
  });
});

describe('milestoneOnReading', () => {
  it('ignores a null reading: the transcript going stale is not a reset', () => {
    expect(milestoneOnReading({ contextTokens: 180_000 }, null)).toBe('ignore');
    expect(milestoneOnReading({ contextTokens: 180_000 }, undefined)).toBe('ignore');
  });

  it('resolves when the reading drops to a fraction of the recorded size', () => {
    expect(milestoneOnReading({ contextTokens: 180_000 }, 20_000)).toBe('resolve');
    expect(milestoneOnReading({ contextTokens: 180_000 }, 89_999)).toBe('resolve');
  });

  it('updates when the reading is still in the same ballpark or larger', () => {
    expect(milestoneOnReading({ contextTokens: 180_000 }, 90_000)).toBe('update');
    expect(milestoneOnReading({ contextTokens: 180_000 }, 200_000)).toBe('update');
  });

  it('updates (never resolves) when there was no recorded size to compare against', () => {
    expect(milestoneOnReading({ contextTokens: null }, 5_000)).toBe('update');
  });
});

describe('milestoneForSharedViewer', () => {
  it('strips the PR link and leaves everything else', () => {
    const m = { kind: 'pr_created' as const, url: 'https://github.com/o/r/pull/1', at: new Date(0), contextTokens: 1 };
    expect(milestoneForSharedViewer(m)).toEqual({ ...m, url: null });
    expect(milestoneForSharedViewer(null)).toBeNull();
    expect(milestoneForSharedViewer(undefined)).toBeUndefined();
  });
});
