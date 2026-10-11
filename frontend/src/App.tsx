import React, { useState, useRef, useCallback, useEffect } from 'react';
import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { contextLevel } from './utils/thresholds';
import { SIDEBAR_WIDTH_DEFAULT, clampSidebarWidth, effectiveSidebarWidth, readSidebarWidth, writeSidebarWidth } from './utils/sidebarWidth';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProjectProvider } from './contexts/ProjectContext';
import { ConnectionProvider, useConnection } from './contexts/ConnectionContext';
import { formatSince } from './utils/connection';
import { FeatureFlagsProvider } from './contexts/FeatureFlagsProvider';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { FLAGS, useFlag } from './flags';
import { ProjectControl } from './components/ProjectControl';
import { Terminal } from './components/Terminal';
import { Hyperspace } from './components/Hyperspace';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { PrContextPrompt } from './components/PrContextPrompt';
import { ReviewButton } from './components/ReviewButton';
import { ReviewDock } from './components/ReviewDock';
import { ThemeProvider, useTheme } from './theme/ThemeProvider';
import { useEasedWarp } from './hooks/useEasedWarp';
import { useStatusFavicon } from './hooks/useStatusFavicon';
import { UsageMini } from './components/UsageMini';
import { useProjects } from './contexts/ProjectContext';
import { useAuth as useAuthHook } from './contexts/AuthContext';
import { computeWarpWithFallback } from './utils/warp';
import { sessionName as buildSessionName } from './utils/sessionName';
import { statusKey } from './utils/statusKey';
import { rateLimitLabel } from './utils/rateLimit';
import { activityApi, warpApi, authApi, reviewApi, AuthMode } from './services/api';
import type { SessionReview } from './types';
import { boxFeed } from './services/boxFeed';
import { mobileHrefFromWorkspaceSearch, MOBILE_MEDIA_QUERY, readOptOut, shouldRedirectToMobile } from './mobile/redirect';

