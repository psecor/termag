// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real ThemeProvider over a stand-in AuthContext: a save goes out as the
// user's preferences, and the theme read back from the user decides the label.
const auth = vi.hoisted(() => ({
  user: { theme: {} as unknown } as { theme: unknown },
  updatePreferences: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

import { ThemeProvider } from '../theme/ThemeProvider';
import { DEFAULT_THEME } from '../theme/schema';
import { StoppedBoxesToggle } from './StoppedBoxesToggle';

let root: Root;
let el: HTMLDivElement;
const render = () => act(() => root.render(<ThemeProvider><ul><StoppedBoxesToggle boxCount={12} projectCount={15} /></ul></ThemeProvider>));
const button = () => el.querySelector('button') as HTMLButtonElement;

beforeEach(() => {
  auth.user = { theme: {} };
  auth.updatePreferences.mockReset();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Show stopped toggle', () => {
  it('starts hidden, with the count of stopped boxes, and saves the choice to the user', async () => {
    let resolve!: () => void;
    auth.updatePreferences.mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    render();
    expect(button().textContent).toBe('Show stopped (12)');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().title).toContain('15 projects on 12 stopped boxes');
    await act(async () => { button().click(); });
    // Flipped at once, while the save is in flight.
    expect(button().textContent).toBe('Hide stopped (12)');
    expect(auth.updatePreferences).toHaveBeenCalledWith({ theme: { ...DEFAULT_THEME, sidebarShowStopped: true } });
    await act(async () => { resolve(); });
  });

  it('reads a saved choice back from the user, so it persists across reloads and browsers', async () => {
    auth.user = { theme: { ...DEFAULT_THEME, sidebarShowStopped: true } };
    render();
    expect(button().textContent).toBe('Hide stopped (12)');
    await act(async () => { button().click(); });
    expect(auth.updatePreferences).toHaveBeenCalledWith({ theme: { ...DEFAULT_THEME, sidebarShowStopped: false } });
  });

  it('flips back when the save fails', async () => {
    auth.updatePreferences.mockRejectedValue(new Error('500'));
    render();
    await act(async () => { button().click(); });
    expect(button().textContent).toBe('Show stopped (12)');
  });
});
