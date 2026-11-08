import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseClaudeUpdatePolicy, parseUpdateMode, resetLoggedModesForTests } from '../claudeUpdatePolicy';
import { modeAuto, modeEnabled } from './gate';

/** The mode table: what enabled and auto answer for what the policy flag serves. */
describe('the mode table', () => {
  afterEach(() => { vi.restoreAllMocks(); resetLoggedModesForTests(); });
  const rows: Array<{ served: string; value: unknown; enabled: boolean; auto: boolean }> = [
    { served: 'off', value: { mode: 'off' }, enabled: false, auto: false },
    { served: 'manual', value: { mode: 'manual' }, enabled: true, auto: false },
    { served: 'auto', value: { mode: 'auto' }, enabled: true, auto: true },
    // No mode is off: the flag serves none, a malformed one, or the flag source is down (the fallback, null).
    { served: 'missing ({})', value: {}, enabled: false, auto: false },
    { served: 'missing (other keys only)', value: { floor: '2.2.0', target: 'latest' }, enabled: false, auto: false },
    { served: 'mode null', value: { mode: null }, enabled: false, auto: false },
    { served: 'malformed ("Auto")', value: { mode: 'Auto' }, enabled: false, auto: false },
    { served: 'malformed (true)', value: { mode: true }, enabled: false, auto: false },
    { served: 'null (flag down)', value: null, enabled: false, auto: false },
  ];
  for (const r of rows) {
    it(`${r.served}: enabled ${r.enabled}, auto ${r.auto}`, () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { mode } = parseClaudeUpdatePolicy(r.value);
      expect(modeEnabled(mode)).toBe(r.enabled);
      expect(modeAuto(mode)).toBe(r.auto);
    });
  }

  it('a missing mode is off, and off keeps the policy\'s floor', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseUpdateMode(undefined, 'x')).toBe('off');
    expect(parseClaudeUpdatePolicy({ floor: '2.2.0' })).toMatchObject({ mode: 'off', floor: '2.2.0' });
    expect(parseClaudeUpdatePolicy(null)).toMatchObject({ mode: 'off', floor: '2.1.308' });
  });
});
