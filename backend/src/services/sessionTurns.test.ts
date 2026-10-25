import { beforeEach, describe, expect, it } from 'vitest';
import { forgetTurns, isDesktopSource, moveTurns, resetTurnsForTests, settle, settleTurnPost, type TurnPost } from './sessionTurns';
import { AUTO_IDLE_MS, HYDRATE_MAX_AGE_MS } from './statusPersistence';

const K = 'box-a|alice-web-agent';
const t3 = (status: TurnPost['status'], threadId?: string, extra: Partial<TurnPost> = {}): TurnPost =>
  ({ status, source: 't3:claude', ...(threadId ? { threadId } : {}), ...extra });
const pane = (status: TurnPost['status'], extra: Partial<TurnPost> = {}): TurnPost => ({ status, ...extra });

describe('sessionTurns: several Claude turns behind one status key', () => {
  beforeEach(() => resetTurnsForTests());

  it('a key no desktop thread posted to is untouched, whatever the pane posts', () => {
    for (const p of [pane('working'), pane('waiting', { message: 'Allow?' }), pane('idle'), pane('working', { source: 'codex-app-server', threadId: 'cx-1' }), pane('idle', { source: 'codex-app-server', threadId: 'cx-2' })]) {
      expect(settleTurnPost(K, p, 1000)).toBe(p);
    }
  });

  it("one thread's Stop does not idle the session while another thread works", () => {
    settleTurnPost(K, t3('working', 'A'), 1000);
    settleTurnPost(K, t3('working', 'B'), 2000);
    expect(settleTurnPost(K, t3('idle', 'A'), 3000)).toEqual({ status: 'working', source: 't3:claude' });
    const last = t3('idle', 'B');
    expect(settleTurnPost(K, last, 4000)).toBe(last);
  });

  it("the pane's Stop does not idle the session while a thread works, and a thread's Stop not while the pane works", () => {
    settleTurnPost(K, t3('working', 'A'), 1000);
    expect(settleTurnPost(K, pane('idle'), 2000)).toEqual({ status: 'working', source: 't3:claude' });
    expect(settleTurnPost(K, t3('idle', 'A'), 3000).status).toBe('idle');

    settleTurnPost(K, pane('working'), 4000);
    settleTurnPost(K, t3('working', 'A'), 5000);
    expect(settleTurnPost(K, t3('idle', 'A'), 6000)).toEqual({ status: 'working', source: undefined });
    expect(settleTurnPost(K, pane('idle'), 7000).status).toBe('idle');
  });

  it('working wins over waiting; the waiting turn shows once nothing works', () => {
    settleTurnPost(K, t3('working', 'A'), 1000);
    expect(settleTurnPost(K, t3('waiting', 'B', { message: 'Claude needs your permission', waitingReason: 'approval' }), 2000).status).toBe('working');
    expect(settleTurnPost(K, t3('idle', 'A'), 3000)).toEqual({
      status: 'waiting', source: 't3:claude', message: 'Claude needs your permission', waitingReason: 'approval',
    });
    // B goes on: working again, then done.
    expect(settleTurnPost(K, t3('working', 'B'), 4000).status).toBe('working');
    expect(settleTurnPost(K, t3('idle', 'B'), 5000).status).toBe('idle');
  });

  it("a pane that waits while a thread works stays waiting underneath, and wins once the thread stops", () => {
    settleTurnPost(K, t3('working', 'A'), 1000);
    const asks = pane('waiting', { message: 'Allow Bash?' });
    expect(settleTurnPost(K, asks, 2000).status).toBe('working');
    expect(settleTurnPost(K, t3('idle', 'A'), 3000)).toEqual({ status: 'waiting', source: undefined, message: 'Allow Bash?', waitingReason: undefined });
  });

  it('a working turn stops counting after the auto-idle window; a waiting one lasts a day', () => {
    settleTurnPost(K, t3('working', 'A'), 0);
    expect(settleTurnPost(K, t3('idle', 'B'), AUTO_IDLE_MS + 1).status).toBe('idle');

    settleTurnPost(K, t3('waiting', 'C', { message: 'm' }), 0);
    expect(settleTurnPost(K, t3('idle', 'D'), HYDRATE_MAX_AGE_MS - 1).status).toBe('waiting');
    expect(settleTurnPost(K, t3('idle', 'D'), HYDRATE_MAX_AGE_MS + 1).status).toBe('idle');
  });

  it('a desktop post without a thread id: working passes as it is, anything else ends every desktop turn', () => {
    settleTurnPost(K, t3('working', 'A'), 1000);
    const pre = t3('working');
    expect(settleTurnPost(K, pre, 2000)).toBe(pre);
    // An older Stop hook line (`termag-status idle`, no stdin): taken as the session's word.
    expect(settleTurnPost(K, t3('idle'), 3000).status).toBe('idle');
    expect(settleTurnPost(K, t3('idle', 'B'), 4000).status).toBe('idle');
  });

  it('an anonymous desktop idle leaves a working pane working', () => {
    settleTurnPost(K, pane('working'), 1000);
    settleTurnPost(K, t3('working', 'A'), 1500);
    expect(settleTurnPost(K, t3('idle'), 2000)).toEqual({ status: 'working', source: undefined });
  });

  it("an anonymous desktop working post (PreToolUse) keeps the key's working threads from going stale", () => {
    settleTurnPost(K, t3('working', 'A'), 0);
    settleTurnPost(K, t3('working'), AUTO_IDLE_MS - 1);
    expect(settleTurnPost(K, t3('idle', 'B'), AUTO_IDLE_MS + 10)).toEqual({ status: 'working', source: 't3:claude' });
    // ...and only working ones: a waiting thread is not made working by it.
    resetTurnsForTests();
    settleTurnPost(K, t3('waiting', 'W', { message: 'Allow?' }), 0);
    expect(settleTurnPost(K, t3('working'), 1000).status).toBe('working');
    expect(settleTurnPost(K, t3('idle', 'B'), 2000).status).toBe('waiting');
  });

  it('moveTurns carries a renamed session\'s turns to its new key', () => {
    const K2 = 'box-a|alice-web2-agent';
    settleTurnPost(K, t3('working', 'A'), 1000);
    moveTurns(K, K2);
    expect(settleTurnPost(K2, t3('idle', 'B'), 2000)).toEqual({ status: 'working', source: 't3:claude' });
    expect(settleTurnPost(K, t3('idle', 'B'), 3000).status).toBe('idle');
    // A key with no turns leaves none behind at the new name either.
    settleTurnPost('box-a|other-agent', t3('working', 'Z'), 1000);
    moveTurns('box-a|nothing-agent', 'box-a|other-agent');
    expect(settleTurnPost('box-a|other-agent', pane('idle'), 2000).status).toBe('idle');
  });

  it('keys are separate, and forgetTurns drops a deleted session', () => {
    settleTurnPost(K, t3('working', 'A'), 1000);
    expect(settleTurnPost('box-b|alice-web-agent', t3('idle', 'B'), 2000).status).toBe('idle');
    forgetTurns(K);
    expect(settleTurnPost(K, t3('idle', 'B'), 3000).status).toBe('idle');
  });

  it('an unusable thread id counts as none', () => {
    const { table } = settle(undefined, t3('working', 'x'.repeat(201)), 0);
    expect(table.size).toBe(0);
  });

  it('isDesktopSource', () => {
    expect(isDesktopSource('t3:claude')).toBe(true);
    expect(isDesktopSource('claude-hooks')).toBe(false);
    expect(isDesktopSource(undefined)).toBe(false);
  });
});
