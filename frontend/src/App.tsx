import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProjectProvider } from './contexts/ProjectContext';
import { ProjectControl } from './components/ProjectControl';
import { Terminal } from './components/Terminal';
import { Hyperspace } from './components/Hyperspace';
import { UsageMini } from './components/UsageMini';
import { useProjects } from './contexts/ProjectContext';
import { useAuth as useAuthHook } from './contexts/AuthContext';
import { Project } from './types';
import { computeWarpWithFallback } from './utils/warp';
import { sessionName as buildSessionName } from './utils/sessionName';
import { activityApi, warpApi } from './services/api';

function Login() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>termag</h1>
        <p>Workspace manager</p>
        <a href="/termag/auth/google" className="btn-primary">Sign in with Google</a>
      </div>
    </div>
  );
}

// ?narrow=N in the URL overrides the default breakpoint. Lets users on
// lower-resolution screens keep the side-by-side layout at widths where
// it would otherwise collapse. Read once at mount; bookmark the URL with
// the param to persist across visits.
function useIsNarrow(defaultBreakpoint = 1600) {
  const breakpoint = (() => {
    const raw = new URLSearchParams(window.location.search).get('narrow');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : defaultBreakpoint;
  })();
  const [narrow, setNarrow] = useState(window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', handler);
    setNarrow(mq.matches);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return narrow;
}

function MainLayout() {
  const { user } = useAuthHook();
  const { projects, activeProjectId, statusMap, getActiveWorkstream } = useProjects();

  const activeProject = projects.find(p => p.id === activeProjectId);
  const hasAgent = activeProject?.workflows.some(w => w.type === 'agent');
  const username = user?.unixUsername ?? '';
  const sessionOwner = activeProject?.ownerUsername ?? username;
  const activeWorkstream = activeProject ? getActiveWorkstream(activeProject.id) : 'main';
  const agentSession = activeProject
    ? buildSessionName(sessionOwner, activeProject.name, 'agent', activeWorkstream)
    : '';
  const ctrlSession = activeProject
    ? buildSessionName(sessionOwner, activeProject.name, 'ctrl', activeWorkstream)
    : '';

  // Typing boost — decays after 1.5s of no keystrokes
  const [typing, setTyping] = useState(false);
  const [warpSpeed, setWarpSpeed] = useState(0.1);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onActivity = useCallback(() => {
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 1500);
  }, []);

  // Heartbeat for human activity tracking — send every 30s while typing
  useEffect(() => {
    if (!typing || !activeProject) return;
    activityApi.heartbeat(activeProject.name).catch(() => {});
    const interval = setInterval(() => {
      if (activeProject) {
        activityApi.heartbeat(activeProject.name).catch(() => {});
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [typing, activeProject]);

  // Iterate every workstream on every project so warp sees parallel work in
  // non-`main` workstreams too. buildSessionName collapses `main` to the
  // historical 3-segment name so single-workstream projects are unchanged.
  const projectAgentStatuses = Object.fromEntries(projects
    .filter(p => p.workflows.some(w => w.type === 'agent'))
    .flatMap(p => {
      const owner = p.ownerUsername ?? username;
      return p.workstreams
        .filter(ws => !ws.archived)
        .map(ws => {
          const agentSession = buildSessionName(owner, p.name, 'agent', ws.name);
          return [agentSession, statusMap[agentSession]] as const;
        });
    })
    .filter(([, status]) => Boolean(status)));

  const warpModel = computeWarpWithFallback(projectAgentStatuses, typing);
  const activeCount = warpModel.workingCount + warpModel.waitingCount;

  // Per-5s sample of targetWarp posted to the backend, which rolls samples
  // into per-minute buckets in warp_samples. Use a ref so the interval reads
  // the current value without being torn down and rebuilt on every render.
  const targetWarpRef = useRef(warpModel.targetWarp);
  useEffect(() => { targetWarpRef.current = warpModel.targetWarp; });
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => {
      warpApi.sample(targetWarpRef.current);
    }, 5000);
    return () => clearInterval(id);
  }, [user]);

  const isActive = warpModel.isActive;
  const warpStr = warpSpeed < 10 ? warpSpeed.toFixed(1) : Math.floor(warpSpeed).toString();

  useEffect(() => {
    if (!('BroadcastChannel' in window)) return;

    const channel = new BroadcastChannel('termag-warp-speed');
    channel.postMessage({ warpSpeed });
    return () => channel.close();
  }, [warpSpeed]);

  // Responsive layout
  const isNarrow = useIsNarrow();
  const [activePane, setActivePane] = useState<'agent' | 'ctrl'>('agent');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 1600);

  // Auto-collapse when crossing the breakpoint
  useEffect(() => {
    setSidebarCollapsed(isNarrow);
  }, [isNarrow]);

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      <div className="app-hyperspace-bg">
        <Hyperspace
          activeCount={activeCount}
          typingBoost={typing}
          targetWarp={warpModel.targetWarp}
          onWarpChange={setWarpSpeed}
        />
      </div>
      <UsageMini />
      <div className="warp-indicator" data-active={isActive || undefined}>
        {warpStr}<em>c</em>
      </div>
      <div className={`app-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed(s => !s)}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>
        {sidebarCollapsed ? (
          <SidebarCollapsed
            projects={projects}
            activeProjectId={activeProjectId}
            statusMap={statusMap}
            username={username}
          />
        ) : (
          <div className="app-control">
            <ProjectControl />
          </div>
        )}
      </div>
      <div className="app-terminals">
        <div className="app-project-bar">
          {activeProject ? (
            activeWorkstream === 'main'
              ? activeProject.name
              : <>{activeProject.name} <span className="workstream-bar-badge">{activeWorkstream}</span></>
          ) : '—'}
          {activeProject && (() => {
            const st = statusMap[agentSession];
            if (st?.rateLimited) {
              return (
                <span className="rate-limit-bar-badge" title={st.rateLimited}>
                  RATE LIMITED
                </span>
              );
            }
            const ctx = st?.contextTokens;
            if (!ctx || ctx < 500_000) return null;
            const level = ctx >= 1_000_000 ? 'danger' : 'warn';
            const label = ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1)}M` : `${Math.round(ctx / 1000)}K`;
            return (
              <span className={`ctx-bar-badge ctx-bar-${level}`} title="Context tokens — consider /clear">
                {label}
              </span>
            );
          })()}
          {isNarrow && activeProject && hasAgent && (
            <div className="pane-tabs">
              <button
                className={`pane-tab ${activePane === 'agent' ? 'active' : ''}`}
                onClick={() => setActivePane('agent')}
              >agent</button>
              <button
                className={`pane-tab ${activePane === 'ctrl' ? 'active' : ''}`}
                onClick={() => setActivePane('ctrl')}
              >ctrl</button>
            </div>
          )}
        </div>
        <div className="app-panes">
          {(!isNarrow || activePane === 'agent') && (
            <div className="app-agent" id="terminal-agent">
              {activeProject && hasAgent ? (
                <Terminal
                  sessionName={agentSession}
                  projectId={activeProject.id}
                  workstream={activeWorkstream}
                  active={true}
                  autoFocus={!isNarrow || activePane === 'agent'}
                  onActivity={onActivity}
                  key={`${activeProject.id}-${activeWorkstream}-agent${isNarrow ? `-${activePane}` : ''}`}
                />
              ) : (
                <div className="empty-pane">
                  {activeProject ? 'Add an agent workflow →' : 'Select a project'}
                </div>
              )}
            </div>
          )}
          {(!isNarrow || activePane === 'ctrl') && (
            <div className={`app-ctrl ${isNarrow ? 'app-ctrl-full' : ''}`} id="terminal-ctrl">
              {activeProject && hasAgent ? (
                <Terminal
                  sessionName={ctrlSession}
                  projectId={activeProject.id}
                  workstream={activeWorkstream}
                  active={true}
                  autoFocus={isNarrow && activePane === 'ctrl'}
                  onActivity={onActivity}
                  key={`${activeProject.id}-${activeWorkstream}-ctrl${isNarrow ? `-${activePane}` : ''}`}
                />
              ) : (
                <div className="empty-pane">
                  {activeProject ? 'Add an agent workflow →' : 'Select a project'}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getInitials(name: string): string {
  // Split on dashes/underscores, take first char of each word, max 3
  const parts = name.split(/[-_]+/).filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 3).map(w => w[0]).join('').toUpperCase();
  // Single word: first 2 chars
  return name.slice(0, 2).toUpperCase();
}

function SidebarCollapsed({
  projects, activeProjectId, statusMap, username,
}: {
  projects: Project[];
  activeProjectId: string | null;
  statusMap: Record<string, { status: string; contextTokens?: number; rateLimited?: string | null } | undefined>;
  username: string;
}) {
  const { setActiveProject } = useProjects();
  return (
    <div className="sidebar-collapsed-list">
      {projects.map(p => {
        const owner = p.ownerUsername ?? username;
        const agentSession = `${owner}-${p.name}-agent`;
        const st = statusMap[agentSession];
        const s = st?.status ?? 'not_running';
        const ctx = st?.contextTokens;
        const rateLimit = st?.rateLimited;
        const ctxLevel = ctx && ctx >= 1_000_000 ? 'danger' : ctx && ctx >= 500_000 ? 'warn' : null;
        const color = s === 'working' ? 'var(--success)' : s === 'waiting' ? 'var(--warning)' : s === 'idle' ? 'var(--danger)' : 'var(--text-muted)';
        const ringClass = rateLimit ? 'rate-limit-ring' : ctxLevel ? `ctx-ring-${ctxLevel}` : '';
        return (
          <div
            key={p.id}
            className={`sidebar-collapsed-item ${activeProjectId === p.id ? 'active' : ''} ${rateLimit ? 'rate-limited' : ''}`}
            title={rateLimit ? `⚠ ${rateLimit}` : p.name}
            onClick={() => setActiveProject(p.id)}
          >
            <span className={`sidebar-dot-light ${ringClass}`} style={{ background: color }} />
            <span className="sidebar-collapsed-initials">{getInitials(p.name)}</span>
          </div>
        );
      })}
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <ProjectProvider>
                <MainLayout />
              </ProjectProvider>
            </RequireAuth>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
