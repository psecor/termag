// The simple UI's sidebar: ⌘K search over every session (by box name too),
// the way to a new chat, and the tabs (OpenItems.tsx), grouped by space:
// sessions, space files and new tabs, in the person's order in each space.
// A user with no spaces gets the same tabs in the same
// No space group. New session is at the top either way; it
// starts with no space chosen, so the session lands under "No space" unless
// one is picked, while each space's + starts one in that space or opens a tab.
// The data it reads is loaded once for the page (simpleData.tsx).
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { useEnvironmentSelection } from '../../hooks/useEnvironments';
import { LAST_ACTIVE_PROJECT_KEY } from '../../contexts/ProjectContext';
import { rowKey, type InboxRow } from '../../mobile/inbox';
import { boxFeed } from '../../services/boxFeed';
import { dropLastActiveProject, readRunningBox, stillRunningWorkspaceHref, subscribeRunningBoxes } from '../../chat/archive';
import { historyListHidden } from '../../chat/chatLayout';
import { boxLabel, fullUiHref } from '../../chat/simpleChat';
import { offersPhoneView, phoneViewHref, subscribePhoneView } from '../../mobile/chatLinks';
import { optBackIntoMobile } from '../../mobile/redirect';
import { ArchivedChats } from './ArchivedChats';
import { ChatNotifyHint } from './ChatNotifyHint';
import { useChatCommands } from './chatCommands';
import { ChatSearch } from './ChatSearch';
import { useChatChrome } from './chatChrome';
import { OpenItemsGroups } from './OpenItems';
import { ReviewsSidebar } from './ReviewsSidebar';
import { useReviewsData } from './reviewsData';
import { useSimpleData, WithSimpleData } from './simpleData';
import { SidebarResize, useSidebarWidth } from './SidebarResize';
import { AccountFoot, DocsSiteLink, SidebarTop } from './SidebarChrome';
import { WhatsNewFootLink } from '../../whatsNew/WhatsNewLinks';
import { newSessionShortcutLabel } from '../../chat/shortcuts';

const NEW_SESSION_KEYS = newSessionShortcutLabel(typeof navigator !== 'undefined' ? navigator.platform : undefined);

const FULL_UI_TITLE = 'Switch to Lab. termag opens in the UI you used last.';

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
  const reviewsOn = useReviewsData().on;
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
  const navigate = useNavigate();
  const environmentsOn = useEnvironmentSelection();
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
  const openFullUi = () => {
    if (activeRecovery) {
      dropLastActiveProject(activeRecovery.projectId, typeof localStorage === 'undefined' ? null : localStorage, LAST_ACTIVE_PROJECT_KEY);
      navigate(stillRunningWorkspaceHref());
    } else navigate(fullUiHref(activeId, activeWs));
  };

  const now = Date.now();
  const activeKey = activeId ? rowKey(activeId, activeWs) : null;
  // ⌘K's commands, under the refresh (chatCommands.ts).
  const commands = useChatCommands({ refresh: refresh === true, openLab: openFullUi, newSessionKeys: NEW_SESSION_KEYS, activeKey });
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const boxNameOf = useMemo(() => new Map(boxes.map(b => [b.id, b.name])), [boxes]);
  const boxOfRow = useCallback((r: InboxRow) => boxLabel(r, r.instanceId ? boxNameOf.get(r.instanceId) : null), [boxNameOf]);

  return (
    <nav
      ref={navRef}
      id="chat-conversations"
      className="chat-sidebar"
      style={resizable ? { width: sidebarWidth.width } : undefined}
      aria-label="Sessions"
      aria-hidden={listHidden || undefined}
      onClick={e => {
        const target = e.target;
        if (mode !== 'drawer' || !(target instanceof Element) || !target.closest('a')) return;
        closeHistory();
      }}
    >
      {refresh && <SidebarTop newSessionKeys={NEW_SESSION_KEYS} search={<ChatSearch rows={rows} now={now} boxNameOf={boxOfRow} actions={commands} />} />}
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
      {reviewsOn && <ReviewsSidebar />}
      <OpenItemsGroups />
      <ArchivedChats />
      <ChatNotifyHint />
      {resizable && <SidebarResize {...sidebarWidth} />}
      {refresh && <div className="chat-sidebar-foot"><AccountFoot openFullUi={openFullUi} phoneView={phoneView} /></div>}
      {!refresh && <div className="chat-sidebar-foot">
        {phoneView && <Link to={phoneView} className="chat-foot-link" data-analytics="chat-phone-view" onClick={optBackIntoMobile}>Phone view</Link>}
        {activeRecovery
          ? <button type="button" className="chat-foot-link" title={FULL_UI_TITLE} onClick={() => {
              dropLastActiveProject(activeRecovery.projectId, typeof localStorage === 'undefined' ? null : localStorage, LAST_ACTIVE_PROJECT_KEY);
              navigate(stillRunningWorkspaceHref());
            }}>Lab</button>
          : <Link to={fullUiHref(activeId, activeWs)} className="chat-foot-link" title={FULL_UI_TITLE}>Lab</Link>}
        {environmentsOn && <Link to="/chat/environments" className="chat-foot-link">Environments</Link>}
        <DocsSiteLink className="chat-foot-link chat-docs-link" />
        <WhatsNewFootLink />
        <Link to="/settings?from=chat" className="chat-foot-link">Settings</Link>
      </div>}
    </nav>
  );
}
