import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLAUDE_UPDATE_POLICY, isClaudeVersion, parseClaudeUpdatePolicy, parseUpdateMode, resetLoggedModesForTests } from './claudeUpdatePolicy';
import { parseCodexUpdatePolicy } from './codexUpdatePolicy';
import { parseDockerUpdatePolicy } from './dockerUpdatePolicy';

describe('parseClaudeUpdatePolicy', () => {
  it('is the defaults for no value, null, an array or a string', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parseClaudeUpdatePolicy(v)).toEqual(DEFAULT_CLAUDE_UPDATE_POLICY);
  });

  it('takes the flag variations as served', () => {
    expect(parseClaudeUpdatePolicy({ floor: '2.1.308', target: 'latest', restart: 'idle', drainSec: 600, forceAfterHours: 24 })).toEqual(DEFAULT_CLAUDE_UPDATE_POLICY);
    expect(parseClaudeUpdatePolicy({ floor: '2.1.308', target: 'stable', restart: 'idle', drainSec: 600, forceAfterHours: 24 }).target).toBe('stable');
  });

  it('takes every valid value of each key', () => {
    expect(parseClaudeUpdatePolicy({ floor: '2.2.0', target: '2.1.312', restart: 'force', drainSec: 0, forceAfterHours: 168 }))
      .toEqual({ mode: 'off', floor: '2.2.0', target: '2.1.312', restart: 'force', drainSec: 0, forceAfterHours: 168 });
    expect(parseClaudeUpdatePolicy({ restart: 'none', drainSec: 3600, forceAfterHours: 1 }))
      .toMatchObject({ restart: 'none', drainSec: 3600, forceAfterHours: 1 });
  });

  it('keeps the default for each bad key, and only that key', () => {
    const cases: Array<[Record<string, unknown>, Partial<typeof DEFAULT_CLAUDE_UPDATE_POLICY>]> = [
      [{ floor: '2.1', target: 'stable' }, { floor: '2.1.308', target: 'stable' }],
      [{ floor: 'v2.1.400' }, { floor: '2.1.308' }],
      [{ floor: '2.1.400; rm -rf ~' }, { floor: '2.1.308' }],
      [{ floor: 2.1 }, { floor: '2.1.308' }],
      [{ target: 'next' }, { target: 'latest' }],
      [{ target: '2.1.312-beta' }, { target: 'latest' }],
      [{ restart: 'now' }, { restart: 'idle' }],
      [{ drainSec: -1 }, { drainSec: 600 }],
      [{ drainSec: 3601 }, { drainSec: 600 }],
      [{ drainSec: 1.5 }, { drainSec: 600 }],
      [{ drainSec: '600' }, { drainSec: 600 }],
      [{ forceAfterHours: 0 }, { forceAfterHours: 24 }],
      [{ forceAfterHours: 169 }, { forceAfterHours: 24 }],
    ];
    for (const [value, expected] of cases) expect(parseClaudeUpdatePolicy(value)).toEqual({ ...DEFAULT_CLAUDE_UPDATE_POLICY, ...expected });
  });

  it('parses over other defaults when given', () => {
    const defaults = { ...DEFAULT_CLAUDE_UPDATE_POLICY, floor: '2.1.400' };
    expect(parseClaudeUpdatePolicy({ floor: 'nope' }, defaults).floor).toBe('2.1.400');
  });
});

describe('the policy\'s mode', () => {
  afterEach(() => { vi.restoreAllMocks(); resetLoggedModesForTests(); });

  it('takes off, manual and auto, and is off when missing, beside the other keys', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const mode of ['off', 'manual', 'auto'] as const) expect(parseClaudeUpdatePolicy({ mode })).toEqual({ ...DEFAULT_CLAUDE_UPDATE_POLICY, mode });
    expect(parseClaudeUpdatePolicy({}).mode).toBe('off');
    expect(parseClaudeUpdatePolicy(null).mode).toBe('off');
    expect(parseClaudeUpdatePolicy({ mode: 'auto', floor: '2.2.0' })).toMatchObject({ mode: 'auto', floor: '2.2.0' });
    // Docker's pinned variation keeps its pin with a mode added.
    expect(parseDockerUpdatePolicy({ mode: 'auto', target: '29.9.3' })).toMatchObject({ mode: 'auto', target: '29.9.3' });
  });

  it('treats a malformed mode as off, keeps the other keys, and logs it once per flag and value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['Auto', 'on', true, 1, ['auto'], { mode: 'auto' }, '']) {
      expect(parseClaudeUpdatePolicy({ mode: bad, floor: '2.2.0' })).toEqual({ ...DEFAULT_CLAUDE_UPDATE_POLICY, floor: '2.2.0', mode: 'off' });
    }
    expect(warn).toHaveBeenCalledTimes(7);
    expect(warn.mock.calls[0][0]).toBe('[TOOL-UPDATE] claude-code-update-policy: mode "Auto" is not off, manual or auto; off');
    parseClaudeUpdatePolicy({ mode: 'Auto' });
    expect(warn).toHaveBeenCalledTimes(7);
    // Another tool's flag is named in its own line.
    parseCodexUpdatePolicy({ mode: 'Auto' });
    expect(warn).toHaveBeenCalledTimes(8);
    expect(warn.mock.calls[7][0]).toContain('codex-update-policy: mode "Auto"');
  });

  it('a missing mode (absent, null, or the flag source\'s null fallback) is off, logged once per flag', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseUpdateMode(undefined, 'x')).toBe('off');
    expect(parseUpdateMode(null, 'x')).toBe('off');
    expect(parseClaudeUpdatePolicy(null).mode).toBe('off');
    expect(parseClaudeUpdatePolicy({}).mode).toBe('off');
    expect(warn.mock.calls.map(c => c[0])).toEqual(['[TOOL-UPDATE] x: no mode; off', '[TOOL-UPDATE] claude-code-update-policy: no mode; off']);
    parseCodexUpdatePolicy(null);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2][0]).toBe('[TOOL-UPDATE] codex-update-policy: no mode; off');
  });
});

describe('isClaudeVersion', () => {
  it('is x.y.z only', () => {
    expect(['2.1.308', '0.0.1', '10.20.300'].every(isClaudeVersion)).toBe(true);
    expect(['2.1', '2.1.308.1', ' 2.1.308', '2.1.308 ', 'latest', '', null, 2].some(isClaudeVersion)).toBe(false);
  });
});
