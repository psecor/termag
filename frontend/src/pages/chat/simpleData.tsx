// What the simple UI's sidebar and a space's explorer both read: the agent
// sessions, their live state, the user's spaces and which boxes reach them,
// which agent started which, the tabs, the tab the route shows, and which
// sessions finished since this browser last had them on screen. Loaded
// once for the page (ChatApp) rather than by each, so the side panel's Files
// costs no requests of its own. The spaces are ChatApp's
// (ChatSpacesProvider). A component rendered without the page around it (a
// test) gets its own through WithSimpleData.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { spawnsApi } from '../../services/api';
import { FLAGS, useFlag } from '../../flags';
import { useSeenStops } from '../../hooks/useSeenStops';
import { markSeen, seenStopKey, unseenStopAge } from '../../utils/unseenStops';

export interface SimpleData {
  items: OpenItemsApi;
  rows: readonly InboxRow[];
  live: ReadonlyMap<string, ChatLiveStatus>;
  setupOf: ReadonlyMap<string, string | null | undefined>;
  /** ChatApp's spaces (ChatSpacesProvider), with their boxes and colours. */
  spaces: SharedChatSpaces;
  /** The tabs replace the session list: simple-ui-side-panel-enabled is on, with or without spaces. */
  itemsShown: boolean;
  /** Rows lead with Claude's title for the session: simple-ui-session-titles-enabled. */
  titlesShown: boolean;
  /** Which agent started which: spawns (GET /api/spawns/parents) and ask threads (their sender), for chat/agentTree.ts and the explorer. */
  links: readonly SpawnLink[];
  /** The tab the route shows, or null. */
  activeTab: string | null;
  /**
   * The rows (by InboxRow.key) whose agent came to rest after this browser last
   * had them on screen, for their blue dot.
   */
  unseen: ReadonlySet<string>;
}

const SimpleDataContext = createContext<SimpleData | null>(null);

export function SimpleDataProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { projects, projectsLoaded, statusMap } = useProjects();
  const sidePanelOn = useFlag(FLAGS.chatSidePanel, false);
  const titlesShown = useFlag(FLAGS.sessionTitles, false);
  const items = useOpenItems(sidePanelOn ? user?.id : null);
  const { pathname, search } = useLocation();
  const route = sidePanelOn ? itemForRoute(pathname, search) : null;
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
  // With spaces-enabled off there are none to wait for: the tabs are one group, as for a user with no spaces.
  const shared = useSharedChatSpaces();
  const spaces = useMemo(() => (shared.enabled ? shared : { ...shared, loaded: true, current: true }), [shared]);
  const itemsShown = sidePanelOn;
  const live = useChatLiveStatuses();
  const setupOf = useMemo(() => new Map(projects.map(p => [p.id, p.setupStatus])), [projects]);

  // The first load seeds the tabs from every session; later loads close the ones that are gone.
  const { seed, reconcile } = items;
  useEffect(() => {
    if (!itemsShown || !projectsLoaded) return;
    const lastActive = new Map(projects.map(p => [p.id, p.lastActiveAt ? Date.parse(p.lastActiveAt) : null]));
    seed(rows.map(r => ({ projectId: r.projectId, workstream: r.workstream, lastActiveAt: lastActive.get(r.projectId) ?? null })));
    reconcile(new Set(rows.map(r => itemKey({ kind: 'chat', projectId: r.projectId, workstream: r.workstream }))));
  }, [itemsShown, projectsLoaded, projects, rows, seed, reconcile]);

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

  const active = activeTab(items.state, route, tab);
  const value = useMemo<SimpleData>(() => ({
    items, rows, live, setupOf, spaces, itemsShown, titlesShown, links, activeTab: active, unseen,
  }), [items, rows, live, setupOf, spaces, itemsShown, titlesShown, links, active, unseen]);
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
