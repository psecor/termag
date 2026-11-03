// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatus, SessionReview } from '../types';

const api = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock('../services/api', () => ({ reviewApi: api }));

const { useReviewPanes, PANE_OVERLAY_MS } = await import('./useReviewPanes');

type Hook = ReturnType<typeof useReviewPanes>;
type Status = Pick<AgentStatus, 'review' | 'reviews'> | undefined;

const r = (slot: number, pr: number): SessionReview => ({
  state: 'reviewing', pr, url: null, at: '2026-10-27T00:00:00Z', doneAt: null, seenAt: null,
  slot, session: slot === 1 ? 'ada-termag-review' : `ada-termag-review-${slot}`,
});

let root: Root | null = null;
let host: HTMLDivElement;
let hook: Hook;
let status: Status;
let projectId = 'p1';
function Probe() {
  hook = useReviewPanes({ projectId, workstream: 'main', owner: 'ada', projectName: 'termag', status });
  return null;
}
const rerender = () => act(() => root!.render(<Probe />));
beforeEach(() => {
  vi.useFakeTimers();
  api.stop.mockResolvedValue({ ok: true });
  status = undefined;
  projectId = 'p1';
  host = document.createElement('div');
  root = createRoot(host);
  rerender();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe('useReviewPanes (docs/parallel-reviews.md)', () => {
  it('shows a started pane at once, open, and keeps it when the push lands', () => {
    status = { reviews: [r(1, 646)] };
    rerender();
    act(() => hook.onStarted({ pr: 647, url: null, session: 'ada-termag-review-2', slot: 2 }));
    expect(hook.panes.map(p => p.slot)).toEqual([1, 2]);
    expect(hook.panes.map((p, i) => hook.isExpanded(p, i))).toEqual([false, true]);
    status = { reviews: [r(1, 646), r(2, 647)] };
    rerender();
    expect(hook.panes.map(p => p.pr)).toEqual([646, 647]);
  });
  it('hides a stopped pane, and only that one, then lets the truth decide after a while', () => {
    status = { reviews: [r(1, 646), r(2, 647)] };
    rerender();
    act(() => hook.stop('ada-termag-review-2'));
    expect(api.stop).toHaveBeenCalledWith('p1', 'main', 'ada-termag-review-2');
    expect(hook.panes.map(p => p.slot)).toEqual([1]);
    // The clearing push never comes: the pane shows again once the overlay lapses.
    act(() => { vi.advanceTimersByTime(PANE_OVERLAY_MS + 1); });
    expect(hook.panes.map(p => p.slot)).toEqual([1, 2]);
  });
  it('lets the overlay lapse on time though the agent keeps pushing status (Bugbot, #786)', () => {
    status = { reviews: [r(1, 646), r(2, 647)] };
    rerender();
    act(() => hook.stop('ada-termag-review-2'));
    // A busy agent: a fresh status object every 2 s, the review list unchanged.
    for (let t = 0; t < PANE_OVERLAY_MS; t += 2000) {
      act(() => { vi.advanceTimersByTime(2000); });
      status = { reviews: [r(1, 646), r(2, 647)] };
      rerender();
    }
    act(() => { vi.advanceTimersByTime(1); });
    expect(hook.panes.map(p => p.slot)).toEqual([1, 2]);
  });
  it('opens and closes each pane on its own, and collapses all at once', () => {
    status = { reviews: [r(1, 646), r(2, 647), r(3, 648)] };
    rerender();
    act(() => hook.toggle(hook.panes[0], 0));
    act(() => hook.toggle(hook.panes[2], 2));
    expect(hook.openCount).toBe(2);
    expect(hook.panes.map((p, i) => hook.isExpanded(p, i))).toEqual([true, false, true]);
    act(() => hook.collapseAll());
    expect(hook.openCount).toBe(0);
  });
  it('opens the pane a focus event names, else the first', () => {
    status = { reviews: [r(1, 646), r(2, 647)] };
    rerender();
    act(() => hook.expandFor('p1', 'main', 'ada-termag-review-2'));
    expect(hook.panes.map((p, i) => hook.isExpanded(p, i))).toEqual([false, true]);
    act(() => hook.collapseAll());
    act(() => hook.expandFor('p1', 'main'));
    expect(hook.panes.map((p, i) => hook.isExpanded(p, i))).toEqual([true, false]);
  });
  it('remembers what is open per workstream across a switch', () => {
    status = { reviews: [r(1, 646)] };
    rerender();
    act(() => hook.toggle(hook.panes[0], 0));
    projectId = 'p2';
    rerender();
    expect(hook.isExpanded(hook.panes[0], 0)).toBe(false);
    projectId = 'p1';
    rerender();
    expect(hook.isExpanded(hook.panes[0], 0)).toBe(true);
  });
});
