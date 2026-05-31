import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AgentProvider, User } from '../types';
import { authApi } from '../services/api';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  logout: () => Promise<void>;
  updateDefaultAgentProvider: (provider: AgentProvider) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  logout: async () => {},
  updateDefaultAgentProvider: async () => {},
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

  const updateDefaultAgentProvider = async (provider: AgentProvider) => {
    const updated = await authApi.updatePreferences({ defaultAgentProvider: provider });
    setUser(updated);
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout, updateDefaultAgentProvider }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
