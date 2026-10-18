import { describe, expect, it } from 'vitest';
import { SELECTABLE_PROVIDER_IDS } from '../providers/registry';
import { agentChoices, defaultAgentChoice } from './switchAgent';

describe('agentChoices', () => {
  it('offers the selectable agents and marks the running one', () => {
    const choices = agentChoices('claude');
    expect(choices.map(c => c.id)).toEqual(SELECTABLE_PROVIDER_IDS);
    expect(choices.filter(c => c.current).map(c => c.id)).toEqual(['claude']);
    expect(choices.find(c => c.id === 'pi')?.label).toBe('pi');
  });

  it('keeps a no-longer-offered current agent visible, first, as current', () => {
    const choices = agentChoices('codex');
    expect(choices[0]).toMatchObject({ id: 'codex', current: true });
    expect(choices.slice(1).map(c => c.id)).toEqual(SELECTABLE_PROVIDER_IDS);
  });

  it('preselects the first agent that would change something', () => {
    expect(defaultAgentChoice('claude')).not.toBe('claude');
    expect(SELECTABLE_PROVIDER_IDS).toContain(defaultAgentChoice('claude'));
    expect(defaultAgentChoice(null)).toBe(SELECTABLE_PROVIDER_IDS[0]);
  });
});
