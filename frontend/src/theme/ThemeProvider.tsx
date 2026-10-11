import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { DEFAULT_THEME, ThemeSettings, normalizeTheme } from './schema';
import { applyTheme } from './apply';
import { createSaveQueue } from './saveQueue';

interface ThemeContextValue {
  /** The theme in effect on screen: the preview while one is set, else the saved theme. */
  theme: ThemeSettings;
  /** The theme the server holds for this user. */
  saved: ThemeSettings;
  /** Show a theme without saving it (null ends the preview). Settings uses this while a colour is being picked. */
  preview: (theme: ThemeSettings | null) => void;
  /** Persist a theme; it becomes `saved` and any preview ends. Rejects with the API error. */
  save: (theme: ThemeSettings) => Promise<void>;
  saving: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  saved: DEFAULT_THEME,
  preview: () => {},
  save: async () => {},
  saving: false,
});

/**
 * Applies the signed-in user's theme as CSS custom properties on <html>, so
 * every route (workspace, dashboard, settings; login with the defaults) sees
 * the same variables. Mounted inside AuthProvider; the theme itself travels
 * on the user object, so a save updates it through AuthContext.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user, updatePreferences } = useAuth();
  const storedTheme = user?.theme;
  const saved = useMemo(() => normalizeTheme(storedTheme), [storedTheme]);
  const [previewed, setPreviewed] = useState<ThemeSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const theme = previewed ?? saved;

  useEffect(() => {
    applyTheme(theme, document.documentElement);
  }, [theme]);

  const preview = useCallback((next: ThemeSettings | null) => setPreviewed(next), []);

  // Saves go through one queue (theme/saveQueue.ts) so overlapping requests
  // settle in order and the preview is only dropped once the last one has.
  const updateRef = useRef(updatePreferences);
  updateRef.current = updatePreferences;
  const [queue] = useState(() => createSaveQueue<ThemeSettings>(
    next => updateRef.current({ theme: next }),
    () => { setPreviewed(null); setSaving(false); },
  ));
  const save = useCallback((next: ThemeSettings) => {
    setSaving(true);
    return queue.push(next);
  }, [queue]);

  const value = useMemo(() => ({ theme, saved, preview, save, saving }), [theme, saved, preview, save, saving]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
