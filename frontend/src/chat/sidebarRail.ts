// The redesigned sidebar collapsed to a rail:
// whether it is, kept per browser, toggled by the button by the brand or ⌘\
// (Ctrl+\ elsewhere); and what the rail shows, Needs you's count and each
// project's icon with a live dot. Pure but for the one small store, so it's
// tested on its own; pages/chat/SidebarRail.tsx draws it.
import { useSyncExternalStore } from 'react';
import type { RowStateKind } from './rowState';

export const SIDEBAR_RAIL_KEY = 'termag.chat.sidebarRail';

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);
let collapsed: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  if (collapsed === null) {
    try { collapsed = storage()?.getItem(SIDEBAR_RAIL_KEY) === '1'; } catch { collapsed = false; }
  }
  return collapsed;
}

/** Collapse the sidebar to its rail, or bring it back; kept for this browser. */
export function setSidebarCollapsed(next: boolean): void {
  if (read() === next) return;
  collapsed = next;
  try { storage()?.setItem(SIDEBAR_RAIL_KEY, next ? '1' : '0'); } catch { /* private mode: this page only */ }
  for (const l of listeners) l();
}

export function toggleSidebarCollapsed(): void { setSidebarCollapsed(!read()); }

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, read, () => false);
}

/**
 * The projects the sidebar's list draws a head for (by user project id, in its order), as ProjectsList publishes
 * them: the rail shows exactly those, so an icon always opens on a head. Null until the list has drawn.
 */
let railProjects: readonly string[] | null = null;
const projectListeners = new Set<() => void>();

export function publishRailProjects(ids: readonly string[] | null): void {
  const same = railProjects !== null && ids !== null && railProjects.length === ids.length && railProjects.every((x, i) => x === ids[i]);
  if (same || (railProjects === null && ids === null)) return;
  railProjects = ids;
  for (const l of projectListeners) l();
}

export function useRailProjects(): readonly string[] | null {
  return useSyncExternalStore(cb => { projectListeners.add(cb); return () => { projectListeners.delete(cb); }; }, () => railProjects, () => null);
}

/** For tests: forget what was read. */
export function resetSidebarRailForTests(): void { collapsed = null; listeners.clear(); railProjects = null; projectListeners.clear(); }

/** ⌘\ on a Mac, Ctrl+\ elsewhere: the collapse's shortcut (by the key's code, so a layout's own backslash still works). */
export function isRailShortcut(e: Pick<KeyboardEvent, 'code' | 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, mac: boolean): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false;
  return e.code === 'Backslash' || e.key === '\\';
}

export function railShortcutLabel(mac: boolean): string { return mac ? '⌘\\' : 'Ctrl+\\'; }

/** A project's live dot on the rail: Needs you (amber) over Working (the accent); none when it's quiet. */
export type RailDot = 'needs' | 'working' | null;

const NEEDS: ReadonlySet<RowStateKind> = new Set(['approval', 'unread', 'error']);

export function railDot(kinds: readonly RowStateKind[]): RailDot {
  if (kinds.some(k => NEEDS.has(k))) return 'needs';
  return kinds.includes('working') ? 'working' : null;
}

/** How many sessions need you, for the rail's Needs you badge. */
export function needsCount(kinds: readonly RowStateKind[]): number {
  return kinds.filter(k => NEEDS.has(k)).length;
}

/** A project's button's name on the rail: the project, and what its dot says. */
export function railLabel(name: string, kinds: readonly RowStateKind[]): string {
  const needs = needsCount(kinds);
  const working = kinds.filter(k => k === 'working').length;
  const parts = [needs ? `${needs} need${needs === 1 ? 's' : ''} you` : null, working ? `${working} working` : null].filter(Boolean);
  return parts.length ? `${name}, ${parts.join(', ')}` : name;
}
