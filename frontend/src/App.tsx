import React, { useState, useRef, useCallback, useEffect } from 'react';
import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { contextLevel } from './utils/thresholds';
import { SIDEBAR_WIDTH_DEFAULT, clampSidebarWidth, effectiveSidebarWidth, readSidebarWidth, writeSidebarWidth } from './utils/sidebarWidth';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProjectProvider } from './contexts/ProjectContext';
import { ConnectionProvider, useConnection } from './contexts/ConnectionContext';
import { formatSince } from './utils/connection';
import { FeatureFlagsProvider } from './contexts/FeatureFlagsProvider';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { PrsOverlay } from './components/PrsOverlay';
import { FLAGS, useFlag } from './flags';
import { projectKindTraits } from './utils/projectKind';
import { ProjectControl } from './components/ProjectControl';
import { Terminal } from './components/Terminal';
import { Hyperspace } from './components/Hyperspace';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { PrContextPrompt } from './components/PrContextPrompt';
import { HandoffStrip } from './components/HandoffStrip';
import { canHandOff } from './utils/handoff';
import { ReviewButton } from './components/ReviewButton';
import { ReviewDock } from './components/ReviewDock';
import { ShareDialog } from './components/ShareDialog';
import Preview from './pages/Preview';
import { useBrowserShareHandoff } from './hooks/useBrowserShareHandoff';
import { BrowserDock } from './components/BrowserDock';
import { ThemeProvider, useTheme } from './theme/ThemeProvider';
import { showStarfield } from './theme/apply';
import { useEasedWarp } from './hooks/useEasedWarp';
import { useStatusFavicon } from './hooks/useStatusFavicon';
import { UsageMini } from './components/UsageMini';
import { useProjects } from './contexts/ProjectContext';
import { useAuth as useAuthHook } from './contexts/AuthContext';
import { computeWarpWithFallback } from './utils/warp';
import { sessionName as buildSessionName } from './utils/sessionName';
import { cloneHoldCopy, cloneTile } from './utils/cloneTile';
import { useSetupContext } from './hooks/useSetupContext';
import { statusKey } from './utils/statusKey';
import { rateLimitLabel } from './utils/rateLimit';
import { FOCUS_PANE_EVENT, retryUntil, type FocusPaneDetail } from './utils/workspaceTarget';
import { activityApi, warpApi, authApi, AuthMode } from './services/api';
import { useReviewPanes } from './hooks/useReviewPanes';
import { boxFeed } from './services/boxFeed';
import { useStartParkedBoxOnOpen } from './hooks/useStartParkedBoxOnOpen';
import { BriefingCard } from './components/BriefingCard';
import { APP_START_PATH, appStartTarget, useLaunchQueue } from './mobile/launch';
import { currentUiMode, leavePageEntry, notePageLocation, pageEntry, recordUiMode, shouldOpenSimpleUi, simpleUiShareHandoff } from './chat/uiMode';
import { currentOptOut, installedAppMode, isStandalone, mobileHrefFromWorkspaceSearch, MOBILE_MEDIA_QUERY, setInstalledAppEnabled, shouldRedirectToMobile, TOUCH_MEDIA_QUERY } from './mobile/redirect';
import { readRefreshHint } from './onboarding/refreshHint';

