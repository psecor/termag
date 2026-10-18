import { describe, it, expect } from 'vitest';
import { quickKeys } from './quickKeys';

describe('quickKeys', () => {
  it("offers Devin's approval digits while its review pane is waiting", () => {
    const labels = quickKeys('devin', 'waiting', null).map(k => k.label);
    expect(labels.slice(0, 8)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(labels).toContain('Enter');
    expect(quickKeys('devin', 'working', null).map(k => k.label)).toEqual(['Enter', 'Esc', '↑', '↓', '^C']);
  });
  it("keeps Claude's three permission digits", () => {
    expect(quickKeys('claude', 'waiting', 'approval').map(k => k.label).slice(0, 3)).toEqual(['1', '2', '3']);
  });
});
