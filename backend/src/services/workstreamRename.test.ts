import { describe, it, expect } from 'vitest';
import { planSessionRenames, validateWorkstreamRename } from './workstreamRename';

describe('validateWorkstreamRename', () => {
  it('accepts a safe new name, trimmed', () => {
    expect(validateWorkstreamRename('feat-x', '  feat-y ')).toEqual({ ok: true, name: 'feat-y' });
  });
  it('rejects unsafe characters, main, and no-ops', () => {
    expect(validateWorkstreamRename('a', 'has space')).toHaveProperty('ok', false);
    expect(validateWorkstreamRename('a', 'slash/y')).toHaveProperty('ok', false);
    expect(validateWorkstreamRename('a', '')).toHaveProperty('ok', false);
    expect(validateWorkstreamRename('a', 42)).toHaveProperty('ok', false);
    expect(validateWorkstreamRename('main', 'other')).toMatchObject({ ok: false, error: expect.stringMatching(/main/) });
    expect(validateWorkstreamRename('a', 'main')).toMatchObject({ ok: false, error: expect.stringMatching(/reserved/) });
    expect(validateWorkstreamRename('a', 'a')).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
  });
});

describe('planSessionRenames', () => {
  it('renames the agent pair for an agent workflow', () => {
    expect(planSessionRenames('me', 'proj', 'old', 'new', ['agent'])).toEqual([
      { role: 'agent', from: 'me-proj-old-agent', to: 'me-proj-new-agent' },
      { role: 'ctrl', from: 'me-proj-old-ctrl', to: 'me-proj-new-ctrl' },
      { role: 'review', from: 'me-proj-old-review', to: 'me-proj-new-review' },
    ]);
  });
  it('renames the data pair for a data workflow and de-duplicates repeated types', () => {
    const plan = planSessionRenames('me', 'proj', 'old', 'new', ['data', 'data', 'agent']);
    expect(plan.map(p => p.role)).toEqual(['data', 'data-ctrl', 'agent', 'ctrl', 'review']);
  });
  it('is empty with no workflows', () => {
    expect(planSessionRenames('me', 'proj', 'old', 'new', [])).toEqual([]);
  });
});
