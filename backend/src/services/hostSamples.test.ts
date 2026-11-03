import { describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ prisma: { instance: { update: vi.fn() } } }));
vi.mock('./agentRegistry', () => ({ connectedInstanceIds: vi.fn(() => []), instanceAgentTransport: vi.fn(() => null), sendToInstanceAgent: vi.fn() }));
import { hostSampleData } from './hostSamples';

describe('hostSampleData', () => {
  it('maps a sample onto the box row with the time, and writes nothing for none', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    expect(hostSampleData({ diskUsedPct: 93, memUsedPct: 14, load1: 11.8, keptCheckouts: 1 }, now))
      .toEqual({ diskUsedPct: 93, memUsedPct: 14, load1: 11.8, keptCheckouts: 1, hostSampledAt: now });
    expect(hostSampleData(null, now)).toEqual({});
  });
  it('writes only what the agent could read: a failed df leaves the last disk reading, and its alert, in place', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const data = hostSampleData({ diskUsedPct: null, memUsedPct: 14, load1: 1, keptCheckouts: 0 }, now);
    expect(data).toEqual({ memUsedPct: 14, load1: 1, keptCheckouts: 0, hostSampledAt: now });
    expect('diskUsedPct' in data).toBe(false);
    expect(hostSampleData({ diskUsedPct: null, memUsedPct: null, load1: null, keptCheckouts: null }, now)).toEqual({});
  });
  it('always writes the SSH session count with the time, null included, so a closed session stops counting', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const base = { diskUsedPct: 50, memUsedPct: 14, load1: 1, keptCheckouts: 0, cores: 8, memTotalMb: 32000 };
    expect(hostSampleData({ ...base, sshSessions: 2 }, now)).toMatchObject({ sshSessions: 2, hostSampledAt: now });
    const unknown = hostSampleData({ ...base, sshSessions: null }, now);
    expect('sshSessions' in unknown && unknown.sshSessions).toBe(null);
    const nothingElse = { diskUsedPct: null, memUsedPct: null, load1: null, keptCheckouts: null, cores: null, memTotalMb: null };
    expect(hostSampleData({ ...nothingElse, sshSessions: 1 }, now)).toEqual({ sshSessions: 1, hostSampledAt: now });
    expect(hostSampleData({ ...nothingElse, sshSessions: null }, now)).toEqual({});
  });
  it('always writes the open tunnel count with the time too, null included', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const base = { diskUsedPct: 50, memUsedPct: 14, load1: 1, keptCheckouts: 0, cores: 8, memTotalMb: 32000, sshSessions: 0 };
    expect(hostSampleData({ ...base, openTunnels: 3 }, now)).toMatchObject({ openTunnels: 3, hostSampledAt: now });
    const unknown = hostSampleData({ ...base, openTunnels: null }, now);
    expect('openTunnels' in unknown && unknown.openTunnels).toBe(null);
    const nothingElse = { diskUsedPct: null, memUsedPct: null, load1: null, keptCheckouts: null, cores: null, memTotalMb: null, sshSessions: null };
    expect(hostSampleData({ ...nothingElse, openTunnels: 1 }, now)).toEqual({ sshSessions: null, openTunnels: 1, hostSampledAt: now });
    expect(hostSampleData({ ...nothingElse, openTunnels: null }, now)).toEqual({});
  });
});
