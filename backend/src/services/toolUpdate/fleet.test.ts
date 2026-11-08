import { describe, expect, it } from 'vitest';
import { FLEET_IN_FLIGHT, behindReference, compareToReference, hostRefusal, selectFleet, slotsFree, type HostFacts } from './fleet';

const host = (hostKey: string, version: string | null, over: Partial<HostFacts> = {}): HostFacts =>
  ({ hostKey, version, connected: true, capable: true, enabled: true, inFlight: false, floor: '2.1.308', reference: '2.1.312', ...over });

describe('hostRefusal', () => {
  it('is the flag first, then offline, not capable, a run in flight', () => {
    const ok = { connected: true, capable: true, enabled: true, inFlight: false };
    expect(hostRefusal(ok)).toBeNull();
    expect(hostRefusal({ ...ok, enabled: false, connected: false })).toBe('claude_update_off');
    expect(hostRefusal({ ...ok, connected: false, capable: false })).toBe('offline');
    expect(hostRefusal({ ...ok, capable: false, inFlight: true })).toBe('not_capable');
    expect(hostRefusal({ ...ok, inFlight: true })).toBe('run_in_flight');
  });
});

describe('behindReference', () => {
  it('is an exact target, else the newest claude in the fleet', () => {
    expect(behindReference('2.1.400', ['2.1.312'])).toBe('2.1.400');
    expect(behindReference('latest', ['2.1.300', null, '2.1.312', '2.1.308'])).toBe('2.1.312');
    expect(behindReference('stable', [null])).toBeNull();
  });
  it('for dated builds under latest, is the newest day, never a hash order (Bugbot on #1080)', () => {
    const isBuild = (v: unknown): v is string => typeof v === 'string' && /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/.test(v);
    expect(behindReference('latest', ['2026.10.01-9999999', '2026.10.22-27dcf5f', null], isBuild)).toBe('2026.10.22-27dcf5f');
    expect(behindReference('latest', ['2026.10.22-99999ab', '2026.10.01-fffffff', '2026.10.22-0a1b2c3', '2026.10.22-99999ab'], isBuild)).toBe('2026.10.22');
    expect(behindReference('2026.10.22-27dcf5f', ['2026.10.22-99999ab'], isBuild)).toBe('2026.10.22-27dcf5f');
  });
});

describe('a tool whose latest is pinned (the Cursor agent; Bugbot on #1080)', () => {
  const isBuild = (v: unknown): v is string => typeof v === 'string' && /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/.test(v);
  const PIN = '2026.10.22-27dcf5f';
  it('is the pinned build under latest, whatever newer build the fleet has; an exact target still wins', () => {
    expect(behindReference('latest', ['2026.11.02-9f8e7d6', PIN, '2026.10.01-0a1b2c3'], isBuild, PIN)).toBe(PIN);
    expect(behindReference('2026.10.01-0a1b2c3', ['2026.11.02-9f8e7d6'], isBuild, PIN)).toBe('2026.10.01-0a1b2c3');
  });
  it('behind takes only hosts below the pin: one on it is current and one past it is ahead', () => {
    const ref = behindReference('latest', ['2026.11.02-9f8e7d6', PIN, '2026.10.01-0a1b2c3', '2026.10.22-0a1b2c3'], isBuild, PIN);
    const hosts = [
      host('on-pin', PIN, { reference: ref, floor: '2025.09.17-25b418f' }),
      host('ahead', '2026.11.02-9f8e7d6', { reference: ref, floor: '2025.09.17-25b418f' }),
      host('older', '2026.10.01-0a1b2c3', { reference: ref, floor: '2025.09.17-25b418f' }),
      host('same-day', '2026.10.22-0a1b2c3', { reference: ref, floor: '2025.09.17-25b418f' }),
    ];
    expect(selectFleet(hosts, 'behind')).toEqual({ hosts: ['older', 'same-day'], skipped: [] });
  });
});

