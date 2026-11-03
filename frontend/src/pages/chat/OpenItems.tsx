// The simple UI's sidebar of tabs (simple-ui-side-panel-enabled,
// chat/openItems.ts), grouped by space: agents, space files and new tabs,
// one fixed-height line each, in the person's order. A chat's tab is in the
// chat's own space (chat/chatSpaces.ts chatHomeSpace), wherever it was opened
// from; a chat in no space of its own is in the space its tab was opened from
// (OpenItem.openedIn), and the list scrolls to the open tab. A new tab goes on top
// of its space, and so does a tab on each access (openItems.ts); a click
// here moves nothing. Dragging a row or Alt+Up/Down on it moves it within its
// space, and a drag over another space is refused with a note. A
// tab's ⋮ (on hover or focus, always on a touch screen), a right click, the
// context menu key or Shift+F10 opens its menu, which has Close tab, Close
// other tabs and Close tabs below (within its space, in its whole order, hidden
// tabs included). Its X, right of the ⋮ and shown when it is, is Close tab. A touch screen has no drag, and tabs keep their order there.
// Each space, and No space, shows its first 10 tabs and the open one; "Show
// more" shows 10 more at a time and goes once all show (chat/incrementalList.ts).
// Only a reload goes back to 10. Hidden tabs stay open.
// A space's head folds it (a click, Enter or Space, Left to fold and Right to
// unfold), remembered per space in this browser as ChatSidebar's groups are
// (chat/chatSpaces.ts); a folded space shows only the open tab, and no Show more.
// A space's head, and No space's, has one ⋮ with one menu (chat/spaceMenu.ts):
// New agent, New tab (a space's explorer, its recents beside Files), the space's
// own actions, then Close all tabs and Close file tabs. A right click, Shift+F10
// or the menu key, or a long press on the head opens that same menu, hung from
// the ⋮. "No space" (agents whose box has no space) has New agent and the tab
// actions. Closing only takes tabs off the list: the session keeps running and
// the file stays in the space, both a ⋮ > New tab or a search away.
import React, { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { rowKey as inboxRowKey, type InboxRow } from '../../mobile/inbox';
import { nestInOrder, readFoldedAgents, toggleFoldedAgent, type TreeRow } from '../../chat/agentTree';
import { useBoxOf } from '../../chat/useBoxOf';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { canStartChatIn, chatHomeSpace, groupKey, readCollapsedSpaces, toggleCollapsedSpace } from '../../chat/chatSpaces';
import { agentLabel, workstreamLabel, workstreamTip } from '../../chat/explorerAgents';
import { groupOpenItems, itemHref, itemKey, newTabId, NO_SPACE_EXPLORER, type OpenItem } from '../../chat/openItems';
import { moveShown, useIncrementalWindows, type IncrementalList } from '../../chat/incrementalList';
import { chatRowName, sidebarLine } from '../../chat/simpleChat';
import { noteSettledBoxes } from '../../chat/noSpaceAgents';
import { spaceColorStyle } from '../../chat/spaceColors';
import { spaceHeaderContextActions } from '../../chat/spaceHeaderActions';
import { spaceCreateActions, spaceHeadMenuActions } from '../../chat/spaceMenu';
import { isMenuKey, MenuButton, useCoarsePointer, useContextMenu, useLongPress, type MenuTrigger } from './ContextMenu';
import { useSimpleData } from './simpleData';
import { ShowMoreRow } from './ShowMoreRow';
import { SpaceSwatch } from './SpaceSwatch';
import { SpaceShareDialog } from './SpaceShareDialog';
import { useAuth } from '../../contexts/AuthContext';
import { spaceShareActions } from '../../chat/spaceShare';
import { useChatChrome } from './chatChrome';
import { StatusMark } from './StatusMark';
import { FoldedCount, StandardRowBody } from './StandardRow';
import { chatRowState, type RowState } from '../../chat/rowState';
import { stateSince } from '../../mobile/inbox';
import { fmtAge } from '../../utils/format';
import { useSidebarView } from '../../chat/sidebarView';
import { viewGroups, type ViewGroup } from '../../chat/sidebarGroups';
import { useReviewsData } from './reviewsData';
import { Icon } from '@launchpad-ui/icons';
import { IconButton } from '@launchpad-ui/components';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { setRunsUnfolded, useAutomationIndex, useUnfoldedRuns } from '../../chat/automationRunGroups';
import { automationHref as automationPageHref } from '../../chat/automationsView';
import { useAutomationsEnabled } from '../../chat/useAutomations';
import { automationHref, groupRuns, newestRunsFirst, runLabel, runsSubtitle, runsUnfolded, shownRuns, subtrees, type RunGroup } from '../../utils/automationRuns';
import { FLAGS, useFlag } from '../../flags';
import { putSessionRef } from '../../chat/sessionRef';
import { desktopSessionHref, openDesktopLink } from '../../chat/desktopLinks';

/**
 * A space's rows on screen: a tab, or an automation's run tabs as one row
 * (utils/automationRuns.ts), each run with the tabs of what it started under
 * it. The automation's row is one place in the space's drag order (runSlot):
 * its run tabs move only together, and a tab moved past it leaves it where it
 * was. Inside it, runs are newest first, so they can't be dragged.
 */
type RunTree = ReadonlyArray<TreeRow<OpenItem>>;
type Entry = { n: TreeRow<OpenItem>; runs?: undefined } | { runs: RunGroup<RunTree>; n?: undefined };
/** One of an automation's runs in its row: its tab, with what it started, or (`tree` unset) a run with no tab, a link that opens one. */
/** A run of an automation's row: its row, its tab's tree when it has one, and the tabs of what it started that sit
 * apart from it (its asks and spawns open as tabs while it isn't, which aren't runs of their own). */
type RunEntry = { row: InboxRow; tree?: RunTree; under?: RunTree[] };

/** The drag-order place an automation's row holds for its run tabs. */
const runSlot = (projectId: string) => `runs:${projectId}`;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

export function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z" />
    </svg>
  );
}

