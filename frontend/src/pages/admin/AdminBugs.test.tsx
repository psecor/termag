// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bug list's search box (AdminBugs.tsx): it writes the trimmed search
// into the URL a beat after the last key, once, however the input is padded.
vi.mock('../../services/adminApi', async (orig) => ({
  ...(await orig<typeof import('../../services/adminApi')>()),
  adminApi: {
    bugReports: vi.fn(async () => ({ reports: [] })),
    bugCounts: vi.fn(async () => ({ counts: { new: 0, triaged: 0, duplicate: 0, fixed: 0, wontfix: 0 } })),
  },
}));

import { AdminBugs } from './AdminBugs';

let root: Root;
let el: HTMLDivElement;
let locations: string[];
let navigate: NavigateFunction;

function Where() {
  const loc = useLocation();
  navigate = useNavigate();
  locations.push(`${loc.key} ${loc.search}`);
  return null;
}

function mount(path: string) {
  act(() => root.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/admin/bugs" element={<AdminBugs now={Date.now()} />} /></Routes>
      <Where />
    </MemoryRouter>,
  ));
}

beforeEach(() => {
  vi.useFakeTimers();
  locations = [];
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.useRealTimers();
});

function type(text: string) {
  const input = el.querySelector('input[type="search"]') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the bug list search', () => {
  it('puts a padded search in the URL trimmed, once, and then settles', async () => {
    mount('/admin/bugs');
    type('  space put ');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const navigations = () => new Set(locations.map(l => l.split(' ')[0])).size;
    expect(locations.at(-1)).toMatch(/ \?q=space(\+|%20)put$/);
    const settled = navigations();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(navigations()).toBe(settled);
    expect((el.querySelector('input[type="search"]') as HTMLInputElement).value).toBe('  space put ');
  });

  it('follows the URL when it changes underneath, and never writes the old search back', async () => {
    mount('/admin/bugs?q=space');
    const input = () => (el.querySelector('input[type="search"]') as HTMLInputElement).value;
    expect(input()).toBe('space');
    // The Bugs tab, or Back, to the list with no search.
    act(() => { navigate('/admin/bugs'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(locations.at(-1)).toMatch(/ $/);
    expect(input()).toBe('');
    // And to another search: the input shows it, and the URL keeps it.
    act(() => { navigate('/admin/bugs?q=broker'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(locations.at(-1)).toMatch(/ \?q=broker$/);
    expect(input()).toBe('broker');
  });
});
