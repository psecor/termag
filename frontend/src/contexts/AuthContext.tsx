import React, { createContext, useCallback, useContext, useState, useEffect, ReactNode } from 'react';
import { AgentProvider, User } from '../types';
import { authApi, PreferencesPatch } from '../services/api';

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
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  logout: async () => {},
  updatePreferences: async () => {},
  updateDefaultAgentProvider: async () => {},
  updateDotfilesRepoUrl: async () => {},
  setOnboarded: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authApi.me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const logout = async () => {
    await authApi.logout();
    setUser(null);
    window.location.href = '/termag/login';
  };

  const updatePreferences = useCallback(async (patch: PreferencesPatch) => {
    const updated = await authApi.updatePreferences(patch);
    setUser(updated);
  }, []);

  const updateDefaultAgentProvider = (provider: AgentProvider) => updatePreferences({ defaultAgentProvider: provider });

  const updateDotfilesRepoUrl = (url: string | null) => updatePreferences({ dotfilesRepoUrl: url });

  const setOnboarded = useCallback(async (done: boolean) => {
    const updated = await authApi.setOnboarded(done);
    // Re-offering (done: false) takes effect on the next sign-in or an explicit
    // visit to /welcome; don't bounce the user out of Settings right now.
    setUser(prev => ({ ...updated, needsOnboarding: done ? false : prev?.needsOnboarding ?? false }));
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, logout, updatePreferences, updateDefaultAgentProvider, updateDotfilesRepoUrl, setOnboarded }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
