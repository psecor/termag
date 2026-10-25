// The simple UI (docs: simple-ui plan, milestone 1): a chat-first client at
// /chat. A sidebar of conversations and one conversation at a time, each a
// project workstream's agent session shown as a chat over its pane. On a
// phone the list is the page, or a drawer over the conversation, so the
// thread keeps the width (chat/chatLayout.ts). Mounted inside the same
// providers as the workspace, without MainLayout: no starfield, and no
// terminals beyond the side panel's ctrl shell (chat/sidePanel.ts, behind
// simple-ui-side-panel-enabled; Open in full UI is the way to the agent
// pane). Behind simple-ui-enabled.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { FLAGS, useFlag } from '../../flags';
import { ConnectionOverlay } from '../../components/ConnectionOverlay';
import { boxFeed } from '../../services/boxFeed';
import { CHAT_NARROW_QUERY, chatHistoryMode } from '../../chat/chatLayout';
import { recordUiMode } from '../../chat/uiMode';
import { isSidePanelShortcut, readSidePanel, writeSidePanel, type SidePanelState } from '../../chat/sidePanel';
import { isNewSessionShortcut } from '../../chat/shortcuts';
import { spacePalette } from '../../chat/spaceColors';
import { ChatSpacesProvider, useChatSpaces } from '../../chat/useChatSpaces';
import { useChatTurnNotifier } from '../../chat/useChatTurnNotifications';
import { NAVIGATE_EVENT, routerPathFor } from '../../mobile/push';
import { ChatChromeProvider } from './chatChrome';
import { ChatSidebar } from './ChatSidebar';
import { NewChat } from './NewChat';
import { ChatRoute } from './ChatRoute';
import { FileExplorer } from './FileExplorer';
import { SpaceFileView } from './SpaceFileView';
import { MarkdownLinkContext } from '../../chat/Markdown';
import { itemHref } from '../../chat/openItems';
import { SimpleDataProvider } from './simpleData';
import { Tooltips } from './Tooltips';
import { parseSpaceFileLink } from '../../utils/spaces';
import { SidePanel } from './SidePanel';
import './chat.css';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(CHAT_NARROW_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(CHAT_NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

function localStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
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

  const narrow = useNarrow();
  const location = useLocation();
  const { pathname } = location;

  // The side panel, and with spaces the tabs (simpleData.tsx): every open of
  // a session, file or new tab is recorded as a tab.
  const sidePanelOn = useFlag(FLAGS.chatSidePanel, false);
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
  const { enabled: spacesOn, loaded: spacesLoaded, spaces, index, current: spacesCurrent } = loadedSpaces;
  const sharedSpaces = useMemo(
    () => ({ enabled: spacesOn, loaded: spacesLoaded, spaces, index, current: spacesCurrent, colorOf: spacePalette(spaces) }),
    [spacesOn, spacesLoaded, spaces, index, spacesCurrent],
  );

  // The side panel: docked and remembered on desktop, an overlay that
  // starts shut on a phone. For a conversation the project list knows and,
  // where the user has spaces (its Files tab), a space file and a new tab.
  const filesInTools = sidePanelOn && spacesOn;
  // A space file link in a reply opens the file here, only where the file
  // route below is mounted; elsewhere it stays a plain link.
  const openLink = useMemo(() => (filesInTools ? (href: string) => {
    const file = parseSpaceFileLink(href, window.location.origin, import.meta.env.BASE_URL);
    if (!file) return false;
    navigate(itemHref({ kind: 'file', ...file }));
    return true;
  } : null), [filesInTools, navigate]);
  const fileMatch = useMatch('/chat/f/:space/*');
  const newTabMatch = useMatch('/chat/files/:space');
  const shownProject = shown ? projects.find(p => p.id === shown.projectId) : undefined;
  const [panel, setPanelState] = useState<SidePanelState>(() => readSidePanel(localStore()));
  const [overlayOpen, setOverlayOpen] = useState(false);
  const setPanel = useCallback((next: SidePanelState) => {
    setPanelState(next);
    writeSidePanel(localStore(), next);
  }, []);
  const panelOpen = narrow ? overlayOpen : panel.open;
  const togglePanel = useCallback(() => {
    if (narrow) setOverlayOpen(o => !o);
    else setPanel({ ...panel, open: !panel.open });
  }, [narrow, panel, setPanel]);
  const closePanel = useCallback(() => {
    if (narrow) setOverlayOpen(false);
    else setPanel({ ...panel, open: false });
  }, [narrow, panel, setPanel]);
  const panelAvailable = sidePanelOn && (Boolean(shownProject) || (filesInTools && Boolean(fileMatch || newTabMatch)));
  useEffect(() => { setOverlayOpen(false); }, [pathname]);
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
    sidePanel: panelAvailable ? { open: panelOpen, toggle: togglePanel } : undefined,
  };

  return (
    <ChatChromeProvider value={chrome}>
      <ChatSpacesProvider value={sharedSpaces}>
      <SimpleDataProvider>
      <MarkdownLinkContext.Provider value={openLink}>
        <div className="chat-root" data-pane={mode} data-history={mode === 'page' || historyOpen ? 'open' : 'closed'}>
          <ConnectionOverlay />
          <Tooltips titles={sidePanelOn} />
          {mode === 'drawer' && historyOpen && (
            <button type="button" className="chat-backdrop" aria-label="Close sessions" onClick={() => setHistoryOpen(false)} />
          )}
          <ChatSidebar />
          <main className="chat-main">
            <Routes>
              <Route index element={<ChatHome />} />
              <Route path="new" element={<NewChat />} />
              <Route path="p/:projectId" element={<ChatRoute />} />
              {filesInTools && <Route path="files/:space" element={<FileExplorer />} />}
              {filesInTools && <Route path="f/:space/*" element={<SpaceFileView />} />}
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
            {panelAvailable && panelOpen && (
              <SidePanel
                project={shownProject}
                workstream={shown?.workstream ?? 'main'}
                files={filesInTools ? (shownProject ? { agent: shownProject } : { space: (fileMatch ?? newTabMatch)?.params.space ?? '', path: fileMatch?.params['*'] }) : null}
                onPicked={pickedInFiles}
                state={panel}
                onChange={setPanel}
                onClose={closePanel}
                overlay={narrow}
              />
            )}
          </main>
        </div>
      </MarkdownLinkContext.Provider>
      </SimpleDataProvider>
      </ChatSpacesProvider>
    </ChatChromeProvider>
  );
}
