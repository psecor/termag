// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: { theme: {} as unknown }, updatePreferences: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

// One day, stood in for the registry, with a sprite and CSS.
const day = vi.hoisted(() => ({
  date: '2026-11-05',
  meta: { date: '2026-11-05', title: 'T', blurb: 'B', sources: [{ label: 'L', url: 'https://example.com' }] },
  css: 'html[data-daily-theme="2026-11-05"] { --accent: #f2a33a; }',
  sprite: 'export default { create: () => ({ draw() {} }) };',
}));
vi.mock('./registry', () => ({ loadDailyTheme: async (d: string) => (d === day.date ? day : null) }));
vi.mock('./date', async orig => ({ ...(await orig<typeof import('./date')>()), pacificDate: () => '2026-11-05' }));

import { setFlagValues } from '../../flags';
import { ThemeProvider } from '../ThemeProvider';
import { DEFAULT_THEME } from '../schema';
import { DAILY_THEME_OVERRIDE_KEY } from './date';
import { DailyThemeLayer } from './DailyThemeLayer';
import { resetDailyThemeCache } from './useDailyTheme';

let root: Root;
let el: HTMLDivElement;
const render = async (node = <DailyThemeLayer />) => {
  await act(async () => { root.render(<ThemeProvider>{node}</ThemeProvider>); });
  await act(async () => {}); // the lazy load
};
const style = () => document.head.querySelector('style[data-daily-theme-style]');
const decor = () => document.querySelector('iframe.daily-theme-decor');

beforeEach(() => {
  auth.user = { theme: {} };
  sessionStorage.clear();
  resetDailyThemeCache();
  window.history.replaceState(null, '', '/termag/');
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  setFlagValues(undefined);
});

describe('DailyThemeLayer', () => {
  it('does nothing with the flag off, even for someone who turned it on', async () => {
    auth.user = { theme: { ...DEFAULT_THEME, dailyTheme: true } };
    await render();
    expect(document.documentElement.dataset.dailyTheme).toBeUndefined();
    expect(style()).toBeNull();
  });

  it('does nothing with the flag on for someone who did not turn it on', async () => {
    setFlagValues({ 'daily-theme-enabled': true });
    await render();
    expect(style()).toBeNull();
  });

  it("applies today's CSS and sprite with the flag on and the setting on, and undoes both on unmount", async () => {
    setFlagValues({ 'daily-theme-enabled': true });
    auth.user = { theme: { ...DEFAULT_THEME, dailyTheme: true } };
    await render();
    expect(document.documentElement.dataset.dailyTheme).toBe('2026-11-05');
    expect(style()?.textContent).toBe(day.css);
    expect(decor()).not.toBeNull();
    expect(decor()?.getAttribute('aria-hidden')).toBe('true');
    act(() => root.unmount());
    root = createRoot(el);
    expect(document.documentElement.dataset.dailyTheme).toBeUndefined();
    expect(style()).toBeNull();
  });

  it('leaves the sprite off while the turkeys fly, and keeps the CSS', async () => {
    setFlagValues({ 'daily-theme-enabled': true });
    auth.user = { theme: { ...DEFAULT_THEME, dailyTheme: true } };
    await render(<DailyThemeLayer suppressSprite />);
    expect(style()).not.toBeNull();
    expect(decor()).toBeNull();
  });

  it('shows a ?dailyTheme= day whatever the setting says, and remembers it for the tab', async () => {
    setFlagValues({ 'daily-theme-enabled': true });
    window.history.replaceState(null, '', '/termag/?dailyTheme=2026-11-05');
    await render();
    expect(document.documentElement.dataset.dailyTheme).toBe('2026-11-05');
    expect(sessionStorage.getItem(DAILY_THEME_OVERRIDE_KEY)).toBe('2026-11-05');
  });

  it('shows nothing with ?dailyTheme=off, even to someone who turned it on', async () => {
    setFlagValues({ 'daily-theme-enabled': true });
    auth.user = { theme: { ...DEFAULT_THEME, dailyTheme: true } };
    window.history.replaceState(null, '', '/termag/?dailyTheme=off');
    await render();
    expect(document.documentElement.dataset.dailyTheme).toBeUndefined();
    expect(style()).toBeNull();
  });

  it('shows no ?dailyTheme= day with the flag off, and remembers nothing: the flag is the kill switch', async () => {
    window.history.replaceState(null, '', '/termag/?dailyTheme=2026-11-05');
    await render();
    expect(document.documentElement.dataset.dailyTheme).toBeUndefined();
    expect(style()).toBeNull();
    expect(sessionStorage.getItem(DAILY_THEME_OVERRIDE_KEY)).toBeNull();
  });

  it('has the day at once on a second mount, with no frame without its CSS', async () => {
    setFlagValues({ 'daily-theme-enabled': true });
    auth.user = { theme: { ...DEFAULT_THEME, dailyTheme: true } };
    await render();
    act(() => root.unmount());
    root = createRoot(el);
    // Synchronously, before any load could settle.
    act(() => { root.render(<ThemeProvider><DailyThemeLayer /></ThemeProvider>); });
    expect(style()?.textContent).toBe(day.css);
  });

  it('shows nothing for a day with no theme', async () => {
    setFlagValues({ 'daily-theme-enabled': true });
    window.history.replaceState(null, '', '/termag/?dailyTheme=2026-11-06');
    await render();
    expect(style()).toBeNull();
  });
});
