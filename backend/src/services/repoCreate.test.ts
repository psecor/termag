import { describe, expect, it } from 'vitest';
import {
  archivedLookup,
  archivedRepoConflict,
  isBranchName,
  parseClaimTiming,
  recordedBranch,
} from './repoCreate';

describe('isBranchName', () => {
  it('accepts a normal branch', () => {
    expect(isBranchName('feature/x-81')).toBe(true);
  });

  it('rejects a parent segment', () => {
    expect(isBranchName('release/../main')).toBe(false);
  });

  it('rejects a leading dash', () => {
    expect(isBranchName('-develop')).toBe(false);
  });

  it('rejects a leading slash', () => {
    expect(isBranchName('/tmp')).toBe(false);
  });
});

describe('recordedBranch', () => {
  it('leaves a host create for detection', () => {
    expect(recordedBranch({ instanceId: null, hasRepo: true, defaultBranch: 'develop' })).toBe(undefined);
  });

  it('records main for an empty boxed project', () => {
    expect(recordedBranch({ instanceId: 'box-1', hasRepo: false, defaultBranch: null })).toBe('main');
  });

  it('records the listed branch', () => {
    expect(recordedBranch({ instanceId: 'box-1', hasRepo: true, defaultBranch: 'develop' })).toBe('develop');
  });

  it('records main only when the requested branch is main', () => {
    expect(recordedBranch({ instanceId: 'box-1', hasRepo: true, defaultBranch: 'main' })).toBe('main');
  });

  it('records HEAD when a repo pick has no usable branch', () => {
    expect(recordedBranch({ instanceId: 'box-1', hasRepo: true, defaultBranch: null })).toBe('HEAD');
  });

  it('records HEAD when the requested branch is not a branch name', () => {
    expect(recordedBranch({ instanceId: 'box-1', hasRepo: true, defaultBranch: 'a/../b' })).toBe('HEAD');
  });
});

describe('archivedLookup', () => {
  it('does not pin a plain create to a box', () => {
    expect(archivedLookup(false, 'box-1')).toEqual({ archived: true });
  });

  it('limits a repo pick to the requested box', () => {
    expect(archivedLookup(true, 'box-1')).toEqual({ archived: true, instanceId: 'box-1' });
  });
});

describe('archivedRepoConflict', () => {
  it('conflicts when the repo name is archived on this box', () => {
    expect(archivedRepoConflict(true, true)).toBe('conflict');
  });

  it('starts fresh when the repo name is not archived on this box', () => {
    expect(archivedRepoConflict(true, false)).toBe('fresh');
  });

  it('un-archives a plain create that found a row', () => {
    expect(archivedRepoConflict(false, true)).toBe('unarchive');
  });

  it('starts fresh when a plain create finds nothing', () => {
    expect(archivedRepoConflict(false, false)).toBe('fresh');
  });
});

describe('parseClaimTiming', () => {
  it('requires ms and leaves an absent pick empty', () => {
    expect(parseClaimTiming({ ms: 12.4 })).toEqual({ ok: true, ms: 12.4, pickMs: null });
  });

  it('accepts a non-negative pick', () => {
    expect(parseClaimTiming({ ms: 10, pickMs: 3.2 })).toEqual({ ok: true, ms: 10, pickMs: 3.2 });
  });

  it('rejects a missing ms', () => {
    expect(parseClaimTiming({ pickMs: 1 })).toEqual({
      ok: false,
      error: 'ms must be a finite non-negative number',
    });
  });

  it('rejects a negative pick', () => {
    expect(parseClaimTiming({ ms: 1, pickMs: -2 })).toEqual({
      ok: false,
      error: 'pickMs must be a finite non-negative number',
    });
  });
});
