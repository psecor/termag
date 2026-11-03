// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real ThemeProvider over a stand-in AuthContext: a save goes out as the
// user's preferences, and the theme read back from the user sets the boxes.
const auth = vi.hoisted(() => ({
  user: { theme: {} as unknown } as { theme: unknown },
  updatePreferences: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

import { setFlagValues } from '../../flags';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { DEFAULT_THEME } from '../../theme/schema';
import { AppearanceSection } from './AppearanceSection';

let root: Root;
let el: HTMLDivElement;
const render = () => act(() => root.render(<ThemeProvider><AppearanceSection /></ThemeProvider>));
const hideAskBoxes = () => {
  const label = [...el.querySelectorAll('label')].find(l => l.textContent?.includes('Hide ask boxes from the Projects list'));
  return label?.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

beforeEach(() => {
  auth.user = { theme: {} };
  auth.updatePreferences.mockReset();
  auth.updatePreferences.mockResolvedValue(undefined);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('Appearance: Hide ask boxes', () => {
  it('is off for a user who never set it', () => {
    render();
    expect(hideAskBoxes()).toBeTruthy();
    expect(hideAskBoxes().checked).toBe(false);
  });

  it('saves the choice to the user, leaving the rest of the theme alone', async () => {
    auth.user = { theme: { ...DEFAULT_THEME, sidebarActivity: true } };
    render();
    await act(async () => { hideAskBoxes().click(); });
    expect(auth.updatePreferences).toHaveBeenCalledWith({ theme: { ...DEFAULT_THEME, sidebarActivity: true, sidebarHideAskBoxes: true } });
  });

  it('reads a saved choice back from the user, and turning it off saves that', async () => {
    auth.user = { theme: { ...DEFAULT_THEME, sidebarHideAskBoxes: true } };
    render();
    expect(hideAskBoxes().checked).toBe(true);
    await act(async () => { hideAskBoxes().click(); });
    expect(auth.updatePreferences).toHaveBeenCalledWith({ theme: DEFAULT_THEME });
  });
});

describe('Appearance: solid presets per palette', () => {
  const swatches = () => [...el.querySelectorAll('.settings-swatch')].map(b => b.getAttribute('aria-label'));
  const solidRadio = () => [...el.querySelectorAll('label')].find(l => l.textContent?.includes('Solid color'))
    ?.querySelector('input[type="radio"]') as HTMLInputElement;

  it('offers the dark presets in dark', () => {
    auth.user = { theme: { ...DEFAULT_THEME, background: { mode: 'solid', color: '#0d1117' } } };
    render();
    expect(swatches()).toContain('Default #0d1117');
    expect(swatches()).toContain('Navy #0b1a2e');
    expect(swatches()).not.toContain('Default #ffffff');
  });

  it('offers light presets in light, starting at the light base', () => {
    auth.user = { theme: { ...DEFAULT_THEME, palette: 'light', background: { mode: 'solid', color: '#ffffff' } } };
    render();
    expect(swatches()[0]).toBe('Default #ffffff');
    expect(swatches()).toContain('Paper #f6f8fa');
    expect(swatches()).not.toContain('Navy #0b1a2e');
  });

  it('keeps a saved dark colour in light, as it is', () => {
    auth.user = { theme: { ...DEFAULT_THEME, palette: 'light', background: { mode: 'solid', color: '#0b1a2e' } } };
    render();
    expect((el.querySelector('input[aria-label="Background color as hex"]') as HTMLInputElement).value).toBe('#0b1a2e');
  });

  it('turns the starfield into the light base in light', async () => {
    auth.user = { theme: { ...DEFAULT_THEME, palette: 'light' } };
    render();
    await act(async () => { solidRadio().click(); });
    expect(auth.updatePreferences).toHaveBeenCalledWith({
      theme: { ...DEFAULT_THEME, palette: 'light', background: { mode: 'solid', color: '#ffffff' } },
    });
  });
});

describe('Appearance: Thanksgiving turkeys', () => {
  const turkeys = () => [...el.querySelectorAll('label')].find(l => l.textContent?.includes('Thanksgiving turkeys'))
    ?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined;
  afterEach(() => setFlagValues(undefined));

  it('is hidden while the flag is off', () => {
    render();
    expect(turkeys()).toBeUndefined();
  });

  it('is hidden with a solid background, where there are no stars to swap', () => {
    setFlagValues({ 'thanksgiving-turkeys-enabled': true });
    auth.user = { theme: { ...DEFAULT_THEME, background: { mode: 'solid', color: '#000000' } } };
    render();
    expect(turkeys()).toBeUndefined();
  });

  it('turns the turkeys on, then off again, with the flag on', async () => {
    setFlagValues({ 'thanksgiving-turkeys-enabled': true });
    render();
    expect(turkeys()!.checked).toBe(false);
    await act(async () => { turkeys()!.click(); });
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({ theme: { ...DEFAULT_THEME, starfieldTurkeys: true } });
    auth.user = { theme: { ...DEFAULT_THEME, starfieldTurkeys: true } };
    render();
    expect(turkeys()!.checked).toBe(true);
    await act(async () => { turkeys()!.click(); });
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({ theme: { ...DEFAULT_THEME, starfieldTurkeys: false } });
  });
});

describe('Appearance: Terminal font', () => {
  const fontRadio = (name: string) => [...el.querySelectorAll('[aria-label="Terminal font"] label')]
    .find(l => l.querySelector('.settings-row-name')?.textContent === name)
    ?.querySelector('input[type="radio"]') as HTMLInputElement;
  const reset = () => [...el.querySelectorAll('button')].find(b => b.textContent === 'Reset to defaults');

  it('is Maple Mono for a user who never chose, with nothing to reset', () => {
    render();
    expect(fontRadio('Maple Mono').checked).toBe(true);
    expect(fontRadio('JetBrains Mono').checked).toBe(false);
    expect(reset()).toBeUndefined();
  });

  it('shows each choice in its own face', () => {
    render();
    const samples = [...el.querySelectorAll<HTMLElement>('.settings-font-sample')].map(s => s.style.fontFamily);
    expect(samples).toEqual(["'Maple Mono', var(--font-mono)", 'var(--font-mono)']);
  });

  it('saves JetBrains Mono, and sends Maple Mono explicitly so the stored choice cannot stick', async () => {
    render();
    await act(async () => { fontRadio('JetBrains Mono').click(); });
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({ theme: { ...DEFAULT_THEME, terminalFont: 'jetbrains' } });
    auth.user = { theme: { ...DEFAULT_THEME, terminalFont: 'jetbrains' } };
    render();
    expect(fontRadio('JetBrains Mono').checked).toBe(true);
    await act(async () => { fontRadio('Maple Mono').click(); });
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({ theme: { ...DEFAULT_THEME, terminalFont: 'maple' } });
  });

  it('is put back to Maple Mono by Reset to defaults', async () => {
    auth.user = { theme: { ...DEFAULT_THEME, terminalFont: 'jetbrains' } };
    render();
    await act(async () => { reset()!.click(); });
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({
      theme: { ...DEFAULT_THEME, palette: 'dark', starfieldTurkeys: false, terminalFont: 'maple' },
    });
  });
});
