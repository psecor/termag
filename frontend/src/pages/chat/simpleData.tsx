// What the simple UI's sidebar and a space's explorer both read: the agent
// sessions, their live state, the user's spaces and which boxes reach them,
// which agent started which, the tabs, and the tab the route shows. Loaded
// once for the page (ChatApp) rather than by each, so the side panel's Files
// costs no requests of its own. The spaces are ChatApp's
// (ChatSpacesProvider). A component rendered without the page around it (a
// test) gets its own through WithSimpleData.
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { buildRows, type InboxRow } from '../../mobile/inbox';
import { chatRows } from '../../chat/simpleChat';
import { useChatLiveStatuses, type ChatLiveStatus } from '../../chat/chatLiveStatus';
import { useSharedChatSpaces, type SharedChatSpaces } from '../../chat/useChatSpaces';
import { activeTab, itemForRoute, itemKey, tabForRoute } from '../../chat/openItems';
import { useOpenItems, useOpenOnRoute, type OpenItemsApi } from '../../chat/useOpenItems';
import type { SpawnLink } from '../../chat/explorerAgents';
import { spawnsApi } from '../../services/api';
import { FLAGS, useFlag } from '../../flags';

export interface SimpleData {
  items: OpenItemsApi;
  rows: readonly InboxRow[];
  live: ReadonlyMap<string, ChatLiveStatus>;
  setupOf: ReadonlyMap<string, string | null | undefined>;
  /** ChatApp's spaces (ChatSpacesProvider), with their boxes and colours. */
  spaces: SharedChatSpaces;
  /** The tabs replace the session list: simple-ui-side-panel-enabled is on and the user has spaces. */
  itemsShown: boolean;
  /** Rows lead with Claude's title for the session: simple-ui-session-titles-enabled. */
  titlesShown: boolean;
  /** Which agent started which (GET /api/spawns/parents). */
  links: readonly SpawnLink[];
  /** The tab the route shows, or null. */
  activeTab: string | null;
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

  const rows = useMemo(
    () => chatRows(buildRows(projects, statusMap, user?.unixUsername ?? '')),
    [projects, statusMap, user?.unixUsername],
  );
  const spaces = useSharedChatSpaces();
  const itemsShown = sidePanelOn && spaces.enabled && !(spaces.loaded && spaces.spaces.length === 0);
  const explorerShown = sidePanelOn && spaces.enabled;
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
  const [links, setLinks] = useState<readonly SpawnLink[]>([]);
  useEffect(() => {
    if (!explorerShown) return;
    let cancelled = false;
    spawnsApi.parents()
      .then(r => { if (!cancelled) setLinks(Array.isArray(r?.links) ? r.links : []); })
      .catch(() => { if (!cancelled) setLinks([]); });
    return () => { cancelled = true; };
  }, [explorerShown, sessionsKey]);

  const active = activeTab(items.state, route, tab);
  const value = useMemo<SimpleData>(() => ({
    items, rows, live, setupOf, spaces, itemsShown, titlesShown, links, activeTab: active,
  }), [items, rows, live, setupOf, spaces, itemsShown, titlesShown, links, active]);
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
