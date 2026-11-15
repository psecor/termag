// The sidebar's Projects view (View options → Show: Projects):
// every session the person can
// see, from the project list rather than this browser's tabs, wherever it
// started (the chat, Lab, the CLI, the desktop app, an ask), live as the list
// reloads on its push. Needs you is pinned on top; then one group per
// repository set (chat/sidebarGroups.ts projectGroups), Shared with me,
// Automations (folded until unfolded) and Files. Each group's head folds it,
// kept per browser; the session on screen shows whatever is folded or
// filtered. An ask or a spawn nests under the session that started it
// (chat/agentTree.ts). A row is a link to the session's chat, so opening it
// also opens (or shows) its tab (useOpenOnRoute), and Tabs agrees on what is
// open. The rows are the tabs' own (OpenItems.tsx, StandardRow.tsx).
// Under user-projects-enabled
// the groups are the person's projects, by name, once GET /api/user-projects
// answers (repository sets until then, and for a checkout with none): a head
// shows the project's open PRs, its count opening the latest session with
// one, and a project with no session yet says so, with New session here.
// The header's project name reveals its group here (chat/revealProject.ts):
// unfolded, scrolled into view, its head focused. A project's head has its
// menu (ProjectMenu.tsx: New session here, Rename, Archive), from its ⋯ or a
// right click.
// Under the same flag each session is a card (SessionCard.tsx):
// the project's icon with the model's mark, the
// title, and a chip with the time in its status; without it the rows are
// the tabs' own, as before. Its heads (cardHead) are the group's icon, its
// name and its count on the name's baseline, with +, the project menu and the
// fold chevron floating over the head's right end on hover; an empty
// project's head starts a session in it. And the layout (chat/sidebarLayout.ts,
// README §3): Pinned (the server's pins, chat/sessionPins.ts) above Needs you,
// then the groups; what you haven't touched in a while goes to one shared
// Older instead of a fold per project, and Shared with me, Automations, Older
// and Archived are one sticky row of buttons at the bottom, each opening its
// section at the end of the list. Group by orders that one list: by Project,
// by Status (Working, Idle and Not running, their heads in their colours), or
// by Space (each with its menu: New agent, New tab, Share, Slack), with Pinned,
// Needs you and the bottom row as they are. There is no Tabs view under the flag.
// Sort (a View option, chat/sidebarSort.ts) is Created, the order above, or
// Recent activity: each session by its own activity, and each group by its most
// recently active session, Pinned and Needs you as they are. Its order holds
// still while the list is in use, and its moves animate (useSteadyOrder.ts);
// the open session keeps the place it had when it was opened, so working in it
// never moves it.
import React, { startTransition, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Alert, AlertText, Button, ButtonGroup, EmptyState, Heading, IconButton, Link as LpLink, Text, ToggleButton, Tooltip, TooltipTrigger,
} from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { useProjects } from '../../contexts/ProjectContext';
import { rowKey as inboxRowKey, stateSince, type InboxRow } from '../../mobile/inbox';
import { nestInOrder, readFoldedAgents, toggleFoldedAgent, type TreeRow } from '../../chat/agentTree';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { workstreamTip } from '../../chat/explorerAgents';
import { itemForRoute, itemHref, newTabId, NO_SPACE_EXPLORER, type OpenItem } from '../../chat/openItems';
import { chatRowState, liveUnlessWaiting, type RowState } from '../../chat/rowState';
import { useSessionPins } from '../../chat/sessionPins';
import { reviewCallKind } from '../../chat/reviews';
import { useReviewsData, useYourCallReviews } from './reviewsData';
import { bothPress, useCardSwipe } from './useCardSwipe';
import { DOCK_SECTIONS, NOT_RUNNING_SECTION, readDock, sectionsByStatus, splitSidebar, toggleDock, type DockSection } from '../../chat/sidebarLayout';
import { activityOf, sortByActivity, sortGroupsByActivity, type Activity, type ListOrder } from '../../chat/sidebarSort';
import { canStartChatIn, chatHomeSpace, groupBySpace } from '../../chat/chatSpaces';
import { spaceCreateActions, spaceHeadMenuActions } from '../../chat/spaceMenu';
import { spaceShareActions } from '../../chat/spaceShare';
import { spaceSlackActions } from '../../chat/spaceSlack';
import { useAutomationsEnabled } from '../../chat/useAutomations';
import { useAuth } from '../../contexts/AuthContext';
import { chatRowName, isSdkChat, sidebarLine } from '../../chat/simpleChat';
import {
  projectGroupFolded, projectGroups, readProjectFolds, toggleProjectFold, USER_PROJECT_KEY, type ProjectGroup,
} from '../../chat/sidebarGroups';
import { setSidebarView, useSidebarView } from '../../chat/sidebarView';
import { sessionOpenPrs } from '../../chat/prGates';
import { onRevealProject, takePendingReveal } from '../../chat/revealProject';
import { prsApi, workstreamsApi, type PrPipelineResponse } from '../../services/api';
import { PRS_CHANGED_EVENT } from '../../utils/prPipeline';
import { usePolled } from '../dashboard/useDashboardData';
import { useBoxOf } from '../../chat/useBoxOf';
import { putSessionRef } from '../../chat/sessionRef';
import { desktopSessionHref, openDesktopLink } from '../../chat/desktopLinks';
import { runLabel } from '../../utils/automationRuns';
import { useAutomationIndex } from '../../chat/automationRunGroups';
import { fmtAge } from '../../utils/format';
import { FLAGS, useFlag } from '../../flags';
import { LP_THEME } from '../../launchpad/theme';
import { isMenuKey, MenuButton, useContextMenu, useLongPress, type MenuAction, type MenuTrigger } from './ContextMenu';
import { FileIcon, FolderIcon, openInBrowserTab } from './OpenItems';
import { ArchivedChats } from './ArchivedChats';
import { useListEdges } from './useListEdges';
import { useSteadyOrder } from './useSteadyOrder';
import { statusKey } from '../../utils/statusKey';
import { sessionName } from '../../utils/sessionName';
import { SpaceSwatch } from './SpaceSwatch';
import { SpaceShareDialog } from './SpaceShareDialog';
import { SpaceSlackDialog } from './SpaceSlackDialog';
import { useSimpleData } from './simpleData';
import { StatusMark } from './StatusMark';
import { FoldedCount, RowTag, StandardRowBody } from './StandardRow';
import { SessionCard } from './SessionCard';
import { glyphIconsOf, ProjectGlyph } from './ProjectGlyph';
import { ModelMark } from './ModelMark';
import { modelMarkFor } from '../../chat/modelMark';
import { boxParked, boxTip, chipAge, chipSince, chipTip, prPill, projectTip } from '../../chat/sessionCard';
import { boxFeed } from '../../services/boxFeed';
import { useChatChrome } from './chatChrome';
import { newSessionHereHref, ProjectDialogs, ProjectMenu, type ProjectDialog } from './ProjectMenu';
import { archivedOutKeys, unarchiveKeys } from '../../chat/archivedSessions';
import { useCardActions } from './useCardActions';
import { useListKeys, type CardKeyActions } from './useListKeys';
import { publishRailProjects } from '../../chat/sidebarRail';
import { archiveWay, liveSiblings, sessionLink, sessionMenuItems, unreadWhy, type SessionMenuItem } from '../../chat/cardActions';
import { canMarkUnseen } from '../../utils/unseenStops';
import { RenameSessionDialog } from './RenameSessionDialog';

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/** A group's own icon on its head, under the flag; a project's is its ProjectGlyph. */
const GROUP_ICONS: Partial<Record<ProjectGroup['kind'], IconName>> = {
  'needs-you': 'warning', shared: 'group', automations: 'calendar-schedule', files: 'folders', older: 'clock-history', archived: 'archive',
};
/** A head that takes its status's colour (sessionCard.css .pj-head[data-tone]); the bottom row's sections are quiet. */
const GROUP_TONES: Partial<Record<ProjectGroup['kind'], 'needs' | 'quiet'>> = {
  'needs-you': 'needs', shared: 'quiet', automations: 'quiet', older: 'quiet', archived: 'quiet',
};
/** A Status grouping's head icons (Needs you keeps its own). */
const STATUS_ICONS: Record<'working' | 'idle' | 'off', IconName> = { working: 'pulse', idle: 'check', off: 'circle-outline' };
const DOCK_NAMES: Record<DockSection, string> = {
  shared: 'Shared with me', automations: 'Automations', 'not-running': 'Not running', older: 'Older', archived: 'Archived',
};
// Not running's is its head's (STATUS_ICONS.off).
const DOCK_ICONS: Record<DockSection, IconName> = {
  shared: 'group', automations: 'calendar-schedule', 'not-running': 'circle-outline', older: 'clock-history', archived: 'archive',
};

