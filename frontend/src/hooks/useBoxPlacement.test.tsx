// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const placement = vi.hoisted(() => vi.fn());
vi.mock('../services/api', () => ({ boxesApi: { placement } }));

import { useBoxPlacement, type BoxPlacementState } from './useBoxPlacement';

const view = (source: 'pool' | 'cold') => ({
  policy: 'reuse-first', policySource: 'org', recommended: { kind: 'new', source, reason: [] }, boxes: [], newBox: { source },
});

let root: Root;
let el: HTMLDivElement;
let state: BoxPlacementState;
function Probe({ repos, size }: { repos: string[]; size: string | null }) {
  state = useBoxPlacement(true, repos, size, '');
  return null;
}
const render = (repos: string[], size: string | null) => act(async () => { root.render(<Probe repos={repos} size={size} />); });
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 350)); });

beforeEach(() => { placement.mockReset(); el = document.createElement('div'); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); });

describe('useBoxPlacement', () => {
  it("keeps the repositories' answer through a size change, and marks the pool hint stale when that size's ask fails", async () => {
    placement.mockResolvedValueOnce(view('pool'));
    await render(['acme/web'], null);
    await settle();
    expect(state.view?.newBox.source).toBe('pool');
    placement.mockRejectedValueOnce(new Error('down'));
    await render(['acme/web'], 'large');
    expect(state.view?.newBox.source).toBe('pool');
    expect(state.sizeStale).toBe(false);
    await settle();
    expect(state).toMatchObject({ failed: false, sizeStale: true });
    expect(state.view).not.toBeNull();
  });

  it('stays failed, so Auto stays New box and Send works, while a retry or a size change is asked', async () => {
    placement.mockRejectedValueOnce(new Error('down'));
    await render(['acme/web'], null);
    await settle();
    expect(state.failed).toBe(true);
    placement.mockReturnValueOnce(new Promise(() => {}));
    await render(['acme/web'], 'large');
    await settle();
    // The size's ask is in flight (and hangs): still failed, so Auto is New box and Send goes.
    expect(state.failed).toBe(true);
    placement.mockResolvedValueOnce(view('cold'));
    await act(async () => { state.retry(); });
    await settle();
    expect(placement.mock.calls.map(c => c[1])).toEqual([null, 'large', 'large']);
    expect(state).toMatchObject({ failed: false });
  });

  it('never carries a failure to a later ask for the same repositories', async () => {
    placement.mockResolvedValueOnce(view('cold'));
    await render(['acme/web'], null);
    await settle();
    placement.mockRejectedValueOnce(new Error('down'));
    await render(['acme/web'], 'large');
    await settle();
    // Another repository's answer replaces the kept one; back on acme/web, its new ask is in flight, not failed.
    placement.mockResolvedValueOnce(view('cold'));
    await render(['acme/api'], 'large');
    await settle();
    placement.mockReturnValueOnce(new Promise(() => {}));
    await render(['acme/web'], 'large');
    expect(state).toMatchObject({ view: null, failed: false });
  });
});
