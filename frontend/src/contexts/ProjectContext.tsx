import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Project, StatusMap, AgentStatusValue } from '../types';
import { projectsApi, visitsApi } from '../services/api';
import { useAuth } from './AuthContext';
import { connectionTracker } from '../utils/connectionTracker';
import { statusReconnectDelayMs } from '../utils/connection';
import { statusKey } from '../utils/statusKey';
import { statusFromPush } from '../utils/statusPush';
import { cloudSessionFeed } from '../services/cloudSessionFeed';
import { boxFeed } from '../services/boxFeed';
import { chatEvents, type ChatFrame } from '../chat/chatEvents';
import { workspaceChangeFromPush } from '../utils/workspacePush';
import { FLAGS, useFlag } from '../flags';
import { cloneInFlight } from '../utils/cloneTile';
import { applyListRead, beginListRead, releaseListRead, settleCloneAction, type CloneAction, type CloneListState } from '../utils/cloneList';

export const LAST_ACTIVE_PROJECT_KEY = 'termag:lastActiveProject';

interface ProjectContextValue {
  projects: Project[];
  /** The project list has been read at least once, so an empty list means none. */
  projectsLoaded: boolean;
  activeProjectId: string | null;
  statusMap: StatusMap;
  setActiveProject: (id: string | null) => void;
  reloadProjects: () => Promise<void>;
  settleProjectClone: (projectId: string, action: CloneAction) => Promise<void>;
  // Returns the active workstream name for a project (defaults to 'main').
  getActiveWorkstream: (projectId: string) => string;
  setActiveWorkstream: (projectId: string, workstreamName: string) => void;
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  projectsLoaded: false,
  activeProjectId: null,
  statusMap: {},
  setActiveProject: () => {},
  reloadProjects: async () => {},
  settleProjectClone: async () => {},
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
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const projectsRef = useRef<Project[]>([]);
  const listClock = useRef<CloneListState<Project>>({ generation: 0, projects: [] });
  // Initialize from the URL so a refresh restores immediately. The URL is the
  // source of truth for the active project + its workstream (see effects below).
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => paramsFromUrl().id);
  const [activeWorkstreamMap, setActiveWorkstreamMap] = useState<Record<string, string>>(() => {
    const { id, ws } = paramsFromUrl();
    return id && ws !== 'main' ? { [id]: ws } : {};
  });
  const [statusMap, setStatusMap] = useState<StatusMap>({});
  const wsRef = useRef<WebSocket | null>(null);
  // Claude Code cloud sessions, behind the flag.
  // Started here, not in a layout: the workspace sidebar and the mobile inbox
  // both sit under this provider and read the same store, and a phone visit
  // never mounts the workspace layout.
  const cloudSessionsOn = useFlag(FLAGS.cloudSessions, false);
  useEffect(() => {
    if (!user || !cloudSessionsOn) return;
    cloudSessionFeed.start();
    return () => cloudSessionFeed.stop();
  }, [user, cloudSessionsOn]);

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
      visitsApi.record({
        projectId: id,
        previousProjectId: previousProjectIdRef.current,
        sessionTag,
        workstream: id ? (activeWorkstreamMapRef.current[id] ?? 'main') : null,
      });
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
    const previous = activeWorkstreamMapRef.current[projectId] ?? 'main';
    setActiveWorkstreamMap(m => ({ ...m, [projectId]: workstreamName }));
    // Mirror into the ref NOW, not at the next render: a caller that follows
    // this with setActiveProject in the same tick (the Recents switcher) must
    // see the new workstream when it records the visit and writes ?ws=.
    activeWorkstreamMapRef.current = { ...activeWorkstreamMapRef.current, [projectId]: workstreamName };
    // A workstream change on the active project is a session visit for
    // "Recents" (previousProjectId === projectId marks it as NOT a project
    // switch, so the dashboard's switch metric ignores it).
    if (projectId === activeProjectIdRef.current && workstreamName !== previous) {
      visitsApi.record({ projectId, previousProjectId: projectId, sessionTag, workstream: workstreamName });
    }
    // Reflect in the URL when it's the active project, so a refresh restores the
    // exact workstream. Replace, not push — a workstream change isn't its own
    // back/forward step.
    if (projectId === activeProjectIdRef.current) {
      updateParams(p => {
        if (workstreamName && workstreamName !== 'main') p.set('ws', workstreamName);
        else p.delete('ws');
      }, { replace: true });
    }
  }, [updateParams, sessionTag]);

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

  const rememberList = useCallback((data: Project[]) => {
    projectsRef.current = data;
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

  const readCloneList = useCallback(() => listClock.current, []);

  const writeCloneList = useCallback((state: CloneListState<Project>) => {
    listClock.current = state;
    projectsRef.current = state.projects;
    setProjects(state.projects);
  }, []);

  const reloadProjects = useCallback(async () => {
    const generation = beginListRead(listClock.current.generation);
    listClock.current = { ...listClock.current, generation };
    try {
      const data = await projectsApi.list();
      const next = applyListRead(listClock.current, { generation, projects: data });
      listClock.current = next;
      if (next.projects !== projectsRef.current) rememberList(next.projects);
      // A read that finished before a newer one is held, not shown: the list on screen is still the old one.
      if (next.applied != null) setProjectsLoaded(true);
    } catch (err) {
      const next = releaseListRead(listClock.current, generation);
      listClock.current = next;
      if (next.projects !== projectsRef.current) rememberList(next.projects);
      if (next.applied != null) setProjectsLoaded(true);
      throw err;
    }
  }, [rememberList]);
  const reloadProjectsRef = useRef(reloadProjects);
  reloadProjectsRef.current = reloadProjects;

  const settleProjectClone = useCallback(async (projectId: string, action: CloneAction) => {
    const result = await settleCloneAction({
      read: readCloneList,
      write: writeCloneList,
      projectId,
      action,
      request: () => action === 'retry' ? projectsApi.retryClone(projectId) : projectsApi.startEmpty(projectId),
      reload: () => projectsApi.list(),
    });
    if (result.list) rememberList(result.list);
    // A retry on a project whose box failed launches a new box, which the
    // feed only learns about from a reload.
    if (action === 'retry') void boxFeed.reload();
    if (result.requestError) throw result.requestError;
  }, [readCloneList, rememberList, writeCloneList]);

  useEffect(() => {
    if (!user) return;
    reloadProjects();
  }, [user, reloadProjects]);

  const cloneLive = projects.some(p => cloneInFlight(p.setupStatus));
  useEffect(() => {
    if (!user || !cloneLive) return;
    const timer = setInterval(() => { reloadProjects().catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [user, cloneLive, reloadProjects]);

  // Status WebSocket with auto-reconnect
  useEffect(() => {
    if (!user) return;
    let disposed = false;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (disposed) return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      // Retire any prior socket with its handlers detached, so its eventual
      // onclose can't schedule a second reconnect on top of this one.
      const prev = wsRef.current;
      if (prev) {
        prev.onopen = null; prev.onmessage = null; prev.onclose = null; prev.onerror = null;
        wsRef.current = null;
        // Its onclose is detached, so report the close here — otherwise the
        // tracker would keep claiming a socket is open across the gap.
        connectionTracker.setSocketOpen(false);
        try { prev.close(); } catch { /* ignore */ }
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/termag/ws/status`);
      wsRef.current = ws;
      const isCurrent = () => wsRef.current === ws;
      // Let the ConnectionProvider force-close this socket when it has been
      // silent past the stale threshold (half-open after a VPN drop).
      connectionTracker.closeSocket = () => { try { ws.close(); } catch { /* ignore */ } };
      // …and reopen it without waiting out the reconnect delay, for the cases
      // where the delay is the whole problem: the tab coming back to the
      // foreground, and "Retry now".
      connectionTracker.reconnectSocket = () => { connect(); };

      ws.onopen = () => {
        if (!isCurrent()) { try { ws.close(); } catch { /* ignore */ } return; }
        connectionTracker.setSocketOpen(true);
        connectionTracker.contact('socket');
        // Chat frames may have been missed while the socket was down; the open
        // chat view refetches its history so a finished turn stops showing busy.
        chatEvents.notifyReconnect();
      };

      ws.onmessage = (event) => {
        if (!isCurrent()) return;
        // Every frame — status pushes and the server's periodic heartbeat —
        // is proof the backend is reachable. Record before parsing so a
        // malformed frame still counts.
        connectionTracker.contact('socket');
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
            instanceId?: string | null;
          };
          // A cloud session changed (spawn outcome, the box's report, a sweep):
          // the feed refetches the owner's list (services/cloudSessionFeed.ts).
          if (msg.type === 'claude-session') { void cloudSessionFeed.reload(); return; }
          // A simple-UI chat event (services/chatRunner.ts): the open chat view folds it in.
          if (msg.type === 'chat') { chatEvents.publish(msg as unknown as ChatFrame); return; }
          // A project or box changed outside this tab (the CLI, a spawn, a sweep, another tab).
          const change = workspaceChangeFromPush(msg);
          if (change === 'projects') { reloadProjectsRef.current().catch(() => {}); return; }
          if (change === 'boxes') { void boxFeed.reload(); return; }
          // A share revoked or left took this session out of the viewer's
          // scope (backend services/statusAudience.ts, shareChangeFrames).
          if (msg.type === 'status-gone') {
            setStatusMap(prev => {
              const { [statusKey(msg.instanceId, msg.session)]: _gone, ...rest } = prev;
              return rest;
            });
            return;
          }
          if (msg.type === 'status') {
            setStatusMap(prev => ({
              ...prev,
              [statusKey(msg.instanceId, msg.session)]: statusFromPush(msg),
            }));
          }
        } catch { /* ignore */ }
      };

      ws.onclose = (event) => {
        if (!isCurrent()) return;
        wsRef.current = null;
        connectionTracker.setSocketOpen(false);
        if (disposed) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, statusReconnectDelayMs(event.code));
      };
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connectionTracker.closeSocket = null;
      connectionTracker.reconnectSocket = null;
      wsRef.current?.close();
    };
  }, [user]);

  return (
    <ProjectContext.Provider value={{
      projects, projectsLoaded, activeProjectId, statusMap, setActiveProject, reloadProjects, settleProjectClone,
      getActiveWorkstream, setActiveWorkstream,
    }}>
      {children}
    </ProjectContext.Provider>
  );
}

export const useProjects = () => useContext(ProjectContext);