/** Pinned's head icon. Hand-drawn: LaunchPad has no pin. */
function PinIcon() {
  return (
    <svg className="pj-pin" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M9.8 1.8 14.2 6.2 11.6 7.4 9 10l.4 3.2-6.6-6.6L6 7l2.6-2.6z" /><path d="M2 14l3.2-3.2" strokeLinecap="round" />
    </svg>
  );
}

const sessions = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`;
const prWord = (n: number) => `${n} ${n === 1 ? 'PR' : 'PRs'}`;

/** What a group's head says to a screen reader after its name: its count, and how many of those are up in Needs you. */
function countWords(g: ProjectGroup): string {
  if (g.kind === 'files') return `${g.count} ${g.count === 1 ? 'tab' : 'tabs'}`;
  // Archived's head carries no rows (ArchivedRows lists them): its projects, sessions and chats, none up in Needs you.
  if (g.kind === 'archived') return `${g.count} archived`;
  const up = g.count - g.rows.length;
  return up > 0 && g.kind !== 'needs-you' ? `${sessions(g.count)}, ${up} in Needs you` : sessions(g.count);
}

export function ProjectsList() {
  const { items, rows: allRows, live, setupOf, links, unseen, setUnseen, activeTab, userProjects, spaces } = useSimpleData();
  const { projects, projectsLoaded, projectsLoadFailed, projectsRefreshFailed, reloadProjects, statusMap } = useProjects();
  // The person's projects (milestone 5's record), under user-projects-enabled, once read.
  const projectsOn = useFlag(FLAGS.userProjects, false);
  const ownProjects = useMemo(
    () => (projectsOn && userProjects?.list
      ? userProjects.list.filter(p => !p.archived).map(p => ({
        id: p.id, name: p.name, lastActiveAt: p.lastActiveAt,
        liveSessions: (p.checkouts ?? []).reduce((n, c) => n + (c.archived ? 0 : c.sessions), 0),
      }))
      : undefined),
    [projectsOn, userProjects?.list],
  );
  // Each project's open PRs, from the PR pipeline (GET /api/prs) as a session's PR pill reads it; only under the flag.
  const prs = usePolled<PrPipelineResponse | null>(() => (projectsOn ? prsApi.list() : Promise.resolve(null)), 60_000, { deps: [projectsOn] });
  const prsRefresh = prs.refresh;
  useEffect(() => {
    if (!projectsOn) return;
    const onChanged = () => prsRefresh();
    window.addEventListener(PRS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PRS_CHANGED_EVENT, onChanged);
  }, [projectsOn, prsRefresh]);
  const openPrs = useMemo(() => sessionOpenPrs(prs.data), [prs.data]);
  const { refresh, mode } = useChatChrome();
  const view = useSidebarView();
  const standard = refresh === true && view.density === 'standard';
  const boxOf = useBoxOf();
  const refsOn = useFlag(FLAGS.chatSessionReferences, false);
  const navigate = useNavigate();
  const ctx = useContextMenu();
  const { pathname, search } = useLocation();
  const route = itemForRoute(pathname, search);
  const openKey = route?.kind === 'chat' ? inboxRowKey(route.projectId, route.workstream) : null;
  const [folds, setFolds] = useState(() => readProjectFolds(storage()));
  const [foldedAgents, setFoldedAgents] = useState(() => readFoldedAgents(storage()));
  const list = useRef<HTMLUListElement>(null);

  const byId = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  // The redesign's reviews: a review session is a card in its project, with a review
  // mark, and one that's your call (Your call, Pushed since your review) sits in Needs you.
  const reviews = useReviewsData();
  const yourCall = useYourCallReviews();
  // The open chat's live status as a row's state and its clock both read it: under the redesign, not while its box is
  // down and the session waits on you, which is never Not running, open or not (rowState.ts liveUnlessWaiting).
  const liveOf = (r: InboxRow) => {
    const lv = live.get(chatLiveKey(r.projectId, r.workstream));
    return projectsOn ? liveUnlessWaiting(r, lv) : lv;
  };
  const stateOf = (r: InboxRow): RowState => {
    const st = chatRowState(r, liveOf(r), setupOf.get(r.projectId), unseen.has(r.key));
    return reviewCallKind(st.kind, yourCall.has(r.key)) !== st.kind ? { ...st, kind: 'approval', text: 'Needs you · the review is your call', unseen: false } : st;
  };
  // Under the redesign an archived session (Workstream.explorerArchivedAt: archived from its card or from a space's
  // Files) leaves the list for Archived with the sessions under it, unless it or one under it is working, needs you or
  // is open, as Files shows it; a shared one stays (chat/archivedSessions.ts).
  const outKeys = projectsOn && allRows.some(r => r.explorerArchived)
    ? archivedOutKeys(allRows, links, r => r.key === openKey || (stateOf(r).kind !== 'done' && stateOf(r).kind !== 'off'))
    : null;
  const archivedRows = outKeys?.size ? allRows.filter(r => outKeys.has(r.key)) : [];
  const rows = archivedRows.length ? allRows.filter(r => !outKeys!.has(r.key)) : allRows;
  // Each automation's zone, so a run is called by the clock time Tabs gives it (OpenItems.tsx runsRow).
  const automations = useAutomationIndex(rows.some(r => r.kind === 'automation'));
  // A session's own activity (its Workstream.lastActiveAt), in ms.
  const activeAtOf = (r: InboxRow): number | null => {
    const at = byId.get(r.projectId)?.workstreams.find(w => w.name === r.workstream)?.lastActiveAt;
    const ms = at ? Date.parse(at) : NaN;
    return Number.isNaN(ms) ? null : ms;
  };
  const now = Date.now();
  // The redesign's layout (under the flag): Pinned, from the server, and Older, before the groups take the rest.
  const cards = projectsOn;
  // Whether the session has a status of its own: a row without one carries its project's time (buildRows).
  const ownStatus = (r: InboxRow) => statusMap[statusKey(r.instanceId, sessionName(r.owner, r.projectName, 'agent', r.workstream))] !== undefined;
  // The time a card's chip shows: the session's own only (chat/sessionCard.ts chipSince). A review's Needs you (or
  // its Working) is the review pane's, not the agent's status: its own time. The open chat's live status wins over
  // the row's (chat/rowState.ts), and then so does its time.
  const chipSinceOf = (r: InboxRow): string | null =>
    chipSince(r, { ownStatus: ownStatus(r), live: liveOf(r) !== undefined });
  // Sort: Recent activity (chat/sidebarSort.ts), under the redesign only. A session's activity is the newest of
  // when it started, its last turn's end and its chip's time (these two only once it has a status of its own: a
  // row without one reads its project's time), not counting not running's; its project's only when it has none.
  const recent = cards && view.sort === 'recent';
  const ms = (iso: string | null | undefined): number | null => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? null : t; };
  const liveActivity = (r: InboxRow): Activity => {
    const own = ownStatus(r);
    const kind = stateOf(r).kind;
    return activityOf({
      state: kind === 'working' ? 'working' : kind === 'off' ? 'off' : 'other',
      startedAt: activeAtOf(r),
      status: own ? { since: ms(chipSinceOf(r)), stoppedAt: ms(r.stoppedAt) } : null,
      projectAt: ms(byId.get(r.projectId)?.lastActiveAt),
    });
  };
  // The open session keeps the activity it had when it was opened, so working in it never moves it (or its group).
  const [heldOpen, setHeldOpen] = useState<{ key: string; activity: Activity } | null>(null);
  const openRow = recent && openKey ? rows.find(r => r.key === openKey) : undefined;
  if (openRow && heldOpen?.key !== openRow.key) setHeldOpen({ key: openRow.key, activity: liveActivity(openRow) });
  else if (!openRow && heldOpen) setHeldOpen(null);
  const activity = (r: InboxRow): Activity => (heldOpen && r.key === heldOpen.key ? heldOpen.activity : liveActivity(r));
  const byActivity = (list: readonly InboxRow[]) => (recent ? sortByActivity(list, activity) : [...list]);
  const pins = useSessionPins();
  const pinOrder = useMemo(() => new Map((pins.pins ?? []).map((p, i) => [p.workstreamId, i])), [pins.pins]);
  // Older goes by how recently a session was active (its start, its last turn, its status: liveActivity), as Recent
  // activity sorts by, never by its Workstream.lastActiveAt alone: that's set when the session is made and never moves.
  const touchedAt = (r: InboxRow): number | null => { const at = liveActivity(r).at; return Number.isFinite(at) ? at : null; };
  const layout = cards
    ? splitSidebar(rows, {
      links, stateOf: r => stateOf(r).kind, touchedAt, now, olderDays: view.olderDays, openKey,
      pinOrder: r => (r.workstreamId ? pinOrder.get(r.workstreamId) ?? null : null),
    })
    : null;
  // Older keeps to the view's filter, as the groups do; Pinned is the person's working set and always shows.
  const olderRows = layout ? byActivity(layout.older.filter(r => view.showIdle || stateOf(r).kind !== 'off' || r.key === openKey)) : [];
  // By its keys, so a new split with the same sessions keeps the same set.
  const elsewhereKeys = layout ? [...layout.pinned, ...layout.older].map(r => r.key).join('\n') : '';
  const elsewhere = useMemo(() => new Set(elsewhereKeys ? elsewhereKeys.split('\n') : []), [elsewhereKeys]);
  const groups = projectGroups({
    rows,
    stateOf: r => stateOf(r).kind,
    projectOf: id => byId.get(id),
    activeAt: activeAtOf,
    links,
    view,
    files: items.state.items,
    openKey,
    openTab: activeTab,
    userProjects: ownProjects,
    openPrs: projectsOn ? openPrs : [],
    redesign: cards ? { elsewhere } : undefined,
  });
  // The bottom row's sections, open or folded per browser; Archived's count comes from its own read.
  const [dock, setDock] = useState(() => readDock(storage()));
  const [archivedCount, setArchivedCount] = useState(0);
  // Archived: the archived chats and projects (ArchivedChats counts them) and the archived sessions, most recently
  // active first (as Sort's Recent activity measures it), each with the sessions under it.
  const archivedSorted = nestInOrder(sortByActivity(archivedRows, liveActivity), r => r.key, links);
  // Group by orders the one list (under the flag): the sessions the projects' groups hold, by project, status or space.
  const projectSections = groups.filter(g => g.kind === 'project');
  const sectionRows = projectSections.flatMap(g => g.rows);
  const newestFirst = (a: InboxRow, b: InboxRow) => (activeAtOf(b) ?? -Infinity) - (activeAtOf(a) ?? -Infinity);
  // Recent activity: each group by its most recently active session; a pinned project stays first, as the
  // project list keeps it, and one with no session listed goes by its own time.
  const upAt = (g: ProjectGroup) => ms(g.userProjectId ? ownProjects?.find(p => p.id === g.userProjectId)?.lastActiveAt : null);
  const byNewest = (list: ProjectGroup[], opts: { first?: (g: ProjectGroup) => boolean; last?: (g: ProjectGroup) => boolean } = {}) => (recent
    ? sortGroupsByActivity(list.map(g => ({ ...g, rows: byActivity(g.rows) })), g => g.rows, activity, { ...opts, emptyAt: upAt })
    : list);
  const byStatus = cards && view.groupBy === 'status'
    ? byNewest(sectionsByStatus(sectionRows, r => stateOf(r).kind, activeAtOf)
      .map(x => ({ key: x.key, kind: 'status' as const, name: x.name, tone: x.tone, rows: x.rows, items: [], count: x.rows.length })))
    : null;
  // Group by Status's Not running is a bottom-row section: folded, it's the row's button,
  // and it opens at the end of the list. Under Group by Project not running is only a card's mark.
  const notRunning = byStatus?.find(g => g.key === NOT_RUNNING_SECTION) ?? null;
  const middle: ProjectGroup[] = !cards || view.groupBy === 'project'
    ? byNewest(projectSections, { first: g => g.pinned === true })
    : byStatus
      ? byStatus.filter(g => g !== notRunning)
      : byNewest(spaceSections(), { last: g => g.space === null });
  const sortedRows = (g: ProjectGroup | undefined): ProjectGroup | null => (g ? (recent ? { ...g, rows: byActivity(g.rows) } : g) : null);
  const dockGroups: Record<Exclude<DockSection, 'archived'>, ProjectGroup | null> = {
    shared: cards ? sortedRows(groups.find(g => g.kind === 'shared')) : null,
    automations: cards ? sortedRows(groups.find(g => g.kind === 'automations')) : null,
    'not-running': notRunning,
    older: olderRows.length ? { key: 'older', kind: 'older', name: 'Older', rows: olderRows, items: [], count: olderRows.length } : null,
  };
  const dockCount = (d: DockSection) => (d === 'archived' ? archivedCount + archivedRows.length : dockGroups[d]?.count ?? 0);
  // The project heads Group by Project draws, in its order, whatever the list is grouped by now (the rail's reveal
  // switches to it), for the collapsed rail, which shows exactly these (chat/sidebarRail.ts).
  const railKey = byNewest(projectSections, { first: g => g.pinned === true }).flatMap(g => (g.userProjectId ? [g.userProjectId] : [])).join('\n');
  useEffect(() => {
    if (!cards) return undefined;
    publishRailProjects(railKey ? railKey.split('\n') : []);
    return () => publishRailProjects(null);
  }, [cards, railKey]);
  // Group by Space: each of the person's spaces, an empty one too (its head starts a session in it), then No space.
  function spaceSections(): ProjectGroup[] {
    const bySpace = new Map(groupBySpace(sectionRows, spaces.spaces, spaces.index).map(x => [x.space, x.rows.map(y => y.row)]));
    // A space's sessions listed elsewhere (Pinned, Needs you, Older), for its head, as a project's are counted.
    const away = new Map<string, number>();
    for (const r of [...(layout?.pinned ?? []), ...olderRows, ...(groups.find(g => g.kind === 'needs-you')?.rows ?? [])]) {
      const home = chatHomeSpace(r, spaces.spaces, spaces.index);
      if (home) away.set(home, (away.get(home) ?? 0) + 1);
    }
    const named = [...spaces.spaces].map(x => x.name).sort((a, b) => a.localeCompare(b));
    const out: ProjectGroup[] = named.flatMap(name => {
      const list = (bySpace.get(name) ?? []).sort(newestFirst);
      // An empty space shows as a head only while sessions that aren't running do, as an empty project does.
      if (!list.length && !view.showIdle) return [];
      const g: ProjectGroup = { key: `space:${name}`, kind: 'space', name, space: name, rows: list, items: [], count: list.length, empty: list.length === 0 };
      if (away.get(name)) g.elsewhere = away.get(name);
      return [g];
    });
    const none = (bySpace.get(null) ?? []).sort(newestFirst);
    // Outside the space names' alphabet, so no space called "none" can share it.
    if (none.length) out.push({ key: 'space:(none)', kind: 'space', name: 'No space', space: null, rows: none, items: [], count: none.length });
    return out;
  }
  const listGroups: ProjectGroup[] = cards
    ? [
      // On a phone (the page or the drawer, not docked) Needs you comes first, then Pinned.
      ...(mode !== 'docked' ? groups.filter(g => g.kind === 'needs-you') : []),
      ...(layout && layout.pinned.length ? [{ key: 'pinned', kind: 'pinned' as const, name: 'Pinned', rows: layout.pinned, items: [], count: layout.pinned.length }] : []),
      ...(mode !== 'docked' ? [] : groups.filter(g => g.kind === 'needs-you')),
      ...middle,
    ]
    : groups;
  // A space's head menu (Group by Space), as the Tabs view's space heads had: New agent, New automation and New
  // tab, then the space's own Share and Slack channels.
  const { user } = useAuth();
  const automationPages = useAutomationsEnabled();
  const slackChannelsOn = useFlag(FLAGS.spaceChannels, false);
  const [sharing, setSharing] = useState<string | null>(null);
  const [slackFor, setSlackFor] = useState<string | null>(null);
  const sharedSpace = sharing ? spaces.spaces.find(x => x.name === sharing) : undefined;
  const openNewTab = (space: string) => {
    const ref = { kind: 'explorer' as const, space };
    const id = newTabId();
    startTransition(() => {
      items.open(ref, id);
      navigate(itemHref(ref, id), { state: { openTools: true } });
    });
  };
  const newInSpace = (space: string | null) => navigate(space ? `/chat/new?space=${encodeURIComponent(space)}` : '/chat/new');
  const spaceMenu = (space: string | null, name: string) => (e: MenuTrigger) => ctx.open(e, name, spaceHeadMenuActions({
    create: spaceCreateActions(space, {
      canStart: space === null || canStartChatIn(space, spaces.spaces),
      newAgent: () => newInSpace(space),
      newTab: () => openNewTab(space ?? NO_SPACE_EXPLORER),
      newAutomation: automationPages ? () => navigate(space ? `/chat/new?schedule=1&space=${encodeURIComponent(space)}` : '/chat/new?schedule=1') : undefined,
    }),
    space: [...spaceShareActions(space, setSharing), ...spaceSlackActions(space, slackChannelsOn, setSlackFor)],
  }), `space:${name}`);
  // The open sections, and a closed one holding the session on screen, which shows that one, as a folded group does.
  const openDockGroups = DOCK_SECTIONS.flatMap(d => {
    const g = d === 'archived' ? null : dockGroups[d];
    if (!g) return [];
    if (dock.has(d)) return [{ d, g, peek: false }];
    return openKey && g.rows.some(r => r.key === openKey) ? [{ d, g, peek: true }] : [];
  });
  const sessionGroups = [...listGroups, ...openDockGroups.map(x => x.g)].filter(g => g.kind !== 'files');
  const pressDock = (d: DockSection) => {
    const opening = !dock.has(d);
    setDock(cur => toggleDock(cur, d, storage()));
    // Its section opens at the end of the list: bring it into view.
    if (opening) window.requestAnimationFrame(() => list.current?.querySelector(`[data-dock="${d}"]`)?.scrollIntoView?.({ block: 'nearest' }));
  };
  // The open session in view, as the tabs' list keeps it: one opened from search or a link may be far
  // down. Again once its row is drawn: on a reload the route knows the session before the list does.
  const openShown = openKey !== null && sessionGroups.some(g => g.rows.some(r => r.key === openKey));
  useEffect(() => {
    if (openShown) list.current?.querySelector<HTMLElement>(':is(.chat-item, .sc)[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [openKey, openShown]);
  // Which project's menu is open (its ⋯ or a right click on its head), and its Rename or Archive dialog,
  // drawn below the groups so an archive taking the group away doesn't take the dialog with it.
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [projectDialog, setProjectDialog] = useState<ProjectDialog>(null);
  // The header's project name (SessionHeader.tsx ProjectCrumb): unfold its group, then show and focus its head once drawn.
  const [revealing, setRevealing] = useState<string | null>(null);
  // Read by the reveal below, which is registered once.
  const groupByNow = useRef(view.groupBy);
  groupByNow.current = cards ? view.groupBy : 'project';
  useEffect(() => {
    const reveal = (id: string) => {
      const key = `${USER_PROJECT_KEY}${id}`;
      // Only Group by Project has a project's head to show.
      if (groupByNow.current !== 'project') setSidebarView({ groupBy: 'project' });
      setFolds(f => (projectGroupFolded(f, key) ? toggleProjectFold(f, key, storage()) : f));
      setRevealing(key);
    };
    // Asked for from the Tabs view, which switched the sidebar here.
    const early = takePendingReveal();
    if (early) reveal(early);
    return onRevealProject(reveal);
  }, []);
  useEffect(() => {
    if (!revealing) return;
    // Once, after the render that unfolded it: a project with no group of its own (its sessions all up in Needs you) shows nothing later.
    setRevealing(null);
    const head = [...(list.current?.querySelectorAll<HTMLElement>('.chat-group') ?? [])].find(g => g.dataset.group === revealing);
    head?.scrollIntoView?.({ block: 'nearest' });
    head?.querySelector<HTMLElement>('.chat-projects-fold')?.focus({ preventScroll: true });
  }, [revealing]);
  const retry = () => {
    void reloadProjects().catch(() => { /* still failed: the alert stays */ });
    if (userProjects?.failed) void userProjects.reload();
  };
  const toggle = (key: string) => setFolds(f => toggleProjectFold(f, key, storage()));

  // The cards (under the flag): a user project's name and repositories for the icon, each session's PR, its box.
  const longPress = useLongPress();
  // The phone's swipes (useCardSwipe.ts): right pins, left archives, touch only.
  const swipe = useCardSwipe(cards);
  // Which head is stuck and whether there's more to scroll either way, for the heads and the fades (sessionCard.css).
  const edges = useListEdges(list, cards);
  // Under Recent activity the order holds still while the list is in use, and its moves animate (useSteadyOrder.ts).
  const busy = ctx.openKey !== null || projectMenu !== null || projectDialog !== null || sharing !== null || slackFor !== null;
  const liveOrder: ListOrder = {
    groups: listGroups.map(g => g.key),
    rows: Object.fromEntries([...listGroups, ...openDockGroups.map(x => x.g)].map(g => [g.key, g.rows.map(r => r.key)])),
  };
  const steady = useSteadyOrder(list, liveOrder, { on: cards, steady: recent, busy, anchor: openKey ? `row:${openKey}` : null, edges });
  const arranged = (g: ProjectGroup): ProjectGroup => {
    const keys = cards ? steady.order.rows[g.key] : undefined;
    if (!keys) return g;
    const byKey = new Map(g.rows.map(r => [r.key, r]));
    return { ...g, rows: keys.map(k => byKey.get(k)).filter((r): r is InboxRow => r !== undefined) };
  };
  const groupByKey = new Map(listGroups.map(g => [g.key, g]));
  const shownGroups = cards
    ? steady.order.groups.map(k => groupByKey.get(k)).filter((g): g is ProjectGroup => g !== undefined).map(arranged)
    : listGroups;
  // A card's chip says the time in its status, so the list redraws on a clock as well as on its pushes.
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!cards) return undefined;
    const t = window.setInterval(() => setClock(c => c + 1), 30_000);
    return () => window.clearInterval(t);
  }, [cards]);
  const upById = useMemo(() => new Map((userProjects?.list ?? []).map(p => [p.id, p])), [userProjects?.list]);
  const prOf = useMemo(() => new Map(openPrs.map(p => [p.key, p.pr])), [openPrs]);
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const boxById = useMemo(() => new Map(boxes.map(b => [b.id, b])), [boxes]);
  // A project's sessions and open PRs, for its icon's tooltip.
  const projectCounts = useMemo(() => {
    const counts = new Map<string, { sessions: number; prs: number }>();
    const keyOf = (projectId: string) => byId.get(projectId)?.userProjectId ?? projectId;
    const countOf = (projectId: string) => {
      const c = counts.get(keyOf(projectId)) ?? { sessions: 0, prs: 0 };
      counts.set(keyOf(projectId), c);
      return c;
    };
    for (const r of rows) countOf(r.projectId).sessions += 1;
    // Each open PR once, so a session with two counts two (sessionOpenPrs keys them by session).
    const projectOfKey = new Map(rows.map(r => [r.key, r.projectId]));
    for (const p of openPrs) {
      const projectId = projectOfKey.get(p.key);
      if (projectId) countOf(projectId).prs += 1;
    }
    return counts;
  }, [rows, byId, openPrs]);

  // Archive in one click with Undo, asking only when it would stop a box (useCardActions.tsx).
  const cardActions = useCardActions({ reloadProjects });
  // The list's keys (useListKeys.ts): j/k move, Enter opens, e archives, p pins; each card's actions by its row key,
  // filled in as the cards are drawn.
  const keyActions = useRef(new Map<string, CardKeyActions>());
  keyActions.current.clear();
  useListKeys(list, keyActions, cards);
  // The card menu's Rename… dialog, and its Copy link.
  const [renaming, setRenaming] = useState<{ projectId: string; workstream: string; title: string; locked: boolean } | null>(null);
  const copyLink = (href: string) => {
    const url = sessionLink(window.location.origin, import.meta.env.BASE_URL, href);
    void navigator.clipboard?.writeText(url).then(
      () => cardActions.notify({ title: 'Link copied', description: url, status: 'info' }),
      () => cardActions.notify({ title: "Couldn't copy the link", description: url, status: 'error' }),
    );
  };
  // Unarchive an archived session: it's back where it was in the list.
  // With every session under it in Archived that has a mark of its own, so the subtree comes back together.
  const unarchiveSession = (r: InboxRow) => {
    const marked = unarchiveKeys(r.key, archivedRows, links).filter(x => x.workstreamId);
    // Each write on its own: the list reads them all again once every one has answered, so those that landed show
    // even if another failed (and stays in Archived, to try again).
    void Promise.allSettled(marked.map(x => workstreamsApi.explorerArchive(x.projectId, x.workstreamId!, false))).then(results => {
      results.forEach((res, i) => {
        if (res.status === 'rejected') console.warn(`[SIDEBAR] unarchiving ${marked[i].key} failed: ${(res.reason as Error)?.message}`);
      });
      return reloadProjects();
    }).catch(() => { /* the list's own alert says a reload failed */ });
  };

  /** A session's card or row; `archived`: one of Archived's, with Unarchive in place of its other actions. */
  function sessionRow(n: TreeRow<InboxRow>, groupKey: string, folded: boolean, archived = false) {
    const r = n.item;
    const state = stateOf(r);
    const line = sidebarLine(r, liveOf(r), setupOf.get(r.projectId));
    const since = stateSince(r);
    const age = since ? fmtAge(Date.now() - new Date(since).getTime()) : null;
    const named = chatRowName(r);
    // An automation's run with no title of its own is called by its automation and when it ran.
    const run = r.kind === 'automation' && !r.sessionTitle?.trim();
    const name = run ? `${r.projectName} · ${runLabel(r.workstream, automations.get(r.projectId)?.timezone)}` : named.title;
    const where = run ? null : named.where;
    const project = byId.get(r.projectId);
    // Lab's agent pane drives it, not the chat runner: the chat shows its pane.
    const tag = project && !isSdkChat(project, r.workstream) ? 'Lab' : null;
    const label = [name, where].filter(Boolean).join(' · ');
    const box = boxOf(r);
    const tip = [label, box && `on ${box}`, tag && 'Runs in Lab', workstreamTip(r), state.text, line.message].filter(Boolean).join('\n');
    const ref = { kind: 'chat' as const, projectId: r.projectId, workstream: r.workstream };
    const href = itemHref(ref);
    const isOpen = r.key === openKey;
    const depth = folded ? 0 : n.depth;
    const kids = n.childCount;
    const hidden = n.hidden.length;
    const desktopHref = desktopSessionHref(r);
    const menuKey = `session:${groupKey}:${r.key}`;
    const pinId = cards && pins.enabled ? r.workstreamId ?? null : null;
    const pinned = pinId ? pins.isPinned(pinId) : false;
    // In Archived only the session at the top of what was archived unarchives; one under it comes back with it (a
    // mark of its own would leave it under its archived parent), as Files offers it.
    const unarchivable = archived && r.explorerArchived === true && n.depth === 0;
    // A card's hover actions: Pin, Archive (chat/cardActions.ts archiveWay) and ⋯.
    const way = cards && project && !archived ? archiveWay(r, { chatRunner: isSdkChat(project, 'main'), liveSiblings: liveSiblings(r, rows) }) : null;
    const archiveIt = way && project ? () => cardActions.archive({
      row: r, title: name, way, open: isOpen, href, project: { id: project.id, name: project.name, instanceId: project.instanceId },
    }) : null;
    const togglePin = pinId ? () => { void (pinned ? pins.unpin(pinId) : pins.pin({ workstreamId: pinId, projectId: r.projectId, workstream: r.workstream })); } : null;
    // The list's e and p (useListKeys.ts) act through the same.
    if (cards && !archived) keyActions.current.set(r.key, { archive: archiveIt, pin: togglePin });
    // A card's ⋯ menu is about the session, never a tab (chat/cardActions.ts sessionMenuItems); the old rows keep theirs.
    const cardMenu = (): MenuAction[] => {
      const run: Record<SessionMenuItem['id'], () => void> = {
        rename: () => setRenaming({ projectId: r.projectId, workstream: r.workstream, title: name, locked: r.sessionTitleSource === 'person' }),
        pin: () => togglePin?.(),
        unread: () => setUnseen(r, !state.unseen),
        copy: () => copyLink(href),
        desktop: () => { if (desktopHref) openDesktopLink(desktopHref); },
        archive: () => archiveIt?.(),
      };
      return sessionMenuItems({
        canRename: !r.shared && r.kind !== 'cloud',
        pinned: pinId ? pinned : null,
        // An automation's run finishes on its schedule, not anyone's turn, so it's never unread (simpleData.tsx unseen).
        // The one on screen is being looked at, so it can't stay unread (the page marks it seen again).
        unread: r.kind === 'automation' ? null
          : state.unseen ? 'read'
            : isOpen ? { why: "It's on screen" }
              : canMarkUnseen(r.status, r.stoppedAt, Date.now()) ? 'unread' : { why: unreadWhy(state.kind) },
        desktop: Boolean(desktopHref),
        archive: archiveIt !== null,
      }).map(item => ({ label: item.label, hint: item.hint, disabled: item.disabled, onSelect: run[item.id] }));
    };
    const menu = (e: MenuTrigger) => ctx.open(e, label, archived ? (unarchivable ? [{ label: 'Unarchive', onSelect: () => unarchiveSession(r) }] : [
      { label: 'Open in new browser tab', onSelect: () => openInBrowserTab(href) },
    ]) : cards ? cardMenu() : [
      { label: 'Open in new browser tab', onSelect: () => openInBrowserTab(href) },
      ...(desktopHref ? [{ label: 'Open in termag desktop', onSelect: () => openDesktopLink(desktopHref) }] : []),
    ], menuKey);
    const dragStart = refsOn
      ? (e: React.DragEvent) => { putSessionRef(e, r, box); e.dataTransfer.setData('text/plain', label); e.dataTransfer.effectAllowed = 'copy'; }
      : undefined;
    if (cards) {
      const up = project?.userProjectId ? upById.get(project.userProjectId) : undefined;
      const projectName = up?.name ?? project?.name ?? r.projectName;
      const repos = project?.repoKeys ?? up?.repos?.map(x => x.repoKey) ?? [];
      const mark = modelMarkFor(project, r.workstreamId, r.provider);
      const instance = r.instanceId && !r.shared ? boxById.get(r.instanceId) : undefined;
      const chipAgeText = chipAge(chipSinceOf(r), now);
      const counts = projectCounts.get(project?.userProjectId ?? r.projectId) ?? { sessions: 0, prs: 0 };
      const cardTip = [label, `${projectName}${box ? ` · on ${box}` : ''}`, tag && 'Runs in Lab', workstreamTip(r),
        chipTip(state, chipAgeText, boxParked(instance)), line.message].filter(Boolean).join('\n');
      return (
        <li key={r.key} className="sc-li" data-flip={`row:${r.key}`} draggable={refsOn} onContextMenu={menu} onDragStart={dragStart}
          {...bothPress(longPress(menu), archived ? {} : swipe({ pin: togglePin, pinned, archive: archiveIt }))}>
          <SessionCard href={href} title={name} review={reviews.sessionKeys.has(r.key)} standard={standard} open={isOpen} state={state} age={chipAgeText}
            branch={project?.workstreams.find(w => w.name === r.workstream)?.branch ?? null} pr={prPill(prOf.get(r.key))}
            box={box} boxTip={box ? boxTip(instance, box, now) : null} tip={cardTip} depth={depth}
            sr={`${state.text}${tag ? ', runs in Lab' : ''}${hidden > 0 ? `, ${hidden} folded` : ''}`}
            glyph={<ProjectGlyph repos={repos} size={15} badge={<ModelMark {...mark} />} icons={glyphIconsOf(up)}
              tip={projectTip({ name: projectName, repos, sessions: counts.sessions, prs: counts.prs, model: mark.label })} />}
            onKeyDown={e => { if (isMenuKey(e)) menu(e); }}
            actions={archived ? <>
              {unarchivable && (
                <IconButton icon="restore" variant="minimal" size="small" className="sc-act" aria-label={`Unarchive ${label}`}
                  data-tip="Unarchive" onPress={() => unarchiveSession(r)} />
              )}
              <MenuButton label={label} open={menu} expanded={ctx.openKey === menuKey} className="chat-item-menu sc-act" />
            </> : <>
              {kids > 0 && !folded && (
                <IconButton icon={hidden > 0 ? 'chevron-right' : 'chevron-down'} variant="minimal" size="small" className="sc-act"
                  aria-label={`${hidden > 0 ? 'Show' : 'Hide'} the ${kids} ${kids === 1 ? 'agent' : 'agents'} ${label} started`}
                  aria-expanded={hidden === 0}
                  onPress={() => setFoldedAgents(f => toggleFoldedAgent(f, r.key, storage()))} />
              )}
              {togglePin && (
                // LaunchPad's Button around termag's pin: LaunchPad has no pin icon.
                <Button variant="minimal" className="sc-act sc-pin" aria-label={pinned ? `Unpin ${label}` : `Pin ${label} to top`}
                  aria-pressed={pinned} data-tip={pinned ? 'Unpin' : 'Pin to top'} onPress={togglePin}>
                  <PinIcon />
                </Button>
              )}
              {archiveIt && (
                <IconButton icon="archive-outline" variant="minimal" size="small" className="sc-act" aria-label={`Archive ${label}`}
                  data-tip="Archive" isDisabled={cardActions.busy.has(r.key)} onPress={archiveIt} />
              )}
              <MenuButton label={label} open={menu} expanded={ctx.openKey === menuKey} className="chat-item-menu sc-act" />
            </>} />
        </li>
      );
    }
    return (
      <li key={r.key} className="chat-item-li chat-tree-li" style={depth ? { '--chat-depth': depth } as React.CSSProperties : undefined}
        draggable={refsOn} onContextMenu={menu} onDragStart={dragStart}>
        {kids > 0 && !folded && (
          <Button variant="minimal" className="chat-twisty chat-projects-twisty" aria-expanded={hidden === 0}
            aria-label={`${hidden > 0 ? 'Show' : 'Hide'} the ${kids} ${kids === 1 ? 'agent' : 'agents'} ${label} started`}
            data-tip={hidden > 0 ? `${kids} folded: show them` : `Fold the ${kids} started by this session`}
            onPress={() => setFoldedAgents(f => toggleFoldedAgent(f, r.key, storage()))}>
            <span className="chat-group-caret" aria-hidden="true" />
          </Button>
        )}
        <Link to={href} draggable={false} className={`chat-item${isOpen ? ' active' : ''}`} aria-current={isOpen ? 'page' : undefined}
          data-kind="chat" data-band={r.band} data-state={state.kind} data-unseen={state.unseen || undefined}
          data-density={standard ? 'standard' : undefined} data-tip={tip}
          onKeyDown={e => { if (isMenuKey(e)) menu(e); }}>
          <StatusMark kind={state.kind} unseen={state.unseen} />
          {standard ? (
            <StandardRowBody name={name} age={age} where={where} state={state} folded={hidden > 0 ? hidden : null} tag={tag} />
          ) : (
            <>
              <span className="chat-item-name">{name}</span>
              {hidden > 0 && <FoldedCount n={hidden} />}
              {tag && <RowTag text={tag} />}
              {age && <span className="chat-item-age" aria-hidden="true">{age}</span>}
            </>
          )}
          <span className="chat-sr">, {state.text}{tag ? ', runs in Lab' : ''}</span>
        </Link>
        <MenuButton label={label} open={menu} expanded={ctx.openKey === menuKey} className="chat-item-menu" />
      </li>
    );
  }

  function fileRow(item: OpenItem) {
    if (item.kind === 'chat') return null;
    const isOpen = item.id === activeTab;
    const name = item.kind === 'file' ? item.path.slice(item.path.lastIndexOf('/') + 1) || item.path : 'New tab';
    const tip = item.kind === 'file' ? `${item.space}:${item.path}` : `${item.space}'s recent files and agents`;
    return (
      <li key={item.id} className="chat-item-li chat-tree-li">
        <Link to={itemHref(item, item.id)} className={`chat-item${isOpen ? ' active' : ''}`} aria-current={isOpen ? 'page' : undefined}
          data-kind={item.kind} data-density={standard ? 'standard' : undefined} data-tip={tip}>
          <span className="chat-item-icon" aria-hidden="true">
            {refresh ? <Icon name={item.kind === 'file' ? 'file' : 'folders'} size="medium" /> : item.kind === 'file' ? <FileIcon /> : <FolderIcon />}
          </span>
          {standard ? <StandardRowBody name={name} age={null} where={tip} state={null} /> : <span className="chat-item-name">{name}</span>}
        </Link>
      </li>
    );
  }

  // A head's icon under the flag: a project's own (ProjectGlyph), or the group's.
  function headIcon(g: ProjectGroup): React.ReactNode {
    if (g.kind === 'pinned') return <PinIcon />;
    if (g.kind === 'status') return <Icon name={STATUS_ICONS[g.tone ?? 'off']} size="medium" />;
    if (g.kind === 'space') return <SpaceSwatch space={g.space ?? null} />;
    const icon = GROUP_ICONS[g.kind];
    if (icon) return <Icon name={icon} size="medium" />;
    const up = g.userProjectId ? upById.get(g.userProjectId) : undefined;
    const first = g.rows[0] ? byId.get(g.rows[0].projectId) : undefined;
    return <ProjectGlyph repos={up?.repos?.map(x => x.repoKey) ?? first?.repoKeys ?? []} size={18} icons={glyphIconsOf(up)} />;
  }

  // A group's head under the flag. The whole head folds the group; an
  // empty project's starts a session in it instead. Its controls float over its right end and take no width.
  function cardHead(g: ProjectGroup, h: {
    folded: boolean; listId: string; upId: string | null; newHere: string | null; prsHref: string | null;
    /** A bottom-row section's head: pressing it closes the section, as its button does (or opens it, when `peek`). */
    close?: () => void;
    peek?: boolean;
  }) {
    const { folded, listId, upId, newHere, prsHref, close, peek = false } = h;
    return (
      <div className="pj-head" data-flip={`head:${g.key}`} data-tone={g.tone ?? GROUP_TONES[g.kind]} data-empty={newHere ? '' : undefined}
        onContextMenu={upId ? e => { e.preventDefault(); setProjectMenu(upId); } : g.kind === 'space' ? spaceMenu(g.space ?? null, g.name) : undefined}
        onKeyDown={g.kind === 'space' ? e => { if (isMenuKey(e)) spaceMenu(g.space ?? null, g.name)(e); } : undefined}>
        <Button variant="minimal" className="pj-fold chat-projects-fold" aria-expanded={newHere ? undefined : !folded}
          aria-controls={newHere ? undefined : listId}
          data-tip={newHere ? `New session in ${g.name}` : close ? (peek ? `Show all of ${g.name}` : `Put ${g.name} away`) : folded ? `Show ${g.name}` : `Fold ${g.name}`}
          onPress={() => (newHere ? navigate(newHere) : close ? close() : toggle(g.key))}
          onKeyDown={e => {
            if (newHere || close) return;
            if ((e.key === 'ArrowLeft' && !folded) || (e.key === 'ArrowRight' && folded)) { e.preventDefault(); toggle(g.key); }
          }}>
          <span className="pj-icon" aria-hidden="true">{headIcon(g)}</span>
          <span className="pj-lbl">
            <span className="pj-name">{g.name}</span>
            {!newHere && !(g.count === 0 && g.elsewhere) && <span className="pj-count" aria-hidden="true">{g.count}</span>}
          </span>
          <span className="chat-sr">, {newHere ? (g.elsewhere ? `none here, ${g.elsewhere} elsewhere: start one` : 'no sessions yet: start one')
            : g.count === 0 && g.elsewhere ? `none here, ${g.elsewhere} elsewhere` : countWords(g)}</span>
        </Button>
        {newHere && <span className="pj-lone" aria-hidden="true"><Icon name="add" size="medium" /></span>}
        {!newHere && folded && <span className="pj-folded-mark" aria-hidden="true"><Icon name="chevron-right" size="medium" /></span>}
        <span className="pj-over">
          {prsHref && g.prs && (
            <Button variant="minimal" size="small" className="chat-group-prs"
              aria-label={`${prWord(g.prs.count)} open in ${g.name}: open the latest session with one`}
              data-tip={`${prWord(g.prs.count)} open: the latest session with one`}
              onPress={() => navigate(prsHref)}>
              {prWord(g.prs.count)}
            </Button>
          )}
          {upId && (
            <IconButton icon="add" variant="minimal" size="small" aria-label={`New session in ${g.name}`}
              data-tip={`New session in ${g.name}`} onPress={() => navigate(newSessionHereHref(upId))} />
          )}
          {upId && (
            <ProjectMenu project={{ id: upId, name: g.name }} isOpen={projectMenu === upId}
              onOpenChange={open => setProjectMenu(open ? upId : null)} onDialog={setProjectDialog} />
          )}
          {/* None on No space: New session with no space named preselects the last one used (chat/useSpaceStep.ts). */}
          {g.kind === 'space' && g.space && canStartChatIn(g.space, spaces.spaces) && (
            <IconButton icon="add" variant="minimal" size="small" aria-label={`New session in ${g.name}`}
              data-tip={`New session in ${g.name}`} onPress={() => newInSpace(g.space ?? null)} />
          )}
          {g.kind === 'space' && (
            <MenuButton label={g.name} open={spaceMenu(g.space ?? null, g.name)} expanded={ctx.openKey === `space:${g.name}`}
              className="chat-group-menu pj-space-menu" tip={`Options for ${g.name}`} />
          )}
          {!newHere && <Icon name="chevron-down" size="medium" className="pj-chev" aria-hidden="true" />}
        </span>
      </div>
    );
  }

  // Under the flag the list waits for the server's pins too, so a pinned session never lands elsewhere first, and
  // Group by Space for the spaces, so nothing is listed under No space and then moves.
  const pinsPending = (cards && pins.enabled && !pins.settled) || (cards && view.groupBy === 'space' && !spaces.loaded);
  const loading = (!projectsLoaded && !projectsLoadFailed) || pinsPending;
  // Neither shows while Loading… does (the pins still to come under the flag).
  // An empty head stands in for it only when it can start a session (a space you only view can't).
  const startsOne = (g: ProjectGroup) => g.empty === true && (g.kind !== 'space' || (!!g.space && canStartChatIn(g.space, spaces.spaces)));
  const empty = projectsLoaded && !pinsPending && rows.length === 0 && !listGroups.some(startsOne);
  const filteredOut = projectsLoaded && !pinsPending && rows.length > 0 && sessionGroups.length === 0 && !DOCK_SECTIONS.some(d => d !== 'archived' && dockCount(d) > 0);
  // The projects' read failing keeps the repository sets' groups, under the same line.
  const failed = projectsLoadFailed || projectsRefreshFailed || (projectsOn && userProjects?.failed === true);
  const rowHref = (key: string) => {
    const r = rows.find(x => x.key === key);
    return r ? itemHref({ kind: 'chat', projectId: r.projectId, workstream: r.workstream }) : null;
  };

  // One group: its head and its sessions (or files). `dockKey`: a bottom-row section's; `peek`: it's closed, and
  // shows only the session on screen.
  function groupItem(g: ProjectGroup, i: number, dockKey?: DockSection, peek = false) {
    // A bottom-row section is open or put away from its button; a closed one showing the open session is folded.
    const folded = dockKey ? peek : projectGroupFolded(folds, g.key);
    // By place, not by key: two repository sets can spell the same id once cleaned (foo-bar/baz, foo/bar-baz).
    const listId = `chat-projects-group-${i}`;
    // A folded group still shows the session on screen, so the sidebar never loses what is open.
    const nested = g.kind === 'files' ? [] : nestInOrder(g.rows, r => r.key, links, foldedAgents, openKey);
    const listed = folded ? nested.filter(n => n.item.key === openKey) : nested;
    const shownRows = listed;
    const shownFiles = folded ? g.items.filter(i => i.id === activeTab) : g.items;
    // One of the person's projects (milestone 5's record): its menu, and, with no session yet, New session here while unfolded.
    const upId = g.userProjectId ?? null;
    // Under the flag an empty project's head always starts a session: it has nothing to fold, whatever was kept.
    const spaceNew = g.kind === 'space' && g.empty && g.space && canStartChatIn(g.space, spaces.spaces) ? `/chat/new?space=${encodeURIComponent(g.space)}` : null;
    const newHere = (g.empty && upId && (cards || !folded) ? newSessionHereHref(upId) : null) ?? spaceNew;
    const empty = shownRows.length === 0 && shownFiles.length === 0 && !newHere;
    const prsHref = g.prs ? rowHref(g.prs.openKey) : null;
    return (
      <li key={g.key} className="chat-group" data-group={g.key} data-project-group={g.kind} data-folded={folded || undefined} data-dock={dockKey}>
        {cards ? cardHead(g, { folded: folded && !newHere, listId, upId, newHere, prsHref, close: dockKey ? () => pressDock(dockKey) : undefined, peek }) : <div className="chat-group-head"
          onContextMenu={upId ? e => { e.preventDefault(); setProjectMenu(upId); } : undefined}>
          {/* LaunchPad's Button wearing the space head's classes, as Archived's head is (ArchivedRows.tsx). */}
          <Button variant="minimal" className="chat-group-toggle chat-projects-fold" aria-expanded={!folded} aria-controls={listId}
            data-tip={folded ? `Show ${g.name}` : `Fold ${g.name}`}
            onPress={() => toggle(g.key)}
            onKeyDown={e => {
              if ((e.key === 'ArrowLeft' && !folded) || (e.key === 'ArrowRight' && folded)) { e.preventDefault(); toggle(g.key); }
            }}>
            <span className="chat-group-caret" aria-hidden="true" />
            <span className="chat-group-name">{g.name}</span>
            <span className="chat-group-count" aria-hidden="true">{g.count}</span>
            <span className="chat-sr">, {countWords(g)}</span>
          </Button>
          {prsHref && g.prs && (
            <Button variant="minimal" size="small" className="chat-group-prs"
              aria-label={`${prWord(g.prs.count)} open in ${g.name}: open the latest session with one`}
              data-tip={`${prWord(g.prs.count)} open: the latest session with one`}
              onPress={() => navigate(prsHref)}>
              {prWord(g.prs.count)}
            </Button>
          )}
          {upId && (
            <ProjectMenu project={{ id: upId, name: g.name }} isOpen={projectMenu === upId}
              onOpenChange={open => setProjectMenu(open ? upId : null)} onDialog={setProjectDialog} />
          )}
        </div>}
        <ul className="chat-group-list" id={listId} aria-label={g.name} hidden={(folded && empty) || (cards && !!newHere)}>
          {newHere && !cards && (
            <li className={`${LP_THEME} chat-project-none`}>
              <Text className="chat-project-none-text">No sessions yet</Text>
              <Button size="small" onPress={() => navigate(newHere)}>New session here</Button>
            </li>
          )}
          {shownRows.map(n => sessionRow(n, g.key, folded))}
          {shownFiles.map(fileRow)}
        </ul>
      </li>
    );
  }

  // Left a space from a share dialog (a space's, or a project's Share… on its Project files): read the spaces again,
  // and leave whatever is on screen in it, a session, a file or its explorer, as the Tabs view's active tab was.
  const leftSpace = (left: string) => {
    const open = openKey ? rows.find(r => r.key === openKey) : undefined;
    spaces.reload?.();
    const inLeft = (open && chatHomeSpace(open, spaces.spaces, spaces.index) === left)
      || ((route?.kind === 'file' || route?.kind === 'explorer') && route.space === left);
    if (inLeft) navigate('/chat');
  };
  return (
    <>
      {failed && (
        <div className={`${LP_THEME} chat-projects-alert`}>
          <Alert status="error" actionsLayout="inline" hideIcon>
            <AlertText><Text elementType="p">Couldn't refresh your sessions</Text></AlertText>
            <ButtonGroup><Button size="small" onPress={retry}>Retry</Button></ButtonGroup>
          </Alert>
        </div>
      )}
      {cards && <span id="sb-list-keys" className="chat-sr">Keys: j and k move between sessions, Enter opens one, e archives it, p pins it.</span>}
      <ul ref={list} className="chat-list chat-items chat-projects" aria-label="Every session" {...steady.listProps}
        aria-describedby={cards ? 'sb-list-keys' : undefined}>
        {loading && <li className="chat-list-empty">Loading…</li>}
        {empty && (
          <li className={`${LP_THEME} chat-projects-empty`}>
            <EmptyState size={null}>
              <Heading level={5}>No sessions yet</Heading>
              <ButtonGroup><Button variant="primary" size="small" onPress={() => navigate('/chat/new')}>New session</Button></ButtonGroup>
            </EmptyState>
          </li>
        )}
        {filteredOut && (
          <li className={`${LP_THEME} chat-list-empty chat-projects-filtered`}>
            Nothing running. <LpLink onPress={() => setSidebarView({ showIdle: true })}>Show sessions that aren't running</LpLink>
          </li>
        )}
        {!pinsPending && shownGroups.map((g, i) => groupItem(g, i))}
        {cards && !pinsPending && openDockGroups.map((x, i) => groupItem(arranged(x.g), listGroups.length + i, x.d, x.peek))}
        {cards && !pinsPending && (
          <li className="sb-archived chat-group" data-dock="archived" data-group="archived" data-project-group="archived">
            {dock.has('archived') && dockCount('archived') > 0 && cardHead(
              { key: 'archived', kind: 'archived', name: 'Archived', rows: [], items: [], count: dockCount('archived') },
              // Its list is ArchivedRows' own (its LIST_ID).
              { folded: false, listId: 'chat-archived-rows', upId: null, newHere: null, prsHref: null, close: () => pressDock('archived') },
            )}
            <ArchivedChats dock={{
              open: dock.has('archived'), onCount: setArchivedCount,
              sessions: archivedSorted.map(n => sessionRow(n, 'archived', false, true)),
            }} />
          </li>
        )}
        {/* With no bottom row, the list's end still carries the bottom fade. */}
        {cards && !(!pinsPending && DOCK_SECTIONS.some(d => dockCount(d) > 0)) && <li className="sb-end" aria-hidden="true" />}
        {cards && !pinsPending && DOCK_SECTIONS.some(d => dockCount(d) > 0) && (
          <li className={`${LP_THEME} sb-dock`} aria-label="More sections">
            {DOCK_SECTIONS.filter(d => dockCount(d) > 0).map(d => (
              <TooltipTrigger key={d} delay={300}>
                <ToggleButton size="small" className="sb-dock-btn" isSelected={dock.has(d)} onChange={() => pressDock(d)}
                  aria-label={`${DOCK_NAMES[d]}, ${dockCount(d)}`}>
                  <Icon name={DOCK_ICONS[d]} size="medium" aria-hidden="true" />
                  <span aria-hidden="true">{dockCount(d)}</span>
                </ToggleButton>
                <Tooltip placement="top" className={LP_THEME}>
                  {d === 'older' ? `Older: not touched in ${view.olderDays === 1 ? 'a day' : `${view.olderDays} days`}` : DOCK_NAMES[d]}
                </Tooltip>
              </TooltipTrigger>
            ))}
          </li>
        )}
      </ul>
      {ctx.menu}
      {cards && cardActions.ui}
      {renaming && <RenameSessionDialog session={renaming} onRenamed={() => reloadProjects()} onClose={() => setRenaming(null)} />}
      <ProjectDialogs dialog={projectDialog} onClose={() => setProjectDialog(null)} onLeftSpace={leftSpace} />
      {slackFor && slackChannelsOn && <SpaceSlackDialog space={slackFor} onClose={() => setSlackFor(null)} />}
      {sharedSpace && (
        <SpaceShareDialog space={sharedSpace} userId={user?.id} onClose={() => setSharing(null)} onChanged={() => spaces.reload?.()}
          onLeft={() => { setSharing(null); leftSpace(sharedSpace.name); }} />
      )}
    </>
  );
}
