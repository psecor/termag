/**
 * The Software tab's per-component counts, kept free
 * of the database so the counting rule is testable. queries.ts builds the hosts and the references.
 */
import { COMMIT_COMPONENTS, compareVersions, type SoftwareState } from './versions';
import type { CellPolicy } from './toolGrade';
import type { FleetSkip } from '../toolUpdate/fleet';
import type { ToolUpdateMode } from '../claudeUpdatePolicy';

/**
 * Why the fleet update would not act on a tool cell: the fleet's own skip for a box (FleetSkip: mode
 * off, offline, an agent that can't, a run in flight, no inventory newer than a day, not installed, an
 * unreadable or uncomparable version), or `orchestrator`, which the fleet buttons never take.
 */
/** A run in flight on a cell: `requested` (queued; at the box's next start for an at-start tool, Docker) or `running`. */
export interface CellRun { id: string; status: 'requested' | 'running'; requestedAt: string; atStart?: true }
export type CellRefusal = FleetSkip | 'orchestrator' | 'orchestrator_panel_off';
/** The orchestrator's Claude Code, for the viewing admin: whether their host panel offers an Update, and their own mode. */
export interface OrchestratorPanel { offered: boolean; mode: ToolUpdateMode }
/** The fleet update's scopes a tab button runs (fleet.ts SCOPES, less `all`). */
export type FleetScopeTaken = 'below-floor' | 'behind';

export interface Cell {
  version: string | null; raw: string | null; path: string | null; state: SoftwareState; observedAt: string;
  /** A tool termag updates, on a box with an owner (or the orchestrator's Claude Code): what it was graded against. */
  policy?: CellPolicy;
  /** A tool cell with a policy: why the fleet update would not act on it (CellRefusal), or null when it would. */
  refusal?: CellRefusal | null;
  /** A box's tool with a policy: whether each scope's fleet update takes it, by selectFleet itself. What the tab's buttons count. */
  fleet?: Record<FleetScopeTaken, boolean>;
  /** The orchestrator's Claude Code: the viewing admin's host panel (OrchestratorPanel). Its grade is the orchestrator's own. */
  panel?: OrchestratorPanel;
  /** An owned box whose policy read failed: graded as an unowned box's, and not for want of an owner. */
  policyUnavailable?: true;
  /** Why the automatic sweep's last pass left it alone, when that blocks an update (SWEEP_BLOCKS), and when the pass ran. */
  sweep?: { why: string; at: string };
  /** A box's tool: its run in flight, as runActive decides it (the pacer's queue included), or absent. */
  inFlight?: CellRun;
}
export interface HostRow {
  hostKey: string; kind: 'orchestrator' | 'box' | 'agent'; name: string; owner: string | null;
  boxKind: string | null; status: string | null; connected: boolean; lastInventoryAt: string | null;
  cells: Record<string, Cell>;
}
export interface ComponentSummary {
  component: string;
  /** What a current host runs: a version, or a commit sha for termag and images. */
  reference: string | null;
  referenceNote: string;
  /** A tool termag updates: its policies' floor (each distinct one, most common first); null for anything else. */
  floor?: string | null;
  counts: Record<SoftwareState, number>;
  /** Versions seen, most common first. */
  spread: Array<{ version: string; hosts: number }>;
}

const EMPTY_COUNTS = (): Record<SoftwareState, number> => ({ current: 0, 'below-floor': 0, behind: 0, outdated: 0, ahead: 0, held: 0, pending: 0, missing: 0, unknown: 0 });
export const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : null);

/** Offline as the host table shows it: the agent is not connected. The orchestrator row is always online. */
export const isOnline = (h: Pick<HostRow, 'kind' | 'connected'>) => h.kind === 'orchestrator' || h.connected;

/**
 * Each component's state counts and version spread over `hosts`. The reference and its note are the
 * caller's, chosen from every host, so leaving offline hosts out changes the counts and not the reference.
 */
export function summarize(components: string[], hosts: HostRow[], reference: (c: string) => { reference: string | null; referenceNote: string; floor?: string | null }): ComponentSummary[] {
  return components.map(c => {
    const counts = EMPTY_COUNTS();
    const spread = new Map<string, number>();
    for (const h of hosts) {
      const cell = h.cells[c];
      if (!cell) continue;
      counts[cell.state]++;
      const v = COMMIT_COMPONENTS.has(c) ? short(cell.version) : cell.version;
      if (v) spread.set(v, (spread.get(v) ?? 0) + 1);
    }
    return {
      component: c, ...reference(c), counts,
      spread: [...spread].map(([version, hosts]) => ({ version, hosts })).sort((a, b) => b.hosts - a.hosts || (compareVersions(b.version, a.version) ?? 0)),
    };
  });
}

export const SUMMARY_HOSTS = ['both', 'online', 'all'] as const;
export type SummaryHosts = (typeof SUMMARY_HOSTS)[number];

/**
 * The MCP `software_summary` answer for a host set. `summary` is always over every host and `online`
 * always without offline hosts, so a key never changes meaning with the mode; the mode picks which are
 * present, and `counted` says so in words.
 */
export function summaryAnswer<T extends object, C extends object>(
  m: { summary: ComponentSummary[]; online: { summary: ComponentSummary[]; offline: number }; targets: T; collector: C },
  hosts: SummaryHosts,
) {
  const { offline } = m.online;
  const counted = hosts === 'all' ? `every host, including ${offline} offline (their inventories may be days old)`
    : hosts === 'online' ? `online hosts only; ${offline} offline left out`
    : `summary: every host, including ${offline} offline; online.summary: online hosts only`;
  return {
    hosts, counted,
    ...(hosts !== 'online' ? { summary: m.summary } : {}),
    ...(hosts !== 'all' ? { online: m.online } : { offline }),
    targets: m.targets, collector: m.collector,
  };
}
