import { describe, expect, it } from 'vitest';
import { chatTrust, chatTurnMode, followUpMode } from './chatTrust';

describe('followUpMode', () => {
  it('caps a trusted turn in an automation run workstream at auto, or read-only without the runner capability', () => {
    expect(followUpMode('bypassPermissions', 'run-20261020-0900', true)).toBe('auto');
    expect(followUpMode('bypassPermissions', 'run-20261020-0900-2', false)).toBe('dontAsk');
    expect(followUpMode('bypassPermissions', 'main', true)).toBe('bypassPermissions');
    expect(followUpMode('bypassPermissions', 'feat-x', false)).toBe('bypassPermissions');
    expect(followUpMode('dontAsk', 'run-20261020-0900', true)).toBe('dontAsk');
  });
});

describe('chatTrust', () => {
  const at = new Date('2026-10-16T00:00:00Z');

  it('stays read-only for every owner, including the org repos, until the owner ticks trust', () => {
    for (const repoUrl of [
      'https://github.com/example-org/webapp.git',
      'https://github.com/example-team/termag',
      'git@github.com:example-org/webapp.git',
      'https://github.com/e2e-org/sample',
      'https://github.com/example-org-evil/x',
      'https://example.com/example-org/x.git',
      null,
    ]) {
      expect(chatTrust({ repoUrl, chatTrustedAt: null }))
        .toEqual({ trusted: false, reason: null, mode: 'dontAsk' });
    }
  });

  it('trusts a ticked project, whatever its repository URL is', () => {
    expect(chatTrust({ repoUrl: 'https://github.com/example-org/webapp.git', chatTrustedAt: at }))
      .toEqual({ trusted: true, reason: 'trusted', mode: 'bypassPermissions' });
    expect(chatTrust({ repoUrl: 'https://github.com/e2e-org/sample', chatTrustedAt: at }))
      .toEqual({ trusted: true, reason: 'trusted', mode: 'bypassPermissions' });
    expect(chatTrust({ repoUrl: null, chatTrustedAt: at }))
      .toEqual({ trusted: true, reason: 'trusted', mode: 'bypassPermissions' });
  });
});

describe('chatTurnMode', () => {
  const at = new Date('2026-10-16T00:00:00Z');
  const org = { repoUrl: 'https://github.com/example-org/webapp.git', chatTrustedAt: null };
  const orgTicked = { repoUrl: 'https://github.com/example-team/termag', chatTrustedAt: at };
  const ticked = { repoUrl: 'https://github.com/e2e-org/sample', chatTrustedAt: at };
  const noRepo = { repoUrl: null, chatTrustedAt: at };
  const noRepoUnticked = { repoUrl: null, chatTrustedAt: null };
  const untrusted = { repoUrl: 'https://github.com/e2e-org/sample', chatTrustedAt: null };
  const pull = { pullHead: true, fork: false };
  const fork = { pullHead: false, fork: true };
  const own = { pullHead: false, fork: false };

  it('keeps a fork or pull-request workstream read-only even after the tick', () => {
    expect(chatTurnMode(orgTicked, pull)).toBe('dontAsk');
    expect(chatTurnMode(orgTicked, fork)).toBe('dontAsk');
    expect(chatTurnMode(ticked, pull)).toBe('dontAsk');
    expect(chatTurnMode(ticked, fork)).toBe('dontAsk');
    expect(chatTurnMode(noRepo, pull)).toBe('dontAsk');
    expect(chatTurnMode(noRepo, fork)).toBe('dontAsk');
  });

  it('gives a ticked project own tree the trusted surface, and never raises an unticked project', () => {
    expect(chatTurnMode(org, own)).toBe('dontAsk');
    expect(chatTurnMode(orgTicked, own)).toBe('bypassPermissions');
    expect(chatTurnMode(ticked, own)).toBe('bypassPermissions');
    expect(chatTurnMode(noRepo, own)).toBe('bypassPermissions');
    expect(chatTurnMode(noRepoUnticked, own)).toBe('dontAsk');
    expect(chatTurnMode(untrusted, own)).toBe('dontAsk');
    expect(chatTurnMode(untrusted, pull)).toBe('dontAsk');
  });
});
