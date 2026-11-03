import { describe, expect, it, vi } from 'vitest';
import { spaceCreateActions, spaceHeadMenuActions } from './spaceMenu';

const act = (label: string) => ({ label, onSelect: vi.fn() });

describe('spaceHeadMenuActions', () => {
  it('orders a space head\'s ⋮: what it starts, the space\'s own actions (Share), then its tab actions', () => {
    const create = [act('New agent'), act('New tab')];
    const tabs = [act('Close all tabs'), act('Close file tabs')];
    expect(spaceHeadMenuActions({ create, tabs }).map(a => a.label)).toEqual(['New agent', 'New tab', 'Close all tabs', 'Close file tabs']);
    // Share space… goes in at index 2 as its own section.
    expect(spaceHeadMenuActions({ create, space: [act('Share space…')], tabs }).map(a => a.label))
      .toEqual(['New agent', 'New tab', 'Share space…', 'Close all tabs', 'Close file tabs']);
  });
});

describe('spaceCreateActions', () => {
  it('gives No space New agent and New tab too, its New tab the agents in no space', () => {
    const newTab = vi.fn();
    const actions = spaceCreateActions(null, { canStart: true, newAgent: vi.fn(), newTab });
    expect(actions.map(a => [a.label, a.hint])).toEqual([['New agent', 'A session with no space'], ['New tab', 'Browse your agents in no space']]);
    actions[1].onSelect();
    expect(newTab).toHaveBeenCalled();
    expect(spaceCreateActions('notes', { canStart: true, newAgent: vi.fn(), newTab }).map(a => a.label)).toEqual(['New agent', 'New tab']);
  });

  it('adds New automation after New agent when given, disabled where the person can\'t start agents', () => {
    const newAutomation = vi.fn();
    const inSpace = spaceCreateActions('notes', { canStart: true, newAgent: vi.fn(), newTab: vi.fn(), newAutomation });
    expect(inSpace.map(a => a.label)).toEqual(['New agent', 'New automation', 'New tab']);
    inSpace[1].onSelect();
    expect(newAutomation).toHaveBeenCalled();
    expect(spaceCreateActions('notes', { canStart: false, newAgent: vi.fn(), newTab: vi.fn(), newAutomation })[1].disabled).toBe(true);
    expect(spaceCreateActions(null, { canStart: true, newAgent: vi.fn(), newTab: vi.fn(), newAutomation }).map(a => a.label))
      .toEqual(['New agent', 'New automation', 'New tab']);
  });
});
