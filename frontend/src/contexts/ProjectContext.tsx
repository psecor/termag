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

  // Status WebSocket
  useEffect(() => {
    if (!user) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/termag/ws/status`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string; session: string; status: AgentStatusValue; updatedAt: string; message?: string;
        };
        if (msg.type === 'status') {
          setStatusMap(prev => ({ ...prev, [msg.session]: { status: msg.status, updatedAt: msg.updatedAt, message: msg.message } }));
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => { setTimeout(() => wsRef.current?.close(), 3000); };
    return () => ws.close();
  }, [user]);

  return (
    <ProjectContext.Provider value={{ projects, activeProjectId, statusMap, setActiveProject: setActiveProjectId, reloadProjects }}>
      {children}
    </ProjectContext.Provider>
  );
}

export const useProjects = () => useContext(ProjectContext);
