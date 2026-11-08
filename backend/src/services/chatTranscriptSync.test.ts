/**
 * The connect backfill against a box with many chats: it reads a few chats at
 * a time in small reads, so a chat the person is using still gets its turn on
 * the box's socket, and every chat is still stored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hello: null as null | ((ev: unknown) => void),
  turnEnd: null as null | ((seen: unknown) => void),
  workstreams: [] as Array<{ id: string; projectId: string; ask?: boolean; box?: string }>,
  reads: [] as Array<{ chatKey: string; maxBytes: number; done: (answer: unknown) => void }>,
}));

vi.mock('../db', () => ({
  prisma: {
    workstream: {
      findMany: vi.fn(async () => h.workstreams),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const ws = h.workstreams.find(w => w.id === where.id);
        return ws && { projectId: ws.projectId, askThread: ws.ask ? { id: 't1' } : null, workflows: [{ provider: 'claude-chat' }], project: { instanceId: ws.box ?? 'box-1', user: { id: 'u1' } } };
      }),
    },
  },
}));
vi.mock('./agentRegistry', () => ({
  instanceAgentTransport: () => ({ capabilities: ['chat-transcript-v1'] }),
  onBoxAgentHello: (l: (ev: unknown) => void) => { h.hello = l; return () => {}; },
  sendToInstanceAgent: (_id: string, _type: string, p: { chatKey: string; maxBytes: number }) =>
    new Promise(done => { h.reads.push({ chatKey: p.chatKey, maxBytes: p.maxBytes, done }); }),
}));
vi.mock('./chatRunner', () => ({
  chatKeyFor: (p: string, w: string) => `${p}--${w}`,
  onChatEvent: (l: (seen: unknown) => void) => { h.turnEnd = l; return () => {}; },
}));
vi.mock('./chatTranscriptStore', () => ({
  getTranscriptStoreConfig: () => ({ plaintext: true }),
  transcriptHead: async () => null,
  appendChunk: vi.fn(),
  resetSession: vi.fn(),
}));

import { prisma } from '../db';
import { startChatTranscriptSync } from './chatTranscriptSync';

const tick = () => new Promise(r => setTimeout(r, 0));
const nothingYet = { sessionId: null };

describe('connect backfill', () => {
  beforeEach(() => {
    h.reads = [];
    h.workstreams = Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, projectId: `p${i}` }));
    startChatTranscriptSync();
  });

  it('reads a few chats at a time, in small reads, and still reaches every chat', async () => {
    h.hello!({ instance: { id: 'box-1', name: 'box-1' }, capabilities: ['chat-transcript-v1'], settled: Promise.resolve() });
    const seen = new Set<string>();
    for (let round = 0; round < 20 && seen.size < 10; round++) {
      for (let i = 0; i < 5; i++) await tick();
      expect(h.reads.length).toBeLessThanOrEqual(2);
      for (const r of h.reads.splice(0)) {
        expect(r.maxBytes).toBeLessThanOrEqual(1024 * 1024);
        seen.add(r.chatKey);
        r.done(nothingYet);
      }
    }
    expect(seen.size).toBe(10);
  });

  it('a turn end on the chat in use reads at once while the backfill is under way', async () => {
    h.workstreams.push({ id: 'live', projectId: 'pl' });
    h.hello!({ instance: { id: 'box-1', name: 'box-1' }, capabilities: ['chat-transcript-v1'], settled: Promise.resolve() });
    for (let i = 0; i < 5; i++) await tick();
    h.turnEnd!({ instanceId: 'box-1', projectId: 'pl', workstreamId: 'live', event: { type: 'turn-end' } });
    for (let i = 0; i < 5; i++) await tick();
    expect(h.reads.map(r => r.chatKey)).toContain('pl--live');
    for (const r of h.reads.splice(0)) r.done(nothingYet);
  });
});

// An ask's thread is a chat on its target project (agent/ask-chat.js), opened
// in the simple UI like any other: its transcript is stored too, so a tab on a
// stopped ask box shows it instead of starting the box.
describe('an ask thread\'s chat', () => {
  beforeEach(() => {
    h.reads = [];
    // Its own box: the first describe's backfill of box-1 is left mid-way.
    h.workstreams = [{ id: 'ask-ws', projectId: 'pa', ask: true, box: 'box-ask' }];
    startChatTranscriptSync();
  });

  it('is stored at its turn end', async () => {
    h.turnEnd!({ instanceId: 'box-ask', projectId: 'pa', workstreamId: 'ask-ws', event: { type: 'turn-end' } });
    for (let i = 0; i < 5; i++) await tick();
    expect(h.reads.map(r => r.chatKey)).toEqual(['pa--ask-ws']);
    for (const r of h.reads.splice(0)) r.done(nothingYet);
  });

  it('is in the connect backfill', async () => {
    h.hello!({ instance: { id: 'box-ask', name: 'box-ask' }, capabilities: ['chat-transcript-v1'], settled: Promise.resolve() });
    for (let i = 0; i < 5; i++) await tick();
    const where = (vi.mocked(prisma.workstream.findMany).mock.calls.at(-1)?.[0] as { where: Record<string, unknown> }).where;
    expect(where).not.toHaveProperty('askThread');
    const seen = new Set(h.reads.map(r => r.chatKey));
    for (const r of h.reads.splice(0)) r.done(nothingYet);
    expect(seen).toContain('pa--ask-ws');
  });
});
