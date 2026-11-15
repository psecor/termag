// What the simple UI's sidebar and a space's explorer both read: the agent
// sessions, their live state, the user's spaces and which boxes reach them,
// which agent started which, the tabs, the tab the route shows, and which
// sessions finished since this browser last had them on screen; and, under
// user-projects-enabled, the person's projects (GET /api/user-projects),
// re-read on each `projects`
// push. Loaded once for the page (ChatApp) rather than by each, so the side
// panel's Files costs no requests of its own. The spaces are ChatApp's
// (ChatSpacesProvider). A component rendered without the page around it (a
// test) gets its own through WithSimpleData.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { rowKey, type InboxRow } from '../../mobile/inbox';
import { chatListRows } from '../../chat/simpleChat';
import { useChatLiveStatuses, type ChatLiveStatus } from '../../chat/chatLiveStatus';
import { useSharedChatSpaces, type SharedChatSpaces } from '../../chat/useChatSpaces';
import { activeTab, itemForRoute, itemKey, tabForRoute } from '../../chat/openItems';
import { useOpenItems, useOpenOnRoute, type OpenItemsApi } from '../../chat/useOpenItems';
import type { SpawnLink } from '../../chat/explorerAgents';
import { askLinks } from '../../chat/agentTree';
import { spawnsApi, userProjectsApi, type UserProjectView } from '../../services/api';
import { PROJECTS_PUSH_EVENT } from '../../utils/workspacePush';
import { FLAGS, useFlag } from '../../flags';
import { useSeenStops } from '../../hooks/useSeenStops';
import { markSeen, markUnseen, seenStopKey, unseenStopAge } from '../../utils/unseenStops';

/** The person's projects (milestone 5's record), as the page read them. */
export interface UserProjectsRead {
  /**
   * Every project of theirs, archived ones included, once GET /api/user-projects
   * has answered; null before it has, with user-projects-enabled off, and when
   * the server says it's off for them. Until then the sidebar groups by
   * repository set (chat/sidebarGroups.ts).
   */
  list: readonly UserProjectView[] | null;
  /** The latest read failed; `list` is the last one that didn't. */
  failed: boolean;
  /** A read has answered since the flag turned on: a list, a failure, or the server saying it's off. False while the first one is out. */
  settled: boolean;
  reload: () => Promise<void>;
}

/** A checkout's live project, by its name, for the sidebar and the header. */
export interface OwnProject { id: string; name: string }

export interface SimpleData {
  items: OpenItemsApi;
  rows: readonly InboxRow[];
  live: ReadonlyMap<string, ChatLiveStatus>;
  setupOf: ReadonlyMap<string, string | null | undefined>;
  /** ChatApp's spaces (ChatSpacesProvider), with their boxes and colours. */
  spaces: SharedChatSpaces;
  /** Which agent started which: spawns (GET /api/spawns/parents) and ask threads (their sender), for chat/agentTree.ts and the explorer. */
  links: readonly SpawnLink[];
  /** The tab the route shows, or null. */
  activeTab: string | null;
  /**
   * The rows (by InboxRow.key) whose agent came to rest after this browser last
   * had them on screen, for their blue dot.
   */
  unseen: ReadonlySet<string>;
  /** Mark a session unread again (its blue dot) or read, as a sidebar card's menu does (utils/unseenStops.ts). */
  setUnseen: (row: Pick<InboxRow, 'projectId' | 'workstream' | 'workstreamId' | 'stoppedAt'>, unseen: boolean) => void;
  userProjects: UserProjectsRead;
  /** A checkout's (Project.id) live project, once the projects are read; null without one. */
  userProjectOf: (projectId: string) => OwnProject | null;
}

const NO_USER_PROJECTS = { list: null, failed: false, settled: false } as const;
const OFF_ON_THE_SERVER = { list: null, failed: false, settled: true } as const;

/**
 * GET /api/user-projects while user-projects-enabled is on: once, again on each
 * `projects` push, and on reload(). The latest read wins. When the flag turns
 * on while the page is open, the project list is read again too
 * (`reloadProjects`): it was read with the flag off, so its checkouts carry no
 * userProjectId to group by.
 */
