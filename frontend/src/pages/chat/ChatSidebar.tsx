// The simple UI's sidebar: ⌘K search over every session (by box name too),
// the way to a new chat, and the tabs (OpenItems.tsx), or under View options →
// Show: Projects every session (ProjectsList.tsx). The tabs are grouped by space:
// sessions, space files and new tabs, in the person's order in each space.
// A user with no spaces gets the same tabs in the same
// No space group. New session is at the top either way; it
// starts with no space chosen, so the session lands under "No space" unless
// one is picked, while each space's + starts one in that space or opens a tab.
// The data it reads is loaded once for the page (simpleData.tsx).
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { useEnvironmentSelection } from '../../hooks/useEnvironments';
import { LAST_ACTIVE_PROJECT_KEY } from '../../contexts/ProjectContext';
import { rowKey, type InboxRow } from '../../mobile/inbox';
import { boxFeed } from '../../services/boxFeed';
import { dropLastActiveProject, readRunningBox, stillRunningWorkspaceHref, subscribeRunningBoxes } from '../../chat/archive';
import { historyListHidden } from '../../chat/chatLayout';
import { boxLabel, fullUiHref } from '../../chat/simpleChat';
import { recordLabOpened, type LabOpenedFrom } from '../../chat/labOpened';
import { offersPhoneView, phoneViewHref, subscribePhoneView } from '../../mobile/chatLinks';
import { optBackIntoMobile } from '../../mobile/redirect';
import { ArchivedChats } from './ArchivedChats';
import { ChatNotifyHint } from './ChatNotifyHint';
import { useChatCommands } from './chatCommands';
import { ChatSearch } from './ChatSearch';
import { useChatChrome } from './chatChrome';
import { OpenItemsGroups } from './OpenItems';
import { ProjectsList } from './ProjectsList';
import { useSidebarView } from '../../chat/sidebarView';
import { ReviewsSidebar } from './ReviewsSidebar';
import { useReviewsData } from './reviewsData';
import { ReviewAsksRow, ReviewsButton } from './ReviewAsks';
import { agentReviewRepo, reviewAsks } from '../../chat/reviews';
import { useProjects } from '../../contexts/ProjectContext';
import { useSimpleData, WithSimpleData } from './simpleData';
import { SidebarResize, useSidebarWidth } from './SidebarResize';
import { AccountFoot, DocsSiteLink, SidebarTop } from './SidebarChrome';
import { focusSoon, RAIL_KEYS, RAIL_MAC, SidebarRail } from './SidebarRail';
import { isRailShortcut, setSidebarCollapsed, toggleSidebarCollapsed, useSidebarCollapsed } from '../../chat/sidebarRail';
import { WhatsNewFootLink } from '../../whatsNew/WhatsNewLinks';
import { newSessionShortcutLabel } from '../../chat/shortcuts';
import { recordUiMode } from '../../chat/uiMode';
import { FLAGS, useFlag } from '../../flags';

const NEW_SESSION_KEYS = newSessionShortcutLabel(typeof navigator !== 'undefined' ? navigator.platform : undefined);

const FULL_UI_TITLE = 'Switch to Lab. termag opens in the UI you used last.';
// Under chat-ui-nudge-enabled only a switch changes where termag opens (chat/uiMode.ts), as the account menu says.
const FULL_UI_SWITCH_TITLE = 'Switch to Lab. termag opens in Lab from now on.';

/** New session: a pencil on a page, the usual "compose" mark, so it reads apart from each space's +. */
function NewSessionIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
        d="M13.5 8.5V13a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V4A1.5 1.5 0 0 1 3 2.5h4.5" />
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M12.2 1.6l2.2 2.2-6.3 6.3-2.9.7.7-2.9z" />
    </svg>
  );
}

const subscribeWindowPhoneView = (cb: () => void) => subscribePhoneView(typeof window === 'undefined' ? undefined : window, cb);
const windowOffersPhoneView = () => typeof window !== 'undefined' && offersPhoneView(window);

export function ChatSidebar() {
  return <WithSimpleData><Sidebar /></WithSimpleData>;
}

