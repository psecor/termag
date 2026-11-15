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
import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { FLAGS, useFlag } from '../../flags';
import { ConnectionOverlay } from '../../components/ConnectionOverlay';
import { boxFeed } from '../../services/boxFeed';
import { useStartParkedBoxOnOpen } from '../../hooks/useStartParkedBoxOnOpen';
import { useBrowserShareHandoff } from '../../hooks/useBrowserShareHandoff';
import { CHAT_NARROW_QUERY, chatHistoryMode, chatZoomable } from '../../chat/chatLayout';
import { installedAppMode, MOBILE_MEDIA_QUERY } from '../../mobile/redirect';
import { useZoomableViewport } from '../../hooks/useZoomableViewport';
import { recordUiMode } from '../../chat/uiMode';
import {
  isSidePanelShortcut, readOpenSidePanels, readSidePanel, readSidePanelTabs, sidePanelFileAt, sidePanelPlace, sidePanelTabAt, withSidePanelOpen, withSidePanelTab,
  writeOpenSidePanels, writeSidePanel, writeSidePanelTabs,
  type SidePanelPlaceTab, type SidePanelPrefs, type SidePanelState, type SidePanelTab,
} from '../../chat/sidePanel';
import { isNewSessionShortcut } from '../../chat/shortcuts';
import { spacePalette } from '../../chat/spaceColors';
import { ChatSpacesProvider, useChatSpaces } from '../../chat/useChatSpaces';
import { useChatTurnNotifier } from '../../chat/useChatTurnNotifications';
import { NAVIGATE_EVENT, routerPathFor } from '../../mobile/push';
import { InferredNotificationTap, PhoneNotificationUpkeep } from '../../mobile/phoneNotifications';
import { isSdkChat } from '../../chat/simpleChat';
import { ChatChromeProvider, useChatChrome } from './chatChrome';
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
import { OpenFilesHome } from './FilesTool';
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
import { NoticeBanner } from '../../notice/NoticeBanner';

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
  const { pick, openInPanel } = items;
  // Under project-files-enabled, beside a side panel, a file's link opens in the panel as a file tab; the chat stays.
  const { sidePanel } = useChatChrome();
  const panelPlace = sidePanel?.place ?? null;
  const showFile = sidePanel?.showFile;
  const openLink = useMemo(() => (href: string) => {
    const target = spaceLinkTarget(href, window.location.origin, import.meta.env.BASE_URL);
    if (!target) return false;
    const { ref, dir } = target;
    if (dir == null && ref.kind === 'file' && panelPlace && showFile) {
      showFile(openInPanel(ref, panelPlace));
      return true;
    }
    startTransition(() => {
      const tab = pick(ref, activeTab);
      navigate(dir == null ? itemHref(ref, tab) : folderHref(ref.space, dir, tab));
    });
    return true;
  }, [navigate, pick, activeTab, openInPanel, panelPlace, showFile]);
  return <MarkdownLinkContext.Provider value={openLink}>{children}</MarkdownLinkContext.Provider>;
}

