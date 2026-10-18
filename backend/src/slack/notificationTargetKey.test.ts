import { describe, it, expect } from 'vitest';
import { notificationCacheKey, targetsForInstance } from './notificationTargetKey';

const session = 'alice-cx-agent';

describe('notification targets by instance', () => {
  const rows = [
    { tmuxSession: session, platform: 'slack', instanceId: '', channel: 'legacy', userId: 'u' },
    { tmuxSession: session, platform: 'slack', instanceId: 'box-a', channel: 'chan-a', userId: 'u' },
    { tmuxSession: session, platform: 'slack', instanceId: 'box-b', channel: 'chan-b', userId: 'u' },
  ];

  it('gives each box its own key and leaves an unscoped row on the legacy key', () => {
    expect(notificationCacheKey(session, 'slack', 'box-a'))
      .not.toBe(notificationCacheKey(session, 'slack', 'box-b'));
    expect(notificationCacheKey(session, 'slack', null))
      .toBe(notificationCacheKey(session, 'slack', undefined));
    expect(targetsForInstance(rows, session, null).map(r => r.channel)).toEqual(['legacy']);
    expect(targetsForInstance(rows, session, 'box-a').map(r => r.channel)).toEqual(['chan-a']);
    expect(targetsForInstance(rows, session, 'box-b').map(r => r.channel)).toEqual(['chan-b']);
  });

  it('falls back to a legacy row only when that box has no target of its own', () => {
    const rows = [
      { tmuxSession: session, platform: 'slack', instanceId: '', channel: 'legacy', userId: 'u' },
      { tmuxSession: session, platform: 'discord', instanceId: '', channel: 'legacy-d', userId: 'u' },
      { tmuxSession: session, platform: 'slack', instanceId: 'box-b', channel: 'chan-b', userId: 'u' },
    ];
    expect(targetsForInstance(rows, session, 'box-a').map(r => r.channel).sort())
      .toEqual(['legacy', 'legacy-d']);
    expect(targetsForInstance(rows, session, 'box-b').map(r => r.channel).sort())
      .toEqual(['chan-b', 'legacy-d']);
    expect(targetsForInstance(rows, session, null).map(r => r.channel).sort())
      .toEqual(['legacy', 'legacy-d']);
  });
});