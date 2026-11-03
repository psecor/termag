import { describe, expect, it } from 'vitest';
import { canShareFiles, resolveSharedFile, sharingDisabled, type SharedFileDeps } from './sharedFiles';

describe('sharingDisabled', () => {
  it('is on for 1, true and yes, in any case, and off otherwise', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ']) expect(sharingDisabled({ SPACE_FILE_SHARING_DISABLED: v })).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'off']) expect(sharingDisabled({ SPACE_FILE_SHARING_DISABLED: v })).toBe(false);
  });
});

describe('canShareFiles', () => {
  it('lets editors and owners share, never a viewer or anyone on a read-only space', () => {
    expect(canShareFiles({ role: 'owner', memberRole: 'owner', readOnly: false })).toBe(true);
    expect(canShareFiles({ role: 'editor', memberRole: 'editor', readOnly: false })).toBe(true);
    expect(canShareFiles({ role: 'viewer', memberRole: 'viewer', readOnly: false })).toBe(false);
    expect(canShareFiles({ role: 'viewer', memberRole: 'owner', readOnly: true })).toBe(false);
  });
});

describe('resolveSharedFile', () => {
  const space = { id: 's1', name: 'notes', description: null, createdById: 'u-owner', createdAt: new Date(0), readOnlyAt: null, deletedAt: null, usedBytes: 0n, quotaBytes: 0n };
  const share = { spaceId: 's1', path: 'a.md', sharedById: 'u-owner', createdAt: new Date(0), sharedBy: null };
  const deps = (calls: string[]): SharedFileDeps => {
    // A variable, not a literal, so the spy on grantedBoxIds (which the deps no longer pick) type-checks.
    const store = {
      findSpace: async () => space,
      fileShare: async () => share,
      memberRoles: async () => new Map([['u-owner', 'owner' as const]]),
      grantedBoxIds: async () => { calls.push('grantedBoxIds'); return new Set<string>(); },
      ldUser: async () => ({ googleEmail: 'viewer@example.com' }) as Awaited<ReturnType<SharedFileDeps['store']['ldUser']>>,
    };
    return { store, viewerAllowed: () => true, disabled: () => false };
  };

  it("reads a shared file without loading the space's box grants, which only a box caller needs", async () => {
    const calls: string[] = [];
    expect(await resolveSharedFile(deps(calls), 'u-viewer', 'notes', 'a.md')).toEqual({ space, share });
    expect(calls).toEqual([]);
  });
});
