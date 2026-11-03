import { describe, expect, it } from 'vitest';
import { DEFAULT_CLAUDE_UPDATE_POLICY, isClaudeVersion, parseClaudeUpdatePolicy } from './claudeUpdatePolicy';

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
      .toEqual({ floor: '2.2.0', target: '2.1.312', restart: 'force', drainSec: 0, forceAfterHours: 168 });
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

describe('isClaudeVersion', () => {
  it('is x.y.z only', () => {
    expect(['2.1.308', '0.0.1', '10.20.300'].every(isClaudeVersion)).toBe(true);
    expect(['2.1', '2.1.308.1', ' 2.1.308', '2.1.308 ', 'latest', '', null, 2].some(isClaudeVersion)).toBe(false);
  });
});
