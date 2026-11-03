// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recorded: Array<{ name: string; attributes: Record<string, unknown> }> = [];
vi.mock('./observability', () => ({
  recordProductEvent: (name: string, attributes: Record<string, unknown>) => { recorded.push({ name, attributes }); },
}));

const { OPENED_SETTLE_MS, RecordClientOpened, REOPEN_AFTER_MS, resetUsageEventsForTests } = await import('./usageEvents');

let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  recorded.length = 0;
  resetUsageEventsForTests();
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const routes = [{ path: '*', element: <RecordClientOpened /> }];

describe('RecordClientOpened', () => {
  it('records the view shown once the load has redirected, not the URL it opened at', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { await router.navigate('/chat'); });
    expect(recorded).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(OPENED_SETTLE_MS); });
    expect(recorded).toEqual([{ name: 'client.opened', attributes: expect.objectContaining({ 'termag.view': 'simple', 'termag.resumed': false }) }]);
  });

  it('records the first open from the timer, even when the tab is focused before it fires', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/chat'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(recorded).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(OPENED_SETTLE_MS); });
    expect(recorded.map(r => r.attributes['termag.resumed'])).toEqual([false]);
  });

  it('records nothing more when a route change remounts it, however long the page has been open', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { vi.advanceTimersByTime(OPENED_SETTLE_MS); });
    act(() => root.unmount());
    vi.advanceTimersByTime(REOPEN_AFTER_MS);
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/chat'] })} />));
    await act(async () => { vi.advanceTimersByTime(OPENED_SETTLE_MS); });
    expect(recorded).toHaveLength(1);
  });

  it('records once per load, and again when the page comes back after long enough away', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/m'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () => { vi.advanceTimersByTime(OPENED_SETTLE_MS); });
    const visible = () => document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { visible(); });
    expect(recorded).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(REOPEN_AFTER_MS); visible(); });
    expect(recorded.map(r => r.attributes['termag.resumed'])).toEqual([false, true]);
    expect(recorded[1].attributes['termag.view']).toBe('mobile');
  });
});
