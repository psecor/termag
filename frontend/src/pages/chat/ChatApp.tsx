// The simple UI (docs: simple-ui plan, milestone 1): a chat-first client at
// /chat. A sidebar of conversations and one conversation at a time, each a
// project workstream's agent session shown as a chat over its pane. On a
// phone the list is the page, or a drawer over the conversation, so the
// thread keeps the width (chat/chatLayout.ts). Mounted inside the same
// providers as the workspace, without MainLayout: no starfield, and no
// terminals beyond the side panel's ctrl shell (chat/sidePanel.ts;
// Open in full UI is the way to the agent
// pane). An automation has its own page, /chat/automations/:id
// (pages/chat/automations/, behind simple-ui-automations-enabled), opened
// from its row in its space's explorer, with that explorer beside it.
import React, { startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { FLAGS, useFlag } from '../../flags';
import { ConnectionOverlay } from '../../components/ConnectionOverlay';
import { boxFeed } from '../../services/boxFeed';
import { useStartParkedBoxOnOpen } from '../../hooks/useStartParkedBoxOnOpen';
import { useBrowserShareHandoff } from '../../hooks/useBrowserShareHandoff';
import { CHAT_NARROW_QUERY, chatHistoryMode, chatZoomable } from '../../chat/chatLayout';
import { MOBILE_MEDIA_QUERY } from '../../mobile/redirect';
import { useZoomableViewport } from '../../hooks/useZoomableViewport';
import { recordUiMode } from '../../chat/uiMode';
import { isSidePanelShortcut, readSidePanel, writeSidePanel, type SidePanelState, type SidePanelTab } from '../../chat/sidePanel';
import { isNewSessionShortcut } from '../../chat/shortcuts';
import { spacePalette } from '../../chat/spaceColors';
import { ChatSpacesProvider, useChatSpaces } from '../../chat/useChatSpaces';
import { useChatTurnNotifier } from '../../chat/useChatTurnNotifications';
import { NAVIGATE_EVENT, routerPathFor } from '../../mobile/push';
import { isSdkChat } from '../../chat/simpleChat';
import { ChatChromeProvider } from './chatChrome';
import { ChatSidebar } from './ChatSidebar';
import { NewChat } from './NewChat';
import { ChatRoute } from './ChatRoute';
import { EnvironmentsPage } from './EnvironmentsPage';
import { FileExplorer } from './FileExplorer';
import { AgentsTab } from './AgentsExplorer';
import { SpaceFileView } from './SpaceFileView';
import { AutomationDetailRoute } from './automations/AutomationDetail';
import { AutomationsProvider, useAutomationsEnabled } from '../../chat/useAutomations';
import { ReviewsPage } from './ReviewsPage';
import { PrPage } from './PrPage';
import { ReviewCloneStart } from './ReviewCloneStart';
import { ReviewsDataProvider } from './reviewsData';
import type { PanelToolState } from './reviewLinks';
import { MarkdownLinkContext } from '../../chat/Markdown';
import { folderForRoute, folderHref, itemHref, NO_SPACE_EXPLORER, spaceLinkTarget } from '../../chat/openItems';
import { SimpleDataProvider, useSimpleData } from './simpleData';
import { Tooltips } from './Tooltips';
import { SidePanel, type SidePanelFiles } from './SidePanel';
import { useAgentAsk, useToolAsk } from './PanelTabs';
import type { AgentTabRef } from '../../chat/panelTabs';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import './chat.css';
// Inter, the chrome refresh's font (chrome.css): @font-face only, fetched once a refreshed chat uses it.
import '@launchpad-ui/tokens/fonts.css';
import './chrome.css';
import './reviews.css';
import { DailyThemeLayer } from '../../theme/daily/DailyThemeLayer';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/**
 * Marks <html> while the simple UI is mounted, so chat.css can hold every
 * field it shows at 16 px on a phone: menus, dialogs and popovers render in
 * portals on <body>, outside .chat-root.
 */
function useSimpleUiDocumentMark() {
  useEffect(() => {
    const html = document.documentElement;
    html.dataset.simpleUi = '';
    return () => { delete html.dataset.simpleUi; };
  }, []);
}

function localStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/**
 * A space file link in a reply opens the file in its tab, else a new one, and
 * a folder's link (ending in `/`) its space's new tab with that folder shown
 * in Files.
 */
function SpaceFileLinks({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { items, activeTab } = useSimpleData();
  const { pick } = items;
  const openLink = useMemo(() => (href: string) => {
    const target = spaceLinkTarget(href, window.location.origin, import.meta.env.BASE_URL);
    if (!target) return false;
    const { ref, dir } = target;
    startTransition(() => {
      const tab = pick(ref, activeTab);
      navigate(dir == null ? itemHref(ref, tab) : folderHref(ref.space, dir, tab));
    });
    return true;
  }, [navigate, pick, activeTab]);
  return <MarkdownLinkContext.Provider value={openLink}>{children}</MarkdownLinkContext.Provider>;
}

function ChatHome() {
  return (
    <div className="chat-home">
      <h1>termag</h1>
      <p>Pick a session on the left, or start a new session from a repository.</p>
    </div>
  );
}

export default function ChatApp() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const match = useMatch('/chat/p/:projectId');
  const [params] = useSearchParams();
  const shownWs = params.get('ws') || 'main';
  const shown = useMemo(
    () => (match?.params.projectId ? { projectId: match.params.projectId, workstream: shownWs } : null),
    [match?.params.projectId, shownWs],
  );
  useChatTurnNotifier(shown);

  // A notification click (public/sw.js → main.tsx) opens its chat in place.
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const target = (e as CustomEvent<URL>).detail;
      const path = target && routerPathFor(target);
      if (!path?.startsWith('/chat')) return;
      e.preventDefault();
      navigate(path);
    };
    window.addEventListener(NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(NAVIGATE_EVENT, onNavigate);
  }, [navigate]);

  const narrow = useMediaQuery(CHAT_NARROW_QUERY);
  // A phone, not a narrow desktop window (mobile/redirect.ts): pinch-zoom and the 16 px fields.
  const phone = useMediaQuery(MOBILE_MEDIA_QUERY);
  useSimpleUiDocumentMark();
  const location = useLocation();
  const { pathname } = location;

  // The chrome refresh: scoped to .chat-root
  // and handed down as useChatChrome().refresh; off, nothing here changes.
  const chromeRefresh = useFlag(FLAGS.chatChromeRefresh, false);
  // PR reviews, under the refresh: the Reviews page and a PR's page.
  const reviewsOn = useFlag(FLAGS.simpleUiReviews, false) && chromeRefresh;
  useEffect(() => { if (chromeRefresh) void ensureLaunchPadSprite(); }, [chromeRefresh]);
  const mode = chatHistoryMode(pathname, narrow);
  const [historyOpen, setHistoryOpen] = useState(false);

  // A conversation change closes the drawer; the list is for picking one.
  useEffect(() => { setHistoryOpen(false); }, [pathname]);
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHistoryOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [historyOpen]);

  // The next load of the bare workspace URL comes back here (chat/uiMode.ts).
  useEffect(() => { recordUiMode('simple'); }, []);

  // The box list drives the setup state of a conversation whose box is
  // still coming up (hooks/useSetupContext), as it does in the workspace.
  useEffect(() => {
    if (!user) return;
    boxFeed.start();
    return () => boxFeed.stop();
  }, [user]);

  // Spaces, the boxes in each and each one's colour, loaded once for the
  // sidebar's groups, the space picker and the chat header's space chip; the
  // set of boxes changing loads them again.
  const { projects } = useProjects();
  const boxKey = useMemo(() => [...new Set(projects.map(p => p.instanceId ?? ''))].sort().join(','), [projects]);
  const loadedSpaces = useChatSpaces({ withBoxes: true, reloadKey: boxKey });
  const { loaded: spacesLoaded, spaces, index, current: spacesCurrent, reload: reloadSpaces } = loadedSpaces;
  const sharedSpaces = useMemo(
    () => ({ loaded: spacesLoaded, spaces, index, current: spacesCurrent, reload: reloadSpaces, colorOf: spacePalette(spaces) }),
    [spacesLoaded, spaces, index, spacesCurrent, reloadSpaces],
  );

  // The side panel: docked and remembered on desktop, an overlay that
  // starts shut on a phone. For a conversation the project list knows, a new
  // tab on the agents in no space and, where the user has spaces (its Files
  // tab), a space file and a new tab.
  const automationsOn = useAutomationsEnabled();
  const fileMatch = useMatch('/chat/f/:space/*');
  const newTabMatch = useMatch('/chat/files/:space');
  // A link to a folder (?dir=, chat/openItems.ts folderHref): its space's new tab, with the folder shown in Files.
  const folderDir = newTabMatch ? folderForRoute(location.search) : null;
  // A new tab on the agents in no space (AgentsExplorer.tsx): with the side panel, spaces or not.
  const agentsMatch = useMatch('/chat/agents');
  // An automation's page, with its space's explorer beside it in Files.
  const automationMatch = useMatch('/chat/automations/:id');
  const automationShown = automationsOn && automationMatch ? automationMatch.params.id ?? null : null;
  const shownProject = shown ? projects.find(p => p.id === shown.projectId) : undefined;
  // An SDK chat shows its stored transcript instead of starting a parked box (chat/storedOpen.ts).
  useStartParkedBoxOnOpen(shownProject, shownWs, Boolean(shownProject && isSdkChat(shownProject, shownWs)));
  const [panel, setPanelState] = useState<SidePanelState>(() => readSidePanel(localStore()));
  const [overlayOpen, setOverlayOpen] = useState(false);
  // A tool asked for by something outside the panel (a share link, a breadcrumb folder, the
  // context card's PR): the panel opens on it, though an empty panel otherwise opens on a launcher.
  // Shown once: the panel says so, and a remount (after a visit to /chat, say) opens as it would.
  const { ask: toolAsk, askTool, forget: forgetToolAsk } = useToolAsk();
  // A subagent's row asks for its agent tab, the same way.
  const { ask: agentAsk, askAgent, forget: forgetAgentAsk } = useAgentAsk();
  const setPanel = useCallback((next: SidePanelState) => {
    setPanelState(next);
    writeSidePanel(localStore(), next);
  }, []);
  const panelOpen = narrow ? overlayOpen : panel.open;
  const togglePanel = useCallback(() => {
    forgetToolAsk();
    if (narrow) setOverlayOpen(o => !o);
    else setPanel({ ...panel, open: !panel.open });
  }, [narrow, panel, setPanel, forgetToolAsk]);
  const closePanel = useCallback(() => {
    forgetToolAsk();
    if (narrow) setOverlayOpen(false);
    else setPanel({ ...panel, open: false });
  }, [narrow, panel, setPanel, forgetToolAsk]);
  const panelAvailable = Boolean(shownProject) || Boolean(agentsMatch) || Boolean(automationShown) || Boolean(fileMatch || newTabMatch);
  // Files: the shown agent's space, or the agents in no space beside an agent with none; a file's or new tab's space.
  const panelFiles: SidePanelFiles | null = shownProject ? { agent: shownProject }
    : agentsMatch ? { space: NO_SPACE_EXPLORER }
    : automationShown ? { automation: automationShown }
    : { space: (fileMatch ?? newTabMatch)?.params.space ?? '', path: fileMatch?.params['*'], dir: folderDir ?? undefined };
  useEffect(() => { setOverlayOpen(false); }, [pathname]);
  // A share link its owner opened (chat/uiMode.ts simpleUiShareHandoff): the
  // panel opens on Browser, the overlay on a phone, and that conversation's
  // pane dials the share's app at its page. Only that conversation gets it:
  // the one in the URL the page loaded with, known on the first render, so a
  // panel already open on Browser has the share when its pane first dials.
  const browserKey = shownProject ? `${shownProject.id}/${shownWs}` : '';
  const [handoffKey] = useState(() => (shown ? `${shown.projectId}/${shown.workstream}` : null));
  const openBrowser = useCallback(() => {
    askTool('browser');
    setPanel({ ...panel, tab: 'browser', open: narrow ? panel.open : true });
  }, [narrow, panel, setPanel, askTool]);
  const openOverlay = useCallback(() => setOverlayOpen(true), []);
  const { openShare, consumeOpenShare } = useBrowserShareHandoff({ browserKey, isNarrow: narrow, expandDock: openBrowser, showCtrl: openOverlay });
  // A space's + → New tab opens Files beside the new tab's recents on desktop.
  // On a phone the panel starts shut there too.
  const openTools = (location.state as { openTools?: boolean } | null)?.openTools === true;
  useEffect(() => {
    if (!openTools || !panelAvailable) return;
    if (!narrow && !panel.open) setPanel({ ...panel, open: true });
    // Once: not again on a reload or on coming back to this tab.
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, openTools, panelAvailable]);
  // A review link asks for a tool (reviewLinks.ts): an agent review opens on Review, a review session on its PR.
  const panelTool = (location.state as PanelToolState | null)?.panelTool;
  useEffect(() => {
    if (!panelTool || !panelAvailable) return;
    askTool(panelTool);
    if (narrow) setOverlayOpen(true);
    setPanel({ ...panel, tab: panelTool, open: narrow ? panel.open : true });
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, panelTool, panelAvailable]);
  // A breadcrumb folder in the file view: Files, with that folder open. `n`
  // makes a second click on the same folder reveal it again.
  const [reveal, setReveal] = useState<{ dir: string; n: number } | null>(null);
  useEffect(() => { setReveal(null); }, [pathname]);
  const revealDir = useCallback((dir: string) => {
    setReveal(r => ({ dir, n: (r?.n ?? 0) + 1 }));
    if (narrow) setOverlayOpen(true);
    askTool('files');
    if (panel.tab !== 'files' || (!narrow && !panel.open)) setPanel({ ...panel, tab: 'files', open: narrow ? panel.open : true });
  }, [narrow, panel, setPanel, askTool]);
  // A link to a folder opens Files on it (the overlay on a phone), once per visit, as a breadcrumb's folder does.
  useEffect(() => {
    if (folderDir == null) return;
    if (narrow) setOverlayOpen(true);
    askTool('files');
    if (panel.tab !== 'files' || (!narrow && !panel.open)) setPanel({ ...panel, tab: 'files', open: narrow ? panel.open : true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, folderDir]);
  const pickedInFiles = useCallback(() => {
    if (panel.tab !== 'files') setPanel({ ...panel, tab: 'files' });
  }, [panel, setPanel]);
  useEffect(() => {
    if (!panelAvailable) return;
    // Capture phase, so the shortcut works from inside the terminal too.
    const onKey = (e: KeyboardEvent) => {
      if (!isSidePanelShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [panelAvailable, togglePanel]);

  // ⌘⇧O / Ctrl+Shift+O opens New session from anywhere here (chat/shortcuts.ts),
  // the terminal included, so it is caught in the capture phase too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isNewSessionShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) navigate('/chat/new');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigate]);

  const chrome = {
    mode,
    historyOpen,
    openHistory: () => setHistoryOpen(true),
    closeHistory: () => setHistoryOpen(false),
    sidePanel: panelAvailable ? {
      open: panelOpen,
      toggle: togglePanel,
      show: (tab: SidePanelTab) => { askTool(tab); if (narrow) setOverlayOpen(true); setPanel({ ...panel, tab, open: narrow ? panel.open : true }); },
      revealDir: fileMatch ? revealDir : undefined,
      // Agent tabs are the refresh's tabs, which a phone's overlay doesn't have.
      showAgent: chromeRefresh && !narrow ? (agent: AgentTabRef) => { askAgent(agent); setPanel({ ...panel, open: true }); } : undefined,
    } : undefined,
    refresh: chromeRefresh,
  };

  // On a phone the chat can be pinch-zoomed, as /m can. The side panel's
  // overlay (Terminal, Browser) keeps the lock: a pinch there would fight xterm
  // and the browser pane's own touch handling.
  const overlayShown = narrow && panelAvailable && panelOpen;
  useZoomableViewport(chatZoomable(phone, overlayShown));

  return (
    <ChatChromeProvider value={chrome}>
      <ChatSpacesProvider value={sharedSpaces}>
      <SimpleDataProvider>
      <AutomationsProvider>
      <ReviewsDataProvider>
      <SpaceFileLinks>
        <div className={chromeRefresh ? `chat-root ${LP_THEME}` : 'chat-root'} data-chrome={chromeRefresh ? 'refresh' : undefined} data-pane={mode} data-history={mode === 'page' || historyOpen ? 'open' : 'closed'}>
          <ConnectionOverlay />
          <Tooltips />
          <DailyThemeLayer />
          {mode === 'drawer' && historyOpen && (
            <button type="button" className="chat-backdrop" aria-label="Close sessions" onClick={() => setHistoryOpen(false)} />
          )}
          <ChatSidebar />
          <main className="chat-main">
            <Routes>
              <Route index element={<ChatHome />} />
              <Route path="new" element={<NewChat />} />
              <Route path="environments" element={<EnvironmentsPage />} />
              <Route path="environments/:id" element={<EnvironmentsPage />} />
              <Route path="environments/:id/history" element={<EnvironmentsPage history />} />
              <Route path="p/:projectId" element={<ChatRoute />} />
              <Route path="agents" element={<AgentsTab />} />
              {reviewsOn && <Route path="reviews" element={<ReviewsPage />} />}
              {reviewsOn && <Route path="pr/:owner/:name/:number" element={<PrPage />} />}
              {/* A review on a repository with no project waits here for its clone (simple-ui-review-clone-enabled). */}
              {reviewsOn && <Route path="review-start/:owner/:name/:number" element={<ReviewCloneStart />} />}
              {/* GitHub's own path, with any tab after it (/files, /commits, /checks), so a URL with the host swapped opens here. */}
              {reviewsOn && <Route path="gh/:owner/:name/pull/:number/*" element={<PrPage />} />}
              <Route path="files/:space" element={<FileExplorer />} />
              <Route path="f/:space/*" element={<SpaceFileView />} />
              {automationsOn && <Route path="automations/:id" element={<AutomationDetailRoute />} />}
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
            {panelAvailable && panelOpen && (
              <SidePanel
                ask={toolAsk}
                onAskUsed={forgetToolAsk}
                agentAsk={agentAsk}
                onAgentAskUsed={forgetAgentAsk}
                project={shownProject}
                workstream={shown?.workstream ?? 'main'}
                files={panelFiles}
                onPicked={pickedInFiles}
                reveal={reveal}
                state={panel}
                onChange={setPanel}
                onClose={closePanel}
                overlay={narrow}
                openShare={browserKey === handoffKey ? openShare : null}
                onOpenShareUsed={consumeOpenShare}
              />
            )}
          </main>
        </div>
      </SpaceFileLinks>
      </ReviewsDataProvider>
      </AutomationsProvider>
      </SimpleDataProvider>
      </ChatSpacesProvider>
    </ChatChromeProvider>
  );
}