/** An agent: a bot's head, with its status as a dot on the corner (none when it isn't running). */
export function AgentIcon({ status }: { status: string }) {
  return (
    <span className="chat-agent-icon" data-status={status} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" d="M8 1.8v2.2" />
        <rect x="2.5" y="4" width="11" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="6" cy="8.5" r="1.1" fill="currentColor" />
        <circle cx="10" cy="8.5" r="1.1" fill="currentColor" />
      </svg>
      <span className="chat-agent-dot" />
    </span>
  );
}

/** A plain left click, which the app handles; a modifier or middle click is the browser's. */
export function plainClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** `href` (an app route) in a new browser tab. */
export function openInBrowserTab(href: string): void {
  window.open(`${import.meta.env.BASE_URL.replace(/\/$/, '')}${href}`, '_blank', 'noopener');
}

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

const rowKey = (r: InboxRow) => itemKey({ kind: 'chat', projectId: r.projectId, workstream: r.workstream });
/** A tab's place in the agent tree: its session's row key, none for a file or explorer tab. */
const chatTreeKey = (i: OpenItem) => (i.kind === 'chat' ? inboxRowKey(i.projectId, i.workstream) : null);

type Drop = { group: string; index: number };
const NO_SPACE = '\u0000none';
/** A state's group's id (the view options' Group by Status), apart from every space's. */
const STATUS_GROUP = '\u0000state:';

