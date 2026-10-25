// The simple UI's conversation list: every project workstream with an agent,
// the ones that need you first, each with the words for its state and the
// agent's last message, ⌘K search over them (by box name too), and the way
// to a new chat. With spaces on, chats are grouped by their box's space, then
// "No space" (chat/chatSpaces.ts), each group headed by its space's colour
// (chat/spaceColors.ts) and foldable. With
// simple-ui-side-panel-enabled and spaces on, the list is the tabs instead
// (OpenItems.tsx), still grouped by space: sessions, space files and new
// tabs, in the person's order in each space. A user with no spaces
// keeps the list above. New session is at the top either way; it starts with
// no space chosen, so the session lands under "No space" unless one is
// picked, while each space's + starts one in that space or opens a tab.
// The data both read is loaded once for the page (simpleData.tsx).
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { LAST_ACTIVE_PROJECT_KEY } from '../../contexts/ProjectContext';
import { stateSince, STATUS_GLYPH, type InboxRow } from '../../mobile/inbox';
import { fmtAge } from '../../utils/format';
import { boxFeed } from '../../services/boxFeed';
import { dropLastActiveProject, readRunningBox, stillRunningWorkspaceHref, subscribeRunningBoxes } from '../../chat/archive';
import { historyListHidden } from '../../chat/chatLayout';
import { boxLabel, chatHref, chatRowName, fullUiHref, sidebarLine } from '../../chat/simpleChat';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { canStartChatIn, groupBySpace, groupKey, readCollapsedSpaces, toggleCollapsedSpace } from '../../chat/chatSpaces';
import { spaceColorStyle } from '../../chat/spaceColors';
import { ArchivedChats } from './ArchivedChats';
import { ChatNotifyHint } from './ChatNotifyHint';
import { ChatSearch } from './ChatSearch';
import { useChatChrome } from './chatChrome';
import { OpenItemsGroups } from './OpenItems';
import { SpaceSwatch } from './SpaceSwatch';
import { useSimpleData, WithSimpleData } from './simpleData';
import { newSessionShortcutLabel } from '../../chat/shortcuts';

const NEW_SESSION_KEYS = newSessionShortcutLabel(typeof navigator !== 'undefined' ? navigator.platform : undefined);

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

const FULL_UI_TITLE = 'Switch to the full UI. termag opens in the UI you used last.';

export function ChatSidebar() {
  return <WithSimpleData><Sidebar /></WithSimpleData>;
}

