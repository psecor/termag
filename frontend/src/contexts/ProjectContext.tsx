import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
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

// Read the active project (+workstream) straight from the current query string.
// Used for the synchronous initial state so a refresh of ?project=… opens that
// project on first paint (no blank flash).
function paramsFromUrl(): { id: string | null; ws: string } {
  const sp = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  return { id: sp.get('project') || null, ws: sp.get('ws') || 'main' };
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  // Initialize from the URL so a refresh restores immediately. The URL is the
  // source of truth for the active project + its workstream (see effects below).
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => paramsFromUrl().id);
  const [activeWorkstreamMap, setActiveWorkstreamMap] = useState<Record<string, string>>(() => {
    const { id, ws } = paramsFromUrl();
    return id && ws !== 'main' ? { [id]: ws } : {};
  });
  const [statusMap, setStatusMap] = useState<StatusMap>({});
  const wsRef = useRef<WebSocket | null>(null);

  // One per page load. Distinguishes "switch in tab A" from "switch in tab B"
  // when the user has multiple tabs open.
  const sessionTag = useMemo(() => {
    try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
  }, []);

  // Seed from localStorage so the first user switch after a reload logs as a
  // real switch (prev → new), not a phantom — and so the initial URL restore
  // (handled by the effects below, which don't record) isn't counted as one.
  const previousProjectIdRef = useRef<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_ACTIVE_PROJECT_KEY) : null
  );
  // Refs mirror state for use inside stable callbacks without stale closures.
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const activeWorkstreamMapRef = useRef(activeWorkstreamMap);
  activeWorkstreamMapRef.current = activeWorkstreamMap;

  // Mutate the current query string in place and write it back.
  const updateParams = useCallback((mutate: (p: URLSearchParams) => void, opts?: { replace?: boolean }) => {
    const next = new URLSearchParams(window.location.search);
    mutate(next);
    setSearchParams(next, opts);
  }, [setSearchParams]);

  // Public switch. Records the visit + persists last-active, then PUSHES the
  // project (and its current workstream) into the URL — push so the browser's
  // back/forward walks project history. The URL→state effect turns that into
  // activeProjectId; it does not re-record, so back/forward & refresh don't
  // inflate the switch metric.
  const setActiveProject = useCallback((id: string | null) => {
    if (id !== previousProjectIdRef.current) {
      visitsApi.record({ projectId: id, previousProjectId: previousProjectIdRef.current, sessionTag });
      previousProjectIdRef.current = id;
      try {
        if (id === null) localStorage.removeItem(LAST_ACTIVE_PROJECT_KEY);
        else localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, id);
      } catch { /* private mode etc. */ }
    }
    updateParams(p => {
      if (id === null) { p.delete('project'); p.delete('ws'); return; }
      p.set('project', id);
      const ws = activeWorkstreamMapRef.current[id] ?? 'main';
      if (ws && ws !== 'main') p.set('ws', ws); else p.delete('ws');
    });
  }, [sessionTag, updateParams]);

  const getActiveWorkstream = useCallback((projectId: string): string => {
    return activeWorkstreamMap[projectId] ?? 'main';
  }, [activeWorkstreamMap]);

  const setActiveWorkstream = useCallback((projectId: string, workstreamName: string) => {
    setActiveWorkstreamMap(m => ({ ...m, [projectId]: workstreamName }));
    // Reflect in the URL when it's the active project, so a refresh restores the
    // exact workstream. Replace, not push — a workstream change isn't its own
    // back/forward step.
    if (projectId === activeProjectIdRef.current) {
      updateParams(p => {
        if (workstreamName && workstreamName !== 'main') p.set('ws', workstreamName);
        else p.delete('ws');
      }, { replace: true });
    }
  }, [updateParams]);

  // URL → state. Single source of truth; fires on user switches, back/forward,
  // bookmarks, and the restore below. No visit recording here (see above).
  useEffect(() => {
    const id = searchParams.get('project') || null;
    const ws = searchParams.get('ws') || 'main';
    setActiveProjectId(id);
    if (id) setActiveWorkstreamMap(m => (m[id] === ws ? m : { ...m, [id]: ws }));
  }, [searchParams]);

  // On a bare URL (e.g. fresh open of /termag with no params), seed the project
  // param from last-active so the effect above opens it. Replace, so it's not a
  // history entry. Runs once.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (searchParams.get('project')) return;
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_ACTIVE_PROJECT_KEY); } catch { /* ignore */ }
    if (last) updateParams(p => p.set('project', last as string), { replace: true });
  }, [searchParams, updateParams]);

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