function ChatHome() {
  // The sidebar redesign's files are the side panel's (FilesTool.tsx), and home has none: its open files are here.
  const { refresh } = useChatChrome();
  const filesTool = useFlag(FLAGS.userProjects, false) && refresh === true;
  return (
    <div className="chat-home">
      <h1>termag</h1>
      <p>Pick a session on the left, or start a new session from a repository.</p>
      {filesTool && <OpenFilesHome />}
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
  // Under chat-phone-home-enabled phones land here, not on /m, so on a phone
  // (or the app installed on a touch device) the chat does /m's notification
  // upkeep: the badge, stale and blocked notifications. Needs-you taps open
  // the chat then, so it infers a tap wherever Apple's installed apps send no
  // click (infersTaps), a Mac's included.
  const phoneHome = useFlag(FLAGS.chatPhoneHome, false);
  const phoneClient = phoneHome && (phone || installedAppMode(window));
  useSimpleUiDocumentMark();
  const location = useLocation();
  const { pathname } = location;

  // The chrome refresh: scoped to .chat-root
  // and handed down as useChatChrome().refresh; off, nothing here changes.
  const chromeRefresh = useFlag(FLAGS.chatChromeRefresh, false);
  // PR reviews, under the refresh: the Reviews page and a PR's page.
  const reviewsOn = useFlag(FLAGS.simpleUiReviews, false) && chromeRefresh;
  // Files open in the side panel (project-files-enabled), where the Files tool is (the sidebar redesign's).
  const projectFilesOn = useFlag(FLAGS.projectFiles, false);
  const userProjectsOn = useFlag(FLAGS.userProjects, false);
  const panelFilesOn = projectFilesOn && userProjectsOn && chromeRefresh;
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

  // The next load of the bare workspace URL comes back here (chat/uiMode.ts),
  // unless chat-ui-nudge-enabled leaves that to an explicit switch.
  const switchesOnly = useFlag(FLAGS.chatUiNudge, false);
  useEffect(() => { if (!switchesOnly) recordUiMode('simple'); }, [switchesOnly]);

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

  // The side panel: docked on desktop, open or shut and on its tab in each
  // session (and space, automation page, agents in no space) as it was left
  // there, shut on Terminal where it never was opened (chat/sidePanel.ts sidePanelPlace); an overlay
  // that starts shut on a phone. For a conversation the project list knows, a new
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
  const panelPlace = sidePanelPlace({
    session: shown, agents: Boolean(agentsMatch), automation: automationShown, space: (fileMatch ?? newTabMatch)?.params.space,
  });
  // The width, shared; open or not, and the tab, the place's own.
  const [prefs, setPrefs] = useState<SidePanelPrefs>(() => readSidePanel(localStore()));
  const [openPlaces, setOpenPlacesState] = useState<string[]>(() => readOpenSidePanels(localStore()));
  const [placeTabs, setPlaceTabsState] = useState<SidePanelPlaceTab[]>(() => readSidePanelTabs(localStore()));
  // The lists as last set, so two changes before a render (an effect's, then a handler's) both land.
  const openPlacesNow = useRef(openPlaces);
  const placeTabsNow = useRef(placeTabs);
  const setPlaceOpen = useCallback((place: string, open: boolean) => {
    const next = withSidePanelOpen(openPlacesNow.current, place, open);
    openPlacesNow.current = next;
    setOpenPlacesState(next);
    writeOpenSidePanels(localStore(), next);
  }, []);
  const setPlaceTab = useCallback((place: string, tab: SidePanelTab, file: string | null = null) => {
    const next = withSidePanelTab(placeTabsNow.current, place, tab, file);
    placeTabsNow.current = next;
    setPlaceTabsState(next);
    writeSidePanelTabs(localStore(), next);
  }, []);
  // A pick in the panel's Files (or Agents) keeps the docked panel open on Files where it
  // lands, so the explorer doesn't shut or switch away under the click; that place then
  // stays open on Files. Where it was picked (`from`, at location `key`): read as open on
  // Files on the first render of the new place, so the panel never unmounts between the two.
  const [carry, setCarry] = useState<{ from: string; key: string } | null>(null);
  const carried = carry != null && !narrow && location.key !== carry.key && panelPlace != null && panelPlace !== carry.from;
  const panel = useMemo<SidePanelState>(
    () => ({
      ...prefs,
      tab: carried ? 'files' : sidePanelTabAt(placeTabs, panelPlace),
      file: panelFilesOn && !carried ? sidePanelFileAt(placeTabs, panelPlace) : null,
      open: panelPlace != null && (carried || openPlaces.includes(panelPlace)),
    }),
    [prefs, placeTabs, openPlaces, panelPlace, carried, panelFilesOn],
  );
  const [overlayOpen, setOverlayOpen] = useState(false);
  // A tool asked for by something outside the panel (a share link, a breadcrumb folder, the
  // context card's PR): the panel opens on it, though an empty panel otherwise opens on a launcher.
  // Shown once: the panel says so, and a remount (after a visit to /chat, say) opens as it would.
  const { ask: toolAsk, askTool, forget: forgetToolAsk } = useToolAsk();
  // A subagent's row asks for its agent tab, the same way.
  const { ask: agentAsk, askAgent, forget: forgetAgentAsk } = useAgentAsk();
  const setPanel = useCallback((next: SidePanelState) => {
    if (next.width !== prefs.width) {
      const shared = { width: next.width };
      setPrefs(shared);
      writeSidePanel(localStore(), shared);
    }
    if (panelPlace && (next.tab !== sidePanelTabAt(placeTabsNow.current, panelPlace) || (next.file ?? null) !== sidePanelFileAt(placeTabsNow.current, panelPlace))) {
      setPlaceTab(panelPlace, next.tab, next.file ?? null);
    }
    if (panelPlace && next.open !== openPlacesNow.current.includes(panelPlace)) setPlaceOpen(panelPlace, next.open);
  }, [prefs, panelPlace, setPlaceOpen, setPlaceTab]);
  // The file tab shown here (null: the tool), keeping the tool as last set, so it can follow a tool change in the same handler.
  const setPlaceFile = useCallback((file: string | null) => {
    if (panelPlace && file !== sidePanelFileAt(placeTabsNow.current, panelPlace)) setPlaceTab(panelPlace, sidePanelTabAt(placeTabsNow.current, panelPlace), file);
  }, [panelPlace, setPlaceTab]);
  // A visit to a place makes it the most recent in each list it's on, so a session in use doesn't age out of the last 50.
  useEffect(() => {
    if (!panelPlace) return;
    if (openPlacesNow.current[0] !== panelPlace && openPlacesNow.current.includes(panelPlace)) setPlaceOpen(panelPlace, true);
    const tabs = placeTabsNow.current;
    if (tabs[0]?.place !== panelPlace && tabs.some(t => t.place === panelPlace)) setPlaceTab(panelPlace, sidePanelTabAt(tabs, panelPlace), sidePanelFileAt(tabs, panelPlace));
  }, [panelPlace, setPlaceOpen, setPlaceTab]);
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
  // Another page, or another session of the same project (only ?ws= changes), starts with the overlay shut.
  useEffect(() => { setOverlayOpen(false); }, [pathname, panelPlace]);
  // A share link its owner opened (chat/uiMode.ts simpleUiShareHandoff): the
  // panel opens on Browser, the overlay on a phone, and that conversation's
  // pane dials the share's app at its page. Only that conversation gets it:
  // the one in the URL the page loaded with, known on the first render, so a
  // panel already open on Browser has the share when its pane first dials.
  const browserKey = shownProject ? `${shownProject.id}/${shownWs}` : '';
  const [handoffKey] = useState(() => (shown ? `${shown.projectId}/${shown.workstream}` : null));
  const openBrowser = useCallback(() => {
    askTool('browser');
    setPanel({ ...panel, tab: 'browser', file: null, open: narrow ? panel.open : true });
  }, [narrow, panel, setPanel, askTool]);
  const openOverlay = useCallback(() => setOverlayOpen(true), []);
  const { openShare, consumeOpenShare } = useBrowserShareHandoff({ browserKey, isNarrow: narrow, expandDock: openBrowser, showCtrl: openOverlay });
  // A space's + → New tab opens Files beside the new tab's recents on desktop.
  // On a phone the panel starts shut there too.
  const openTools = (location.state as { openTools?: boolean } | null)?.openTools === true;
  useEffect(() => {
    if (!openTools || !panelAvailable) return;
    if (panel.tab !== 'files' || panel.file || (!narrow && !panel.open)) setPanel({ ...panel, tab: 'files', file: null, open: narrow ? panel.open : true });
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
    setPanel({ ...panel, tab: panelTool, file: null, open: narrow ? panel.open : true });
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
    if (panel.tab !== 'files' || panel.file || (!narrow && !panel.open)) setPanel({ ...panel, tab: 'files', file: null, open: narrow ? panel.open : true });
  }, [narrow, panel, setPanel, askTool]);
  // A link to a folder opens Files on it (the overlay on a phone), once per visit, as a breadcrumb's folder does.
  useEffect(() => {
    if (folderDir == null) return;
    if (narrow) setOverlayOpen(true);
    askTool('files');
    if (panel.tab !== 'files' || panel.file || (!narrow && !panel.open)) setPanel({ ...panel, tab: 'files', file: null, open: narrow ? panel.open : true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, folderDir]);
  const pickedInFiles = useCallback(() => {
    if (panel.tab !== 'files') setPanel({ ...panel, tab: 'files' });
    setCarry(!narrow && panelPlace ? { from: panelPlace, key: location.key } : null);
  }, [panel, setPanel, narrow, panelPlace, location.key]);
  // The navigation the pick made spends the carry, whether or not it moved to another place; one that did is remembered open on Files.
  useEffect(() => {
    if (!carry || location.key === carry.key) return;
    if (carried && panelPlace) {
      setPlaceOpen(panelPlace, true);
      setPlaceTab(panelPlace, 'files');
    }
    setCarry(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
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
      show: (tab: SidePanelTab) => { askTool(tab); if (narrow) setOverlayOpen(true); setPanel({ ...panel, tab, file: null, open: narrow ? panel.open : true }); },
      revealDir: fileMatch ? revealDir : undefined,
      // Agent tabs are the refresh's tabs, which a phone's overlay doesn't have.
      showAgent: chromeRefresh && !narrow ? (agent: AgentTabRef) => { askAgent(agent); setPanel({ ...panel, file: null, open: true }); } : undefined,
      place: panelFilesOn ? panelPlace : null,
      showFile: panelFilesOn && panelPlace ? (id: string) => {
        if (narrow) setOverlayOpen(true);
        else if (!openPlacesNow.current.includes(panelPlace)) setPlaceOpen(panelPlace, true);
        setPlaceFile(id);
      } : undefined,
      openInMain: panelFilesOn ? (file: { space: string; path: string }) => startTransition(() => navigate(itemHref({ kind: 'file', ...file }))) : undefined,
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
          {phoneHome && <InferredNotificationTap />}
          {phoneClient && <PhoneNotificationUpkeep />}
          <Tooltips />
          <DailyThemeLayer />
          {mode === 'drawer' && historyOpen && (
            <button type="button" className="chat-backdrop" aria-label="Close sessions" onClick={() => setHistoryOpen(false)} />
          )}
          <ChatSidebar />
          {/* The main pane: the notice banner over the route and the side panel, so the sidebar never moves. */}
          <div className="chat-pane">
          <NoticeBanner className="chat-pane-notice" />
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
                carried={carried}
                reveal={reveal}
                state={panel}
                onChange={setPanel}
                onFile={setPlaceFile}
                onClose={closePanel}
                overlay={narrow}
                openShare={browserKey === handoffKey ? openShare : null}
                onOpenShareUsed={consumeOpenShare}
              />
            )}
          </main>
          </div>
        </div>
      </SpaceFileLinks>
      </ReviewsDataProvider>
      </AutomationsProvider>
      </SimpleDataProvider>
      </ChatSpacesProvider>
    </ChatChromeProvider>
  );
}