function useUserProjectsRead(on: boolean, reloadProjects: () => Promise<void>): UserProjectsRead {
  const [read, setRead] = useState<{ list: readonly UserProjectView[] | null; failed: boolean; settled: boolean }>(NO_USER_PROJECTS);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!on) return;
    const mine = ++generation.current;
    try {
      const list = await userProjectsApi.list();
      if (mine === generation.current) setRead({ list: Array.isArray(list) ? list : [], failed: false, settled: true });
    } catch (err) {
      if (mine !== generation.current) return;
      // The server's flag is the word: off for this person, there is nothing to show and nothing failed.
      const off = (err as { response?: { data?: { code?: string } } })?.response?.data?.code === 'user_projects_disabled';
      setRead(r => (off ? OFF_ON_THE_SERVER : { list: r.list, failed: true, settled: true }));
    }
  }, [on]);
  const wasOn = useRef(on);
  useEffect(() => {
    const turnedOn = on && !wasOn.current;
    wasOn.current = on;
    if (turnedOn) reloadProjects().catch(() => { /* ProjectContext says so: projectsRefreshFailed */ });
  }, [on, reloadProjects]);
  useEffect(() => {
    generation.current += 1;
    setRead(NO_USER_PROJECTS);
    if (!on) return;
    void reload();
    const onPush = () => { void reload(); };
    window.addEventListener(PROJECTS_PUSH_EVENT, onPush);
    return () => window.removeEventListener(PROJECTS_PUSH_EVENT, onPush);
  }, [on, reload]);
  return useMemo(() => ({ ...read, reload }), [read, reload]);
}

const SimpleDataContext = createContext<SimpleData | null>(null);