function Sidebar() {
  const { closeHistory, mode, historyOpen } = useChatChrome();
  const listHidden = historyListHidden(mode, historyOpen);
  const navRef = useRef<HTMLElement>(null);
  // React 18's types have no `inert` prop. A closed drawer is only translated
  // off-screen, so without this the links stay first in tab order.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    if (listHidden) nav.setAttribute('inert', '');
    else nav.removeAttribute('inert');
  }, [listHidden]);
  const { rows, live, setupOf, spaces, itemsShown, titlesShown } = useSimpleData();
  const navigate = useNavigate();
  const match = useMatch('/chat/p/:projectId');
  const [params] = useSearchParams();
  const activeId = match?.params.projectId ?? null;
  const activeWs = params.get('ws') || 'main';
  const activeRecovery = useSyncExternalStore(subscribeRunningBoxes, () => (activeId ? readRunningBox(activeId) : null));

  const now = Date.now();
  const groups = useMemo(() => (spaces.enabled ? groupBySpace(rows, spaces.index) : []), [spaces.enabled, spaces.index, rows]);
  const grouped = groups.some(g => g.space !== null);
  const [collapsed, setCollapsed] = useState(() => readCollapsedSpaces(storage()));
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const boxNameOf = useMemo(() => new Map(boxes.map(b => [b.id, b.name])), [boxes]);
  const boxOfRow = useCallback((r: InboxRow) => boxLabel(r, r.instanceId ? boxNameOf.get(r.instanceId) : null), [boxNameOf]);

  function row(r: InboxRow, alsoIn: readonly string[]) {
    const since = stateSince(r);
    const active = r.projectId === activeId && r.workstream === activeWs;
    const line = sidebarLine(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId));
    const named = chatRowName(r, titlesShown);
    return (
      <li key={r.key}>
        <Link
          to={chatHref(r.projectId, r.workstream)}
          className={`chat-row${active ? ' active' : ''}`}
          aria-current={active ? 'page' : undefined}
          data-band={r.band}
        >
          <span className="chat-glyph" data-status={line.glyph} aria-hidden="true">{STATUS_GLYPH[line.glyph]}</span>
          <span className="chat-row-body">
            <span className="chat-row-top">
              <span className="chat-row-name" title={named.title ?? undefined}>
                {named.title ?? <>{r.projectName}{r.workstream !== 'main' && <span className="chat-row-ws"> · {r.workstream}</span>}</>}
              </span>
              {since && <span className="chat-row-age">{fmtAge(now - new Date(since).getTime())}</span>}
            </span>
            {/* Each line is one line, cut with an ellipsis; the title shows the rest. */}
            {named.title && <span className="chat-row-where" title={named.where}>{named.where}</span>}
            <span className="chat-row-state" title={line.state}>{line.state}</span>
            {line.message && <span className="chat-row-msg" title={line.message}>{line.message}</span>}
            {alsoIn.length > 0 && <span className="chat-row-also" title={`also in ${alsoIn.join(', ')}`}>also in {alsoIn.join(', ')}</span>}
          </span>
        </Link>
      </li>
    );
  }

  return (
    <nav
      ref={navRef}
      id="chat-conversations"
      className="chat-sidebar"
      aria-label="Sessions"
      aria-hidden={listHidden || undefined}
      onClick={e => {
        const target = e.target;
        if (mode !== 'drawer' || !(target instanceof Element) || !target.closest('a')) return;
        closeHistory();
      }}
    >
      <div className="chat-sidebar-head">
        <Link to="/chat" className="chat-brand">termag</Link>
        <Link to="/chat/new" className="btn-primary chat-new" title={`New session (${NEW_SESSION_KEYS})`}>
          <span className="chat-new-label">New session</span><kbd className="chat-new-kbd" aria-hidden="true">{NEW_SESSION_KEYS}</kbd>
        </Link>
      </div>
      <div className="chat-search">
        <ChatSearch rows={rows} now={now} boxNameOf={boxOfRow} />
      </div>
      {itemsShown && <OpenItemsGroups />}
      {!itemsShown && <ul className="chat-list">
        {rows.length === 0 && <li className="chat-list-empty">No sessions yet.</li>}
        {grouped
          ? groups.map(g => {
            const key = groupKey(g.space);
            const name = g.space ?? 'No space';
            const folded = collapsed.has(key);
            // A folded group still shows the open session, so it is never hidden.
            const shown = folded ? g.rows.filter(({ row: r }) => r.projectId === activeId && r.workstream === activeWs) : g.rows;
            const needYou = g.rows.filter(({ row: r }) => r.band === 'attention').length;
            const listId = g.space ? `chat-group-s-${g.space}` : 'chat-group-none';
            return (
              <li key={key} className="chat-group" data-space={g.space ? undefined : 'none'} data-folded={folded || undefined} style={spaceColorStyle(g.space, spaces.colorOf)}>
                <div className="chat-group-head">
                  <button
                    type="button"
                    className="chat-group-toggle"
                    aria-expanded={!folded}
                    aria-controls={listId}
                    title={folded ? `Show the sessions in ${name}` : `Fold ${name}`}
                    onClick={() => setCollapsed(c => toggleCollapsedSpace(c, key, storage()))}
                  >
                    <span className="chat-group-caret" aria-hidden="true" />
                    <SpaceSwatch space={g.space} />
                    <span className="chat-group-name">{name}</span>
                    <span className="chat-group-count" aria-label={`${g.rows.length} ${g.rows.length === 1 ? 'session' : 'sessions'}`}>{g.rows.length}</span>
                    {folded && needYou > 0 && <span className="chat-group-attn">{needYou} need{needYou === 1 ? 's' : ''} you</span>}
                  </button>
                  {g.space && canStartChatIn(g.space, spaces.spaces) && (
                    <Link to={`/chat/new?space=${encodeURIComponent(g.space)}`} className="chat-group-new" title={`New session in ${g.space}`} aria-label={`New session in ${g.space}`}>+</Link>
                  )}
                </div>
                <ul className="chat-group-list" id={listId} aria-label={name} hidden={shown.length === 0}>
                  {shown.map(({ row: r, alsoIn }) => row(r, alsoIn))}
                </ul>
              </li>
            );
          })
          : rows.map(r => row(r, []))}
      </ul>}
      <ArchivedChats />
      <ChatNotifyHint />
      <div className="chat-sidebar-foot">
        {activeRecovery
          ? <button type="button" className="chat-foot-link" title={FULL_UI_TITLE} onClick={() => {
              dropLastActiveProject(activeRecovery.projectId, typeof localStorage === 'undefined' ? null : localStorage, LAST_ACTIVE_PROJECT_KEY);
              navigate(stillRunningWorkspaceHref());
            }}>Full UI</button>
          : <Link to={fullUiHref(activeId, activeWs)} className="chat-foot-link" title={FULL_UI_TITLE}>Full UI</Link>}
        <Link to="/settings?from=chat" className="chat-foot-link">Settings</Link>
      </div>
    </nav>
  );
}
