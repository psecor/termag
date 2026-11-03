// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PALETTE_STORAGE_KEY } from './apply';
import { DEFAULT_THEME } from './schema';
import { ThemeProvider } from './ThemeProvider';

const mocks = vi.hoisted(() => ({
  auth: { user: null as { theme: unknown } | null, loading: true },
  applyTheme: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ ...mocks.auth, updatePreferences: vi.fn() }),
}));
// Calls through to the real applyTheme, so the cache and <html> assertions
// below see what a real apply would have done.
vi.mock('./apply', async importOriginal => {
  const actual = await importOriginal<typeof import('./apply')>();
  mocks.applyTheme.mockImplementation(actual.applyTheme);
  return { ...actual, applyTheme: mocks.applyTheme };
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.applyTheme.mockClear();
  mocks.auth = { user: null, loading: true };
  // What index.html's pre-paint script leaves for a light user.
  localStorage.setItem(PALETTE_STORAGE_KEY, 'light');
  document.documentElement.dataset.palette = 'light';
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  localStorage.clear();
  delete document.documentElement.dataset.palette;
});

describe('ThemeProvider', () => {
  it('applies nothing while /auth/me is loading, so the pre-paint palette and its cache survive', () => {
    act(() => root.render(<ThemeProvider>{null}</ThemeProvider>));
    expect(mocks.applyTheme).not.toHaveBeenCalled();
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.palette).toBe('light');
  });

  it('applies the saved theme once the user arrives', () => {
    act(() => root.render(<ThemeProvider>{null}</ThemeProvider>));
    mocks.auth = { user: { theme: { ...DEFAULT_THEME, palette: 'light' } }, loading: false };
    act(() => root.render(<ThemeProvider>{null}</ThemeProvider>));
    expect(mocks.applyTheme).toHaveBeenCalledTimes(1);
    expect(mocks.applyTheme.mock.calls[0][0]).toEqual({ ...DEFAULT_THEME, palette: 'light' });
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.palette).toBe('light');
  });
});
