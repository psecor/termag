import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  notifyShareChange, sendThroughShare, setShareChangeCallback, shareChangeFrames, shareChangeTouches, sharedScope,
  startSharedRefresh, statusRoute, type ScopeHolder, type ShareRow,
} from './statusAudience';
import { prisma } from '../db';

vi.mock('../db', () => ({ prisma: { projectShare: { findMany: vi.fn() } } }));

// Alice owns P (myproj, workstreams main + feature) and Q (myproj-secret),
// both on box-a, plus an archived project shared with Bob. Bob holds a share
// on P only, so Bob must see nothing of Q, though its names start like P's.
const row = (projectId: string, name: string, workstreams: string[], extra: Partial<ShareRow['project']> = {}): ShareRow => ({
  projectId,
  project: { name, instanceId: 'box-a', archived: false, user: { unixUsername: 'alice' }, workstreams: workstreams.map(w => ({ name: w })), ...extra },
});
const bob = { unixUsername: 'bob', ...sharedScope([row('p', 'myproj', ['main', 'feature']), row('old', 'gone', ['main'], { archived: true })]) };

describe('sharedScope', () => {
  it("holds every role of every live workstream of the shared projects, by box", () => {
    expect(bob.sharedStatusKeys).toContain('box-a|alice-myproj-agent');
    expect(bob.sharedStatusKeys).toContain('box-a|alice-myproj-feature-data-ctrl');
    expect(bob.sharedStatusKeys.size).toBe(2 * 5);
    expect(bob.sharedOwners).toEqual(['alice']);
  });

  it('keeps an archived shared project for chat, not for statuses', () => {
    expect([...bob.sharedProjectIds]).toEqual(['p', 'old']);
    expect(bob.sharedStatusKeys).not.toContain('box-a|alice-gone-agent');
  });

  it('defaults a project without workstream rows to main', () => {
    expect(sharedScope([row('p', 'myproj', [])]).sharedStatusKeys).toContain('box-a|alice-myproj-ctrl');
  });
});

describe('statusRoute', () => {
  it("sends a collaborator the shared project's sessions", () => {
    expect(statusRoute(bob, 'alice-myproj-agent', 'box-a')).toBe('shared');
    expect(statusRoute(bob, 'alice-myproj-feature-review', 'box-a')).toBe('shared');
  });

  it("sends a collaborator on P nothing for Q, the same owner's other project", () => {
    for (const session of ['alice-myproj-secret-agent', 'alice-myproj-secret-ctrl', 'alice-other-agent']) {
      // recheck: the caller re-reads a stale scope and sends only on 'shared'.
      expect(statusRoute(bob, session, 'box-a')).toBe('recheck');
    }
    // After the re-read the scope still holds no Q session.
    expect(statusRoute({ ...bob, ...sharedScope([row('p', 'myproj', ['main', 'feature'])]) }, 'alice-myproj-secret-agent', 'box-a')).toBe('recheck');
  });

  it("matches the box: P's name on another of the owner's boxes is not P", () => {
    expect(statusRoute(bob, 'alice-myproj-agent', 'box-b')).toBe('recheck');
    expect(statusRoute(bob, 'alice-myproj-agent', null)).toBe('recheck');
  });

  it('admits a workstream made since once the scope is re-read', () => {
    expect(statusRoute(bob, 'alice-myproj-new-agent', 'box-a')).toBe('recheck');
    const reread = { ...bob, ...sharedScope([row('p', 'myproj', ['main', 'feature', 'new'])]) };
    expect(statusRoute(reread, 'alice-myproj-new-agent', 'box-a')).toBe('shared');
  });

  it("stops at a revoked share once the scope is re-read", () => {
    expect(statusRoute({ ...bob, ...sharedScope([]) }, 'alice-myproj-agent', 'box-a')).toBeNull();
  });

  it("gives the owner every session of theirs, and nobody else anyone else's", () => {
    const alice = { unixUsername: 'alice', ...sharedScope([]) };
    expect(statusRoute(alice, 'alice-myproj-secret-agent', 'box-a')).toBe('own');
    expect(statusRoute(bob, 'bob-mine-agent', 'box-a')).toBe('own');
    expect(statusRoute(bob, 'carol-x-agent', 'box-a')).toBeNull();
  });

  it("leaves a cloud session's runner to the box check, not the share, even when a sharer's name prefixes it", () => {
    expect(statusRoute(bob, 'alice-claude-runner-s1-abc-r', 'box-a')).toBe('runner');
    expect(statusRoute(bob, 'alice-claude-runner-s1-abc-r', null)).toBe('recheck');
  });
});

