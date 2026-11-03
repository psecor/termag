import { describe, expect, it } from 'vitest';
import {
  archivedAsideName,
  archivedLookups,
  archivedRepoConflict,
  parseArchivedNameChoice,
  isBranchName,
  isNewBranchName,
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

describe('isNewBranchName', () => {
  it('accepts a branch with slashes', () => {
    expect(isNewBranchName('skz/ABC-123/fix-login')).toBe(true);
    expect(isNewBranchName('v1.2/fix')).toBe(true);
  });

  it('rejects what git check-ref-format would refuse after isBranchName lets it through', () => {
    for (const bad of ['team/', 'a//b', 'a/.b', '.a', 'a.', 'a/b.lock', 'a.lock/b', 'a@{1}', '@', 'HEAD']) {
      expect(isNewBranchName(bad), bad).toBe(false);
    }
  });

  it('keeps every refusal of isBranchName', () => {
    for (const bad of ['release/../main', '-develop', '/tmp', 'a b']) expect(isNewBranchName(bad), bad).toBe(false);
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

describe('archivedLookups', () => {
  it('tries the requested box before any box for a plain create', () => {
    expect(archivedLookups(false, 'box-1')).toEqual([{ archived: true, instanceId: 'box-1' }, { archived: true }]);
  });

  it('limits a repo pick to the requested box', () => {
    expect(archivedLookups(true, 'box-1')).toEqual([{ archived: true, instanceId: 'box-1' }]);
  });
});

describe('parseArchivedNameChoice', () => {
  it('reads both choices and treats absence as none', () => {
    expect(parseArchivedNameChoice('unarchive')).toBe('unarchive');
    expect(parseArchivedNameChoice('rename-aside')).toBe('rename-aside');
    expect(parseArchivedNameChoice(undefined)).toBeNull();
    expect(parseArchivedNameChoice(null)).toBeNull();
  });

  it('rejects anything else', () => {
    expect(parseArchivedNameChoice('delete')).toBeUndefined();
  });
});

describe('archivedRepoConflict', () => {
  const sameBox = { sameBox: true };

  it('conflicts when the repo name is archived on this box', () => {
    expect(archivedRepoConflict(true, sameBox)).toBe('conflict');
  });

  it('starts fresh when the repo name is not archived on this box', () => {
    expect(archivedRepoConflict(true, null)).toBe('fresh');
  });

  it('un-archives a plain create that found a row', () => {
    expect(archivedRepoConflict(false, sameBox)).toBe('unarchive');
    expect(archivedRepoConflict(false, { sameBox: false })).toBe('unarchive');
  });

  it('starts fresh when a plain create finds nothing', () => {
    expect(archivedRepoConflict(false, null)).toBe('fresh');
  });

  it('follows the form\'s answer to a conflict', () => {
    expect(archivedRepoConflict(true, sameBox, 'unarchive')).toBe('unarchive');
    expect(archivedRepoConflict(true, sameBox, 'rename-aside')).toBe('rename-aside');
  });

  it('has nothing to rename aside when the row is on another box', () => {
    expect(archivedRepoConflict(false, { sameBox: false }, 'rename-aside')).toBe('fresh');
  });
});

describe('archivedAsideName', () => {
  const at = new Date('2026-10-21T04:39:59Z');

  it('names it after the day it was archived', () => {
    expect(archivedAsideName('webapp', at, new Set())).toBe('webapp-archived-2026-10-21');
  });

  it('counts past names in use', () => {
    const taken = new Set(['webapp-archived-2026-10-21', 'webapp-archived-2026-10-21-2']);
    expect(archivedAsideName('webapp', at, taken)).toBe('webapp-archived-2026-10-21-3');
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
