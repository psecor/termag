import { describe, expect, it } from 'vitest';
import type { PrOverview, PrThread } from '../services/api';
import { approvalGates } from './approvalGates';

const pr = (extra: Partial<PrOverview> = {}) => ({
  checks: [{ name: 'backend', state: 'passed' as const }, { name: 'Cursor Bugbot', state: 'passed' as const }, { name: 'Cursor Security Agent', state: 'passed' as const }],
  reviewDecision: null, reviews: [], mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', requestedReviewers: [], autoMerge: true, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  ...extra,
}) as unknown as PrOverview;
const thread = (author: string, resolved: boolean): PrThread => ({ id: author + resolved, path: 'a.ts', line: 1, side: 'RIGHT', resolved, outdated: false, comments: [{ id: 'c', author, bot: false, body: 'x', createdAt: null, url: null }] });

describe('approvalGates', () => {
  it('is ready when your threads are resolved and the bots are clean on the head read, and says auto-merge out loud', () => {
    const { gates, ready } = approvalGates(pr(), [thread('e2e-octocat', true), thread('cursor', false)], 'e2e-octocat', 'a1b2c3d');
    expect(ready).toBe(true);
    expect(gates.map(g => [g.key, g.tone])).toEqual([['threads', 'pass'], ['checks', 'pass'], ['bugbot', 'pass'], ['security', 'pass'], ['head', 'pass'], ['automerge', 'warn']]);
  });

  it('holds the approval on an open thread of yours, a running bot or a head that moved', () => {
    expect(approvalGates(pr(), [thread('e2e-octocat', false)], 'e2e-octocat', 'a1b2c3d').ready).toBe(false);
    expect(approvalGates(pr({ checks: [{ name: 'Cursor Security Agent', state: 'pending' }] }), [], 'e2e-octocat', 'a1b2c3d').ready).toBe(false);
    expect(approvalGates(pr(), [], 'e2e-octocat', 'ffffff0').gates.find(g => g.key === 'head')!.tone).toBe('fail');
  });

  it('takes the head the check named in capitals for the same commit', () => {
    expect(approvalGates(pr(), [], 'e2e-octocat', 'A1B2C3D').gates.find(g => g.key === 'head')!.tone).not.toBe('fail');
  });

  it('holds it while it does not know who you are, rather than calling every thread someone else\'s', () => {
    const noViewer = approvalGates(pr(), [thread('e2e-octocat', false)], null, 'a1b2c3d');
    expect(noViewer.ready).toBe(false);
    expect(noViewer.gates.find(g => g.key === 'threads')!.tone).toBe('running');
  });

  it('holds it when the threads could not be read, or the check named no head', () => {
    const unreadable = approvalGates(pr(), 'unreadable', 'e2e-octocat', 'a1b2c3d');
    expect(unreadable.ready).toBe(false);
    expect(unreadable.gates.find(g => g.key === 'threads')).toMatchObject({ tone: 'fail', detail: "Couldn't read them" });
    for (const head of ['', null]) {
      const noHead = approvalGates(pr(), [], 'e2e-octocat', head);
      expect(noHead.ready).toBe(false);
      expect(noHead.gates.find(g => g.key === 'head')!.tone).toBe('fail');
    }
  });
});
