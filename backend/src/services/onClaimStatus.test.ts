import { describe, expect, it } from 'vitest';
import { onClaimRunUpdate, parseOnClaimReport } from './onClaimStatus';

describe('parseOnClaimReport', () => {
  it('maps a needs-auth skip to the owner setup message', () => {
    expect(parseOnClaimReport({ state: 'skipped', reason: 'needs-auth' })).toEqual({
      state: 'skipped',
      error: 'Dotfiles wait for GitHub login on the box',
    });
  });

  it('keeps a real failure', () => {
    expect(parseOnClaimReport({ state: 'failed', reason: 'script-failed', logTail: 'install exited 1\n' })).toEqual({
      state: 'failed',
      error: 'install exited 1',
    });
  });

  it('rejects an unknown state', () => {
    expect(parseOnClaimReport({ state: 'pending' })).toBeNull();
  });
});

describe('onClaimRunUpdate', () => {
  it('stores the skip on a ready row and clears errors on success', () => {
    expect(onClaimRunUpdate('box_1', { state: 'succeeded' })).toEqual({
      where: { id: 'box_1', status: 'ready' },
      data: { onClaimStatus: 'succeeded', onClaimError: null },
    });
  });
});