describe('sending through a share', () => {
  // The share table as loadSharedScope reads it; a test changes it to commit a change.
  let table: ShareRow[] = [];
  const findMany = vi.mocked(prisma.projectShare.findMany);
  beforeEach(() => {
    table = [row('p', 'myproj', ['main'])];
    findMany.mockReset();
    findMany.mockImplementation((async () => table) as never);
  });

  const holder = (checkedAt: number): ScopeHolder & { unixUsername: string } =>
    ({ userId: 'u-bob', unixUsername: 'bob', ...sharedScope(table), sharedCheckedAt: checkedAt });
  const admitted = (h: ScopeHolder & { unixUsername: string }, session: string) => () => statusRoute(h, session, 'box-a') === 'shared';
  const settle = () => new Promise(r => setTimeout(r, 0));

  it('sends at once on a fresh scope, and reads nothing', () => {
    const bob = holder(Date.now());
    const sent: string[] = [];
    sendThroughShare(bob, admitted(bob, 'alice-myproj-agent'), () => sent.push('p'));
    sendThroughShare(bob, admitted(bob, 'alice-myproj-secret-agent'), () => sent.push('q'));
    expect(sent).toEqual(['p']);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not send a revoked share the push that finds its scope stale", async () => {
    const bob = holder(0);
    table = [];
    const sent: string[] = [];
    sendThroughShare(bob, admitted(bob, 'alice-myproj-agent'), () => sent.push('p'));
    expect(sent).toEqual([]);
    await settle();
    expect(sent).toEqual([]);
    expect(bob.sharedStatusKeys.size).toBe(0);
  });

  it('sends pushes held behind a read in the order they came', async () => {
    const bob = holder(0);
    const sent: string[] = [];
    for (const n of ['1', '2', '3']) sendThroughShare(bob, admitted(bob, 'alice-myproj-agent'), () => sent.push(n));
    expect(sent).toEqual([]);
    await settle();
    expect(sent).toEqual(['1', '2', '3']);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('a share change reads again after the read in flight, and later pushes wait for it', async () => {
    const bob = holder(0);
    const sent: string[] = [];
    // A read starts on the old table...
    let releaseOld!: () => void;
    findMany.mockImplementationOnce((() => new Promise(r => { releaseOld = () => r([row('p', 'myproj', ['main'])] as never); })) as never);
    sendThroughShare(bob, admitted(bob, 'alice-myproj-agent'), () => sent.push('before'));
    await settle();
    // ...then the revoke commits and is announced.
    table = [];
    const reread = startSharedRefresh(bob, bob.sharedRefresh);
    sendThroughShare(bob, admitted(bob, 'alice-myproj-agent'), () => sent.push('after'));
    releaseOld();
    await reread;
    await settle();
    expect(sent).toEqual(['before']);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the read fails, keeping the owners for the next re-read', async () => {
    const bob = holder(0);
    findMany.mockRejectedValueOnce(new Error('db down'));
    const sent: string[] = [];
    sendThroughShare(bob, admitted(bob, 'alice-myproj-agent'), () => sent.push('p'));
    await settle();
    expect(sent).toEqual([]);
    expect(statusRoute(bob, 'alice-myproj-agent', 'box-a')).toBe('recheck');
    expect(bob.sharedRefresh).toBeUndefined();
  });
});

describe('share changes', () => {
  it('reach the listener, and touch the collaborator or everyone on the project', () => {
    const seen: unknown[] = [];
    setShareChangeCallback(c => seen.push(c));
    notifyShareChange({ userId: 'u-bob' });
    setShareChangeCallback(null);
    notifyShareChange({ userId: 'u-carol' });
    expect(seen).toEqual([{ userId: 'u-bob' }]);

    const viewer = { userId: 'u-bob', sharedProjectIds: new Set(['p']) };
    expect(shareChangeTouches({ userId: 'u-bob' }, viewer)).toBe(true);
    expect(shareChangeTouches({ userId: 'u-carol' }, viewer)).toBe(false);
    expect(shareChangeTouches({ projectId: 'p' }, viewer)).toBe(true);
    expect(shareChangeTouches({ projectId: 'q' }, viewer)).toBe(false);
  });

  it('send what the re-read admits and clear what it drops', () => {
    const before = new Set(['box-a|alice-p-agent', 'box-a|alice-q-agent']);
    const after = new Set(['box-a|alice-p-agent', 'box-b|carol-r-agent']);
    const statuses: [string, string][] = [
      ['box-a|alice-p-agent', 'working'], ['box-a|alice-q-agent', 'idle'],
      ['box-b|carol-r-agent', 'waiting'], ['box-c|dave-s-agent', 'working'],
    ];
    // P was already in scope, so it is not sent again; Q was revoked; R is new.
    expect(shareChangeFrames(before, after, statuses)).toEqual({
      admitted: [['box-b|carol-r-agent', 'waiting']],
      gone: ['box-a|alice-q-agent'],
    });
    // A read that failed closed drops everything.
    expect(shareChangeFrames(before, new Set(), statuses).gone).toEqual([...before]);
  });
});
