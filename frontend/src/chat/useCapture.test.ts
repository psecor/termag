import { describe, it, expect } from 'vitest';
import { intervalFor, paneKey } from './useCapture';

describe('intervalFor', () => {
  it('polls fast while working, slowly otherwise', () => {
    expect(intervalFor('working')).toBe(2_000);
    expect(intervalFor('waiting')).toBe(10_000);
    expect(intervalFor('idle')).toBe(30_000);
    expect(intervalFor('not_running')).toBe(30_000);
    expect(intervalFor(undefined)).toBe(30_000);
  });
});

describe('paneKey', () => {
  it('tells panes apart by project, role and workstream', () => {
    const keys = new Set([
      paneKey('p1', 'review', 'main'), paneKey('p1', 'review', 'feat'),
      paneKey('p2', 'review', 'main'), paneKey('p1', 'agent', 'main'),
    ]);
    expect(keys.size).toBe(4);
  });
});
