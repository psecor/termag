import { describe, expect, it } from 'vitest';
import { automationHref, automationState, matchesAutomation, runRowText, shownAutomation } from './automationsView';
import { automation, run } from './automationsView.fixtures';

describe('automationsView', () => {
  it('links to an automation by the id it is given', () => {
    expect(automationHref('p 1')).toBe('/chat/automations/p%201');
    expect(matchesAutomation(automation(), 'a1')).toBe(true);
    expect(matchesAutomation(automation(), 'p1')).toBe(true);
    expect(matchesAutomation(automation(), 'p2')).toBe(false);
  });

  it('says on, off, paused with why, or archived', () => {
    expect(automationState(automation()).label).toBe('On');
    expect(automationState(automation({ enabled: false })).label).toBe('Off');
    const paused = automationState(automation({ pausedReason: 'consecutive_failures' }));
    expect(paused).toMatchObject({ tone: 'paused', label: 'Paused' });
    expect(paused.title).toContain('kept failing');
    expect(automationState(automation({ archived: true, pausedReason: 'box_gone' })).tone).toBe('archived');
  });

  it('words a run row', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(runRowText(run({ trigger: 'manual', durationSec: 60, costUsd: 0.123, changesLabel: '2 commits, pushed' }), 'UTC', now))
      .toMatchObject({ trigger: 'run by hand', state: 'done', took: '1m · $0.12', changes: '2 commits, pushed' });
    expect(runRowText(run({ state: 'skipped', reasonLabel: 'the box was asleep' }), 'UTC', now).state).toBe('skipped: the box was asleep');
    expect(runRowText(run({ state: 'running' }), 'UTC', now)).toMatchObject({ trigger: 'scheduled', state: 'running', took: '' });
  });

  it('shows the detail for this id, else the list entry, never a detail for another id', () => {
    const a = { ...automation(), runs: [] };
    const b = automation({ id: 'a2', projectId: 'p2', projectName: 'other' });
    expect(shownAutomation('p1', a, [b])).toBe(a);
    expect(shownAutomation('p2', a, [b])).toBe(b);
    expect(shownAutomation('p3', a, [b])).toBeNull();
    expect(shownAutomation('a2', null, [b])).toBe(b);
  });
});
