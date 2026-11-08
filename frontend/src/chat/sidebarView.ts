// The sidebar's view options under the chrome refresh,
// kept per browser: how dense the rows
// are, how they are grouped, and what is shown. pages/chat/ViewOptions.tsx
// sets them; OpenItems.tsx reads them, and only while the refresh is on.
import { useSyncExternalStore } from 'react';

export type SidebarDensity = 'compact' | 'standard';
export type SidebarGroupBy = 'space' | 'project' | 'status';

export interface SidebarView {
  density: SidebarDensity;
  groupBy: SidebarGroupBy;
  /** Space files and new tabs, beside the agents. */
  showFiles: boolean;
  /** Agents that aren't running. */
  showIdle: boolean;
}

export const SIDEBAR_VIEW_KEY = 'termag.chat.sidebarView';
export const DEFAULT_SIDEBAR_VIEW: SidebarView = { density: 'compact', groupBy: 'space', showFiles: true, showIdle: true };

interface Storage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The kept view, each option checked on its own, so a bad or old value falls back to its default alone. */
export function parseSidebarView(raw: string | null): SidebarView {
  let r: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) r = parsed as Record<string, unknown>;
  } catch { /* garbage: defaults */ }
  const d = DEFAULT_SIDEBAR_VIEW;
  return {
    density: r.density === 'compact' || r.density === 'standard' ? r.density : d.density,
    groupBy: r.groupBy === 'space' || r.groupBy === 'project' || r.groupBy === 'status' ? r.groupBy : d.groupBy,
    showFiles: typeof r.showFiles === 'boolean' ? r.showFiles : d.showFiles,
    showIdle: typeof r.showIdle === 'boolean' ? r.showIdle : d.showIdle,
  };
}

const storage = (): Storage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

let current: SidebarView | null = null;
const listeners = new Set<() => void>();

function read(): SidebarView {
  if (!current) {
    let raw: string | null = null;
    try { raw = storage()?.getItem(SIDEBAR_VIEW_KEY) ?? null; } catch { /* blocked */ }
    current = parseSidebarView(raw);
  }
  return current;
}

export function setSidebarView(patch: Partial<SidebarView>): void {
  current = { ...read(), ...patch };
  try { storage()?.setItem(SIDEBAR_VIEW_KEY, JSON.stringify(current)); } catch { /* private mode, full storage */ }
  for (const l of listeners) l();
}

/** For tests: forget the in-memory copy, so the next read is the storage's. */
export function resetSidebarViewForTests(): void {
  current = null;
}

export function useSidebarView(): SidebarView {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    read,
    () => DEFAULT_SIDEBAR_VIEW,
  );
}
