// The sidebar's view options under the chrome refresh,
// kept per browser: how dense the rows,
// kept per browser: tabs or every
// session, how dense the rows are, how they are grouped, and what is shown. pages/chat/ViewOptions.tsx
// sets them; OpenItems.tsx reads them, and only while the refresh is on.
// Only what the person picked is kept (marked `v: 2`), so an option never
// picked takes the default of the moment: under user-projects-enabled
//  Projects is the default view
// and Tabs groups by Project unless Space or Status was picked; a kept Tabs
// stays Tabs. Group by Space stays until milestone 8 retires spaces.
// Since the sidebar
// redesign there is no Tabs view under the flag:
// the sidebar is always every session, Group by orders that one list, and Sort
// says how (chat/sidebarSort.ts: Created, the default, or Recent activity). With
// the flag off it is all as before.
import { useMemo, useSyncExternalStore } from 'react';
import { FLAGS, useFlag } from '../flags';
import { DEFAULT_OLDER_DAYS, OLDER_DAYS, type OlderDays } from './sidebarLayout';
import { DEFAULT_SIDEBAR_SORT, SIDEBAR_SORTS, type SidebarSort } from './sidebarSort';

export type SidebarDensity = 'compact' | 'standard';
export type SidebarGroupBy = 'space' | 'project' | 'status';
/** Tabs: the tabs this browser keeps (chat/openItems.ts). Projects: every session, from the project list (pages/chat/ProjectsList.tsx). */
export type SidebarShow = 'tabs' | 'projects';

export interface SidebarView {
  /** What the sidebar lists; Group by applies only to Tabs. */
  show: SidebarShow;
  density: SidebarDensity;
  groupBy: SidebarGroupBy;
  /** Space files and new tabs, beside the agents. */
  showFiles: boolean;
  /** Agents that aren't running. */
  showIdle: boolean;
  /** Under user-projects-enabled: after how many days untouched a session moves to Older (chat/sidebarLayout.ts); 0 is never. */
  olderDays: OlderDays;
  /** Under user-projects-enabled: Created (the list's own order) or Recent activity (chat/sidebarSort.ts). */
  sort: SidebarSort;
}

export const SIDEBAR_VIEW_KEY = 'termag.chat.sidebarView';
export const DEFAULT_SIDEBAR_VIEW: SidebarView = { show: 'tabs', density: 'compact', groupBy: 'space', showFiles: true, showIdle: true, olderDays: DEFAULT_OLDER_DAYS, sort: DEFAULT_SIDEBAR_SORT };
/** The defaults under user-projects-enabled: every session, and Tabs by project. */
export const PROJECTS_SIDEBAR_VIEW: SidebarView = { ...DEFAULT_SIDEBAR_VIEW, show: 'projects', groupBy: 'project' };

/** The Tabs view's groupings, in View options' order. Space stays until milestone 8 retires spaces. */
export const SIDEBAR_GROUPINGS: readonly SidebarGroupBy[] = ['space', 'project', 'status'];

/** What this browser keeps: the options the person picked, each on its own. One never picked (or kept bad) is absent. */
export type PickedSidebarView = Partial<SidebarView>;

interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/**
 * What this browser kept before only picks were (milestone 3's whole view, no
 * `v`): every option was written each time one changed, so its Tabs and its
 * Space grouping may be the old defaults rather than picks, and are read as
 * unpicked. A kept Projects, Project or Status was a pick: they weren't defaults.
 */
const PICKS_VERSION = 2;

/** The kept picks, each option checked on its own, so a bad or old value is dropped alone. */
export function parsePickedSidebarView(raw: string | null): PickedSidebarView {
  let r: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) r = parsed as Record<string, unknown>;
  } catch { /* garbage: defaults */ }
  const out: PickedSidebarView = {};
  const picks = r.v === PICKS_VERSION;
  if (r.show === 'projects' || (r.show === 'tabs' && picks)) out.show = r.show;
  if (r.density === 'compact' || r.density === 'standard') out.density = r.density;
  // Space was the default too, written with the rest: only a picked one (v: 2) is a choice.
  if ((r.groupBy === 'space' && picks) || r.groupBy === 'project' || r.groupBy === 'status') out.groupBy = r.groupBy;
  if (typeof r.showFiles === 'boolean') out.showFiles = r.showFiles;
  if (typeof r.showIdle === 'boolean') out.showIdle = r.showIdle;
  if ((OLDER_DAYS as readonly unknown[]).includes(r.olderDays)) out.olderDays = r.olderDays as OlderDays;
  if ((SIDEBAR_SORTS as readonly unknown[]).includes(r.sort)) out.sort = r.sort as SidebarSort;
  return out;
}

/**
 * The view the sidebar shows: the picks over the defaults. `projects`
 * (user-projects-enabled): always every session, by project unless another
 * grouping was picked (a kept Space included); a kept Tabs is no longer one.
 */
export function resolveSidebarView(picked: PickedSidebarView, projects = false, projectFiles = false): SidebarView {
  const view: SidebarView = projects ? { ...PROJECTS_SIDEBAR_VIEW, ...picked, show: 'projects' } : { ...DEFAULT_SIDEBAR_VIEW, ...picked };
  // Under project-files-enabled spaces hold files, not sessions: a kept Space reads as Project.
  return projects && projectFiles && view.groupBy === 'space' ? { ...view, groupBy: 'project' } : view;
}

/** The groupings View options and ⌘K offer: no Space under project-files-enabled. */
export function sidebarGroupings(projects = false, projectFiles = false): readonly SidebarGroupBy[] {
  return projects && projectFiles ? SIDEBAR_GROUPINGS.filter(g => g !== 'space') : SIDEBAR_GROUPINGS;
}

/** The kept view, each option checked on its own, so a bad or old value falls back to its default alone. */
export function parseSidebarView(raw: string | null, projects = false): SidebarView {
  return resolveSidebarView(parsePickedSidebarView(raw), projects);
}

const storage = (): Storage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

let current: PickedSidebarView | null = null;
const listeners = new Set<() => void>();
const NONE_PICKED: PickedSidebarView = {};

function read(): PickedSidebarView {
  if (!current) {
    let raw: string | null = null;
    try { raw = storage()?.getItem(SIDEBAR_VIEW_KEY) ?? null; } catch { /* blocked */ }
    current = parsePickedSidebarView(raw);
  }
  return current;
}

export function setSidebarView(patch: Partial<SidebarView>): void {
  current = { ...read(), ...patch };
  try { storage()?.setItem(SIDEBAR_VIEW_KEY, JSON.stringify({ v: PICKS_VERSION, ...current })); } catch { /* private mode, full storage */ }
  for (const l of listeners) l();
}

/** For tests: forget the in-memory copy, so the next read is the storage's. */
export function resetSidebarViewForTests(): void {
  current = null;
}

export function useSidebarView(): SidebarView {
  const projects = useFlag(FLAGS.userProjects, false);
  const projectFiles = useFlag(FLAGS.projectFiles, false);
  const picked = useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    read,
    () => NONE_PICKED,
  );
  return useMemo(() => resolveSidebarView(picked, projects, projectFiles), [picked, projects, projectFiles]);
}
