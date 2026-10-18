import { describe, it, expect } from 'vitest';
import { termagReference, parseVersion, compareVersions, newestVersion, toolState, commitState, hooksFromDetail, hooksState, clientFromHeaders, sortComponents } from './versions';

describe('parseVersion and compareVersions', () => {
  it('reads semver, date-hash, three-thousand-series and two-part versions', () => {
    expect(parseVersion('2.1.300')).toEqual([2, 1, 300]);
    expect(parseVersion('v24.21.0')).toEqual([24, 21, 0]);
    expect(parseVersion('2026.10.01-e373342')).toEqual([2026, 10, 1]);
    expect(parseVersion('3000.11.92')).toEqual([3000, 11, 92]);
    expect(parseVersion('3.5a')).toEqual([3, 5]);
    expect(parseVersion('7.0.0-1013-aws')).toEqual([7, 0, 0, 1013]);
    expect(parseVersion('beta')).toBeNull();
  });
  it('orders numerically, not as text', () => {
    expect(compareVersions('2.1.300', '2.1.99')).toBeGreaterThan(0);
    expect(compareVersions('2026.09.30-aaa', '2026.10.01-bbb')).toBeLessThan(0);
    expect(compareVersions('3.4', '3.4.0')).toBe(0);
    expect(compareVersions('x', 'y')).toBeNull();
    expect(compareVersions('x', 'x')).toBe(0);
  });
  it('picks the newest of a fleet', () => {
    expect(newestVersion(['2.1.290', null, '2.1.300', 'garbage', '2.0.9'])).toBe('2.1.300');
    expect(newestVersion([null, undefined])).toBeNull();
  });
});

describe('toolState', () => {
  it('grades against the fleet reference', () => {
    expect(toolState({ version: '2.1.300', ok: true }, '2.1.300')).toBe('current');
    expect(toolState({ version: '2.1.290', ok: true }, '2.1.300')).toBe('behind');
    expect(toolState({ version: '2.0.9', ok: true }, '2.1.300')).toBe('outdated');
    expect(toolState({ version: '2.2.0', ok: true }, '2.1.300')).toBe('ahead');
  });
  it('separates not installed, unreadable and never reported', () => {
    expect(toolState({ version: null, ok: false, path: null }, '1.0.0')).toBe('missing');
    expect(toolState({ version: null, ok: false, path: '/usr/bin/x' }, '1.0.0')).toBe('unknown');
    expect(toolState(null, '1.0.0')).toBe('unknown');
  });
});

describe('commitState, hooks and clients', () => {
  it('compares commits by prefix', () => {
    expect(commitState('abcdef1234567890', 'abcdef123456ffff')).toBe('current');
    expect(commitState('abcdef1234567890', '1111111111111111')).toBe('behind');
    expect(commitState(null, 'abc')).toBe('unknown');
    expect(commitState('abc', null)).toBe('unknown');
  });
  it('reads the hooks step of a box update', () => {
    expect(hooksFromDetail('pull=pulled:3 reconcile=clean deps=installed agent=restarted hooks=would-update')).toBe('would-update');
    expect(hooksFromDetail('pull=none')).toBeNull();
    expect(hooksState('updated')).toBe('current');
    expect(hooksState('failed')).toBe('outdated');
    expect(hooksState('absent')).toBe('missing');
  });
  it('recognises each client and ignores everything else', () => {
    expect(clientFromHeaders('web/0123456789ab', undefined)).toEqual({ kind: 'web', version: '0123456789ab' });
    expect(clientFromHeaders('mobile/unknown', undefined)).toEqual({ kind: 'mobile', version: 'unknown' });
    expect(clientFromHeaders(undefined, 'termag-cli/0.1.0')).toEqual({ kind: 'cli', version: '0.1.0' });
    expect(clientFromHeaders(undefined, 'termag-tui/0.1.0 node/24')).toEqual({ kind: 'tui', version: '0.1.0' });
    expect(clientFromHeaders(undefined, 'metaterm/0.2.0')).toEqual({ kind: 'metaterm', version: '0.2.0' });
    expect(clientFromHeaders('web/<script>', 'Mozilla/5.0')).toBeNull();
    expect(clientFromHeaders(undefined, 'termag-cli/$(rm)')).toBeNull();
  });
  it('sorts components in display order', () => {
    expect(sortComponents(['kernel', 'zzz', 'claude', 'termag'])).toEqual(['termag', 'claude', 'kernel', 'zzz']);
  });
});

describe('termagReference', () => {
  const t = { boxImageCommit: 'box', orchestratorImageCommit: 'orch', runningCommit: 'run' };
  it('grades boxes against the box image and orchestrator agents against the orchestrator', () => {
    expect(termagReference('box', t)).toBe('box');
    expect(termagReference('orchestrator', t)).toBe('orch');
    expect(termagReference('agent', t)).toBe('orch');
  });
  it('falls back to the running commit with no image', () => {
    const none = { boxImageCommit: null, orchestratorImageCommit: null, runningCommit: 'run' };
    expect(termagReference('box', none)).toBe('run');
    expect(termagReference('agent', none)).toBe('run');
  });
});
