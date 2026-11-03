import { describe, expect, it } from 'vitest';
import { DEFAULT_CODEX_UPDATE_POLICY, parseCodexUpdatePolicy } from './codexUpdatePolicy';
import { DEFAULT_CLAUDE_UPDATE_POLICY, parseClaudeUpdatePolicy } from './claudeUpdatePolicy';

describe('parseCodexUpdatePolicy', () => {
  it('is the defaults for no value: the advisories\' floor, latest, and no restart', () => {
    for (const v of [undefined, null, [], 'latest', 3]) expect(parseCodexUpdatePolicy(v)).toEqual(DEFAULT_CODEX_UPDATE_POLICY);
    expect(DEFAULT_CODEX_UPDATE_POLICY).toEqual({ floor: '0.131.0', target: 'latest', restart: 'none', drainSec: 600, forceAfterHours: 24 });
  });

  it('takes every valid value of each key', () => {
    expect(parseCodexUpdatePolicy({ floor: '0.165.0', target: '0.166.0', restart: 'idle', drainSec: 0, forceAfterHours: 168 }))
      .toEqual({ floor: '0.165.0', target: '0.166.0', restart: 'idle', drainSec: 0, forceAfterHours: 168 });
    expect(parseCodexUpdatePolicy({ target: 'latest', restart: 'force' })).toMatchObject({ target: 'latest', restart: 'force' });
  });

  it('keeps Codex\'s default for each bad key, never Claude Code\'s', () => {
    expect(parseCodexUpdatePolicy({ floor: '2.1' }).floor).toBe('0.131.0');
    expect(parseCodexUpdatePolicy({ floor: '0.131.0; rm -rf ~' }).floor).toBe('0.131.0');
    expect(parseCodexUpdatePolicy({ restart: 'now' }).restart).toBe('none');
    expect(parseCodexUpdatePolicy({ drainSec: 99999 }).drainSec).toBe(600);
  });

  it('takes no dist-tag Codex does not publish: stable, alpha, a prerelease', () => {
    for (const target of ['stable', 'alpha', 'native', '0.166.0-alpha.6', 'linux-x64']) expect(parseCodexUpdatePolicy({ target }).target).toBe('latest');
  });

  it('leaves Claude Code\'s parser as it was: stable is still a Claude target', () => {
    expect(parseClaudeUpdatePolicy({ target: 'stable' }).target).toBe('stable');
    expect(parseClaudeUpdatePolicy(null)).toEqual(DEFAULT_CLAUDE_UPDATE_POLICY);
  });
});
