import React, { createContext, useCallback, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { AgentProvider, User } from '../types';
import { authApi, PreferencesPatch } from '../services/api';
import { adoptUiMode, onUiModeRecorded, type UiMode } from '../chat/uiMode';
import { edgeCheckpoint, markEdgeSignedIn } from '../utils/edgeSession';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  logout: () => Promise<void>;
  /** Save any subset of preferences; the returned user (with its theme) replaces the current one. */
  updatePreferences: (patch: PreferencesPatch) => Promise<void>;
  updateDefaultAgentProvider: (provider: AgentProvider) => Promise<void>;
  updateDotfilesRepoUrl: (url: string | null) => Promise<void>;
  /** First-run wizard finished/skipped (true) or re-offer it (false); updates the user in place. */
  setOnboarded: (done: boolean) => Promise<void>;
  /** My files was just made (POST /auth/me/my-files, the side panel's Files): the user says so at once. */
  noteMyFiles: (space: string) => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  logout: async () => {},
  updatePreferences: async () => {},
  updateDefaultAgentProvider: async () => {},
  updateDotfilesRepoUrl: async () => {},
  noteMyFiles: () => {},
  setOnboarded: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const current = useRef<User | null>(null);
  current.current = user;

  useEffect(() => {
    const sent = edgeCheckpoint();
    authApi.me()
      .then(u => {
        // The edge let this page and its user through: a tab that signed in
        // wakes the tabs that went quiet while it did (utils/edgeSession.ts).
        markEdgeSignedIn(sent);
        // A kept choice of termag or Lab wins over this browser's, and lands
        // before the routes that read it render.
        if (u.uiMode === 'simple' || u.uiMode === 'full') adoptUiMode(u.uiMode);
        setUser(u);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Preference saves run one at a time, so their responses (each a whole
  // user) apply in the order the saves were made, and the last one carries
  // them all. Two at once can land out of order and put back a stale field:
  // Lab's toast saves the switch to the chat and its own answer together
  // (chatNudge/ChatNudge.tsx).
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  const save = useCallback((patch: PreferencesPatch): Promise<User> => {
    const run = saves.current.then(() => authApi.updatePreferences(patch));
    saves.current = run.catch(() => {});
    return run.then(updated => { setUser(updated); return updated; });
  }, []);

  // Keep a new choice on the user, once per change. The server reports
  // `uiMode` only while onboarding-refresh-enabled is on for this user;
  // without it nothing is sent. A change is judged against the choice this
  // page last sent, which a response to an earlier save may not show yet.
  const sentMode = useRef<UiMode | null>(null);
  useEffect(() => onUiModeRecorded(mode => {
    const u = current.current;
    if (!u || !('uiMode' in u) || (sentMode.current ?? u.uiMode) === mode) return;
    sentMode.current = mode;
    save({ uiMode: mode }).catch(() => { if (sentMode.current === mode) sentMode.current = null; });
  }), [save]);

  const logout = async () => {
    await authApi.logout();
    setUser(null);
    window.location.href = '/termag/login';
  };

  const updatePreferences = useCallback(async (patch: PreferencesPatch) => { await save(patch); }, [save]);

  const updateDefaultAgentProvider = (provider: AgentProvider) => updatePreferences({ defaultAgentProvider: provider });

  const updateDotfilesRepoUrl = (url: string | null) => updatePreferences({ dotfilesRepoUrl: url });

  const setOnboarded = useCallback(async (done: boolean) => {
    const updated = await authApi.setOnboarded(done);
    // Re-offering (done: false) takes effect on the next sign-in or an explicit
    // visit to /welcome; don't bounce the user out of Settings right now.
    setUser(prev => ({ ...updated, needsOnboarding: done ? false : prev?.needsOnboarding ?? false }));
  }, []);

  const noteMyFiles = useCallback((space: string) => {
    setUser(prev => (prev && prev.myFilesSpace !== space ? { ...prev, myFilesSpace: space } : prev));
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, logout, updatePreferences, updateDefaultAgentProvider, updateDotfilesRepoUrl, setOnboarded, noteMyFiles }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
