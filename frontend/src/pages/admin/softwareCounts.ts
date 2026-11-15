import { cellBlocks } from '../../utils/toolUpdate';
import type { SoftwareHost, SoftwareMatrix, SoftwareState, SoftwareSummary } from '../../services/adminApi';

// A tool that is not installed is something to install, not an update: missing stays in its own column.
// A pending reboot (the `reboot` row) is an update installed but not yet running, so it counts.
// `held` doesn't: its tool's policy (mode off) keeps it where it is.
export const NEEDS_UPDATE = new Set<SoftwareState>(['below-floor', 'behind', 'outdated', 'pending']);
/** Offline as the host table marks it; the orchestrator row is always online (backend services/software/summary.ts). */
export const isOnline = (h: SoftwareHost) => h.kind === 'orchestrator' || h.connected;

/**
 * Whether the backend grades the tools termag updates against each box's policy: their cells carry
 * the `policy` they were graded against (backend services/software/toolGrade.ts). An older one doesn't.
 */
export const gradedByPolicy = (hosts: SoftwareHost[]): boolean => hosts.some(h => Object.values(h.cells).some(c => c.policy));

/**
 * What on a host needs an admin, from this tab: a tool termag updates below its policy's floor, or
 * behind its target (cells with a `policy`), and a pending reboot. Nothing else counts: no action here
 * updates tmux, git, the OS, termag or the orchestrator's container tools. Without policy grading (an
 * older backend), every behind or outdated cell counts as behind, as the tab did before.
 *
 * Below a floor always counts: it is a fact about the box. `stuck` says that nothing here would update
 * any of those tools (each cell's `refusal` that blocks, refusalBlocks: the fleet update's own skip, mode off,
 * offline, an agent that can't, a run in flight), so the header can say so rather than present the box as
 * actionable (Devin on #1608). Behind counts only a tool the update would act on.
 */
export function hostAttention(h: SoftwareHost, graded: boolean): { belowFloor: boolean; stuck: boolean; behind: boolean; reboot: boolean } {
  const cells = Object.entries(h.cells);
  const reboot = h.cells.reboot?.state === 'pending';
  if (!graded) return { belowFloor: false, stuck: false, behind: cells.some(([c, x]) => c !== 'reboot' && NEEDS_UPDATE.has(x.state)), reboot };
  const below = cells.filter(([, x]) => x.policy && x.state === 'below-floor');
  return {
    belowFloor: below.length > 0,
    // A run in flight is an update on its way, and the orchestrator has its own action: neither is stuck (Devin on #1608).
    // cellBlocks: the orchestrator by its own policy, so the counts are the same for every admin (Bugbot on #1607).
    stuck: below.length > 0 && below.every(([, x]) => cellBlocks(x)),
    behind: cells.some(([, x]) => x.policy && x.state === 'behind' && !cellBlocks(x)),
    reboot,
  };
}
export const needsUpdate = (h: SoftwareHost, graded: boolean): boolean => { const a = hostAttention(h, graded); return a.belowFloor || a.behind || a.reboot; };

export interface SoftwareCounts {
  summary: SoftwareSummary[];
  /** The header's "needs of total hosts need updates": hosts with anything hostAttention counts. */
  needs: number;
  total: number;
  /** Of those, the hosts with a tool below its floor, a tool behind its target, and a reboot pending. */
  belowFloor: number;
  /** Of the hosts below a floor, those where nothing on this tab would update any tool below its floor. */
  stuck: number;
  behind: number;
  reboot: number;
  /** The tools are graded against each box's policy (gradedByPolicy): the header names the three counts. */
  graded: boolean;
  /** Offline hosts left out of every count: 0 when nothing is excluded. */
  excluded: number;
  /** Whether the backend sends the online counts; an older one doesn't, and everything is counted. */
  canExclude: boolean;
}

/** The Software tab's counts, with or without offline hosts. Off, they are the backend's summary over every host. */
export function softwareCounts(m: SoftwareMatrix, excludeOffline: boolean): SoftwareCounts {
  const canExclude = m.online != null;
  const graded = gradedByPolicy(m.hosts);
  const exclude = excludeOffline && !!m.online;
  const hosts = exclude ? m.hosts.filter(isOnline) : m.hosts;
  const att = hosts.map(h => hostAttention(h, graded));
  return {
    summary: exclude ? m.online!.summary : m.summary,
    needs: att.filter(a => a.belowFloor || a.behind || a.reboot).length,
    total: hosts.length,
    belowFloor: att.filter(a => a.belowFloor).length,
    stuck: att.filter(a => a.stuck).length,
    behind: att.filter(a => a.behind).length,
    reboot: att.filter(a => a.reboot).length,
    graded,
    excluded: m.hosts.length - hosts.length,
    canExclude,
  };
}

/** The header's line: the three counts once the tools are graded by policy, else how many hosts need updates. */
export function headerText(c: SoftwareCounts): string {
  if (!c.graded) return `${c.needs} of ${c.total} hosts need updates`;
  return `${c.belowFloor} below floor${c.stuck ? ` (${c.stuck} can’t be updated here)` : ''} · ${c.behind} behind target · ${c.reboot} reboot pending · of ${c.total} hosts`;
}

export type HostKindFilter = 'all' | 'box' | 'agent' | 'orchestrator';
/** The host table's "show": every host, the hosts needing updates (hostAttention), or only those with a tool below its floor. */
export type HostNeedFilter = 'all' | 'needs' | 'below-floor';
/** The host table's rows: its own filters, independent of the counts' "exclude offline hosts". */
export function tableHosts(hosts: SoftwareHost[], f: { kind: HostKindFilter; show: HostNeedFilter; hideOffline: boolean }): SoftwareHost[] {
  const graded = gradedByPolicy(hosts);
  return hosts
    .filter(h => f.kind === 'all' || h.kind === f.kind)
    .filter(h => f.show === 'all' || (f.show === 'needs' ? needsUpdate(h, graded) : hostAttention(h, graded).belowFloor))
    .filter(h => !f.hideOffline || isOnline(h));
}

/**
 * The hosts the fleet update's count is over. The action itself skips offline hosts (backend
 * toolUpdate/fleet.ts hostRefusal), so with "exclude offline hosts" on the count is what it reaches;
 * off, it is every host as before. Which hosts the action targets doesn't change.
 */
export const fleetCountHosts = (hosts: SoftwareHost[], excludeOffline: boolean): SoftwareHost[] => (excludeOffline ? hosts.filter(isOnline) : hosts);
