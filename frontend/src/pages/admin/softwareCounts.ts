import type { SoftwareHost, SoftwareMatrix, SoftwareState, SoftwareSummary } from '../../services/adminApi';

// A tool that is not installed is something to install, not an update: missing stays in its own column.
export const NEEDS_UPDATE = new Set<SoftwareState>(['behind', 'outdated']);
export const needsUpdate = (h: SoftwareHost) => Object.values(h.cells).some(c => NEEDS_UPDATE.has(c.state));
/** Offline as the host table marks it; the orchestrator row is always online (backend services/software/summary.ts). */
export const isOnline = (h: SoftwareHost) => h.kind === 'orchestrator' || h.connected;

export interface SoftwareCounts {
  summary: SoftwareSummary[];
  /** The header's "needs of total hosts need updates". */
  needs: number;
  total: number;
  /** Offline hosts left out of every count: 0 when nothing is excluded. */
  excluded: number;
  /** Whether the backend sends the online counts; an older one doesn't, and everything is counted. */
  canExclude: boolean;
}

/** The Software tab's counts, with or without offline hosts. Off, they are the backend's summary over every host. */
export function softwareCounts(m: SoftwareMatrix, excludeOffline: boolean): SoftwareCounts {
  const canExclude = m.online != null;
  if (!excludeOffline || !m.online) return { summary: m.summary, needs: m.hosts.filter(needsUpdate).length, total: m.hosts.length, excluded: 0, canExclude };
  const online = m.hosts.filter(isOnline);
  return { summary: m.online.summary, needs: online.filter(needsUpdate).length, total: online.length, excluded: m.hosts.length - online.length, canExclude };
}

export type HostKindFilter = 'all' | 'box' | 'agent' | 'orchestrator';
/** The host table's rows: its own filters, independent of the counts' "exclude offline hosts". */
export function tableHosts(hosts: SoftwareHost[], f: { kind: HostKindFilter; onlyBad: boolean; hideOffline: boolean }): SoftwareHost[] {
  return hosts
    .filter(h => f.kind === 'all' || h.kind === f.kind)
    .filter(h => !f.onlyBad || needsUpdate(h))
    .filter(h => !f.hideOffline || isOnline(h));
}

/**
 * The hosts the fleet update's count is over. The action itself skips offline hosts (backend
 * toolUpdate/fleet.ts hostRefusal), so with "exclude offline hosts" on the count is what it reaches;
 * off, it is every host as before. Which hosts the action targets doesn't change.
 */
export const fleetCountHosts = (hosts: SoftwareHost[], excludeOffline: boolean): SoftwareHost[] => (excludeOffline ? hosts.filter(isOnline) : hosts);
