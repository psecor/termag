import { describe, it, expect } from 'vitest';
import { channelNameFor, legacyChannelNameFor, matchChannelTarget, ChannelProjectLike } from './channels';

function proj(over: Partial<ChannelProjectLike> & { id: string; name: string }): ChannelProjectLike {
  return {
    userId: 'u-alice',
    user: { unixUsername: 'alice' },
    workstreams: [{ name: 'main' }],
    ...over,
  };
}

describe('channelNameFor', () => {
  it('collapses main and mirrors the tmux naming minus the role', () => {
    expect(channelNameFor('alice', 'termag')).toBe('proj-alice-termag');
    expect(channelNameFor('alice', 'termag', 'main')).toBe('proj-alice-termag');
    expect(channelNameFor('alice', 'termag', 'slack-app')).toBe('proj-alice-termag-slack-app');
  });

  it('slugifies to Slack-legal names', () => {
    expect(channelNameFor('Alice', 'My Project', 'Feat.1')).toBe('proj-alice-my-project-feat-1');
    expect(channelNameFor('a', 'x'.repeat(100)).length).toBe(80);
  });

  it('legacy form has no username', () => {
    expect(legacyChannelNameFor('termag')).toBe('proj-termag');
  });
});

describe('matchChannelTarget', () => {
  const alice = proj({ id: 'p1', name: 'termag', workstreams: [{ name: 'main' }, { name: 'slack-app' }] });
  const bob = proj({ id: 'p2', name: 'termag', userId: 'u-bob', user: { unixUsername: 'bob' } });

  it('matches a main-workstream channel by canonical name', () => {
    expect(matchChannelTarget('proj-alice-termag', [alice, bob]))
      .toEqual({ projectId: 'p1', workstream: 'main' });
    expect(matchChannelTarget('proj-bob-termag', [alice, bob]))
      .toEqual({ projectId: 'p2', workstream: 'main' });
  });

  it('matches a workstream channel, including hyphenated workstream names', () => {
    expect(matchChannelTarget('proj-alice-termag-slack-app', [alice, bob]))
      .toEqual({ projectId: 'p1', workstream: 'slack-app' });
  });

  it('does not match an unknown workstream', () => {
    expect(matchChannelTarget('proj-alice-termag-nope', [alice, bob])).toBeNull();
  });

  it('falls back to the legacy #proj-<project> form, preferring the invoking user', () => {
    expect(matchChannelTarget('proj-termag', [alice, bob], 'u-bob'))
      .toEqual({ projectId: 'p2', workstream: 'main' });
    expect(matchChannelTarget('proj-termag', [alice, bob], 'u-alice'))
      .toEqual({ projectId: 'p1', workstream: 'main' });
    expect(matchChannelTarget('proj-termag', [alice, bob]))
      .toEqual({ projectId: 'p1', workstream: 'main' });
  });

  it('prefers the canonical form when a legacy name collides with a hyphenated project', () => {
    // Project literally named "alice-termag" owned by bob vs alice's "termag".
    const weird = proj({ id: 'p3', name: 'alice-termag', userId: 'u-bob', user: { unixUsername: 'bob' } });
    expect(matchChannelTarget('proj-alice-termag', [weird, alice], 'u-bob'))
      .toEqual({ projectId: 'p1', workstream: 'main' });
  });

  it('handles hyphenated usernames and project names', () => {
    const p = proj({ id: 'p4', name: 'ic-okr-viewer', userId: 'u-jd', user: { unixUsername: 'j-doe' }, workstreams: [{ name: 'main' }, { name: 'v2-api' }] });
    expect(matchChannelTarget('proj-j-doe-ic-okr-viewer-v2-api', [p]))
      .toEqual({ projectId: 'p4', workstream: 'v2-api' });
  });

  it('ignores channels without the prefix', () => {
    expect(matchChannelTarget('general', [alice])).toBeNull();
    expect(matchChannelTarget('D0123ABC', [alice])).toBeNull();
  });

  it('treats a project with no workstream rows as main-only', () => {
    const p = proj({ id: 'p5', name: 'old', workstreams: [] });
    expect(matchChannelTarget('proj-alice-old', [p])).toEqual({ projectId: 'p5', workstream: 'main' });
  });
});
