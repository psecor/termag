import { afterEach, describe, expect, it, vi } from 'vitest';
import { debugEnabled, debugLog, debugTagsFromEnv, resetDebugLogForTests } from './debugLog';

afterEach(() => {
  resetDebugLogForTests();
  vi.restoreAllMocks();
});

describe('debugTagsFromEnv', () => {
  it('reads a comma list of tags, case-insensitively, and all/1/* as everything', () => {
    expect(debugTagsFromEnv('status, gh-authz')).toEqual(new Set(['STATUS', 'GH-AUTHZ']));
    expect(debugTagsFromEnv(undefined)).toEqual(new Set());
    expect(debugTagsFromEnv('')).toEqual(new Set());
    for (const all of ['all', 'ALL', '1', '*', 'STATUS,all']) expect(debugTagsFromEnv(all)).toBe('all');
  });
});

describe('debugLog', () => {
  it('prints nothing with TERMAG_DEBUG unset, and does not build the message', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const message = vi.fn(() => 'Push s1 to 3 clients');
    expect(debugEnabled('STATUS', {})).toBe(false);
    debugLog('STATUS', message);
    expect(message).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('prints a tagged line for a listed tag only', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(debugEnabled('status', { TERMAG_DEBUG: 'STATUS' })).toBe(true);
    debugLog('STATUS', () => 'Push s1 to 3 clients');
    debugLog('GH-AUTHZ', () => 'ada GET /repos allowed');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[STATUS] Push s1 to 3 clients');
  });
});
