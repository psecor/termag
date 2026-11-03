import { describe, expect, it } from 'vitest';
import { automationSpace, automationsIn, isAutomationShown, searchAutomations } from './automationPlaces';
import { automation } from './automationsView.fixtures';

const spaces = [{ name: 'team' }, { name: 'notes' }];

describe('automationPlaces', () => {
  it('puts an automation in the space it lives in while the user has it, else in no space', () => {
    expect(automationSpace(automation({ spaceName: 'team' }), spaces)).toBe('team');
    expect(automationSpace(automation({ spaceName: null }), spaces)).toBeNull();
    // A sharee outside the owner's space, or a space deleted since.
    expect(automationSpace(automation({ spaceName: 'gone' }), spaces)).toBeNull();
  });

  it('lists a place\'s automations by name, archived ones left out', () => {
    const list = [
      automation({ id: 'a', projectName: 'zeta', spaceName: 'team' }),
      automation({ id: 'b', projectName: 'alpha', spaceName: 'team' }),
      automation({ id: 'c', projectName: 'old', spaceName: 'team', archived: true }),
      automation({ id: 'd', projectName: 'loose', spaceName: null }),
      automation({ id: 'e', projectName: 'orphan', spaceName: 'gone' }),
    ];
    expect(automationsIn(list, 'team', spaces).map(a => a.id)).toEqual(['b', 'a']);
    expect(automationsIn(list, null, spaces).map(a => a.id)).toEqual(['d', 'e']);
    expect(automationsIn(list, 'notes', spaces)).toEqual([]);
    expect(automationsIn(null, 'team', spaces)).toEqual([]);
  });

  it('searches names by every word, and knows its page by either id', () => {
    const list = [automation({ projectName: 'PR babysitter' }), automation({ projectName: 'deps bump' })];
    expect(searchAutomations(list, 'baby pr').map(a => a.projectName)).toEqual(['PR babysitter']);
    expect(searchAutomations(list, ' ')).toEqual([]);
    expect(isAutomationShown(automation({ id: 'a1', projectId: 'p1' }), 'p1')).toBe(true);
    expect(isAutomationShown(automation({ id: 'a1', projectId: 'p1' }), 'a1')).toBe(true);
    expect(isAutomationShown(automation({ id: 'a1', projectId: 'p1' }), null)).toBe(false);
  });
});
