// The simple UI's conversation list: every project workstream with an agent,
// the ones that need you first, each with the words for its state and the
// agent's last message, ⌘K search over them (by box name too), and the way
// to a new chat. With spaces on, chats are grouped by their box's space, then
// "No space" (chat/chatSpaces.ts), each group headed by its space's colour
// (chat/spaceColors.ts) and foldable. With
// simple-ui-side-panel-enabled, the list is the tabs instead (OpenItems.tsx),
// grouped by space: sessions, space files and new tabs, in the person's order
// in each space. A user with no spaces, or with spaces off, gets the same
// tabs in the same No space group. New session is at the top either way; it
// starts with no space chosen, so the session lands under "No space" unless
// one is picked, while each space's + starts one in that space or opens a tab.
// The data both read is loaded once for the page (simpleData.tsx). An
// automation's runs are one folded row, unfolded when one of them is open
// (utils/automationRuns.ts), in this list and in the explorers alike.
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { LAST_ACTIVE_PROJECT_KEY } from '../../contexts/ProjectContext';
import { rowKey, stateSince, STATUS_GLYPH, type InboxRow } from '../../mobile/inbox';
import { fmtAge } from '../../utils/format';
import { boxFeed } from '../../services/boxFeed';
import { dropLastActiveProject, readRunningBox, stillRunningWorkspaceHref, subscribeRunningBoxes } from '../../chat/archive';
import { historyListHidden } from '../../chat/chatLayout';
import { boxLabel, chatHref, chatRowName, fullUiHref, sidebarLine } from '../../chat/simpleChat';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { agentLabel, workstreamLabel, workstreamTip } from '../../chat/explorerAgents';
import { nestInOrder, readFoldedAgents, toggleFoldedAgent, type TreeRow } from '../../chat/agentTree';
import { canStartChatIn, groupBySpace, groupKey, readCollapsedSpaces, toggleCollapsedSpace } from '../../chat/chatSpaces';
import { spaceColorStyle } from '../../chat/spaceColors';
import { ArchivedChats } from './ArchivedChats';
import { ChatNotifyHint } from './ChatNotifyHint';
import { useChatCommands } from './chatCommands';
import { ChatSearch } from './ChatSearch';
import { useChatChrome } from './chatChrome';
import { OpenItemsGroups } from './OpenItems';
import { ReviewsSidebar } from './ReviewsSidebar';
import { useReviewsData } from './reviewsData';
import { SpaceSwatch } from './SpaceSwatch';
import { useSimpleData, WithSimpleData } from './simpleData';
import { SidebarResize, useSidebarWidth } from './SidebarResize';
import { AccountFoot, SidebarTop } from './SidebarChrome';
import { WhatsNewFootLink } from '../../whatsNew/WhatsNewLinks';
import { newSessionShortcutLabel } from '../../chat/shortcuts';
import { setRunsUnfolded, useAutomationIndex, useUnfoldedRuns } from '../../chat/automationRunGroups';
import { automationHref as automationPageHref } from '../../chat/automationsView';
import { useAutomationsEnabled } from '../../chat/useAutomations';
import { automationHref, groupRuns, runLabel, runsStatus, runsSubtitle, runsUnfolded, shownRuns, subtrees } from '../../utils/automationRuns';
import { FLAGS, useFlag } from '../../flags';
import { putSessionRef } from '../../chat/sessionRef';

