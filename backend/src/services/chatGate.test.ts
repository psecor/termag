import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ via: string; type: string; payload: Record<string, unknown> }> = [];
let projects: Array<{ id: string; archived: boolean; workstreams: { id: string; archived: boolean }[] }> = [];

vi.mock('../db', () => ({
  prisma: {
    project: { findMany: async () => projects },
  },
}));
vi.mock('./agentRegistry', () => ({
  onAgentHello: () => () => {},
  sendToInstanceAgent: async (_instanceId: string, type: string, payload: Record<string, unknown>) => {
    sent.push({ via: 'instance', type, payload });
    if (type === 'chat-sweep') {
      return { keys: [{ chatKey: 'p1--main', projectId: 'p1', workstreamId: 'main' }] };
    }
    return { ok: true };
  },
  sendToAgent: async (_userId: string, type: string, payload: Record<string, unknown>) => {
    sent.push({ via: 'user', type, payload });
    if (type === 'chat-sweep') return { keys: [] };
    return { ok: true };
  },
}));

const { sweepChatsOnHello } = await import('./chatGate');

beforeEach(() => { sent.length = 0; projects = []; });

describe('sweepChatsOnHello', () => {
  it('does not sweep a warm hello that has no user', async () => {
    await sweepChatsOnHello({ userId: null, instanceId: 'box1', capabilities: ['chat-durable-v1'] });
    expect(sent).toEqual([]);
  });

  it('does not sweep an agent that is not durable', async () => {
    await sweepChatsOnHello({ userId: 'u_ada', instanceId: 'box1', capabilities: [] });
    expect(sent).toEqual([]);
  });

  it('sweeps and recovers once the claim names the owner', async () => {
    projects = [{ id: 'p1', archived: false, workstreams: [{ id: 'main', archived: false }] }];
    await sweepChatsOnHello({ userId: 'u_ada', instanceId: 'box1', capabilities: ['chat-durable-v1'] });
    expect(sent.map(s => [s.via, s.type])).toEqual([['instance', 'chat-sweep'], ['instance', 'chat-recover']]);
    expect(sent[1].payload).toEqual({ deadKeys: [] });
  });

  it('names an archived project as dead', async () => {
    projects = [{ id: 'p1', archived: true, workstreams: [{ id: 'main', archived: false }] }];
    await sweepChatsOnHello({ userId: 'u_ada', instanceId: 'box1', capabilities: ['chat-durable-v1'] });
    expect(sent[1].payload).toEqual({ deadKeys: ['p1--main'] });
  });
});
