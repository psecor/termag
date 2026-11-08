// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSlotInfo } from '../services/api';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../services/api', () => ({ terminalApi: api }));

const { useTerminalTabs } = await import('./useTerminalTabs');

type Hook = ReturnType<typeof useTerminalTabs>;

let root: Root | null = null;
let host: HTMLDivElement;
let hook: Hook;
let projectId: string | null;
let enabled: boolean;
/** What tmux says is live — the list mock reads it, add/close mutate it. */
let live: TerminalSlotInfo[];
function term(slot: number): TerminalSlotInfo {
  return { session: `p1-termag-ctrl${slot === 1 ? '' : `-${slot}`}`, slot, label: slot === 1 ? 'ctrl' : `term ${slot}` };
}
function Probe() {
  hook = useTerminalTabs({ projectId, workstream: 'main', enabled });
  return null;
}
const rerender = () => act(() => root!.render(<Probe />));
beforeEach(() => {
  live = [];
  api.list.mockImplementation(() => Promise.resolve({ terminals: [...live].sort((a, b) => a.slot - b.slot), max: 8 }));
  api.add.mockImplementation(async () => {
    const used = new Set(live.map(t => t.slot));
    let slot = 2;
    while (used.has(slot)) slot++;
    if (slot > 8) throw Object.assign(new Error('full'), { response: { data: { error: 'All 8 terminals in this workstream are in use: close one first.', code: 'terminals_full' } } });
    const t = term(slot);
    live = [...live, t];
    return { ok: true, ...t };
  });
  api.close.mockImplementation(async (_p: string, _w: string, slot: number) => {
    if (!live.some(t => t.slot === slot)) {
      // Offline agent: the kill cannot happen, the pane stays.
      throw Object.assign(new Error('offline'), { response: { data: { error: "Owner's agent is offline" } } });
    }
    live = live.filter(t => t.slot !== slot);
    return { ok: true, session: term(slot).session };
  });
  projectId = 'p1';
  enabled = true;
  host = document.createElement('div');
  root = createRoot(host);
  rerender();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('useTerminalTabs', () => {
  it('starts on the ctrl pane and adopts the fetched list, extras only', async () => {
    expect(hook.activeSlot).toBeNull();
    await act(async () => {});
    expect(api.list).toHaveBeenCalledWith('p1', 'main');
    live = [term(1), term(3)];
    projectId = 'p2';
    rerender();
    await act(async () => {});
    expect(hook.tabs.map(t => t.slot)).toEqual([3]);
    expect(hook.activeSlot).toBeNull();
  });

  it('adds a tab, makes it active, and reconciles tabs the slow mount fetch would have lost', async () => {
    // The Bugbot scenario: slots 2 and 4 are already live, but the mount fetch
    // has not answered when the user clicks + (which bumps the epoch and
    // discards its answer). Without the post-add refresh, the strip would show
    // only the new slot and hide the two that were open.
    let answerMountFetch!: (v: unknown) => void;
    api.list.mockReturnValueOnce(new Promise(resolve => { answerMountFetch = resolve; }));
    projectId = 'p3';
    rerender();
    // The fake add keeps working off `live`; pre-seed the two live tabs so the
    // add lands on slot 3 (the lowest free one) and the truth holds 2, 3, 4.
    live = [term(2), term(4)];
    await act(async () => { await hook.add(); });
    expect(hook.activeSlot).toBe(3);
    expect(hook.tabs.map(t => t.slot)).toEqual([2, 3, 4]);
    // The discarded mount fetch's late answer stays discarded.
    await act(async () => { answerMountFetch({ terminals: [], max: 8 }); });
    expect(hook.tabs.map(t => t.slot)).toEqual([2, 3, 4]);
  });

  it('reports a failed add and keeps the list', async () => {
    for (let i = 2; i <= 8; i++) live = [...live, term(i)];
    projectId = 'p2'; // a switch, so the hook fetches the seeded list
    rerender();
    await act(async () => {});
    expect(hook.tabs.map(t => t.slot)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    await act(async () => { await hook.add(); });
    expect(hook.error).toMatch(/close one first/);
    expect(hook.tabs.map(t => t.slot)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(hook.activeSlot).toBeNull();
  });

  it('closing the active tab returns to ctrl; a failed close reads the list back', async () => {
    await act(async () => { await hook.add(); });
    expect(hook.activeSlot).toBe(2);
    api.close.mockRejectedValueOnce(Object.assign(new Error('offline'), { response: { data: { error: "Owner's agent is offline" } } }));
    await act(async () => { await hook.close(2); });
    expect(hook.error).toMatch(/offline/);
    // The pane is still alive (the read-back says so) but the user closed it —
    // the active tab stays on ctrl, with the tab back in the strip.
    expect(hook.tabs.map(t => t.slot)).toEqual([2]);
    expect(hook.activeSlot).toBeNull();
  });

  it('a re-read that lost the closed tab falls back to ctrl with an empty strip', async () => {
    await act(async () => { await hook.add(); });
    expect(hook.activeSlot).toBe(2);
    live = []; // the pane died for real; the close itself "succeeded" nowhere
    api.close.mockRejectedValueOnce(Object.assign(new Error('gone'), { response: { data: { error: 'nope' } } }));
    await act(async () => { await hook.close(2); });
    expect(hook.tabs).toEqual([]);
    expect(hook.activeSlot).toBeNull();
  });

  it('a project or workstream switch clears the old tabs at once, before the fetch lands', async () => {
    await act(async () => { await hook.add(); });
    expect(hook.tabs.map(t => t.slot)).toEqual([2]);
    let answerList!: (v: unknown) => void;
    api.list.mockReturnValueOnce(new Promise(resolve => { answerList = resolve; }));
    projectId = 'p2';
    rerender();
    expect(hook.tabs).toEqual([]);
    expect(hook.activeSlot).toBeNull();
    await act(async () => { answerList({ terminals: [term(4)], max: 8 }); });
    expect(hook.tabs.map(t => t.slot)).toEqual([4]);
  });

  it('an offline list answer keeps what the strip had', async () => {
    await act(async () => { await hook.add(); });
    expect(hook.tabs.map(t => t.slot)).toEqual([2]);
    api.list.mockRejectedValueOnce(new Error('offline'));
    projectId = 'p2';
    rerender(); // switch: clears at once, fetch fails — nothing to keep
    await act(async () => {});
    expect(hook.tabs).toEqual([]);
    expect(hook.error).toBeNull();
  });

  it('with the flag off there is no tab list and no fetch', async () => {
    enabled = false;
    api.list.mockClear();
    rerender();
    await act(async () => {});
    expect(api.list).not.toHaveBeenCalled();
    expect(hook.tabs).toEqual([]);
  });
});