describe('selectFleet', () => {
  const fleet = [
    host('a', '2.1.300'),
    host('b', '2.1.308'),
    host('c', '2.1.312'),
    host('d', null),
    host('e', '2.1.290', { connected: false }),
    host('f', '2.1.290', { capable: false }),
    host('g', '2.1.290', { inFlight: true }),
    host('h', '2.1.290', { enabled: false }),
  ];

  it('below-floor takes the hosts under the floor, and says why the others under it cannot run', () => {
    expect(selectFleet(fleet, 'below-floor')).toEqual({
      hosts: ['a'],
      skipped: [
        { hostKey: 'd', reason: 'no_inventory' },
        { hostKey: 'e', reason: 'offline' },
        { hostKey: 'f', reason: 'not_capable' },
        { hostKey: 'g', reason: 'run_in_flight' },
        { hostKey: 'h', reason: 'claude_update_off' },
      ],
    });
  });

  it('behind takes everything under the reference; current and ahead hosts are not listed', () => {
    const s = selectFleet([...fleet, host('i', '2.2.0')], 'behind');
    expect(s.hosts).toEqual(['a', 'b']);
    expect(s.skipped.map(x => x.hostKey)).toEqual(['d', 'e', 'f', 'g', 'h']);
  });

  it('compares each host with its own floor', () => {
    const s = selectFleet([host('low', '2.1.310', { floor: '2.1.308' }), host('high', '2.1.310', { floor: '2.1.400' })], 'below-floor');
    expect(s).toEqual({ hosts: ['high'], skipped: [] });
  });

  it('behind with no reference known updates nobody blind: the one case left as unknown_version', () => {
    expect(selectFleet([host('a', '2.1.300', { reference: null })], 'behind')).toEqual({ hosts: [], skipped: [{ hostKey: 'a', reason: 'unknown_version' }] });
  });

  it('says why a host has no version to compare: not installed, unreadable, no inventory', () => {
    const s = selectFleet([
      host('none', null, { inventory: 'not_installed' }),
      host('garbled', null, { inventory: 'version_unreadable' }),
      host('never', null, { inventory: 'no_inventory' }),
      host('unsaid', null),
    ], 'behind');
    expect(s).toEqual({ hosts: [], skipped: [
      { hostKey: 'none', reason: 'not_installed' },
      { hostKey: 'garbled', reason: 'version_unreadable' },
      { hostKey: 'never', reason: 'no_inventory' },
      { hostKey: 'unsaid', reason: 'no_inventory' },
    ] });
  });

  it('a host with no version that also cannot run says why it cannot run, offline first', () => {
    const s = selectFleet([
      host('off', null, { inventory: 'version_unreadable', connected: false }),
      host('flag', null, { inventory: 'not_installed', enabled: false, connected: false }),
      host('old', null, { inventory: 'no_inventory', capable: false }),
    ], 'below-floor');
    expect(s.skipped).toEqual([
      { hostKey: 'off', reason: 'offline' },
      { hostKey: 'flag', reason: 'claude_update_off' },
      { hostKey: 'old', reason: 'not_capable' },
    ]);
  });

  it('all takes every host that can run, its version or none', () => {
    const s = selectFleet(fleet, 'all');
    expect(s.hosts).toEqual(['a', 'b', 'c', 'd']);
    expect(s.skipped.map(x => x.reason)).toEqual(['offline', 'not_capable', 'run_in_flight', 'claude_update_off']);
  });
});

describe('slotsFree', () => {
  it('starts at most ten runs in flight', () => {
    expect(FLEET_IN_FLIGHT).toBe(10);
    expect(slotsFree(0)).toBe(10);
    expect(slotsFree(7)).toBe(3);
    expect(slotsFree(10)).toBe(0);
    expect(slotsFree(12)).toBe(0);
  });
});

describe('compareToReference', () => {
  it('orders x.y.z as compareVersions does', () => {
    expect(Math.sign(compareToReference('2.1.300', '2.1.312')!)).toBe(-1);
    expect(compareToReference('0.166.0', '0.166.0')).toBe(0);
  });
  it('reads another build of the same day as behind, and days by date (Bugbot on #1080)', () => {
    expect(compareToReference('2026.10.22-0a1b2c3', '2026.10.22-27dcf5f')).toBe(-1);
    expect(compareToReference('2026.10.22-99999ab', '2026.10.22-27dcf5f')).toBe(-1);
    expect(compareToReference('2026.10.22-27dcf5f', '2026.10.22-27dcf5f')).toBe(0);
    expect(Math.sign(compareToReference('2026.10.01-9999999', '2026.10.22-0000000')!)).toBe(-1);
    expect(Math.sign(compareToReference('2026.11.01-0000000', '2026.10.22-9999999')!)).toBe(1);
  });
  it('selects a same-day build behind an exact target', () => {
    const h = (hostKey: string, version: string): HostFacts => ({ hostKey, connected: true, capable: true, enabled: true, inFlight: false, version, floor: '2025.09.17-25b418f', reference: '2026.10.22-27dcf5f' });
    expect(selectFleet([h('a', '2026.10.22-0a1b2c3'), h('b', '2026.10.22-27dcf5f'), h('c', '2026.10.22-99999ab')], 'behind').hosts).toEqual(['a', 'c']);
  });
  it('below-floor compares builds by day: another build of the floor\'s day is not below it (Bugbot on #1080)', () => {
    expect(compareToReference('2026.10.22-0a1b2c3', '2026.10.22-27dcf5f', true)).toBe(0);
    expect(Math.sign(compareToReference('2026.10.21-fffffff', '2026.10.22-27dcf5f', true)!)).toBe(-1);
    const h = (hostKey: string, version: string): HostFacts => ({ hostKey, connected: true, capable: true, enabled: true, inFlight: false, version, floor: '2026.10.22-27dcf5f', reference: '2026.10.22-27dcf5f' });
    const hosts = [h('a', '2026.10.22-0a1b2c3'), h('b', '2026.10.21-fffffff'), h('c', '2026.10.22-27dcf5f')];
    expect(selectFleet(hosts, 'below-floor').hosts).toEqual(['b']);
    expect(selectFleet(hosts, 'behind').hosts).toEqual(['a', 'b']);
  });
  it('selects every build of the day, and older days, behind a day-only reference', () => {
    expect(compareToReference('2026.10.22-99999ab', '2026.10.22')).toBe(-1);
    expect(Math.sign(compareToReference('2026.10.01-fffffff', '2026.10.22')!)).toBe(-1);
    expect(Math.sign(compareToReference('2026.11.01-0000000', '2026.10.22')!)).toBe(1);
    const h = (hostKey: string, version: string): HostFacts => ({ hostKey, connected: true, capable: true, enabled: true, inFlight: false, version, floor: '2025.09.17-25b418f', reference: '2026.10.22' });
    expect(selectFleet([h('a', '2026.10.22-0a1b2c3'), h('b', '2026.10.22-99999ab'), h('c', '2026.10.01-fffffff')], 'behind').hosts).toEqual(['a', 'b', 'c']);
  });
});
