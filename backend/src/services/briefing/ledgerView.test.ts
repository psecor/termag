import { describe, expect, it } from 'vitest';
import { indexRow, ledgerIndex, ledgerSession } from './ledgerView';
import type { Ledger, LedgerSession } from './types';

function session(over: Partial<LedgerSession> = {}): LedgerSession {
  return {
    projectId: 'p1', projectName: 'termag', workstream: 'main', access: 'owner', instanceId: 'box1', boxName: 'devbox',
    hostOffline: false, provider: 'claude',
    status: { now: 'waiting', updatedAt: null, waitingReason: 'permission', rateLimited: null, milestone: null },
    activity: { agentMs: 90_000, humanMs: 1_830_000, tokens: 1000, visits: 3, lastVisitAt: null, peakContextTokens: 150_000 },
    digest: {
      branch: 'feat/x',
      commits: [{ sha: 'abc1234', at: '2026-10-10T10:00:00Z', subject: 'feat: the newest' }, { sha: 'def5678', at: '2026-10-10T09:00:00Z', subject: 'fix: older' }],
      transcript: {
        userTurns: 4, firstAt: null, lastAt: null,
        lastUserPrompts: ['first', `  the   last\n${'x'.repeat(300)}`],
        lastAssistantText: 'Should I merge it?', endsWithQuestion: true,
        todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'in_progress' }],
      },
    },
    paneTail: 'Allow? (y/n)',
    prs: [{ repo: 'o/termag', number: 12, title: 't', url: null, lane: 'checks', laneLabel: 'Checks & bot review', failingChecks: ['ci'], waitingOn: [], blockedBy: null }],
    notes: [],
    ...over,
  };
}

function ledger(sessions: LedgerSession[]): Ledger {
  return {
    window: { since: 's', until: 'u', tz: 'UTC', label: 'l', basis: 'since_last', previousBriefingAt: null },
    generatedAt: 'g',
    totals: { agentMs: 0, humanMs: 0, tokens: 0, sessionsTouched: sessions.length, switches: 0, waitingNow: 0, prsNeedingAttention: 0, keptCheckouts: 0, offlineBoxes: 0 },
    sessions, cloudSessions: [], otherPrs: [], notes: ['n'], trust: 'full trust note',
  };
}

describe('indexRow', () => {
  it('keeps numbers and flags, and cuts the text short', () => {
    const r = indexRow(session());
    expect(r).toMatchObject({
      projectId: 'p1', workstream: 'main', box: 'devbox', status: 'waiting', waitingReason: 'permission',
      agentMin: 2, humanMin: 31, branch: 'feat/x', commitsListed: 2, latestCommit: 'feat: the newest',
      userTurns: 4, endsWithQuestion: true, openTodos: 2, hasDetail: true,
      prs: [{ repo: 'o/termag', number: 12, laneLabel: 'Checks & bot review', failingChecks: 1, needsAttention: true }],
    });
    expect(r.lastPrompt!.startsWith('the last x')).toBe(true);
    expect(r.lastPrompt!.length).toBe(160);
    expect(JSON.stringify(r)).not.toContain('Should I merge it?');
    expect(JSON.stringify(r)).not.toContain('Allow?');
  });

  it('has no detail without a digest or pane tail', () => {
    const r = indexRow(session({ digest: null, paneTail: null }));
    expect(r).toMatchObject({ hasDetail: false, commitsListed: 0, latestCommit: null, lastPrompt: null, openTodos: 0, endsWithQuestion: false });
  });
});

describe('ledgerIndex', () => {
  it('stays far smaller than the ledger on a busy day', () => {
    const many = Array.from({ length: 40 }, (_, i) => session({ workstream: `ws-${i}`, paneTail: 'p'.repeat(3000) }));
    const l = ledger(many);
    const idx = ledgerIndex(l);
    expect(idx.view).toBe('index');
    expect(idx.sessions).toHaveLength(40);
    expect(idx.notes).toEqual(['n']);
    expect(idx.trust).toMatch(/UNTRUSTED.*projectId and workstream/);
    expect(JSON.stringify(idx).length * 4).toBeLessThan(JSON.stringify(l).length);
  });
});

describe('ledgerSession', () => {
  it('finds one session, main by default', () => {
    const l = ledger([session(), session({ workstream: 'feat-x' })]);
    expect(ledgerSession(l, 'p1', null)?.session.workstream).toBe('main');
    expect(ledgerSession(l, 'p1', 'feat-x')).toMatchObject({ view: 'session', session: { workstream: 'feat-x' }, trust: 'full trust note' });
    expect(ledgerSession(l, 'p2', 'main')).toBeNull();
  });
});
