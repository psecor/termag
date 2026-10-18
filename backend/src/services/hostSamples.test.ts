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
});