const BROWSER_EXPANDED_KEY = 'termag.browserPane.expanded';
function readBrowserExpanded(): Record<string, boolean> {
  try {
    const raw = window.sessionStorage.getItem(BROWSER_EXPANDED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch { return {}; }
}
function writeBrowserExpanded(state: Record<string, boolean>): void {
  try { window.sessionStorage.setItem(BROWSER_EXPANDED_KEY, JSON.stringify(state)); } catch { /* storage unavailable: the state is just not kept */ }
}

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

  // onboarding-refresh-enabled, as this browser last saw it for a signed-in
  // user: the sign-in page has no user to evaluate it for (onboarding/refreshHint.ts).
  const [refresh] = useState(readRefreshHint);
  if (refresh) return <Suspense fallback={null}><SignIn label={label} /></Suspense>;

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
  const { projects, activeProjectId, statusMap, getActiveWorkstream, setActiveWorkstream } = useProjects();
  const connection = useConnection();
  useStatusFavicon();

  useEffect(() => {
    if (!user) return;
    boxFeed.start();
    // The feed polls only while a box is changing, so a tab left in the
    // background keeps a list from before a box started elsewhere. Coming
    // back to it refetches, unless a list landed in the last 30 s.
    const onVisible = () => { if (document.visibilityState === 'visible') void boxFeed.reloadIfOlderThan(30_000); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      boxFeed.stop();
    };
  }, [user]);

  // The starfield shows when the kill-switch flag allows it (defaults
  // on, so behavior is unchanged without flags) and the user's theme asks for it
  // in the dark palette (its white stars on a dark fade don't belong in light).
  // The flag can only take it away. Otherwise .app-layout paints --bg-backdrop,
  // which the theme sets (theme/ThemeProvider.tsx): the palette's base colour,
  // or the user's solid colour.
  const hyperspaceAllowed = useFlag(FLAGS.hyperspaceBackground, true);
  const { theme } = useTheme();
  const showHyperspace = hyperspaceAllowed && showStarfield(theme);
  // Thanksgiving: the user's turkeys, while the flag offers them.
  const turkeysAllowed = useFlag(FLAGS.thanksgivingTurkeys, false);
  const starfieldTurkeys = turkeysAllowed && theme.starfieldTurkeys === true;

  const activeProject = projects.find(p => p.id === activeProjectId);
  useStartParkedBoxOnOpen(activeProject, activeProject ? getActiveWorkstream(activeProject.id) : 'main');

  const hasAgent = activeProject?.workflows.some(w => w.type === 'agent');
  const setupCtx = useSetupContext(activeProject);
  const cloneHeld = cloneTile(activeProject?.setupStatus, setupCtx).holdTerminal;
  const cloneHold = cloneHeld
    ? cloneHoldCopy(activeProject?.setupStatus, activeProject?.setupError, setupCtx)
    : '';
  const username = user?.unixUsername ?? '';
  const sessionOwner = activeProject?.ownerUsername ?? username;
  const activeWorkstream = activeProject ? getActiveWorkstream(activeProject.id) : 'main';
  // Hand off from the context card: owner only, behind agent-handoff-enabled.
  // The route takes the workstream's id.
  const handoffOn = useFlag(FLAGS.agentHandoff, false);
  // Browser pane: a headless Chromium on the project's
  // box, docked under the ctrl terminal, behind browser-pane-enabled. Expanded
  // per project + workstream; collapsing closes the browser on the box.
  const browserPaneOn = useFlag(FLAGS.browserPane, false);
  // Preview shares: the owner's "Share…" on the dock,
  // the default lifetime it preselects, and kept profiles' "Reset browser".
  const previewShareOn = useFlag(FLAGS.previewShare, false);
  const previewShareTtl = useFlag(FLAGS.previewShareTtlHours, 24);
  const keptProfilesOn = useFlag(FLAGS.persistentProfiles, false);
  // The share dialog, open with the page the owner's pane shows (its links open there).
  const [sharing, setSharing] = useState<{ atPath: string | null } | null>(null);
  // Kept in sessionStorage for this tab: Settings and the dashboard unmount
  // the workspace, and a pane that was open should be open on the way back
  // (the box keeps its browser parked for a minute for the same reason).
  const [browserExpanded, setBrowserExpanded] = useState<Record<string, boolean>>(() => readBrowserExpanded());
  const browserKey = activeProject ? `${activeProject.id}/${activeWorkstream}` : '';
  const toggleBrowser = useCallback(() => {
    setBrowserExpanded(prev => {
      const next = { ...prev, [browserKey]: !prev[browserKey] };
      writeBrowserExpanded(next);
      return next;
    });
  }, [browserKey]);
  const handoffWs = activeProject?.workstreams.find(w => w.name === activeWorkstream);
  // The workstream's stored agent, as the menus read it: only one that can write a handoff gets the button.
  const handoffProvider = handoffWs
    ? activeProject?.workflows.find(w => w.type === 'agent' && w.workstreamId === handoffWs.id)?.provider ?? user?.defaultAgentProvider ?? 'claude'
    : null;
  const handoffWorkstreamId = handoffOn && activeProject && handoffWs && activeProject.role !== 'collaborator'
    && projectKindTraits(activeProject.kind).canHandOff && canHandOff(handoffProvider)
    ? handoffWs.id
    : null;
  const agentSession = activeProject
    ? buildSessionName(sessionOwner, activeProject.name, 'agent', activeWorkstream)
    : '';
  const ctrlSession = activeProject
    ? buildSessionName(sessionOwner, activeProject.name, 'ctrl', activeWorkstream)
    : '';
  // Review panes (Review button → a ReviewDock each under the ctrl terminal),
  // per project+workstream: up to 8 with parallel-reviews-enabled
  // (hooks/useReviewPanes.ts).
  const parallelReviewsOn = useFlag(FLAGS.parallelReviews, false);
  const reviews = useReviewPanes({
    projectId: activeProject?.id ?? null,
    workstream: activeWorkstream,
    owner: sessionOwner,
    projectName: activeProject?.name ?? null,
    status: statusMap[statusKey(activeProject?.instanceId, agentSession)],
  });
  const { expandFor: expandReviewFor } = reviews;

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
  // A share link's handoff to the owner's own pane: the dock opened (in the
  // ctrl column, brought forward on a narrow viewport), and the share for
  // its first dial only.
  const expandDock = useCallback((key: string) => {
    setBrowserExpanded(prev => {
      const next = { ...prev, [key]: true };
      writeBrowserExpanded(next);
      return next;
    });
  }, []);
  const showCtrl = useCallback(() => setActivePane('ctrl'), []);
  const { openShare: browserOpenShare, consumeOpenShare } = useBrowserShareHandoff({ browserKey, isNarrow, expandDock, showCtrl });

  // A status-strip row or search hit switched here and names a pane:
  // open the review dock, or bring the ctrl pane
  // forward. The dock lives in the ctrl column, which narrow mode only
  // mounts on the ctrl tab. The terminals remount on the switch, so focus
  // retries until the pane is there.
  useEffect(() => {
    let cancel: (() => void) | null = null;
    const onFocusPane = (e: Event) => {
      const { projectId, workstream, pane, session } = (e as CustomEvent<FocusPaneDetail>).detail;
      if (isNarrow) setActivePane(pane === 'agent' ? 'agent' : 'ctrl');
      if (pane === 'review') {
        // The pane it names, else the first one.
        expandReviewFor(projectId, workstream, session);
        return;
      }
      cancel?.();
      cancel = retryUntil(() => {
        const el = document.querySelector<HTMLTextAreaElement>(`#terminal-${pane} textarea`);
        el?.focus();
        return !!el && document.activeElement === el;
      });
    };
    window.addEventListener(FOCUS_PANE_EVENT, onFocusPane);
    return () => { window.removeEventListener(FOCUS_PANE_EVENT, onFocusPane); cancel?.(); };
  }, [isNarrow, expandReviewFor]);

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
            turkeys={starfieldTurkeys}
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
            Appearance). The readout is meaningless without live statuses, so
            it is hidden while the connection banner over the terminals says
            why. */}
        {theme.sidebarActivity && (
          <div className="app-sidebar-footer">
            <UsageMini />
            {connection.state === 'online' && (
              <div className="warp-indicator" data-active={isActive || undefined}>
                {warpStr}<em>c</em>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="app-terminals">
        {connection.state !== 'online' && (
          <div
            className="connection-banner"
            data-connection={connection.state}
            role="status"
            aria-live="polite"
            title={connection.lastContactAt
              ? `Last contact with termag: ${new Date(connection.lastContactAt).toLocaleTimeString()}`
              : 'No contact with termag yet'}
          >
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
            const title = level === 'ok' ? 'Context tokens' : 'Context tokens: consider /clear';
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
          {/* Home view: with no project selected, the latest briefing stands
              where the two empty panes would be. Reading it is not activity. */}
          {!activeProject && (
            <div className="app-home-briefing">
              <BriefingCard variant="compact" />
            </div>
          )}
          {activeProject && (!isNarrow || activePane === 'agent') && (
            <div
              className="app-agent"
              id="terminal-agent"
              style={(!isNarrow && activeProject && hasAgent) ? { flex: `0 0 ${agentPct}%` } : undefined}
            >
              {activeProject && hasAgent && !cloneHeld ? (
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
                      position: relative): "PR opened" with Compact / Clear / Keep. */}
                  <PrContextPrompt
                    projectId={activeProject.id}
                    instanceId={activeProject.instanceId}
                    workstream={activeWorkstream}
                    session={agentSession}
                    status={statusMap[statusKey(activeProject.instanceId, agentSession)]}
                    handoffWorkstreamId={handoffWorkstreamId}
                  />
                  {/* A handoff of this pane in progress. */}
                  <HandoffStrip
                    status={statusMap[statusKey(activeProject.instanceId, agentSession)]}
                    canAbort={activeProject.role !== 'collaborator'}
                  />
                  {/* Lower-right overlay: start a Devin review of the PR being worked on. */}
                  <ReviewButton
                    projectId={activeProject.id}
                    workstream={activeWorkstream}
                    panes={reviews.panes}
                    parallel={parallelReviewsOn}
                    onStarted={reviews.onStarted}
                    key={`${activeProject.id}-${activeWorkstream}-review-btn`}
                  />
                </>
              ) : (
                <div className="empty-pane">
                  {cloneHeld ? cloneHold : activeProject ? 'Add an agent workflow →' : 'Select a project'}
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
          {activeProject && (!isNarrow || activePane === 'ctrl') && (
            <div className={`app-ctrl ${isNarrow ? 'app-ctrl-full' : ''}`} id="terminal-ctrl">
              {activeProject && hasAgent && !cloneHeld ? (
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
                  {/* The review panes dock under the ctrl terminal, slot order:
                      a one-line bar each collapsed; the open ones share the column. */}
                  {reviews.panes.map((p, i) => (
                    <ReviewDock
                      key={p.session}
                      projectId={activeProject.id}
                      instanceId={activeProject.instanceId}
                      workstream={activeWorkstream}
                      sessionName={p.session}
                      // The sweep owns the truth; a lost connection greys the status glyph
                      // client-side (`.stale`) instead of an offline poller answer.
                      status={{ alive: true, state: p.state, pr: p.pr, url: p.url, reviewer: p.reviewer ?? null }}
                      review={p}
                      expanded={reviews.isExpanded(p, i)}
                      onToggle={() => reviews.toggle(p, i)}
                      onStop={() => reviews.stop(p.session)}
                      onCollapseAll={i === 0 && reviews.openCount > 1 ? reviews.collapseAll : undefined}
                    />
                  ))}
                  {/* The browser pane docks under the review pane: a one-line
                      bar collapsed, most of the column expanded. */}
                  {browserPaneOn && (
                    <BrowserDock
                      projectId={activeProject.id}
                      workstream={activeWorkstream}
                      expanded={browserExpanded[browserKey] ?? false}
                      onToggle={toggleBrowser}
                      openShare={browserOpenShare}
                      onOpenShareUsed={consumeOpenShare}
                      showReset={keptProfilesOn}
                      onShare={previewShareOn && activeProject.role !== 'collaborator' ? (atPath) => setSharing({ atPath }) : undefined}
                    />
                  )}
                  {sharing && (
                    <ShareDialog
                      projectId={activeProject.id}
                      workstream={activeWorkstream}
                      defaultTtlHours={previewShareTtl}
                      atPath={sharing.atPath}
                      onClose={() => setSharing(null)}
                      // The dev stack running is another workstream's: the dialog follows the workspace there.
                      onSwitchWorkstream={(ws) => setActiveWorkstream(activeProject.id, ws)}
                    />
                  )}
                </>
              ) : (
                <div className="empty-pane">
                  {cloneHeld ? cloneHold : activeProject ? 'Add an agent workflow →' : 'Select a project'}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* ?prs=<view>: the PR overlay, over the workspace (opened from the status strip's PRs tile). */}
      <PrsOverlay />
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
const SpawnNetwork = lazy(() => import('./pages/SpawnNetwork'));
const Automations = lazy(() => import('./pages/Automations'));
const Welcome = lazy(() => import('./pages/Welcome'));
const SignIn = lazy(() => import('./pages/welcome/SignIn'));
const MobileApp = lazy(() => import('./pages/mobile/MobileApp'));
const ChatApp = lazy(() => import('./pages/chat/ChatApp'));

/**
 * Phone-sized viewports go to the mobile client when the
 * `mobile-redirect-enabled` flag is on and this browser has not pressed
 * "Lab". With `mobile-installed-app-enabled`, an app installed on a touch
 * device always does (§5.1) and its "Lab" lasts for that window only. Sits
 * inside FeatureFlagsProvider (for the flags) and before MainLayout, so no
 * terminal socket is opened for a page that is about to leave.
 */
function MobileRedirectGate({ children }: { children: React.ReactNode }) {
  const flagOn = useFlag(FLAGS.mobileRedirect, false);
  const phoneLike = typeof window !== 'undefined' && window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  setInstalledAppEnabled(useFlag(FLAGS.mobileInstalledApp, false));
  const installed = typeof window !== 'undefined' && installedAppMode(window);
  const optedOut = currentOptOut(installed);
  if (shouldRedirectToMobile({ flagOn, phoneLike, optedOut, installed })) {
    return <Navigate to={mobileHrefFromWorkspaceSearch(window.location.search)} replace />;
  }
  return <>{children}</>;
}

/**
 * The workspace, or the simple UI when that is where this browser was last
 * and the page was loaded at the bare workspace URL (chat/uiMode.ts), or for
 * a share link its owner opened: its side panel's browser, not the dock.
 */
function SimpleUiReturnGate({ children }: { children: React.ReactNode }) {
  const flagOn = useFlag(FLAGS.simpleUi, false);
  const sidePanelOn = useFlag(FLAGS.chatSidePanel, false);
  const location = useLocation();
  const [toSimple] = useState(() => simpleUiShareHandoff({ flagOn, sidePanelOn, mode: currentUiMode(), search: location.search })
    ?? (shouldOpenSimpleUi({
      flagOn, mode: currentUiMode(), entry: pageEntry(), here: `${location.pathname}${location.search}`, locationKey: location.key,
    }) ? '/chat' : null));
  useEffect(() => {
    leavePageEntry();
    if (!toSimple) recordUiMode('full');
  }, [toSimple]);
  if (toSimple) return <Navigate to={toSimple} replace />;
  return <>{children}</>;
}

/** Forgets where the page was loaded once it navigates anywhere (chat/uiMode.ts). */
function PageEntryTracker() {
  const { key } = useLocation();
  useEffect(() => { notePageLocation(key); }, [key]);
  return null;
}

/** The installed app's start_url (mobile/launch.ts): the phone client or the simple UI. */
function AppStart() {
  const simpleUi = useFlag(FLAGS.simpleUi, false);
  const touch = typeof window !== 'undefined' && window.matchMedia(TOUCH_MEDIA_QUERY).matches;
  const standalone = typeof window !== 'undefined' && isStandalone(window);
  return <Navigate to={appStartTarget({ touch, standalone, simpleUi })} replace />;
}

/** The simple UI at /chat exists only for users with simple-ui-enabled. */
function SimpleUiGate({ children }: { children: React.ReactNode }) {
  const enabled = useFlag(FLAGS.simpleUi, false);
  if (!enabled) return <Navigate to="/" replace />;
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
  useLaunchQueue();
  return (
    <AuthProvider>
      <ThemeProvider>
        {/* Inside ThemeProvider so the error card has the theme's variables;
            around every route so a crash anywhere shows a message, not a blank page. */}
        <AppErrorBoundary>
        <PageEntryTracker />
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
          {/* A reviewer's preview: its own page, outside
              the workspace and every gate (first run, phone, simple UI), with no
              flags provider: the server decides what a reviewer sees. */}
          <Route
            path="/preview/:shareId"
            element={
              <RequireAuth>
                <Preview />
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
          {/* Settings: outside the workspace layout, inside FeatureFlagsProvider
              for the flag-gated sections (Notifications, MCP), as /welcome is.
              /settings/mcp?server= opens on the MCP section. */}
          {['/settings', '/settings/mcp'].map(path => (
            <Route
              key={path}
              path={path}
              element={
                <RequireAuth>
                  <FeatureFlagsProvider>
                    <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                      <Settings />
                    </Suspense>
                  </FeatureFlagsProvider>
                </RequireAuth>
              }
            />
          ))}
          {/* One spawn tree as a network: mounted like
              the dashboard, so it opens no status WebSocket and sends no heartbeat. */}
          {/* Automations: the index and one automation's page
              with its runs. Mounted like the dashboard (no status socket, no
              heartbeat) but inside FeatureFlagsProvider, as /welcome is: a run's
              conversation link reads simple-ui-enabled, and useFlag outside the
              provider only ever returns its fallback. */}
          <Route
            path="/automations"
            element={
              <RequireAuth>
                <FeatureFlagsProvider>
                  <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                    <Automations />
                  </Suspense>
                </FeatureFlagsProvider>
              </RequireAuth>
            }
          />
          <Route
            path="/automations/:id"
            element={
              <RequireAuth>
                <FeatureFlagsProvider>
                  <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                    <Automations />
                  </Suspense>
                </FeatureFlagsProvider>
              </RequireAuth>
            }
          />
          <Route
            path="/spawns/:rootId"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                  <SpawnNetwork />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/spawns/session/:projectId/:workstream"
            element={
              <RequireAuth>
                <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                  <SpawnNetwork />
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
          {/* The installed app's start_url: picks /m or /chat, then gets out of the way. */}
          <Route
            path={APP_START_PATH}
            element={
              <RequireAuth>
                <FeatureFlagsProvider>
                  <AppStart />
                </FeatureFlagsProvider>
              </RequireAuth>
            }
          />
          {/* The simple UI (chat-first, terminals on request): same providers
              as the workspace, no MainLayout. Behind simple-ui-enabled. */}
          <Route
            path="/chat/*"
            element={
              <RequireAuth>
                <FirstRunGate>
                <FeatureFlagsProvider>
                  <SimpleUiGate>
                    <ConnectionProvider>
                      <ProjectProvider>
                        <Suspense fallback={<div className="loading-screen">Loading…</div>}>
                          <ChatApp />
                        </Suspense>
                      </ProjectProvider>
                    </ConnectionProvider>
                  </SimpleUiGate>
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
                        <SimpleUiReturnGate>
                          <MainLayout />
                        </SimpleUiReturnGate>
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