function Login() {
  // The backend decides the sign-in mechanism (AUTH_MODE); fetch it so the
  // button label matches reality instead of hardcoding a provider. The entry
  // point is mode-agnostic — the backend routes /auth/login accordingly.
  const [mode, setMode] = useState<AuthMode | null>(null);
  useEffect(() => {
    authApi.config().then(c => setMode(c.mode)).catch(() => {});
  }, []);
  const label = mode === 'okta' ? 'Sign in with Okta'
    : mode === 'oidc' ? 'Sign in with SSO'
    : mode === 'google' ? 'Sign in with Google'
    : 'Sign in';

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>termag</h1>
        <p>Workspace manager</p>
        <a href="/termag/auth/login" className="btn-primary">{label}</a>
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
  const connection = useConnection();
  useStatusFavicon();

  useEffect(() => {
    if (!user) return;
    boxFeed.start();
    return () => boxFeed.stop();
  }, [user]);

  // The starfield shows when the hyperspace flag allows it (defaults on) and
  // the user's theme asks for it.
  // The flag can only take it away. Otherwise .app-layout paints --bg-backdrop,
  // which the theme sets (theme/ThemeProvider.tsx): the base colour, or the
  // user's solid colour.
  const hyperspaceAllowed = useFlag(FLAGS.hyperspaceBackground, true);
  const { theme } = useTheme();
  const showHyperspace = hyperspaceAllowed && theme.background.mode === 'hyperspace';

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
  const reviewSession = activeProject
    ? buildSessionName(sessionOwner, activeProject.name, 'review', activeWorkstream)
    : '';

  // Devin review pane (Review button → ReviewDock under the ctrl terminal),
  // per project+workstream. Its state rides the agent session's status
  // (`review`, the only thing the backend's review sweep writes); the
  // browser polls nothing. A tiny optimistic
  // overlay bridges the POST→push gap for the pane that was just started, and
  // hides a just-stopped one until the clearing push lands.
  const reviewKey = activeProject ? `${activeProject.id}/${activeWorkstream}` : '';
  const [reviewExpanded, setReviewExpanded] = useState<Record<string, boolean>>({});
  const [reviewOverlay, setReviewOverlay] = useState<Record<string, { review: SessionReview } | 'cleared'>>({});
  const reviewMetaRaw = statusMap[statusKey(activeProject?.instanceId, agentSession)]?.review ?? null;
  const overlay = reviewOverlay[reviewKey];
  const reviewMeta = overlay === 'cleared' ? null : overlay?.review ?? reviewMetaRaw;
  // Drop the overlay once the pushed truth covers it — and on a timer in case
  // the push never lands (offline browser, an agent that never reports).
  useEffect(() => {
    if (overlay === undefined) return;
    const truthCovers = overlay === 'cleared' ? reviewMetaRaw == null : reviewMetaRaw != null;
    if (truthCovers) {
      setReviewOverlay(prev => { if (!(reviewKey in prev)) return prev; const next = { ...prev }; delete next[reviewKey]; return next; });
      return;
    }
    const t = setTimeout(() => {
      setReviewOverlay(prev => { if (!(reviewKey in prev)) return prev; const next = { ...prev }; delete next[reviewKey]; return next; });
    }, 8000);
    return () => clearTimeout(t);
  }, [overlay, reviewMetaRaw, reviewKey]);
  const reviewStatus = reviewMeta
    ? {
        session: reviewSession,
        // The sweep owns the truth; a lost connection greys the status glyph
        // client-side (`.stale`) instead of an offline poller answer.
        connected: true as const,
        alive: true as const,
        running: reviewMeta.state === 'reviewing' || reviewMeta.state === 'waiting' || reviewMeta.state === 'done',
        state: reviewMeta.state,
        pr: reviewMeta.pr,
        url: reviewMeta.url,
        startedAt: null,
      }
    : null;
  const review = reviewStatus ? { expanded: reviewExpanded[reviewKey] ?? false, status: reviewStatus } : null;
  const onReviewStarted = useCallback((r: { pr: number; url: string | null; session: string }) => {
    setReviewOverlay(prev => ({
      ...prev,
      [reviewKey]: { review: { state: 'reviewing', pr: r.pr, url: r.url, at: new Date().toISOString(), doneAt: null, seenAt: null } },
    }));
    setReviewExpanded(prev => ({ ...prev, [reviewKey]: true }));
  }, [reviewKey]);
  const toggleReview = useCallback(() => {
    setReviewExpanded(prev => ({ ...prev, [reviewKey]: !prev[reviewKey] }));
  }, [reviewKey]);
  const stopReview = useCallback(() => {
    if (!activeProject) return;
    setReviewOverlay(prev => ({ ...prev, [reviewKey]: 'cleared' }));
    reviewApi.stop(activeProject.id, activeWorkstream).catch(() => {});
  }, [activeProject, activeWorkstream, reviewKey]);

  // Typing boost — decays after 1.5s of no keystrokes
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onActivity = useCallback(() => {
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 1500);
  }, []);

  // Heartbeat for human activity tracking — send every 30s while typing
  useEffect(() => {
    if (!typing || !activeProject) return;
    activityApi.heartbeat(activeProject.name, activeProject.instanceId ?? null).catch(() => {});
    const interval = setInterval(() => {
      if (activeProject) {
        activityApi.heartbeat(activeProject.name, activeProject.instanceId ?? null).catch(() => {});
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
          return [statusKey(p.instanceId, agentSession), statusMap[statusKey(p.instanceId, agentSession)]] as const;
        });
    })
    .filter(([, status]) => Boolean(status)));

  const warpModel = computeWarpWithFallback(projectAgentStatuses, typing);
  const activeCount = warpModel.workingCount + warpModel.waitingCount;
  // Sidebar speed readout, eased toward the target by a timer rather than by
  // the canvas, so it keeps moving when the starfield is off or frozen.
  const warpSpeed = useEasedWarp(warpModel.targetWarp);

  // Per-5s sample of targetWarp posted to the backend, which rolls samples
  // into per-minute buckets in warp_samples. Use a ref so the interval reads
  // the current value without being torn down and rebuilt on every render.
  const targetWarpRef = useRef(warpModel.targetWarp);
  useEffect(() => { targetWarpRef.current = warpModel.targetWarp; });
  // Skip samples while offline: they fail anyway (and the failures are
  // already counted by the axios interceptor via the probe loop), and once
  // reconnected a burst of queued values would record activity that never
  // happened. Degraded still samples — that traffic doubles as evidence.
  const connectionRef = useRef(connection.state);
  useEffect(() => { connectionRef.current = connection.state; });
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => {
      if (connectionRef.current === 'offline') return;
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

  // Adjustable agent/ctrl split (wide mode only). Agent pane gets `agentPct`%
  // of the width; the divider drags it (clamped 15–85), double-click resets to
  // 50. Persisted to localStorage. The terminals' own ResizeObserver refits
  // them as the panes resize, so nothing else to wire.
  const [agentPct, setAgentPct] = useState<number>(() => {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('termag-pane-split') : null;
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) && n >= 15 && n <= 85 ? n : 50;
  });
  const panesRef = useRef<HTMLDivElement>(null);
  const draggingDivider = useRef(false);
  useEffect(() => {
    try { localStorage.setItem('termag-pane-split', String(agentPct)); } catch { /* private mode */ }
  }, [agentPct]);
  const onDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingDivider.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onDividerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingDivider.current || !panesRef.current) return;
    const rect = panesRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setAgentPct(Math.max(15, Math.min(85, pct)));
  }, []);
  const onDividerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingDivider.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  // Adjustable sidebar width: a handle on its right edge drags it (clamped
  // 180–480), double-click resets, remembered per browser. The project list
  // reflows on its own; nothing else measures the sidebar.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth(typeof localStorage !== 'undefined' ? localStorage : null));
  const sidebarRef = useRef<HTMLDivElement>(null);
  const draggingSidebar = useRef(false);
  useEffect(() => { writeSidebarWidth(typeof localStorage !== 'undefined' ? localStorage : null, sidebarWidth); }, [sidebarWidth]);
  // The saved width is capped against the live viewport so the terminals and
  // the handle stay visible when a width saved on a desktop meets a phone.
  const [viewportWidth, setViewportWidth] = useState<number>(() => (typeof window !== 'undefined' ? window.innerWidth : SIDEBAR_WIDTH_DEFAULT * 4));
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const sidebarPx = effectiveSidebarWidth(sidebarWidth, viewportWidth);
  const onSidebarHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingSidebar.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onSidebarHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingSidebar.current || !sidebarRef.current) return;
    setSidebarWidth(clampSidebarWidth(e.clientX - sidebarRef.current.getBoundingClientRect().left));
  }, []);
  const onSidebarHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingSidebar.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  return (
    <div className="app-layout">
      {/* Sustained-offline takeover: dims everything below (fixed, z 200). */}
      <ConnectionOverlay />
      {showHyperspace && (
        <div className="app-hyperspace-bg">
          <Hyperspace
            activeCount={activeCount}
            typingBoost={typing}
            targetWarp={warpModel.targetWarp}
            connection={connection.state}
          />
        </div>
      )}
      <div className="app-sidebar" ref={sidebarRef} style={{ ['--control-width' as string]: `${sidebarPx}px` } as React.CSSProperties}>
        <div className="app-control">
          <ProjectControl />
        </div>
        <div
          className="app-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize the sidebar; double-click to reset"
          onPointerDown={onSidebarHandleDown}
          onPointerMove={onSidebarHandleMove}
          onPointerUp={onSidebarHandleUp}
          onPointerCancel={onSidebarHandleUp}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
        />
        {/* Indicators own the sidebar's bottom edge: the project list above
            scrolls to a hard stop here instead of sliding underneath them.
            The thermometer and warp readout are opt-in (Settings →
            Appearance); the connection state shows here regardless. */}
        {(theme.sidebarActivity || connection.state !== 'online') && (
          <div className="app-sidebar-footer">
            {theme.sidebarActivity && <UsageMini />}
            {connection.state === 'online' ? (
              <div className="warp-indicator" data-active={isActive || undefined}>
                {warpStr}<em>c</em>
              </div>
            ) : (
              // The speed readout is meaningless without live statuses; use its
              // slot for the connection state so the sidebar says what the
              // starfield is showing.
              <div
                className="warp-indicator connection-indicator"
                data-connection={connection.state}
                title={connection.lastContactAt
                  ? `Last contact with termag: ${new Date(connection.lastContactAt).toLocaleTimeString()}`
                  : 'No contact with termag yet'}
              >
                {connection.state === 'offline' ? 'offline' : 'reconnecting'}
                {connection.lastContactAt != null && (
                  <small>{formatSince(connection.now - connection.lastContactAt)}</small>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="app-terminals">
        {connection.state !== 'online' && (
          <div className="connection-banner" data-connection={connection.state} role="status" aria-live="polite">
            {connection.state === 'offline'
              ? <>Connection to termag lost{connection.lastContactAt != null && <> · last contact {formatSince(connection.now - connection.lastContactAt)} ago</>} · statuses below are stale · retrying</>
              : <>Reconnecting to termag…</>}
          </div>
        )}
        <div className="app-project-bar">
          {activeProject ? (
            activeWorkstream === 'main'
              ? activeProject.name
              : <>{activeProject.name} <span className="workstream-bar-badge">{activeWorkstream}</span></>
          ) : '—'}
          {activeProject && (() => {
            const st = statusMap[statusKey(activeProject.instanceId, agentSession)];
            if (st?.rateLimited) {
              return (
                <span className="rate-limit-bar-badge" title={st.rateLimited}>
                  {rateLimitLabel(st.rateLimited)}
                </span>
              );
            }
            const ctx = st?.contextTokens;
            if (ctx == null) return null;
            const level = contextLevel(ctx);
            const label = ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1)}M` : `${Math.round(ctx / 1000)}K`;
            const title = level === 'ok' ? 'Context tokens' : 'Context tokens — consider /clear';
            return (
              <span className={`ctx-bar-badge ctx-bar-${level}`} title={title}>
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
        <div className="app-panes" ref={panesRef}>
          {(!isNarrow || activePane === 'agent') && (
            <div
              className="app-agent"
              id="terminal-agent"
              style={(!isNarrow && activeProject && hasAgent) ? { flex: `0 0 ${agentPct}%` } : undefined}
            >
              {activeProject && hasAgent ? (
                <>
                  <Terminal
                    sessionName={agentSession}
                    projectId={activeProject.id}
                    workstream={activeWorkstream}
                    instanceId={activeProject.instanceId}
                    active={true}
                    autoFocus={!isNarrow || activePane === 'agent'}
                    onActivity={onActivity}
                    key={`${activeProject.id}-${activeWorkstream}-agent${isNarrow ? `-${activePane}` : ''}`}
                  />
                  {/* Overlay strip across the top of THIS pane (.app-agent is
                      position: relative): "PR opened — Compact / Clear / Keep". */}
                  <PrContextPrompt
                    projectId={activeProject.id}
                    instanceId={activeProject.instanceId}
                    workstream={activeWorkstream}
                    session={agentSession}
                    status={statusMap[statusKey(activeProject.instanceId, agentSession)]}
                  />
                  {/* Lower-right overlay: start a Devin review of the PR being worked on. */}
                  <ReviewButton
                    projectId={activeProject.id}
                    workstream={activeWorkstream}
                    hasReview={!!review}
                    onStarted={onReviewStarted}
                    key={`${activeProject.id}-${activeWorkstream}-review-btn`}
                  />
                </>
              ) : (
                <div className="empty-pane">
                  {activeProject ? 'Add an agent workflow →' : 'Select a project'}
                </div>
              )}
            </div>
          )}
          {!isNarrow && activeProject && hasAgent && (
            <div
              className="pane-divider"
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onDoubleClick={() => setAgentPct(50)}
              title="Drag to resize · double-click to reset"
            />
          )}
          {(!isNarrow || activePane === 'ctrl') && (
            <div className={`app-ctrl ${isNarrow ? 'app-ctrl-full' : ''}`} id="terminal-ctrl">
              {activeProject && hasAgent ? (
                <>
                  <div className="app-ctrl-term">
                    <Terminal
                      sessionName={ctrlSession}
                      projectId={activeProject.id}
                      workstream={activeWorkstream}
                      instanceId={activeProject.instanceId}
                      active={true}
                      autoFocus={isNarrow && activePane === 'ctrl'}
                      onActivity={onActivity}
                      key={`${activeProject.id}-${activeWorkstream}-ctrl${isNarrow ? `-${activePane}` : ''}`}
                    />
                  </div>
                  {/* The Devin review pane docks under the ctrl terminal:
                      a one-line bar collapsed, half the column expanded. */}
                  {review && (
                    <ReviewDock
                      projectId={activeProject.id}
                      instanceId={activeProject.instanceId}
                      workstream={activeWorkstream}
                      sessionName={reviewSession}
                      status={review.status}
                      review={reviewMeta}
                      expanded={review.expanded}
                      onToggle={toggleReview}
                      onStop={stopReview}
                    />
                  )}
                </>
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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const Welcome = lazy(() => import('./pages/Welcome'));
const MobileApp = lazy(() => import('./pages/mobile/MobileApp'));

/**
 * Phone-sized viewports go to the mobile client when the
 * `mobile-redirect-enabled` flag is on and this browser has not pressed
 * "Full UI". Sits inside FeatureFlagsProvider (for the flag) and before
 * MainLayout, so no terminal socket is opened for a page that is about to leave.
 */
function MobileRedirectGate({ children }: { children: React.ReactNode }) {
  const flagOn = useFlag(FLAGS.mobileRedirect, false);
  const phoneLike = typeof window !== 'undefined' && window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  const optedOut = readOptOut(typeof localStorage !== 'undefined' ? localStorage : null);
  if (shouldRedirectToMobile({ flagOn, phoneLike, optedOut })) {
    return <Navigate to={mobileHrefFromWorkspaceSearch(window.location.search)} replace />;
  }
  return <>{children}</>;
}

/**
 * First-run gate for the workspace: a user who has never finished setup and
 * has no projects is sent to /welcome. /welcome itself is
 * outside this gate, and finishing/skipping clears the flag.
 */
function FirstRunGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.needsOnboarding) return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        {/* Inside ThemeProvider so the error card has the theme's variables;
            around every route so a crash anywhere shows a message, not a blank page. */}
        <AppErrorBoundary>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Dashboard: its own route, deliberately outside FeatureFlagsProvider /
              ProjectProvider / MainLayout — no status WebSocket, no terminals, no
              hyperspace canvas, and no human heartbeat (reading the dashboard must
              not count as working time). Lazy so Recharts stays out of the
              workspace bundle. Suspense sits INSIDE RequireAuth so a logged-out
              visitor never downloads the chunk. */}
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                  <Dashboard />
                </Suspense>
              </RequireAuth>
            }
          />
          {/* First-run setup: its own page, outside the workspace layout. */}
          <Route
            path="/welcome"
            element={
              <RequireAuth>
                <FeatureFlagsProvider>
                  <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                    <Welcome />
                  </Suspense>
                </FeatureFlagsProvider>
              </RequireAuth>
            }
          />
          {/* Settings: mounted like the dashboard, outside the workspace layout. */}
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                  <Settings />
                </Suspense>
              </RequireAuth>
            }
          />
          {/* Admin: same isolation as the dashboard. The
              page redirects non-admins; the server 404s them regardless. */}
          <Route
            path="/admin/*"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                  <Admin />
                </Suspense>
              </RequireAuth>
            }
          />
          {/* Phone client: same providers as the workspace,
              no MainLayout — an inbox and a chat view over the agent pane. */}
          <Route
            path="/m/*"
            element={
              <RequireAuth>
                <FirstRunGate>
                <FeatureFlagsProvider>
                  <ConnectionProvider>
                    <ProjectProvider>
                      <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                        <MobileApp />
                      </Suspense>
                    </ProjectProvider>
                  </ConnectionProvider>
                </FeatureFlagsProvider>
                </FirstRunGate>
              </RequireAuth>
            }
          />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <FirstRunGate>
                <FeatureFlagsProvider>
                  <ConnectionProvider>
                    <ProjectProvider>
                      <MobileRedirectGate>
                        <MainLayout />
                      </MobileRedirectGate>
                    </ProjectProvider>
                  </ConnectionProvider>
                </FeatureFlagsProvider>
                </FirstRunGate>
              </RequireAuth>
            }
          />
        </Routes>
        </AppErrorBoundary>
      </ThemeProvider>
    </AuthProvider>
  );
}
