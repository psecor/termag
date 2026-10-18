import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  instance: { update: vi.fn(async () => ({})) },
  hostSample: { create: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
  agentSpawn: { count: vi.fn(async () => 1) },
}));
vi.mock('../db', () => ({ prisma }));
vi.mock('./agentRegistry', () => ({
  connectedInstanceIds: vi.fn(() => ['b1']),
  instanceAgentTransport: vi.fn(() => ({ capabilities: ['host-sample-v1'] })),
  sendToInstanceAgent: vi.fn(async (_id: string, cmd: string) => (cmd === 'tmux-list'
    ? { sessions: ['me-proj-agent', 'me-proj-ctrl', 'me-proj-ws-agent', 'me-claude-runner-s1-x-r'] }
    : { diskUsedPct: 50, memUsedPct: 60, load1: 1.5, keptCheckouts: 0, cores: 2, memTotalMb: 3793 })),
}));

import { HOST_SAMPLE_RETENTION_MS, countAgentSessions, sampleHosts } from './hostSamples';

describe('sampleHosts history', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the latest on the box row and writes a history row with live agents', async () => {
    const now = new Date('2026-10-17T12:00:00Z');
    expect(await sampleHosts(now)).toBe(1);
    expect(prisma.instance.update).toHaveBeenCalledTimes(1);
    expect(prisma.hostSample.create.mock.calls[0][0]).toEqual({ data: {
      instanceId: 'b1', at: now, diskUsedPct: 50, memUsedPct: 60, load1: 1.5, cores: 2, memTotalMb: 3793, liveAgents: 2, spawnedLive: 1,
    } });
    expect(prisma.hostSample.deleteMany.mock.calls[0][0]).toEqual({ where: { at: { lt: new Date(now.getTime() - HOST_SAMPLE_RETENTION_MS) } } });
  });

  it('counts agent-role sessions only, and nothing from a reply it cannot read', () => {
    expect(countAgentSessions({ sessions: ['a-agent', 'a-ctrl', 'b-review', 'c-x-agent'] })).toBe(2);
    expect(countAgentSessions(null)).toBeNull();
    expect(countAgentSessions({ sessions: 'nope' })).toBeNull();
  });
});
