// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ sharedWithMe: vi.fn() }));
vi.mock('../../services/api', () => ({ previewSharesApi: api }));

import { SharedPreviewsSection } from './SharedPreviewsSection';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const share = (id: string, hoursLeft: number) => ({
  id, owner: { name: 'Olive' }, project: { name: 'webapp' }, workstream: 'main', expiresAt: new Date(NOW + hoursLeft * 3600e3).toISOString(),
});
let root: Root;
let el: HTMLDivElement;
const render = (now: number) => act(() => root.render(<SharedPreviewsSection now={now} />));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  api.sharedWithMe.mockReset();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.useRealTimers(); });

describe('previews shared with you', () => {
  it('lists live shares, asks again every minute, and drops one that expired meanwhile', async () => {
    api.sharedWithMe.mockResolvedValue([]);
    render(NOW);
    await flush();
    expect(el.textContent).toBe('');
    // A share made for you while the dashboard is open shows at the next ask.
    api.sharedWithMe.mockResolvedValue([share('s1', 2), share('s2', 0.5)]);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/termag/preview/s1');
    // An hour on, s2 has expired: gone without waiting for the server.
    render(NOW + 3600e3);
    expect(el.querySelectorAll('li')).toHaveLength(1);
    expect(api.sharedWithMe).toHaveBeenCalledTimes(2);
  });

  it('asks again when the tab comes back', async () => {
    api.sharedWithMe.mockResolvedValue([]);
    render(NOW);
    await flush();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(api.sharedWithMe).toHaveBeenCalledTimes(2);
  });
});
