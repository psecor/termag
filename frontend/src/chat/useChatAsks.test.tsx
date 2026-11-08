// @vitest-environment jsdom
// useChatAsks reads the asks again while a finished one's finish notice is
// due, so the words change once the notice is sent (asks.ts askNoticePollMs).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAskMessage, ChatAskThread } from './asks';

const api = vi.hoisted(() => ({ asks: vi.fn() }));
vi.mock('../services/api', () => ({ chatApi: { asks: api.asks } }));

import { ASK_MISSING_POLLS, ASK_POLL_MS, readChatAsks, useChatAsks, usePaneAsks } from './useChatAsks';

const T1 = 'cmvtr5x6r0i0lafsfuclk9ed5';
const finished = (notice: ChatAskMessage['notice']): { threads: ChatAskThread[] } => ({
  threads: [{
    id: T1, title: 't', target: 'termag-4/termag-4', chat: null, prs: [], createdAt: '2026-10-29T13:23:12.000Z',
    messages: [{
      id: 'a9525f4870115a431e32d6a46', hop: 1, status: 'completed', queued: false, error: null, reply: 'stored', notice,
      supersededBy: null, publish: null, createdAt: '2026-10-29T13:23:12.000Z', startedAt: '2026-10-29T13:23:18.000Z',
      completedAt: new Date(Date.now() - 1000).toISOString(),
    }],
  }],
});

function Probe() {
  useChatAsks('p1', 'main', [T1], 1, false, true);
  return null;
}

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  api.asks.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('useChatAsks', () => {
  it('reads a finished ask again while its notice is due, and stops once it is sent', async () => {
    api.asks.mockResolvedValueOnce(finished('due')).mockResolvedValueOnce(finished('due')).mockResolvedValue(finished('sent'));
    await act(async () => { root.render(<Probe />); });
    await tick(0);
    expect(api.asks).toHaveBeenCalledTimes(1);
    await tick(ASK_POLL_MS);
    expect(api.asks).toHaveBeenCalledTimes(2);
    await tick(ASK_POLL_MS);
    expect(api.asks).toHaveBeenCalledTimes(3);
    await tick(ASK_POLL_MS * 4);
    expect(api.asks).toHaveBeenCalledTimes(3);
  });

  it('doesn\'t read a finished ask again once nothing is due', async () => {
    api.asks.mockResolvedValue(finished('none'));
    await act(async () => { root.render(<Probe />); });
    await tick(ASK_POLL_MS * 4);
    expect(api.asks).toHaveBeenCalledTimes(1);
  });

  it('reads every thread a chat named past 50, in reads of 50, and sees the oldest end', async () => {
    const th = (i: number) => `cmvtr5x6r0i0lafsfuclk${String(i).padStart(4, '0')}`;
    const ids = Array.from({ length: 120 }, (_, i) => th(i));
    const base = working().threads[0];
    // The orchestrator answers only what it is asked for: th(0) recorded no parent, so only its id finds it.
    let th0: 'working' | 'completed' = 'working';
    api.asks.mockImplementation(async (_p: string, _w: string, named: string[]) => ({
      threads: named.map(id => ({ ...base, id, messages: [{ ...base.messages[0], status: id === th(0) ? th0 : 'completed', completedAt: id === th(0) && th0 === 'working' ? null : new Date(Date.now() - 1000).toISOString() }] })),
    }));
    let shown: ReadonlyMap<string, ChatAskThread> = new Map();
    function Many() { shown = useChatAsks('p1', 'main', ids, ids.length, false, true); return null; }
    await act(async () => { root.render(<Many />); });
    await tick(0);
    expect(api.asks.mock.calls.map(c => c[2])).toEqual([ids.slice(0, 50), ids.slice(50, 100), ids.slice(100)]);
    expect([...shown.keys()]).toHaveLength(120);
    expect(shown.get(th(0))?.messages[0].status).toBe('working');
    th0 = 'completed';
    await tick(ASK_POLL_MS);
    expect(api.asks).toHaveBeenCalledTimes(6);
    expect(shown.get(th(0))?.messages[0].status).toBe('completed');
    // Nothing is going any more: no more reads.
    await tick(ASK_POLL_MS * 4);
    expect(api.asks).toHaveBeenCalledTimes(6);
  });
});

describe('readChatAsks', () => {
  const thread = (id: string, createdAt: string): ChatAskThread => ({ ...finished('none').threads[0], id, createdAt });
  const A = 'cmvtr5x6r0i0lafsfuclk0001';
  const B = 'cmvtr5x6r0i0lafsfuclk0002';

  it('is one read while the ids fit in one, none named included', async () => {
    api.asks.mockResolvedValue({ threads: [] });
    await readChatAsks('p1', 'main', []);
    await readChatAsks('p1', 'main', [A]);
    expect(api.asks.mock.calls.map(c => c[2])).toEqual([[], [A]]);
  });

  it('answers each thread once, oldest first, when the reads overlap (each also answers the chat\'s newest)', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `cmvtr5x6r0i0lafsfuclk${String(i + 10).padStart(4, '0')}`);
    api.asks
      .mockResolvedValueOnce({ threads: [thread(A, '2026-11-05T12:00:00.000Z'), thread(B, '2026-11-05T13:00:00.000Z')] })
      .mockResolvedValueOnce({ threads: [thread(B, '2026-11-05T13:00:00.000Z'), thread(ids[50], '2026-11-05T11:00:00.000Z')] });
    const r = await readChatAsks('p1', 'main', ids);
    expect(r.threads.map(t => t.id)).toEqual([ids[50], A, B]);
  });

  it('fails when one of its reads fails', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `cmvtr5x6r0i0lafsfuclk${String(i + 10).padStart(4, '0')}`);
    api.asks.mockResolvedValueOnce({ threads: [] }).mockRejectedValueOnce(new Error('502'));
    await expect(readChatAsks('p1', 'main', ids)).rejects.toThrow('502');
  });
});

