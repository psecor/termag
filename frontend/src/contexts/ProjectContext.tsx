import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Project, StatusMap, AgentStatusValue } from '../types';
import { projectsApi } from '../services/api';
import { useAuth } from './AuthContext';

interface ProjectContextValue {
  projects: Project[];
  activeProjectId: string | null;
  statusMap: StatusMap;
  setActiveProject: (id: string | null) => void;
  reloadProjects: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  activeProjectId: null,
  statusMap: {},
  setActiveProject: () => {},
  reloadProjects: async () => {},
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<StatusMap>({});
  const wsRef = useRef<WebSocket | null>(null);

  const reloadProjects = useCallback(async () => {
    const data = await projectsApi.list();
    setProjects(data);
  }, []);

  useEffect(() => {
    if (!user) return;
    reloadProjects();
  }, [user, reloadProjects]);

  // Status WebSocket with auto-reconnect
  useEffect(() => {
    if (!user) return;
    let disposed = false;

    function connect() {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/termag/ws/status`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            session: string;
            status: AgentStatusValue;
            updatedAt: string;
            message?: string;
            source?: 'claude-hooks' | 'codex-app-server' | 'codex-jsonl' | 'tmux-fallback';
            waitingReason?: 'approval' | 'user_input' | 'unknown' | null;
            activityScore?: number;
            tokenBurst?: number;
            activeTurn?: boolean;
            threadId?: string;
          };
          if (msg.type === 'status') {
            setStatusMap(prev => ({
              ...prev,
              [msg.session]: {
                status: msg.status,
                updatedAt: msg.updatedAt,
                message: msg.message,
                source: msg.source,
                waitingReason: msg.waitingReason,
                activityScore: msg.activityScore,
                tokenBurst: msg.tokenBurst,
                activeTurn: msg.activeTurn,
                threadId: msg.threadId,
                pollerMeta: (msg as any).pollerMeta,
              },
            }));
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed) setTimeout(connect, 3000);
      };
    }

    connect();
    return () => { disposed = true; wsRef.current?.close(); };
  }, [user]);

  return (
    <ProjectContext.Provider value={{ projects, activeProjectId, statusMap, setActiveProject: setActiveProjectId, reloadProjects }}>
      {children}
    </ProjectContext.Provider>
  );
}

export const useProjects = () => useContext(ProjectContext);
