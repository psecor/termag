import { useEffect, useMemo, useState } from 'react';
import { pacificDate, safeSessionStorage, themeDateOverride, type ThemeDateOverride } from './date';
import { loadDailyTheme, type DailyTheme } from './registry';

// How often the layer looks at the clock, so an open tab turns over at midnight.
const DATE_CHECK_MS = 60_000;

// Days already loaded (a theme, or null for a day with none), so a page switch
// that mounts the layer again has the day at once instead of a frame without it.
const loaded = new Map<string, DailyTheme | null>();

export type DailyThemeState =
  | { status: 'off'; theme: null }      // no day is asked for
  | { status: 'loading'; theme: null }  // a day is asked for, not loaded yet
  | { status: 'none'; theme: null }     // that day has no theme (or it failed to load)
  | { status: 'ready'; theme: DailyTheme };

const OFF: DailyThemeState = { status: 'off', theme: null };

function stateFor(date: string | null): DailyThemeState {
  if (!date) return OFF;
  if (!loaded.has(date)) return { status: 'loading', theme: null };
  const t = loaded.get(date) ?? null;
  return t ? { status: 'ready', theme: t } : { status: 'none', theme: null };
}

/**
 * The day's theme to show. With `enabled` (daily-theme-enabled) off there is
 * none, previews included: the flag is the kill switch. With it on, it is
 * today's (Pacific) when `optedIn`, a ?dailyTheme= override's day whatever
 * `optedIn` says (for previews and review), and none with ?dailyTheme=off.
 */
export function useDailyTheme(enabled: boolean, optedIn: boolean): DailyThemeState {
  // Read (and remembered) only while the flag is on: off, a ?dailyTheme= link
  // leaves nothing behind that would come back if the flag were turned on.
  // Synchronous, so ?dailyTheme=off never lets today's day paint first; its one
  // write (remembering the override) is the same on every call.
  const override = useMemo<ThemeDateOverride>(
    () => (enabled && typeof window !== 'undefined' ? themeDateOverride(window.location.search, safeSessionStorage()) : null),
    [enabled]);
  const [today, setToday] = useState(() => pacificDate());
  useEffect(() => {
    if (override) return;
    const id = setInterval(() => setToday(pacificDate()), DATE_CHECK_MS);
    return () => clearInterval(id);
  }, [override]);

  const date = !enabled || override === 'off' ? null : override ?? (optedIn ? today : null);
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!date || loaded.has(date)) return;
    let live = true;
    loadDailyTheme(date)
      .then(t => { loaded.set(date, t); })
      .catch(err => {
        // A chunk that fails to load (a deploy swapped it) leaves the usual look.
        console.warn('[daily-theme] could not load', date, err);
        loaded.set(date, null);
      })
      .finally(() => { if (live) setVersion(v => v + 1); });
    return () => { live = false; };
  }, [date]);
  return stateFor(date);
}

/** Tests only: forget every loaded day. */
export function resetDailyThemeCache(): void {
  loaded.clear();
}