const working = (): { threads: ChatAskThread[] } => {
  const f = finished('none');
  return { threads: [{ ...f.threads[0], messages: [{ ...f.threads[0].messages[0], status: 'working', completedAt: null }] }] };
};

let seen: ReturnType<typeof usePaneAsks>[] = [];
function PaneProbe({ agentWorking, project = 'p1' }: { agentWorking: boolean; project?: string }) {
  seen.push(usePaneAsks(project, 'main', agentWorking, true));
  return null;
}

describe('usePaneAsks', () => {
  it('reads by parent alone, and again while the pane\'s agent works', async () => {
    api.asks.mockResolvedValue({ threads: [] });
    await act(async () => { root.render(<PaneProbe agentWorking />); });
    await tick(0);
    expect(api.asks).toHaveBeenCalledWith('p1', 'main', []);
    await tick(ASK_POLL_MS * 2);
    expect(api.asks).toHaveBeenCalledTimes(3);
    // Idle with nothing going: one more read for the change, then none.
    await act(async () => { root.render(<PaneProbe agentWorking={false} />); });
    await tick(ASK_POLL_MS * 4);
    expect(api.asks).toHaveBeenCalledTimes(4);
  });

  it('keeps reading while an ask is going after the agent is idle', async () => {
    api.asks.mockResolvedValueOnce(working()).mockResolvedValueOnce(working()).mockResolvedValue(finished('none'));
    await act(async () => { root.render(<PaneProbe agentWorking={false} />); });
    await tick(ASK_POLL_MS * 4);
    expect(api.asks).toHaveBeenCalledTimes(3);
  });

  it('tries a failed first read again quickly for a minute, then once a minute until it is answered', async () => {
    seen = [];
    api.asks.mockRejectedValue(new Error('503'));
    await act(async () => { root.render(<PaneProbe agentWorking={false} />); });
    await tick(ASK_POLL_MS * ASK_MISSING_POLLS);
    expect(api.asks).toHaveBeenCalledTimes(ASK_MISSING_POLLS);
    expect(seen[seen.length - 1].state).toBe('loading');
    api.asks.mockResolvedValue(finished('none'));
    await tick(60_000);
    expect(api.asks).toHaveBeenCalledTimes(ASK_MISSING_POLLS + 1);
    expect(seen[seen.length - 1].state).toBe('ready');
    await tick(60_000 * 3);
    expect(api.asks).toHaveBeenCalledTimes(ASK_MISSING_POLLS + 1);
  });

  it('takes a 404 as an answer, none, and reads no more while the agent is idle', async () => {
    seen = [];
    api.asks.mockRejectedValue(Object.assign(new Error('404'), { response: { status: 404 } }));
    await act(async () => { root.render(<PaneProbe agentWorking={false} />); });
    await tick(60_000 * 3);
    expect(api.asks).toHaveBeenCalledTimes(1);
    expect(seen[seen.length - 1]).toEqual({ state: 'ready', threads: new Map() });
  });

  it('clears the asks when a 404 follows an answer', async () => {
    seen = [];
    api.asks.mockResolvedValueOnce(finished('none')).mockRejectedValue(Object.assign(new Error('404'), { response: { status: 404 } }));
    await act(async () => { root.render(<PaneProbe agentWorking />); });
    await tick(0);
    expect(seen[seen.length - 1].threads.size).toBe(1);
    await tick(ASK_POLL_MS);
    expect(seen[seen.length - 1]).toEqual({ state: 'ready', threads: new Map() });
  });

  it('stops after a minute of failures once the chat has had an answer', async () => {
    api.asks.mockResolvedValueOnce({ threads: [] }).mockRejectedValue(new Error('503'));
    await act(async () => { root.render(<PaneProbe agentWorking />); });
    await tick(0);
    await act(async () => { root.render(<PaneProbe agentWorking={false} />); });
    await tick(60_000 * 5);
    expect(api.asks).toHaveBeenCalledTimes(1 + ASK_MISSING_POLLS);
  });

  it('is loading until its first answer, and never shows another chat\'s asks', async () => {
    seen = [];
    let answer: (v: { threads: ChatAskThread[] }) => void = () => {};
    api.asks.mockResolvedValueOnce(finished('none'))
      .mockImplementationOnce(() => new Promise(r => { answer = r; }));
    await act(async () => { root.render(<PaneProbe agentWorking={false} project="p1" />); });
    await tick(0);
    expect(seen[0].state).toBe('loading');
    expect(seen[seen.length - 1].state).toBe('ready');
    expect(seen[seen.length - 1].threads.has(T1)).toBe(true);
    // Another chat: none of p1's while p2's first read is out.
    await act(async () => { root.render(<PaneProbe agentWorking={false} project="p2" />); });
    expect(seen[seen.length - 1]).toEqual({ state: 'loading', threads: new Map() });
    await act(async () => { answer({ threads: [] }); });
    await tick(0);
    expect(seen[seen.length - 1].state).toBe('ready');
    expect(seen[seen.length - 1].threads.size).toBe(0);
  });
});
