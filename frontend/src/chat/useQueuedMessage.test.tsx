// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_TTL_MS, claimQueued, readQueued, releaseQueued, writeQueued } from './newChat';
import { useQueuedMessage, type QueuedMessage } from './useQueuedMessage';

const latest: { current: QueuedMessage | null } = { current: null };
let renders = 0;

function Harness(props: { projectId: string; up?: boolean; raw?: boolean; send: (p: string, w: string, k: string) => Promise<void> }) {
  renders++;
  latest.current = useQueuedMessage({ projectId: props.projectId, workstream: 'main', up: props.up ?? true, offline: false, send: props.send, raw: props.raw });
  return null;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  root = createRoot(document.createElement('div'));
});

afterEach(() => { act(() => root.unmount()); });

const flush = () => act(async () => { await Promise.resolve(); });

describe('useQueuedMessage', () => {
  it('sends the queued message once Claude is up and clears it after the send', async () => {
    writeQueued(localStorage, 'A', 'fix the bug');
    const send = vi.fn(() => Promise.resolve());
    await act(async () => root.render(<Harness projectId="A" up={false} send={send} />));
    expect(latest.current?.queued).toBe('fix the bug');
    expect(send).not.toHaveBeenCalled();

    await act(async () => root.render(<Harness projectId="A" up send={send} />));
    await flush();
    expect(send).toHaveBeenCalledWith('A', 'main', 'fix the bug');
    expect(latest.current?.queued).toBeNull();
    expect(latest.current?.echo).toBe('fix the bug');
    expect(readQueued(localStorage, 'A')).toBeNull();
  });

  it('flattens newlines for a pane, and keeps them for the chat runner', async () => {
    writeQueued(localStorage, 'A', 'first line\nsecond line');
    const send = vi.fn(() => Promise.resolve());
    await act(async () => root.render(<Harness projectId="A" send={send} />));
    await flush();
    expect(send).toHaveBeenCalledWith('A', 'main', 'first line second line');

    writeQueued(localStorage, 'B', 'first line\nsecond line\n');
    await act(async () => root.render(<Harness projectId="B" raw send={send} />));
    await flush();
    expect(send).toHaveBeenLastCalledWith('B', 'main', 'first line\nsecond line');
  });

  it('settles a send that lands after a switch on its own chat, not the open one', async () => {
    writeQueued(localStorage, 'A', 'message for A');
    writeQueued(localStorage, 'B', 'message for B');
    const sendA = deferred();
    const send = vi.fn((p: string) => (p === 'A' ? sendA.promise : new Promise<void>(() => {})));

    await act(async () => root.render(<Harness projectId="A" send={send} />));
    expect(send).toHaveBeenCalledWith('A', 'main', 'message for A');

    await act(async () => root.render(<Harness projectId="B" up={false} send={send} />));
    expect(latest.current?.queued).toBe('message for B');

    await act(async () => { sendA.resolve(); await sendA.promise; });
    await flush();
    expect(latest.current?.queued).toBe('message for B');
    expect(latest.current?.echo).toBeNull();
    expect(readQueued(localStorage, 'A')).toBeNull();
    expect(readQueued(localStorage, 'B')).toBe('message for B');
  });

  it('keeps the message after a failed send and sends it again only on retry', async () => {
    writeQueued(localStorage, 'A', 'fix the bug');
    const send = vi.fn<(p: string, w: string, k: string) => Promise<void>>(
      () => Promise.reject({ response: { status: 503, data: { error: "Owner's agent is offline" } } }),
    );
    await act(async () => root.render(<Harness projectId="A" send={send} />));
    await flush();
    expect(latest.current?.error).toBe("Owner's agent is offline");
    expect(latest.current?.queued).toBe('fix the bug');
    expect(readQueued(localStorage, 'A')).toBe('fix the bug');
    expect(send).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Harness projectId="A" send={send} />));
    expect(send).toHaveBeenCalledTimes(1);

    send.mockImplementation(() => Promise.resolve());
    await act(async () => { latest.current!.retry(); });
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(readQueued(localStorage, 'A')).toBeNull();
  });

  it('leaves a message another tab is sending alone', async () => {
    writeQueued(localStorage, 'A', 'fix the bug');
    claimQueued(localStorage, 'A', 'other-tab', Date.now());
    const send = vi.fn(() => Promise.resolve());
    await act(async () => root.render(<Harness projectId="A" send={send} />));
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(latest.current?.queued).toBe('fix the bug');
  });

  it('queues what is typed before Claude is up after what is already waiting', async () => {
    writeQueued(localStorage, 'A', 'first');
    await act(async () => root.render(<Harness projectId="A" up={false} send={() => Promise.resolve()} />));
    await act(async () => { latest.current!.enqueue('second'); });
    expect(latest.current?.queued).toBe('first second');
    expect(readQueued(localStorage, 'A')).toBe('first second');
  });

  it('never sends a chat twice while its send is in flight, even after another chat sent in between', async () => {
    writeQueued(localStorage, 'A', 'message for A');
    writeQueued(localStorage, 'B', 'message for B');
    const pending = new Map<string, ReturnType<typeof deferred>>();
    const send = vi.fn((p: string) => { const d = deferred(); pending.set(p, d); return d.promise; });

    await act(async () => root.render(<Harness projectId="A" send={send} />));
    await act(async () => root.render(<Harness projectId="B" send={send} />));
    await act(async () => root.render(<Harness projectId="A" send={send} />));
    expect(send.mock.calls.map(c => c[0])).toEqual(['A', 'B']);

    await act(async () => { pending.get('A')!.resolve(); await pending.get('A')!.promise; });
    await flush();
    expect(latest.current?.queued).toBeNull();
    expect(send.mock.calls.map(c => c[0])).toEqual(['A', 'B']);
    await act(async () => { pending.get('B')!.resolve(); await pending.get('B')!.promise; });
  });

  it('takes over when the tab holding the claim gives it back', async () => {
    writeQueued(localStorage, 'A', 'fix the bug');
    claimQueued(localStorage, 'A', 'other-tab', Date.now());
    const send = vi.fn(() => Promise.resolve());
    await act(async () => root.render(<Harness projectId="A" send={send} />));
    expect(send).not.toHaveBeenCalled();

    releaseQueued(localStorage, 'A', 'other-tab');
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'termag-chat-queued-claim:A' })); });
    await flush();
    expect(send).toHaveBeenCalledWith('A', 'main', 'fix the bug');
  });

  it('takes over once a claim left by a tab that went away has expired', async () => {
    vi.useFakeTimers();
    try {
      writeQueued(localStorage, 'A', 'fix the bug');
      claimQueued(localStorage, 'A', 'other-tab', Date.now());
      const send = vi.fn(() => Promise.resolve());
      await act(async () => root.render(<Harness projectId="A" send={send} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_TTL_MS - 1_000); });
      expect(send).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(send).toHaveBeenCalledWith('A', 'main', 'fix the bug');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a message storage no longer holds, without retrying', async () => {
    vi.useFakeTimers();
    try {
      writeQueued(localStorage, 'C', 'fix the bug');
      const send = vi.fn(() => Promise.resolve());
      await act(async () => root.render(<Harness projectId="C" up={false} send={send} />));
      expect(latest.current?.queued).toBe('fix the bug');
      localStorage.removeItem('termag-chat-queued:C');
      await act(async () => root.render(<Harness projectId="C" up send={send} />));
      expect(send).not.toHaveBeenCalled();
      expect(latest.current?.queued).toBeNull();
      const before = renders;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(renders).toBe(before);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so, instead of looping, when no claim can be written', async () => {
    vi.useFakeTimers();
    writeQueued(localStorage, 'D', 'fix the bug');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    try {
      const send = vi.fn(() => Promise.resolve());
      await act(async () => root.render(<Harness projectId="D" send={send} />));
      expect(send).not.toHaveBeenCalled();
      expect(latest.current?.error).toMatch(/could not reserve/);
      expect(latest.current?.queued).toBe('fix the bug');
      const before = renders;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(renders).toBe(before);
      expect(send).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reports a message storage would not hold', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    try {
      await act(async () => root.render(<Harness projectId="E" up={false} send={() => Promise.resolve()} />));
      let held = true;
      await act(async () => { held = latest.current!.enqueue('fix the bug'); });
      expect(held).toBe(false);
      expect(latest.current?.queued).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it('does not resend after the chat view remounts while its send is in flight', async () => {
    writeQueued(localStorage, 'F', 'fix the bug');
    const d = deferred();
    const send = vi.fn(() => d.promise);
    await act(async () => root.render(<Harness projectId="F" send={send} />));
    act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Harness projectId="F" send={send} />));
    expect(send).toHaveBeenCalledTimes(1);
    expect(latest.current?.queued).toBe('fix the bug');

    await act(async () => { d.resolve(); await d.promise; });
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(latest.current?.queued).toBeNull();
  });

  it('sends what was queued behind a message once that one is through', async () => {
    writeQueued(localStorage, 'G', 'first');
    const d = deferred();
    const send = vi.fn((_p: string, _w: string, k: string) => (k === 'first' ? d.promise : Promise.resolve()));
    await act(async () => root.render(<Harness projectId="G" send={send} />));
    writeQueued(localStorage, 'G', 'first second');
    await act(async () => { d.resolve(); await d.promise; });
    await flush();
    await flush();
    expect(send.mock.calls.map(c => c[2])).toEqual(['first', 'second']);
    expect(readQueued(localStorage, 'G')).toBeNull();
  });
});
