import { describe, expect, it } from 'vitest';
import { canHandOff, defaultHandoffMode, handoffTargets, handoffModeChoices, handoffStateLabel, isHandoffAbortable, showHandoffStrip } from './handoff';
import type { SessionHandoff } from '../types';

const h = (o: Partial<SessionHandoff>): SessionHandoff => ({ id: 'ck1', state: 'requested', mode: 'clear', toProvider: null, reason: null, at: '2026-10-18T12:00:00Z', ...o });
const at = Date.parse('2026-10-18T12:00:00Z');

describe('handoff modes', () => {
  it('offers clear and compact only for an agent that can do them in place', () => {
    expect(handoffModeChoices('claude').map(c => c.available)).toEqual([true, true, true]);
    // pi has /new and /compact of its own.
    expect(handoffModeChoices('pi').map(c => c.available)).toEqual([true, true, true]);
    // Cursor cannot write a handoff, so nothing is offered.
    expect(handoffModeChoices('cursor').map(c => c.available)).toEqual([false, false, false]);
    expect(defaultHandoffMode('claude')).toBe('clear');
    expect(defaultHandoffMode('pi')).toBe('clear');
  });

  it('restarts into any agent that can start on a file, even ones that cannot write a handoff', () => {
    expect(handoffTargets('claude').map(a => a.id)).toEqual(['claude', 'cursor', 'devin', 'pi']);
  });

  it('is not offered for an agent that cannot be handed off', () => {
    expect(canHandOff('claude')).toBe(true);
    expect(canHandOff('codex')).toBe(false);
    // No metaterm tools reach Cursor or Devin, so they cannot write a handoff.
    expect(canHandOff('cursor')).toBe(false);
    expect(canHandOff('devin')).toBe(false);
    expect(canHandOff('claude-chat')).toBe(false);
    expect(canHandOff(null)).toBe(false);
  });
});

describe('the strip', () => {
  it('shows an open handoff, a finished one briefly and a failure for longer', () => {
    expect(showHandoffStrip(h({ state: 'writing' }), at + 60 * 60_000)).toBe(true);
    expect(showHandoffStrip(h({ state: 'done' }), at + 5_000)).toBe(true);
    expect(showHandoffStrip(h({ state: 'done' }), at + 20_000)).toBe(false);
    expect(showHandoffStrip(h({ state: 'failed' }), at + 60_000)).toBe(true);
    expect(showHandoffStrip(null, at)).toBe(false);
  });

  it('offers abort only before the pane is touched', () => {
    expect(isHandoffAbortable(h({ state: 'written' }))).toBe(true);
    expect(isHandoffAbortable(h({ state: 'resetting' }))).toBe(false);
  });

  it('says what is happening, with the reason when it went wrong', () => {
    expect(handoffStateLabel(h({ state: 'resetting', mode: 'restart', toProvider: 'cursor' }))).toBe('Hand off: restarting on Cursor');
    expect(handoffStateLabel(h({ state: 'aborted', reason: 'aborted by the owner' }))).toBe('Hand off aborted: aborted by the owner');
    expect(handoffStateLabel(h({ state: 'writing', reason: 'pi restarts instead' }))).toBe('Hand off: the agent is writing its handoff (pi restarts instead)');
  });
});