export function SimpleDataProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { projects, projectsLoaded, statusMap, reloadProjects } = useProjects();
  const items = useOpenItems(user?.id);
  const userProjects = useUserProjectsRead(useFlag(FLAGS.userProjects, false) && Boolean(user), reloadProjects);
  // A checkout's project: its userProjectId, among the person's live projects.
  const userProjectOf = useMemo(() => {
    const live = new Map((userProjects.list ?? []).filter(p => !p.archived).map(p => [p.id, { id: p.id, name: p.name }]));
    const byCheckout = new Map(projects.flatMap(p => {
      const own = p.userProjectId ? live.get(p.userProjectId) : undefined;
      return own ? [[p.id, own] as const] : [];
    }));
    return (projectId: string): OwnProject | null => byCheckout.get(projectId) ?? null;
  }, [userProjects.list, projects]);
  const { pathname, search } = useLocation();
  const route = itemForRoute(pathname, search);
  const tab = tabForRoute(search);
  useOpenOnRoute(items, route, tab);

  // A project with asks keeps its never-used main out of every list unless it is open (simpleChat.chatListRows).
  const routeChat = itemForRoute(pathname, search);
  const routeKey = routeChat?.kind === 'chat' ? rowKey(routeChat.projectId, routeChat.workstream) : null;
  const openKeys = useMemo(() => {
    const keys = items.state.items.flatMap(i => (i.kind === 'chat' ? [rowKey(i.projectId, i.workstream)] : []));
    return [...keys, ...(routeKey ? [routeKey] : [])].sort().join('\n');
  }, [items.state.items, routeKey]);
  // Mains seen used on this page, kept across renders, so one never folds away between a turn and the next project list.
  const usedMains = useRef(new Set<string>());
  const rows = useMemo(
    () => chatListRows(projects, statusMap, user?.unixUsername ?? '', new Set(openKeys.split('\n')), usedMains.current),
    [projects, statusMap, user?.unixUsername, openKeys],
  );
  const spaces = useSharedChatSpaces();
  const live = useChatLiveStatuses();
  const setupOf = useMemo(() => new Map(projects.map(p => [p.id, p.setupStatus])), [projects]);

  // The first load seeds the tabs from every session; later loads close the ones that are gone.
  const { seed, reconcile } = items;
  useEffect(() => {
    if (!projectsLoaded) return;
    const lastActive = new Map(projects.map(p => [p.id, p.lastActiveAt ? Date.parse(p.lastActiveAt) : null]));
    seed(rows.map(r => ({ projectId: r.projectId, workstream: r.workstream, lastActiveAt: lastActive.get(r.projectId) ?? null })));
    reconcile(new Set(rows.map(r => itemKey({ kind: 'chat', projectId: r.projectId, workstream: r.workstream }))));
  }, [projectsLoaded, projects, rows, seed, reconcile]);

  const sessionsKey = useMemo(() => rows.map(r => r.key).sort().join(','), [rows]);
  // Every list nests a child under its parent (chat/agentTree.ts): spawns by
  // GET /api/spawns/parents, ask threads by what their rows carry.
  const [spawnLinks, setSpawnLinks] = useState<readonly SpawnLink[]>([]);
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    spawnsApi.parents()
      .then(r => { if (!cancelled) setSpawnLinks(Array.isArray(r?.links) ? r.links : []); })
      .catch(() => { if (!cancelled) setSpawnLinks([]); });
    return () => { cancelled = true; };
  }, [signedIn, sessionsKey]);
  const links = useMemo(() => [...askLinks(rows), ...spawnLinks], [rows, spawnLinks]);

  // Stopped since you looked, in the Lab's store: the chat
  // the route shows, while the tab is visible, is seen on arrival and again
  // whenever it stops. An automation's runs finish on their schedule, not on
  // anyone's turn, so they are never unseen: every run would light one.
  const { seenStops, updateSeen, pageVisible } = useSeenStops();
  const viewedRow = routeKey ? rows.find(r => r.key === routeKey) : undefined;
  const viewedSeenKey = viewedRow ? seenStopKey(viewedRow.projectId, viewedRow.workstream, viewedRow.workstreamId) : null;
  const viewedStoppedAt = viewedRow?.stoppedAt;
  useEffect(() => {
    if (!viewedSeenKey || !pageVisible) return;
    updateSeen(s => markSeen(s, viewedSeenKey, Date.now(), viewedStoppedAt));
  }, [viewedSeenKey, viewedStoppedAt, pageVisible, updateSeen]);
  const unseen = useMemo(() => {
    const now = Date.now();
    return new Set(rows.flatMap(r => {
      if (r.kind === 'automation' || (r.key === routeKey && pageVisible)) return [];
      const key = seenStopKey(r.projectId, r.workstream, r.workstreamId);
      return key && unseenStopAge(seenStops, key, r.status, r.stoppedAt, now) ? [r.key] : [];
    }));
  }, [rows, routeKey, pageVisible, seenStops]);

  const setUnseen = useCallback((r: Pick<InboxRow, 'projectId' | 'workstream' | 'workstreamId' | 'stoppedAt'>, on: boolean) => {
    const key = seenStopKey(r.projectId, r.workstream, r.workstreamId);
    if (key) updateSeen(s => (on ? markUnseen(s, key, r.stoppedAt) : markSeen(s, key, Date.now(), r.stoppedAt)));
  }, [updateSeen]);

  const active = activeTab(items.state, route, tab);
  const value = useMemo<SimpleData>(() => ({
    items, rows, live, setupOf, spaces, links, activeTab: active, unseen, setUnseen, userProjects, userProjectOf,
  }), [items, rows, live, setupOf, spaces, links, active, unseen, setUnseen, userProjects, userProjectOf]);
  return <SimpleDataContext.Provider value={value}>{children}</SimpleDataContext.Provider>;
}

export function useSimpleData(): SimpleData {
  const data = useContext(SimpleDataContext);
  if (!data) throw new Error('useSimpleData outside SimpleDataProvider');
  return data;
}

/** The page's data, or null outside SimpleDataProvider. */
export function useSimpleDataIfAny(): SimpleData | null {
  return useContext(SimpleDataContext);
}

/** `children` with the page's data, loading it here when nothing above did. */
export function WithSimpleData({ children }: { children: React.ReactNode }) {
  return useContext(SimpleDataContext) ? <>{children}</> : <SimpleDataProvider>{children}</SimpleDataProvider>;
}