function Sidebar() {
  const { closeHistory, mode, historyOpen, refresh } = useChatChrome();
  const reviewsData = useReviewsData();
  const reviewsOn = reviewsData.on;
  const listHidden = historyListHidden(mode, historyOpen);
  // The chrome refresh's sidebar is resizable while it is docked beside the conversation.
  const resizable = refresh === true && mode === 'docked';
  const sidebarWidth = useSidebarWidth();
  const navRef = useRef<HTMLElement>(null);
  // React 18's types have no `inert` prop. A closed drawer is only translated
  // off-screen, so without this the links stay first in tab order.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    if (listHidden) nav.setAttribute('inert', '');
    else nav.removeAttribute('inert');
  }, [listHidden]);
  const { rows } = useSimpleData();
  // View options → Show (chat/sidebarView.ts), read only under the refresh, where the options are.
  const showProjects = useSidebarView().show === 'projects' && refresh === true;
  const navigate = useNavigate();
  const environmentsOn = useEnvironmentSelection();
  const fullUiTitle = useFlag(FLAGS.chatUiNudge, false) ? FULL_UI_SWITCH_TITLE : FULL_UI_TITLE;
  // The sidebar redesign rides on user-projects-enabled until it's on for everyone.
  const sidebarUx = useFlag(FLAGS.userProjects, false) && refresh === true;
  // The redesign's reviews: the blue row for the asks you haven't started, else a
  // Reviews button beside New session; a started review is a card in its project.
  const { projects: checkouts } = useProjects();
  const asks = sidebarUx && reviewsOn ? reviewAsks(reviewsData.queue, reviewsData.agentReviews.map(a => ({
    number: a.number, repo: agentReviewRepo(a.url, checkouts.find(p => p.id === a.projectId)?.repoKeys),
  }))) : null;
  // Collapsed to the rail (SidebarRail.tsx, chat/sidebarRail.ts): the redesign's, on a desktop width only.
  const collapsible = sidebarUx && mode === 'docked';
  const collapsed = useSidebarCollapsed() && collapsible;
  useEffect(() => {
    if (!collapsible) return undefined;
    // In the capture phase, so it works from a terminal pane too (xterm takes its keys).
    const onKey = (e: KeyboardEvent) => {
      if (!isRailShortcut(e, RAIL_MAC)) return;
      // Every one, a held key's repeats included, stops here: off a Mac Ctrl+\ in a terminal is SIGQUIT.
      e.preventDefault();
      e.stopPropagation();
      // Held down, the key repeats: one toggle per press.
      if (e.repeat) return;
      toggleSidebarCollapsed();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [collapsible]);
  const match = useMatch('/chat/p/:projectId');
  const [params] = useSearchParams();
  const activeId = match?.params.projectId ?? null;
  const activeWs = params.get('ws') || 'main';
  // On a phone, the way back to the phone client, at the open conversation.
  // Live: rotating a phone from landscape to portrait offers it.
  const onPhone = useSyncExternalStore(subscribeWindowPhoneView, windowOffersPhoneView, () => false);
  const phoneView = onPhone ? phoneViewHref(activeId, activeWs) : null;
  const activeRecovery = useSyncExternalStore(subscribeRunningBoxes, () => (activeId ? readRunningBox(activeId) : null));
  // The refresh's account menu goes to Lab the way the Lab link below does.
  // Lab, from the account menu, ⌘K or the foot link: a switch, so Lab is
  // where termag opens from now on (chat/uiMode.ts). `from` is for lab.opened (chat/labOpened.ts).
  const openFullUi = (from: LabOpenedFrom) => {
    recordLabOpened(from);
    recordUiMode('full');
    if (activeRecovery) {
      dropLastActiveProject(activeRecovery.projectId, typeof localStorage === 'undefined' ? null : localStorage, LAST_ACTIVE_PROJECT_KEY);
      navigate(stillRunningWorkspaceHref());
    } else navigate(fullUiHref(activeId, activeWs));
  };

  const now = Date.now();
  const activeKey = activeId ? rowKey(activeId, activeWs) : null;
  // ⌘K's commands, under the refresh (chatCommands.ts).
  const commands = useChatCommands({ refresh: refresh === true, openLab: () => openFullUi('command-menu'), newSessionKeys: NEW_SESSION_KEYS, activeKey });
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const boxNameOf = useMemo(() => new Map(boxes.map(b => [b.id, b.name])), [boxes]);
  const boxOfRow = useCallback((r: InboxRow) => boxLabel(r, r.instanceId ? boxNameOf.get(r.instanceId) : null), [boxNameOf]);

  return (
    <nav
      ref={navRef}
      id="chat-conversations"
      className="chat-sidebar"
      data-sidebar-ux={sidebarUx ? '' : undefined}
      data-collapsed={collapsed || undefined}
      style={collapsed ? { width: 52 } : resizable ? { width: sidebarWidth.width } : undefined}
      aria-label="Sessions"
      aria-hidden={listHidden || undefined}
      onClick={e => {
        const target = e.target;
        if (mode !== 'drawer' || !(target instanceof Element) || !target.closest('a')) return;
        closeHistory();
      }}
    >
      {/* The rail over the sidebar, which stays mounted under it (hidden by sessionCard.css): its list keeps its pins,
          folds, reveal and any Undo in flight, and ⌘K's palette still opens from the rail's Search. */}
      {collapsed && <SidebarRail />}
      {refresh && <SidebarTop newSessionKeys={NEW_SESSION_KEYS} search={<ChatSearch rows={rows} now={now} boxNameOf={boxOfRow} actions={commands} />}
        collapse={collapsible ? { onPress: () => { setSidebarCollapsed(true); focusSoon('.sb-rail-show'); }, keys: RAIL_KEYS } : undefined}
        besideNew={asks && asks.count === 0 ? <ReviewsButton /> : undefined} />}
      {!refresh && <div className="chat-sidebar-head">
        <Link to="/chat" className="chat-brand">termag</Link>
        <span className="chat-new-wrap">
          {/* The button's title names the shortcut for screen readers; this is the sighted hint. */}
          <kbd className="chat-new-kbd" aria-hidden="true">{NEW_SESSION_KEYS}</kbd>
          <Link to="/chat/new" className="btn-primary chat-new" aria-label="New session" title={`New session (${NEW_SESSION_KEYS})`}>
            <NewSessionIcon />
          </Link>
        </span>
      </div>}
      {!refresh && <div className="chat-search">
        <ChatSearch rows={rows} now={now} boxNameOf={boxOfRow} />
      </div>}
      {reviewsOn && !sidebarUx && <ReviewsSidebar />}
      {asks && asks.count > 0 && <ReviewAsksRow count={asks.count} requesters={asks.requesters} />}
      {showProjects ? <ProjectsList /> : <OpenItemsGroups />}
      {/* The redesign's Archived is a section of the Projects view's bottom row (ProjectsList.tsx). */}
      {!(sidebarUx && showProjects) && <ArchivedChats />}
      <ChatNotifyHint />
      {resizable && <SidebarResize {...sidebarWidth} />}
      {refresh && <div className="chat-sidebar-foot"><AccountFoot openFullUi={() => openFullUi('account-menu')} phoneView={phoneView} /></div>}
      {!refresh && <div className="chat-sidebar-foot">
        {phoneView && <Link to={phoneView} className="chat-foot-link" data-analytics="chat-phone-view" onClick={optBackIntoMobile}>Phone view</Link>}
        {activeRecovery
          ? <button type="button" className="chat-foot-link" title={fullUiTitle} onClick={() => openFullUi('account-menu')}>Lab</button>
          : <Link to={fullUiHref(activeId, activeWs)} className="chat-foot-link" title={fullUiTitle} onClick={() => { recordLabOpened('account-menu'); recordUiMode('full'); }}>Lab</Link>}
        {environmentsOn && <Link to="/chat/environments" className="chat-foot-link">Environments</Link>}
        <DocsSiteLink className="chat-foot-link chat-docs-link" />
        <WhatsNewFootLink />
        <Link to="/settings?from=chat" className="chat-foot-link">Settings</Link>
      </div>}
    </nav>
  );
}