/** The groups and their tabs. */
export function OpenItemsGroups() {
  const { items, rows, live, setupOf, spaces, activeTab, titlesShown, links, unseen } = useSimpleData();
  const [foldedAgents, setFoldedAgents] = useState(() => readFoldedAgents(typeof localStorage === 'undefined' ? null : localStorage));
  const boxOf = useBoxOf();
  // A session's tab dragged into a composer puts a reference to it in the message (chat/sessionRef.ts).
  const refsOn = useFlag(FLAGS.chatSessionReferences, false);
  // The chrome refresh: a state mark and the age on each agent, the title alone, and a count per space.
  const { refresh } = useChatChrome();
  const navigate = useNavigate();
  const byKey = useMemo(() => new Map(rows.map(r => [rowKey(r), r])), [rows]);
  // A review session is in the sidebar's Reviews section (ReviewsSidebar.tsx), not its space.
  const { sessionKeys: reviewSessions } = useReviewsData();
  const tabs = useMemo(
    () => (reviewSessions.size ? items.state.items.filter(i => i.kind !== 'chat' || !reviewSessions.has(inboxRowKey(i.projectId, i.workstream))) : items.state.items),
    [items.state.items, reviewSessions],
  );
  const groups = useMemo(
    // Nothing until the spaces load: every tab would show under No space first.
    () => {
      if (!spaces.loaded) return [];
      const spaceOf = (c: Parameters<typeof itemKey>[0]) => {
        const row = byKey.get(itemKey(c));
        return row ? chatHomeSpace(row, spaces.spaces, spaces.index) : undefined;
      };
      return groupOpenItems(tabs, spaces.spaces.map(s => s.name), spaceOf);
    },
    [tabs, spaces.loaded, spaces.spaces, spaces.index, byKey],
  );
  // Under the refresh, the view options (chat/sidebarView.ts): Compact or Standard rows,
  // by space (filtered) or by state; off, the spaces' groups as they are.
  const view = useSidebarView();
  const standard = refresh && view.density === 'standard';
  const shownGroups: ViewGroup[] = refresh
    ? viewGroups(groups, view, i => {
      if (i.kind !== 'chat') return null;
      const r = byKey.get(itemKey(i));
      return r ? chatRowState(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId), unseen.has(r.key)).kind : null;
    }, activeTab)
    : groups.map(g => ({ space: g.space, status: null, items: g.items, total: g.items.length }));
  /**
   * A group's whole order, for Close other tabs and Close tabs below: a space's
   * every tab, the filters notwithstanding, or a state's group's every tab, past
   * Show more included.
   */
  const wholeOrder = (groupId: string): string[] | undefined => (groupId.startsWith(STATUS_GROUP)
    ? shownGroups.find(g => g.status && `${STATUS_GROUP}${g.status.key}` === groupId)?.items
    : groups.find(g => (g.space ?? NO_SPACE) === groupId)?.items)?.map(i => i.id);
  const windowFor = useIncrementalWindows();
  const ctx = useContextMenu();
  const longPress = useLongPress();
  /** A New tab on `space`'s explorer (NO_SPACE_EXPLORER: the agents in no space), on top, shown with its Files open. */
  const openNewTab = (space: string) => {
    const ref = { kind: 'explorer' as const, space };
    const id = newTabId();
    startTransition(() => {
      items.open(ref, id);
      navigate(itemHref(ref, id), { state: { openTools: true } });
    });
  };
  const coarse = useCoarsePointer();
  // Each tab's X is LaunchPad's cancel icon, which needs the sprite with the chrome refresh off too.
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  // Sharing a space: Share space is the space's own section of its head's ⋮
  // menu (chat/spaceMenu.ts, from the space-sidebar work), the menu's item 3;
  // shareActions(space) is that section. It opens SpaceShareDialog.
  const { user } = useAuth();
  const [sharing, setSharing] = useState<string | null>(null);
  const sharedSpace = sharing ? spaces.spaces.find(s => s.name === sharing) : undefined;
  const shareActions = (space: string | null) => spaceShareActions(space, setSharing);
  const activeItem = items.state.items.find(i => i.id === activeTab);
  const activeChatKey = activeItem ? chatTreeKey(activeItem) : null;
  const unfoldedRuns = useUnfoldedRuns();
  // Every run of each automation, by project id, from the session list the explorers read (so it grows as runs
  // start): an automation's row lists its runs, not only the ones open as tabs. A run's own asks and spawns aren't runs.
  const started = useMemo(() => new Set(links.map(l => inboxRowKey(l.projectId, l.workstream))), [links]);
  const runsOf = useMemo(() => {
    const m = new Map<string, InboxRow[]>();
    for (const r of rows) {
      if (r.kind !== 'automation' || r.workstream === 'main' || started.has(inboxRowKey(r.projectId, r.workstream))) continue;
      m.set(r.projectId, [...(m.get(r.projectId) ?? []), r]);
    }
    return m;
  }, [rows, started]);
  const automations = useAutomationIndex(rows.some(r => r.kind === 'automation'));
  // With the simple UI's automation pages, an unfolded automation always ends in a link to its page there,
  // and a space's head menu has New automation.
  const automationPages = useAutomationsEnabled();
  const [collapsed, setCollapsed] = useState(() => readCollapsedSpaces(storage()));
  const toggle = (key: string) => setCollapsed(c => toggleCollapsedSpace(c, key, storage()));
  // The boxes the index has settled for, so Agents knows which are in no space during a reload (noSpaceAgents.boxesKnown).
  useEffect(() => { noteSettledBoxes(rows.map(r => r.instanceId), spaces.current); }, [rows, spaces.current]);
  // Tabs from before openedIn, on chats in no space of their own, go to the one space whose
  // explorer lists them (its box reaches it), once the index is current for every box.
  const { place } = items;
  useEffect(() => {
    if (!spaces.enabled || !spaces.current || spaces.spaces.length === 0) return;
    const known = new Set(spaces.spaces.map(s => s.name));
    place(i => {
      const row = byKey.get(itemKey(i));
      if (!row) return undefined;
      const listedIn = (row.instanceId ? spaces.index.get(row.instanceId) ?? [] : []).filter(s => known.has(s));
      return { home: chatHomeSpace(row, spaces.spaces, spaces.index), listedIn };
    });
  }, [items.state.items, byKey, spaces.enabled, spaces.current, spaces.spaces, spaces.index, place]);

  const list = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<{ group: string; id: string; label: string } | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  // Moving a row re-inserts its node, and closing one removes it, which drops focus; put it on the row
  // with this focus key (a tab's `tab:<id>`, an automation's row's `runs:<project>`, a run link's `run:<key>`) after the render.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    [...(list.current?.querySelectorAll<HTMLElement>('[data-focus-key]') ?? [])].find(a => a.dataset.focusKey === key)?.focus();
  }, [items.state.items]);
  /** The focus key of the row after `el`'s row in its group on screen, else the one before it: where an X's close leaves focus. */
  const neighbourKey = (el: Element): string | null => {
    const own = el.closest('li')?.querySelector<HTMLElement>('[data-focus-key]');
    const rows = [...(el.closest('.chat-group-list')?.querySelectorAll<HTMLElement>('[data-focus-key]') ?? [])];
    const at = own ? rows.indexOf(own) : -1;
    return at < 0 ? null : (rows[at + 1] ?? rows[at - 1])?.dataset.focusKey ?? null;
  };
  // The open tab in view, in its own space's group: a chat opened from search, a link, Recents or
  // another space's explorer lands there, maybe far down the list.
  const placed = groups.find(g => g.items.some(i => i.id === activeTab))?.space;
  useEffect(() => {
    if (!activeTab) return;
    const row = [...(list.current?.querySelectorAll<HTMLElement>('a[data-tab]') ?? [])].find(a => a.dataset.tab === activeTab);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [activeTab, placed]);

  const nameOf = (space: string | null) => space ?? 'No space';

  /**
   * Closes `ids`, from `groupName`. When that closes the open tab, it goes to
   * `stay` (the tab acted on, when it stays open), else the first tab left in
   * the open tab's space, else the first left anywhere, else Home. Returns the tab it goes to, if it goes.
   */
  function closeTabs(ids: readonly string[], groupName: string, stay?: OpenItem): OpenItem | undefined {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    if (ids.length > 1) setAnnounce(`Closed ${ids.length} tabs in ${groupName}`);
    if (!activeTab || !gone.has(activeTab)) { items.dismiss(ids); return; }
    const left = (list: readonly OpenItem[]) => list.find(i => !gone.has(i.id));
    const own = groups.find(g => g.items.some(i => i.id === activeTab));
    const next = (stay && !gone.has(stay.id) ? stay : undefined) ?? left(own?.items ?? []) ?? left(groups.flatMap(g => g.items));
    startTransition(() => {
      items.dismiss(ids);
      navigate(next ? itemHref(next, next.id) : '/chat');
    });
    return next;
  }

  // Each group's whole order, its window, and what is on screen (only the open tab
  // when the space is folded), from this render, for the moves below.
  // `all` and `onScreen` count an automation's row as one place (runSlot); `expand` is the tabs a place stands for.
  const shownOf = new Map<string, { all: string[]; expand: (place: string) => string[]; win: IncrementalList<Entry[]>; onScreen: string[]; more: boolean; folded: boolean }>();

  /**
   * Moves tab `id` to place `to` among `shown`, the group's tabs on screen:
   * a move is counted on screen, so one step passes the neighbour you see,
   * and no tab goes into the hidden range, or comes out of it, by a move
   * (incrementalList.moveShown).
   */
  function move(groupId: string, groupName: string, shown: string[], id: string, to: number, label: string) {
    const g = shownOf.get(groupId);
    if (!g) return;
    const from = shown.indexOf(id);
    if (to < 0 || to >= shown.length) {
      setAnnounce(to < 0 ? `${label} is already first in ${groupName}. Tabs stay in their space.`
        : g.more ? `${label} is the last one shown in ${groupName}. Show more to move it further.`
        : `${label} is already last in ${groupName}. Tabs stay in their space.`);
      return;
    }
    if (to === from) return;
    items.arrange(g.all.flatMap(g.expand), moveShown(g.all, shown, id, to).flatMap(g.expand));
    // Folded, the window isn't on screen: leave it as it is.
    if (!g.folded) g.win.showAtLeast(g.win.visible.length);
    setAnnounce(`${label} moved to position ${to + 1} of ${shown.length} in ${groupName}`);
  }

  const end = () => { setDrag(null); setDrop(null); setDenied(null); };
  // While a row is dragged nothing outside its own space takes it: the browser
  // shows its no-drop cursor, and a space it is over says why.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const refuse = (e: DragEvent) => {
      e.preventDefault();
      if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    window.addEventListener('dragend', end);
    return () => { window.removeEventListener('dragover', refuse); window.removeEventListener('drop', refuse); window.removeEventListener('dragend', end); };
  }, [dragging]);

  // A group's tabs as the list shows them: an ask or spawned agent under the session that started it
  // (chat/agentTree.ts). Drops, moves and row indexes all count in this order; a child always comes
  // back under its parent.
  const treeOf = (g: { items: readonly OpenItem[] }) => nestInOrder(g.items, chatTreeKey, links, foldedAgents, activeChatKey);

  const groupProps = (groupId: string, groupName: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      if (groupId !== drag.group) {
        e.dataTransfer.dropEffect = 'none';
        if (denied !== groupId) {
          setDenied(groupId);
          setDrop(null);
          setAnnounce(`Can't move ${drag.label} to ${groupName}. Tabs stay in their space.`);
        }
        return;
      }
      e.dataTransfer.dropEffect = 'move';
      if (denied) setDenied(null);
      if ((e.target as HTMLElement).closest('.chat-group-head') && (drop?.group !== groupId || drop.index !== 0)) setDrop({ group: groupId, index: 0 });
    },
    onDrop: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const g = groups.find(x => (x.space ?? NO_SPACE) === drag.group);
      const shown = shownOf.get(drag.group)?.onScreen;
      if (g && shown && groupId === drag.group && drop?.group === drag.group) {
        const from = shown.indexOf(drag.id);
        move(drag.group, nameOf(g.space), shown, drag.id, drop.index > from ? drop.index - 1 : drop.index, drag.label);
      }
      end();
    },
  });

  // `run`: a tab inside an automation's row (runsRow), out of the drag order; `name`, for the run itself, its time.
  function row(item: OpenItem, index: number, groupId: string, groupName: string, ids: string[], node?: TreeRow<OpenItem>, run?: { name?: string }) {
    const isActive = item.id === activeTab;
    // A state's group (view options) mixes spaces, so its tabs keep their places: no drag, no Alt+Up/Down.
    const movable = !groupId.startsWith(STATUS_GROUP) && !run;
    const depth = node?.depth ?? 0;
    const kids = node?.childCount ?? 0;
    const treeKey = node?.key ?? null;
    // Folded is what is shown: a parent folded in storage stays open while its child is the open tab (agentTree.nestInOrder).
    const folded = (node?.hidden.length ?? 0) > 0;
    // Under the refresh, a folded parent counts what it hides beside its name; its caret may be hidden (chrome.css).
    const foldedCount = refresh && folded ? node!.hidden.length : null;
    let icon: React.ReactNode;
    let name: React.ReactNode;
    let label: string;
    let tip: string;
    let status: string | null = null;
    let band: string | undefined;
    let state: RowState | null = null;
    let age: string | null = null;
    let where: string | null = null;
    // The session a drag of this tab references, with the flag on.
    let refRow: InboxRow | null = null;
    let desktopHref: string | null = null;
    if (item.kind === 'chat') {
      const r = byKey.get(itemKey(item))!;
      if (refsOn) refRow = r;
      desktopHref = desktopSessionHref(r);
      const line = sidebarLine(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId));
      state = refresh ? chatRowState(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId), unseen.has(r.key)) : null;
      const since = refresh ? stateSince(r) : null;
      age = since ? fmtAge(Date.now() - new Date(since).getTime()) : null;
      icon = state ? <StatusMark kind={state.kind} /> : <AgentIcon status={line.glyph} />;
      // One line: Claude's title for the session with the project after it, or the project as before.
      // Under the refresh, the title alone; the project is in its tooltip.
      const named = chatRowName(r, titlesShown);
      // An ask leads with its title (Claude's title for its session after it); otherwise as named.
      name = run?.name ? run.name : named.title
        ? <>{named.title}{named.where && !refresh && <span className="chat-row-ws"> · {named.where}</span>}</>
        : <>{r.projectName}{r.workstream !== 'main' && <span className="chat-row-ws"> · {workstreamLabel(r)}</span>}</>;
      label = named.title ? [named.title, named.where].filter(Boolean).join(' · ') : agentLabel(r);
      where = named.title ? named.where || null : null;
      // Under the refresh, the state's words, which say when it is unseen.
      status = state?.text ?? line.state;
      const box = boxOf(r);
      tip = [label, box && `on ${box}`, workstreamTip(r), status, line.message].filter(Boolean).join('\n');
      band = r.band;
    } else if (item.kind === 'file') {
      // Under the refresh, LaunchPad's icons at their drawn 20px, in the state mark's column.
      icon = <span className="chat-item-icon" aria-hidden="true">{refresh ? <Icon name="file" size="medium" /> : <FileIcon />}</span>;
      name = label = baseName(item.path);
      tip = `${item.space}:${item.path}`;
    } else {
      icon = <span className="chat-item-icon" aria-hidden="true">{refresh ? <Icon name="folders" size="medium" /> : <FolderIcon />}</span>;
      name = 'New tab';
      label = item.space === NO_SPACE_EXPLORER ? 'New tab: agents in no space' : `New tab in ${item.space}`;
      tip = item.space === NO_SPACE_EXPLORER ? 'Recent agents in no space, with all of them in Tools' : `${item.space}'s recent files and agents`;
    }
    const dropHere = drop && drop.group === groupId && drag && drag.id !== item.id ? drop.index : null;
    // "Other" and "below" are in the space's whole order, from the group itself rather than this
    // row's `ids`, so they keep meaning that wherever the row's place is counted (a list that
    // shows part of itself counts it on screen) and include tabs hidden past a window.
    const all = wholeOrder(groupId) ?? ids;
    const others = all.filter(id => id !== item.id);
    const below = all.slice(all.indexOf(item.id) + 1);
    const close = () => closeTabs([item.id], groupName);
    const menu = (e: MenuTrigger) => ctx.open(e, label, [
      { label: 'Duplicate tab', onSelect: () => startTransition(() => navigate(itemHref(item, items.duplicate(item.id)))) },
      { label: 'Open in new browser tab', onSelect: () => openInBrowserTab(itemHref(item)) },
      ...(desktopHref ? [{ label: 'Open in termag desktop', onSelect: () => openDesktopLink(desktopHref) }] : []),
      { label: 'Close tab', onSelect: close },
      { label: 'Close other tabs', disabled: others.length === 0, onSelect: () => closeTabs(others, groupName, item) },
      { label: 'Close tabs below', disabled: below.length === 0, onSelect: () => closeTabs(below, groupName, item) },
    ], item.id);
    return (
      <li key={item.id} style={depth ? { '--chat-depth': depth } as React.CSSProperties : undefined}
        className={`chat-item-li chat-tree-li chat-item-closable${drag?.id === item.id ? ' dragging' : ''}${dropHere === index ? ' drop-before' : ''}${dropHere === index + 1 && index === ids.length - 1 ? ' drop-after' : ''}`}
        draggable={!coarse && (movable || refRow !== null)}
        onContextMenu={menu}
        onDragStart={e => {
          // A session's tab also goes into a composer as a reference, a copy; a tab that can't move only does that.
          if (refRow) putSessionRef(e, refRow, boxOf(refRow), titlesShown);
          e.dataTransfer.setData('text/plain', label);
          if (!movable) { e.dataTransfer.effectAllowed = 'copy'; return; }
          e.dataTransfer.effectAllowed = refRow ? 'copyMove' : 'move';
          setDrag({ group: groupId, id: item.id, label });
        }}
        onDragOver={e => {
          if (!drag || drag.group !== groupId || !movable) return;
          e.preventDefault();
          const box = e.currentTarget.getBoundingClientRect();
          const at = e.clientY < box.top + box.height / 2 ? index : index + 1;
          if (drop?.group !== groupId || drop.index !== at) setDrop({ group: groupId, index: at });
        }}
        onDragEnd={end}>
        {kids > 0 && treeKey !== null && (
          <button type="button" className="chat-twisty" aria-expanded={!folded}
            aria-label={`${folded ? 'Show' : 'Hide'} the ${kids} ${kids === 1 ? 'agent' : 'agents'} ${label} started`}
            data-tip={folded ? `${kids} folded: show them` : `Fold the ${kids} started by this session`}
            onClick={() => setFoldedAgents(f => (f.has(treeKey) === !folded ? f : toggleFoldedAgent(f, treeKey, typeof localStorage === 'undefined' ? null : localStorage)))}>
            <span className="chat-group-caret" aria-hidden="true" />
          </button>
        )}
        {/* The href has no tab, so a modifier click opens the thing itself in a new browser tab. */}
        <Link to={itemHref(item)} draggable={false} data-tab={item.id} data-focus-key={`tab:${item.id}`} className={`chat-item${isActive ? ' active' : ''}`}
          aria-current={isActive ? 'page' : undefined} aria-describedby="chat-items-move-hint"
          data-kind={item.kind} data-band={band} data-state={state?.kind} data-density={standard ? 'standard' : undefined} data-tip={tip}
          onClick={e => {
            if (!plainClick(e)) return;
            e.preventDefault();
            navigate(itemHref(item, item.id));
          }}
          onKeyDown={e => {
            if (isMenuKey(e)) { menu(e); return; }
            if (!movable || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            e.preventDefault();
            refocus.current = `tab:${item.id}`;
            move(groupId, groupName, ids, item.id, index + (e.key === 'ArrowUp' ? -1 : 1), label);
          }}>
          {icon}
          {standard ? (
            <StandardRowBody name={name} age={age} where={item.kind === 'file' ? `${item.space}:${item.path}` : where} state={state} folded={foldedCount} />
          ) : (
            <>
              <span className="chat-item-name">{name}</span>
              {foldedCount !== null && <FoldedCount n={foldedCount} />}
              {age && <span className="chat-item-age" aria-hidden="true">{age}</span>}
            </>
          )}
          {status && <span className="chat-sr">, {status}</span>}
        </Link>
        <MenuButton label={label} open={menu} expanded={ctx.openKey === item.id} className="chat-item-menu" />
        {/* Close tab, as the menu's; focus goes to the tab that takes its place, so a keyboard stays in the list. */}
        <IconButton icon="cancel" size="small" variant="minimal" className={`chat-item-close ${LP_THEME}`} aria-label={`Close ${label}`}
          data-tip="Close tab" onPress={e => {
            // From the rows on screen, so an automation's row and its runs count as neighbours too.
            // With none on screen (a folded space shows only the open tab), the tab the close goes to takes its place.
            const key = neighbourKey(e.target);
            const next = close();
            refocus.current = key ?? (next ? `tab:${next.id}` : null);
          }} />
      </li>
    );
  }

  /** A run of an automation's row with no tab: a link that opens it in one (the route does), and a ⋮ to open it elsewhere. */
  function runLink(r: InboxRow, name: string) {
    const href = itemHref({ kind: 'chat', projectId: r.projectId, workstream: r.workstream });
    const line = sidebarLine(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId));
    const state = refresh ? chatRowState(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId), unseen.has(r.key)) : null;
    const since = refresh ? stateSince(r) : null;
    const age = since ? fmtAge(Date.now() - new Date(since).getTime()) : null;
    const label = `${r.projectName} · ${name}`;
    const status = state?.text ?? line.state;
    const menu = (e: MenuTrigger) => ctx.open(e, label, [
      { label: 'Open', onSelect: () => startTransition(() => navigate(href)) },
      { label: 'Open in new browser tab', onSelect: () => openInBrowserTab(href) },
    ], `run:${r.key}`);
    return (
      <li key={`run:${r.key}`} className="chat-item-li chat-tree-li" style={{ '--chat-depth': 1 } as React.CSSProperties} onContextMenu={menu}>
        <Link to={href} className="chat-item chat-run-link" data-focus-key={`run:${r.key}`} data-kind="chat" data-band={r.band} data-state={state?.kind}
          data-density={standard ? 'standard' : undefined} data-tip={[label, status, line.message].filter(Boolean).join('\n')}
          onKeyDown={e => { if (isMenuKey(e)) menu(e); }}>
          {state ? <StatusMark kind={state.kind} /> : <AgentIcon status={line.glyph} />}
          {standard ? <StandardRowBody name={name} age={age} where={null} state={state} /> : (
            <>
              <span className="chat-item-name">{name}</span>
              {age && <span className="chat-item-age" aria-hidden="true">{age}</span>}
            </>
          )}
          {status && <span className="chat-sr">, {status}</span>}
        </Link>
        <MenuButton label={label} open={menu} expanded={ctx.openKey === `run:${r.key}`} className="chat-item-menu" />
      </li>
    );
  }

  /**
   * The automation's row, where its run tabs are: its latest run's status (working while any works), schedule and
   * run count; unfolded, its newest runs, each with the tabs of what it started under it, then Show all. It counts
   * and lists every run (runsOf), the ones with no tab as links, so a run that starts shows up as the explorer's does.
   */
  function runsRow(g: RunGroup<RunTree>, groupId: string, groupName: string, ids: string[]) {
    const auto = automations.get(g.projectId);
    const runRow = (n: TreeRow<OpenItem>) => byKey.get(itemKey(n.item))!;
    const isOpen = (t: RunTree) => t.some(n => n.item.id === activeTab);
    // A tab whose root is an ask or spawn (its run isn't open as a tab) isn't a run: it goes under its run's entry,
    // so the count is the explorer's. One whose run isn't listed at all stays in view, after the runs, uncounted.
    const isRun = (r: { projectId: string; workstream: string }) => !started.has(inboxRowKey(r.projectId, r.workstream));
    const runOfTree = (r: InboxRow): string | null => {
      let at: { projectId: string; workstream: string } = r;
      for (let hops = 0; !isRun(at); hops++) {
        const l = links.find(l => l.projectId === at.projectId && l.workstream === at.workstream);
        if (!l || l.parentProjectId !== g.projectId || hops > links.length) return null;
        at = { projectId: l.parentProjectId, workstream: l.parentWorkstream };
      }
      return at.workstream;
    };
    const runTrees = g.runs.filter(t => isRun(runRow(t[0])));
    const tabbed = new Set(runTrees.map(t => itemKey(t[0].item)));
    const runs: RunEntry[] = newestRunsFirst([
      ...runTrees.map(tree => ({ row: runRow(tree[0]), tree })),
      ...(runsOf.get(g.projectId) ?? []).filter(r => !tabbed.has(rowKey(r))).map(row => ({ row })),
    ], e => e.row.workstream);
    const strays: RunEntry[] = [];
    for (const tree of g.runs.filter(t => !runTrees.includes(t))) {
      const ws = runOfTree(runRow(tree[0]));
      const e = ws === null ? undefined : runs.find(e => e.row.workstream === ws);
      if (e) e.under = [...(e.under ?? []), tree];
      else strays.push({ row: runRow(tree[0]), tree });
    }
    const entryOpen = (e: RunEntry) => (!!e.tree && isOpen(e.tree)) || !!e.under?.some(isOpen);
    const openRun = g.runs.find(isOpen);
    const open = runsUnfolded(g.projectId, unfoldedRuns, openRun ? runRow(openRun[0]) : null);
    const glyphOf = (r: InboxRow) => sidebarLine(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId)).glyph;
    // The run the row's status is: one that works, else the latest.
    const lead = (runs.find(e => glyphOf(e.row) === 'working') ?? runs[0] ?? strays[0]).row;
    const state = refresh ? chatRowState(lead, live.get(chatLiveKey(lead.projectId, lead.workstream)), setupOf.get(lead.projectId)) : null;
    const count = runs.length;
    const countText = `${count} ${count === 1 ? 'run' : 'runs'}`;
    const subtitle = auto ? runsSubtitle(auto) : null;
    const shownCount = open ? shownRuns(runs, entryOpen).length : 0;
    const shown = open ? [...shownRuns(runs, entryOpen), ...strays] : [];
    const deeper = (t: RunTree, by: number) => t.map(n => ({ ...n, depth: n.depth + by }));
    const treeRows = (t: RunTree, name?: string) => t.map((n, i) => row(n.item, -1, groupId, groupName, ids, n, i === 0 && name ? { name } : {}));
    return (
      <React.Fragment key={`runs:${g.projectId}`}>
        <li className="chat-item-li chat-tree-li">
          <button type="button" className="chat-item chat-runs-item" data-focus-key={`runs:${g.projectId}`} aria-expanded={open} data-state={state?.kind}
            data-tip={[g.projectName, auto ? `automation: ${subtitle}` : 'automation', countText].join('\n')}
            onClick={() => setRunsUnfolded(g.projectId, !open)}>
            {state ? <StatusMark kind={state.kind} /> : <AgentIcon status={glyphOf(lead)} />}
            <span className="chat-item-name">{g.projectName}{subtitle && <span className="chat-row-ws"> · {subtitle}</span>}</span>
            <span className="chat-group-count" aria-label={countText}>{count}</span>
            <span className="chat-runs-caret chat-group-caret" aria-hidden="true" />
          </button>
        </li>
        {shown.flatMap(e => {
          const name = runLabel(e.row.workstream, auto?.timezone);
          const head = e.tree ? treeRows(deeper(e.tree, 1), strays.includes(e) ? undefined : name) : [runLink(e.row, name)];
          return [...head, ...(e.under ?? []).flatMap(t => treeRows(deeper(t, 2)))];
        })}
        {(count > shownCount || automationPages) && open && (
          <li className="chat-item-li chat-tree-li" style={{ '--chat-depth': 1 } as React.CSSProperties}>
            <Link to={automationPages ? automationPageHref(g.projectId) : automationHref(g.projectId)} className="chat-item chat-runs-all">
              {count > shownCount ? `Show all ${count} runs` : 'Open automation'}
            </Link>
          </li>
        )}
      </React.Fragment>
    );
  }

  return (
    <>
      {sharedSpace && (
        <SpaceShareDialog space={sharedSpace} userId={user?.id} onClose={() => setSharing(null)} onChanged={() => spaces.reload?.()}
          onLeft={() => {
            const left = groups.find(g => g.space === sharedSpace.name);
            setSharing(null);
            spaces.reload?.();
            if (left?.items.some(i => i.id === activeTab)) navigate('/chat');
          }} />
      )}
      <ul ref={list} className="chat-list chat-items">
        {!spaces.loaded && <li className="chat-list-empty">Loading…</li>}
        {spaces.loaded && groups.length === 0 && <li className="chat-list-empty">No sessions yet.</li>}
        {shownGroups.map(g => {
          const id = g.status ? `${STATUS_GROUP}${g.status.key}` : g.space ?? NO_SPACE;
          const name = g.status ? g.status.name : nameOf(g.space);
          const nested = treeOf(g);
          const ids = nested.map(n => n.item.id);
          const refused = denied === id && drag !== null;
          const key = g.status ? id : groupKey(g.space);
          const folded = collapsed.has(key);
          // A folded space still shows the open tab, so the sidebar never loses what is on screen.
          // The window counts places: a top-level tab with everything nested under it, so a parent and
          // its children show and hide together (incrementalList.ts), and the open tab's place always shows.
          // An automation's run tabs, with what each run started, are one place: its row (runsRow).
          const entries: Entry[] = groupRuns(subtrees(nested, n => n.depth), t => (t[0].item.kind === 'chat' ? byKey.get(itemKey(t[0].item)) : null))
            .flatMap((x): Entry[] => (x.group ? [{ runs: x.group }] : x.item.map(n => ({ n }))));
          // The drag order counts each automation's row as one place, standing for its tabs in their stored order.
          const slotOf = new Map(entries.flatMap(e => (e.runs ? e.runs.runs.flat().map(n => [n.item.id, runSlot(e.runs.projectId)] as const) : [])));
          const allPlaces = [...new Set(ids.map(i => slotOf.get(i) ?? i))];
          const expand = (place: string) => (place.startsWith('runs:') ? ids.filter(i => slotOf.get(i) === place) : [place]);
          const places: Entry[][] = [];
          for (const e of entries) {
            if (e.runs || e.n.depth === 0 || !places.length) places.push([e]);
            else places[places.length - 1].push(e);
          }
          const win = windowFor(id, places, place => place.some(e => (e.n ? e.n.item.id === activeTab : e.runs.runs.some(t => t.some(n => n.item.id === activeTab)))));
          const onScreenRows: Entry[] = folded ? nested.filter(n => n.item.id === activeTab).map(n => ({ n })) : win.visible.flat();
          // Rows know their place on screen, in tree order, so drags and Alt+Up/Down count what is shown:
          // the window when the space is open, only the open tab when it is folded.
          const shownIds = onScreenRows.map(e => (e.n ? e.n.item.id : runSlot(e.runs.projectId)));
          shownOf.set(id, { all: allPlaces, expand, win, onScreen: shownIds, more: !folded && win.hidden > 0, folded });
          const needYou = g.items.filter(i => i.kind === 'chat' && byKey.get(itemKey(i))?.band === 'attention').length;
          const listId = g.status ? `chat-items-state-${g.status.key}` : g.space ? `chat-items-s-${g.space}` : 'chat-items-none';
          // The head's one menu, from its ⋮ or from the head itself, always hung from the ⋮.
          // Only for the head: the menu is portaled, but its events still bubble here.
          const space = g.space;
          const groupMenu = (e: MenuTrigger) => {
            // A state's group has no menu: New agent, New tab and Close all are a space's.
            if (g.status || !(e.currentTarget as Node).contains(e.target as Node)) return;
            const actions = spaceHeadMenuActions({
              create: spaceCreateActions(space, {
                canStart: space === null || canStartChatIn(space, spaces.spaces),
                newAgent: () => navigate(space ? `/chat/new?space=${encodeURIComponent(space)}` : '/chat/new'),
                newTab: () => openNewTab(space ?? NO_SPACE_EXPLORER),
                newAutomation: automationPages
                  ? () => navigate(space ? `/chat/new?schedule=1&space=${encodeURIComponent(space)}` : '/chat/new?schedule=1')
                  : undefined,
              }),
              space: shareActions(space),
              // Every tab in the space, the view's filters notwithstanding.
              tabs: spaceHeaderContextActions(groups.find(x => x.space === g.space)?.items ?? g.items, gone => closeTabs(gone, name)),
            });
            const dots = (e.currentTarget as HTMLElement).closest('.chat-group-head')?.querySelector<HTMLElement>('.chat-group-menu');
            ctx.open(e, name, actions, `group:${id}`, dots);
          };
          const press = longPress(groupMenu);
          return (
            <li key={id} className={`chat-group${refused ? ' drop-denied' : ''}`} data-group={id} data-space={g.space || g.status ? undefined : 'none'}
              data-state-group={g.status?.key} data-folded={folded || undefined} style={g.status ? undefined : spaceColorStyle(g.space, spaces.colorOf)} {...(g.status ? {} : groupProps(id, name))}>
              {/* The fold toggle is the head's focus stop; the menu keys on it bubble to the head's menu. */}
              <div className="chat-group-head" onContextMenu={groupMenu}
                onKeyDown={e => { if (isMenuKey(e)) groupMenu(e); }}
                {...press} onPointerDown={e => { if (e.currentTarget.contains(e.target as Node)) press.onPointerDown(e); }}>
                <button type="button" className="chat-group-toggle" aria-expanded={!folded} aria-controls={listId}
                  aria-describedby="chat-space-menu-hint"
                  data-tip={folded ? `Show ${name}'s tabs` : `Fold ${name}`}
                  onClick={() => toggle(key)}
                  onKeyDown={e => {
                    if ((e.key === 'ArrowLeft' && !folded) || (e.key === 'ArrowRight' && folded)) { e.preventDefault(); toggle(key); }
                  }}>
                  <span className="chat-group-caret" aria-hidden="true" />
                  {!g.status && <SpaceSwatch space={g.space} />}
                  <span className="chat-group-name">{name}</span>
                  {refresh && <span className="chat-group-count" aria-hidden="true">{g.items.length}</span>}
                  {folded && needYou > 0 && <span className="chat-group-attn">{needYou} need{needYou === 1 ? 's' : ''} you</span>}
                </button>
                {!g.status && <MenuButton label={name} open={groupMenu} expanded={ctx.openKey === `group:${id}`} className="chat-group-menu"
                  tip={`Options for ${name}`} />}
              </div>
              <ul className="chat-group-list" id={listId} aria-label={name} hidden={folded && onScreenRows.length === 0}>
                {!folded && g.total === 0 && <li className="chat-group-empty">Nothing open. Use ⋮ for a new agent or tab.</li>}
                {onScreenRows.map(e => (e.n ? row(e.n.item, shownIds.indexOf(e.n.item.id), id, name, shownIds, e.n) : runsRow(e.runs, id, name, shownIds)))}
                {!folded && <ShowMoreRow list={win} name={name} />}
              </ul>
              {refused && <div className="chat-drop-note" aria-hidden="true">Tabs stay in their space</div>}
            </li>
          );
        })}
      </ul>
      {ctx.menu}
      <span id="chat-space-menu-hint" className="chat-sr">Shift+F10 opens the space's menu, the same as its ⋮.</span>
      <span id="chat-items-move-hint" className="chat-sr">Alt+Up or Alt+Down moves it within its space. Shift+F10 opens its menu.</span>
      <span className="chat-sr" aria-live="polite">{announce}</span>
    </>
  );
}