const NEW_SESSION_KEYS = newSessionShortcutLabel(typeof navigator !== 'undefined' ? navigator.platform : undefined);

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/** A row's name with its box, which tells apart same-named sessions on different boxes. */
const rowTip = (name: string, box: string | null) => (box ? `${name} on ${box}` : name);

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
  const { rows, live, setupOf, spaces, itemsShown, titlesShown, links } = useSimpleData();
  const navigate = useNavigate();
  const match = useMatch('/chat/p/:projectId');
  const [params] = useSearchParams();
  const activeId = match?.params.projectId ?? null;
  const activeWs = params.get('ws') || 'main';
  const activeRecovery = useSyncExternalStore(subscribeRunningBoxes, () => (activeId ? readRunningBox(activeId) : null));
  // The refresh's account menu goes to Lab the way the Lab link below does.
  const openFullUi = () => {
    if (activeRecovery) {
      dropLastActiveProject(activeRecovery.projectId, typeof localStorage === 'undefined' ? null : localStorage, LAST_ACTIVE_PROJECT_KEY);
      navigate(stillRunningWorkspaceHref());
    } else navigate(fullUiHref(activeId, activeWs));
  };

  const now = Date.now();
  const groups = useMemo(() => (spaces.enabled ? groupBySpace(rows, spaces.spaces, spaces.index) : []), [spaces.enabled, spaces.spaces, spaces.index, rows]);
  const grouped = groups.some(g => g.space !== null);
  const [collapsed, setCollapsed] = useState(() => readCollapsedSpaces(storage()));
  const [foldedAgents, setFoldedAgents] = useState(() => readFoldedAgents(storage()));
  const activeKey = activeId ? rowKey(activeId, activeWs) : null;
  // ⌘K's commands, under the refresh (chatCommands.ts).
  const commands = useChatCommands({ refresh: refresh === true, openLab: openFullUi, newSessionKeys: NEW_SESSION_KEYS, activeKey });
  // Each list as a tree: an ask or spawned agent under the session that started it (chat/agentTree.ts).
  const tree = <T,>(list: readonly T[], keyOf: (t: T) => string) => nestInOrder(list, keyOf, links, foldedAgents, activeKey);
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const boxNameOf = useMemo(() => new Map(boxes.map(b => [b.id, b.name])), [boxes]);
  const unfoldedRuns = useUnfoldedRuns();
  const automations = useAutomationIndex(rows.some(r => r.kind === 'automation'));
  // With the simple UI's automation pages, an unfolded automation always ends in a link to its page there.
  const automationPages = useAutomationsEnabled();
  const boxOfRow = useCallback((r: InboxRow) => boxLabel(r, r.instanceId ? boxNameOf.get(r.instanceId) : null), [boxNameOf]);
  // A row dragged into a composer puts a reference to its session in the message (chat/sessionRef.ts).
  const refsOn = useFlag(FLAGS.chatSessionReferences, false);

  // `hidden`: the rows a folded `node` leaves out, as rows; the space groups nest { row, alsoIn }, so each caller unwraps its own.
  // `label`: what the row is called in place of its project and workstream (a run under its automation).
  function row(r: InboxRow, alsoIn: readonly string[], node?: TreeRow<unknown>, hidden: readonly InboxRow[] = [], label?: string) {
    const since = stateSince(r);
    const active = r.projectId === activeId && r.workstream === activeWs;
    const line = sidebarLine(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId));
    const named = chatRowName(r, titlesShown);
    const depth = node?.depth ?? 0;
    const kids = node?.childCount ?? 0;
    // Folded is what is shown: a parent folded in storage stays open on the way to the open session (agentTree.nestInOrder), and hides nothing then.
    const folded = hidden.length > 0;
    const hiddenNeedYou = hidden.filter(h => h.band === 'attention').length;
    const foldedNote = folded && (
      <span className="chat-row-folded">
        {hidden.length} folded{hiddenNeedYou > 0 && <span className="chat-group-attn"> · {hiddenNeedYou} need{hiddenNeedYou === 1 ? 's' : ''} you</span>}
      </span>
    );
    // Every name tooltip says the box: same-named sessions on different boxes (each ask box's
    // termag-3) differ only there, whether the row leads with a title or the project.
    const nameTip = rowTip(named.ask ? workstreamTip(r) ?? '' : named.title ?? named.where ?? '', boxOfRow(r));
    const nameText = label ?? named.title ?? <>{r.projectName}{r.workstream !== 'main' && <span className="chat-row-ws" title={workstreamTip(r) ?? undefined}> · {workstreamLabel(r)}</span>}</>;
    // A nested row (an ask or spawned agent under its sender) is one line, as the space's tabs are:
    // the glyph keeps its status, and what a top-level row says under its name goes in the tooltip.
    const compact = depth > 0;
    const tip = compact
      ? [named.title ?? agentLabel(r), named.where, nameTip, line.state, line.message, alsoIn.length ? `also in ${alsoIn.join(', ')}` : null].filter(Boolean).join('\n')
      : undefined;
    return (
      <li key={r.key} className="chat-tree-li" style={depth ? { '--chat-depth': depth } as React.CSSProperties : undefined}>
        {kids > 0 && (
          <button
            type="button"
            className="chat-twisty"
            aria-expanded={!folded}
            aria-label={`${folded ? 'Show' : 'Hide'} the ${kids} ${kids === 1 ? 'agent' : 'agents'} ${agentLabel(r)} started`}
            title={folded ? `Show the ${kids} started by this session` : `Fold the ${kids} started by this session`}
            onClick={() => setFoldedAgents(f => (f.has(r.key) === !folded ? f : toggleFoldedAgent(f, r.key, storage())))}
          ><span className="chat-group-caret" aria-hidden="true" /></button>
        )}
        <Link
          to={chatHref(r.projectId, r.workstream)}
          className={`chat-row${compact ? ' chat-row-compact' : ''}${active ? ' active' : ''}`}
          aria-current={active ? 'page' : undefined}
          data-band={r.band}
          title={tip}
          onDragStart={refsOn ? e => putSessionRef(e, r, boxOfRow(r), titlesShown) : undefined}
        >
          <span className="chat-glyph" data-status={line.glyph} aria-hidden="true">{STATUS_GLYPH[line.glyph]}</span>
          {compact ? (
            <span className="chat-row-body">
              <span className="chat-row-top">
                <span className="chat-row-name">{nameText}</span>
                {foldedNote}
              </span>
              <span className="chat-sr">, {line.state}</span>
            </span>
          ) : <span className="chat-row-body">
            <span className="chat-row-top">
              {/* An ask is called by its title: its project and box are the ask's plumbing, in the tooltip. */}
              <span className="chat-row-name" title={nameTip}>{nameText}</span>
              {since && <span className="chat-row-age">{fmtAge(now - new Date(since).getTime())}</span>}
            </span>
            {/* Each line is one line, cut with an ellipsis; the title shows the rest. */}
            {named.title && named.where && <span className="chat-row-where" title={named.where}>{named.where}</span>}
            <span className="chat-row-state" title={line.state}>{line.state}</span>
            {line.message && <span className="chat-row-msg" title={line.message}>{line.message}</span>}
            {alsoIn.length > 0 && <span className="chat-row-also" title={`also in ${alsoIn.join(', ')}`}>also in {alsoIn.join(', ')}</span>}
            {foldedNote}
          </span>}
        </Link>
      </li>
    );
  }

  /**
   * An automation's runs as one row: its latest run's status, its schedule and run count; unfolded, the newest runs
   * (each with what it started under it), then Show all. `runs`: each run's subtree, newest first; `rowOf` its rows.
   */
  function runGroup<T>(projectId: string, projectName: string, runs: ReadonlyArray<ReadonlyArray<TreeRow<T>>>, rowOf: (t: T) => InboxRow, alsoInOf: (t: T) => readonly string[]) {
    const auto = automations.get(projectId);
    const isOpen = (n: TreeRow<T>) => { const r = rowOf(n.item); return r.projectId === activeId && r.workstream === activeWs; };
    // The run holding the open session, itself or something it started.
    const openRun = runs.find(t => t.some(isOpen));
    const open = runsUnfolded(projectId, unfoldedRuns, openRun ? rowOf(openRun[0].item) : null);
    const status = runsStatus(runs.map(t => { const r = rowOf(t[0].item); return sidebarLine(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId)).glyph; }));
    const count = runs.length;
    const countText = `${count} ${count === 1 ? 'run' : 'runs'}`;
    const shown = open ? shownRuns(runs, t => t.some(isOpen)) : [];
    return (
      <React.Fragment key={`runs:${projectId}`}>
        <li className="chat-tree-li">
          <button type="button" className="chat-row chat-runs-head" aria-expanded={open}
            title={[projectName, auto ? `automation: ${runsSubtitle(auto)}` : 'automation', countText].join('\n')}
            onClick={() => setRunsUnfolded(projectId, !open)}>
            <span className="chat-twisty" aria-hidden="true"><span className="chat-group-caret" /></span>
            <span className="chat-glyph" data-status={status} aria-hidden="true">{STATUS_GLYPH[status]}</span>
            <span className="chat-row-body">
              <span className="chat-row-top">
                <span className="chat-row-name">{projectName}</span>
                <span className="chat-group-count" aria-label={countText}>{count}</span>
              </span>
              {auto && <span className="chat-row-state">{runsSubtitle(auto)}</span>}
            </span>
          </button>
        </li>
        {shown.flatMap(t => t.map((n, i) => row(rowOf(n.item), alsoInOf(n.item), { ...n, depth: n.depth + 1 }, n.hidden.map(rowOf),
          i === 0 ? runLabel(rowOf(n.item).workstream, auto?.timezone) : undefined)))}
        {(count > shown.length || automationPages) && open && (
          <li className="chat-tree-li" style={{ '--chat-depth': 1 } as React.CSSProperties}>
            <Link to={automationPages ? automationPageHref(projectId) : automationHref(projectId)} className="chat-row chat-row-compact chat-runs-all">
              {count > shown.length ? `Show all ${count} runs` : 'Open automation'}
            </Link>
          </li>
        )}
      </React.Fragment>
    );
  }

  /** A list's tree, with each automation's runs, and what each started, as one row (runGroup). */
  function listRows<T>(nodes: ReadonlyArray<TreeRow<T>>, rowOf: (t: T) => InboxRow, alsoInOf: (t: T) => readonly string[]) {
    return groupRuns(subtrees(nodes, n => n.depth), t => rowOf(t[0].item)).flatMap(x => (x.group
      ? [runGroup(x.group.projectId, x.group.projectName, x.group.runs, rowOf, alsoInOf)]
      : x.item.map(n => row(rowOf(n.item), alsoInOf(n.item), n, n.hidden.map(rowOf)))));
  }

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
      {refresh && <SidebarTop newSessionKeys={NEW_SESSION_KEYS} search={<ChatSearch rows={rows} now={now} boxNameOf={boxOfRow} actions={commands} />} viewOptions={itemsShown} />}
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
      {itemsShown && reviewsOn && <ReviewsSidebar />}
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
                  {listRows(tree(shown, x => x.row.key), x => x.row, x => x.alsoIn)}
                </ul>
              </li>
            );
          })
          : listRows(tree(rows, r => r.key), r => r, () => [])}
      </ul>}
      <ArchivedChats />
      <ChatNotifyHint />
      {resizable && <SidebarResize {...sidebarWidth} />}
      {refresh && <div className="chat-sidebar-foot"><AccountFoot openFullUi={openFullUi} /></div>}
      {!refresh && <div className="chat-sidebar-foot">
        {activeRecovery
          ? <button type="button" className="chat-foot-link" title={FULL_UI_TITLE} onClick={() => {
              dropLastActiveProject(activeRecovery.projectId, typeof localStorage === 'undefined' ? null : localStorage, LAST_ACTIVE_PROJECT_KEY);
              navigate(stillRunningWorkspaceHref());
            }}>Lab</button>
          : <Link to={fullUiHref(activeId, activeWs)} className="chat-foot-link" title={FULL_UI_TITLE}>Lab</Link>}
        <WhatsNewFootLink />
        <Link to="/settings?from=chat" className="chat-foot-link">Settings</Link>
      </div>}
    </nav>
  );
}
