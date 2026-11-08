import { describe, expect, it } from 'vitest';
import { environmentView, formatDuration } from './environmentStatus';
import type { EnvironmentStatus } from '../types';

const base: EnvironmentStatus = {
  state: 'up', file: '.termag/environment.json',
  setup: { state: 'succeeded', startedAt: '2026-10-29T10:00:00Z', durationMs: 151_000 },
  run: { state: 'succeeded', durationMs: 42_000 },
  seed: { state: 'none' },
  ports: [{ name: 'frontend', port: 5174, path: '/termag/', healthy: true }, { name: 'backend', port: 3040, path: '/', healthy: false }],
  secrets: { resolved: ['APP_API_KEY'], missing: ['APP_SDK_KEY'] },
  warnings: ['APP_SDK_KEY is not something termag delivers, so the steps run without it'],
};

describe('environmentView', () => {
  it("shows setup's time beside the app's state, and a dot per port", () => {
    const v = environmentView(base)!;
    expect(v.label).toBe('App up · set up in 2m 31s');
    expect(v.phase).toBe('up');
    expect(v.inFlight).toBe(false);
    expect(v.ports).toEqual([
      { name: 'frontend', port: 5174, healthy: true, url: 'http://localhost:5174/termag/' },
      { name: 'backend', port: 3040, healthy: false, url: 'http://localhost:3040/' },
    ]);
    expect(v.title).toContain('setup: succeeded, 2m 31s');
    expect(v.title).toContain('warning: APP_SDK_KEY');
  });

  it('counts a running setup from when it started, and asks to be polled', () => {
    const v = environmentView({ ...base, state: 'setup', setup: { state: 'running', startedAt: '2026-10-29T10:00:00Z' } }, Date.parse('2026-10-29T10:01:05Z'))!;
    expect(v.label).toBe('Setting up 1m 5s');
    expect(v.phase).toBe('working');
    expect(v.inFlight).toBe(true);
  });

  it('says which step failed', () => {
    expect(environmentView({ ...base, state: 'failed', setup: { state: 'failed', durationMs: 3000 } })!.label).toBe('Setup failed after 3s');
    expect(environmentView({ ...base, state: 'failed', run: { state: 'failed' } })!.label).toBe('App failed to start');
  });

  it('shows nothing for no report, or a checkout with no environment file', () => {
    expect(environmentView(null)).toBeNull();
    expect(environmentView({ ...base, state: 'none' })).toBeNull();
  });

  it('formats durations as people say them', () => {
    expect([formatDuration(400), formatDuration(59_000), formatDuration(61_000), formatDuration(7_260_000)]).toEqual(['1s', '59s', '1m 1s', '2h 1m']);
  });
});

describe('environmentView: a held environment', () => {
  it("says it is held for its owner to read and run, and isn't in flight", () => {
    const v = environmentView({ ...base, state: 'held', setup: { state: 'none' }, run: { state: 'none' }, ports: [] })!;
    expect(v.label).toBe('Held: read it, then termag-env up');
    expect(v.phase).toBe('idle');
    expect(v.inFlight).toBe(false);
    expect(v.title).toMatch(/a version of the environment someone else wrote/);
    expect(v.title).toMatch(/an environment that points at one/);
    expect(v.title).toMatch(/a repository's own environment file/);
  });
});

// Bugbot on #998 (9df5afe2): an app the box found on ::1 alone is linked there, as Share opens it.
describe('environmentView: a port on ::1', () => {
  it('links it at [::1]', () => {
    const v = environmentView({ ...base, ports: [{ name: 'frontend', port: 5174, path: '/termag/', healthy: true, host: '::1' }] })!;
    expect(v.ports[0].url).toBe('http://[::1]:5174/termag/');
  });
});


