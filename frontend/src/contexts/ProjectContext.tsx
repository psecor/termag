import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { Project, StatusMap, AgentStatusValue } from '../types';
import { projectsApi, visitsApi } from '../services/api';
import { useAuth } from './AuthContext';

const LAST_ACTIVE_PROJECT_KEY = 'termag:lastActiveProject';

interface ProjectContextValue {
  projects: Project[];
  activeProjectId: string | null;
  statusMap: StatusMap;
  setActiveProject: (id: string | null) => void;
  reloadProjects: () => Promise<void>;
  // Returns the active workstream name for a project (defaults to 'main').
  getActiveWorkstream: (projectId: string) => string;
  setActiveWorkstream: (projectId: string, workstreamName: string) => void;
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  activeProjectId: null,
  statusMap: {},
  setActiveProject: () => {},
  reloadProjects: async () => {},
  getActiveWorkstream: () => 'main',
  setActiveWorkstream: () => {},
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<StatusMap>({});
  const wsRef = useRef<WebSocket | null>(null);

  // One per page load. Distinguishes "switch in tab A" from "switch in tab B"
  // when the user has multiple tabs open.
  const sessionTag = useMemo(() => {
    try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
  }, []);

  // Seed from localStorage so the first switch after a page reload is logged
  // as a real switch (prev → new) rather than a phantom (null → new).
  const previousProjectIdRef = useRef<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_ACTIVE_PROJECT_KEY) : null
  );

  const setActiveProject = useCallback((id: string | null) => {
    if (id !== previousProjectIdRef.current) {
      visitsApi.record({
        projectId: id,
        previousProjectId: previousProjectIdRef.current,
        sessionTag,
      });
      previousProjectIdRef.current = id;
      try {
        if (id === null) localStorage.removeItem(LAST_ACTIVE_PROJECT_KEY);
        else localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, id);
      } catch { /* private mode etc. */ }
    }
    setActiveProjectId(id);
  }, [sessionTag]);

  // Active workstream is keyed by projectId; defaults to 'main' when unset.
  // We don't persist this across reloads — switching back to 'main' on a
  // page refresh is the right default for "I just opened the app."
  const [activeWorkstreamMap, setActiveWorkstreamMap] = useState<Record<string, string>>({});

  const getActiveWorkstream = useCallback((projectId: string): string => {
    return activeWorkstreamMap[projectId] ?? 'main';
  }, [activeWorkstreamMap]);

  const setActiveWorkstream = useCallback((projectId: string, workstreamName: string) => {
    setActiveWorkstreamMap(m => ({ ...m, [projectId]: workstreamName }));
  }, []);

  const reloadProjects = useCallback(async () => {
    const data = await projectsApi.list();
    setProjects(data);
    // Drop stale active-workstream entries for projects whose current
    // workstream list no longer contains the selected name. Prevents the
    // UI from chasing a session that just got deleted out from under it.
    setActiveWorkstreamMap(m => {
      const next: Record<string, string> = {};
      for (const p of data) {
        const wanted = m[p.id];
        if (wanted && p.workstreams.some(w => w.name === wanted)) {
          next[p.id] = wanted;
        }
      }
      return next;
    });
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
                contextTokens: (msg as any).contextTokens,
                rateLimited: (msg as any).rateLimited,
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
    <ProjectContext.Provider value={{
      projects, activeProjectId, statusMap, setActiveProject, reloadProjects,
      getActiveWorkstream, setActiveWorkstream,
    }}>
      {children}
    </ProjectContext.Provider>
  );
}

export const useProjects = () => useContext(ProjectContext);
