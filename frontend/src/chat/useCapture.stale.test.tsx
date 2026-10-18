// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.fn();
vi.mock('../services/api', () => ({ sessionsApi: { capture: (...args: unknown[]) => capture(...args) } }));

import { useCapture } from './useCapture';

type Latest = ReturnType<typeof useCapture>;
const latest: { current: Latest | null } = { current: null };

function Harness({ projectId }: { projectId: string }) {
  latest.current = useCapture({ projectId, role: 'agent', workstream: 'main', status: 'idle', statusUpdatedAt: undefined, enabled: true });
  return null;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  capture.mockReset();
  capture.mockImplementation((projectId: string) => Promise.resolve({ session: projectId, content: `pane ${projectId}`, styled: true }));
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useCapture after a switch', () => {
  it('ignores a refresh made for the previous pane', async () => {
    await act(async () => root.render(<Harness projectId="A" />));
    await advance(0);
    expect(latest.current?.content).toBe('pane A');
    const refreshForA = latest.current!.refresh;

    await act(async () => root.render(<Harness projectId="B" />));
    await advance(1200);
    expect(latest.current?.content).toBe('pane B');

    // Past the server's gap, so only the pane guard can stop the old closure.
    await advance(1200);
    const callsBefore = capture.mock.calls.length;
    await act(async () => { refreshForA(); });
    await advance(0);

    expect(capture.mock.calls.slice(callsBefore).map(c => c[0])).not.toContain('A');
    expect(latest.current?.content).toBe('pane B');
  });

  it('still refreshes the pane it shows', async () => {
    await act(async () => root.render(<Harness projectId="A" />));
    await advance(1200);
    const callsBefore = capture.mock.calls.length;
    await act(async () => { latest.current!.refresh(); });
    await advance(0);
    expect(capture.mock.calls.length).toBe(callsBefore + 1);
  });
});
