/**
 * The Software tab's per-component counts, kept free
 * of the database so the counting rule is testable. queries.ts builds the hosts and the references.
 */
import { COMMIT_COMPONENTS, compareVersions, type SoftwareState } from './versions';

export interface Cell { version: string | null; raw: string | null; path: string | null; state: SoftwareState; observedAt: string }
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
  counts: Record<SoftwareState, number>;
  /** Versions seen, most common first. */
  spread: Array<{ version: string; hosts: number }>;
}

const EMPTY_COUNTS = (): Record<SoftwareState, number> => ({ current: 0, behind: 0, outdated: 0, ahead: 0, missing: 0, unknown: 0 });
export const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : null);

/** Offline as the host table shows it: the agent is not connected. The orchestrator row is always online. */
export const isOnline = (h: Pick<HostRow, 'kind' | 'connected'>) => h.kind === 'orchestrator' || h.connected;

/**
 * Each component's state counts and version spread over `hosts`. The reference and its note are the
 * caller's, chosen from every host, so leaving offline hosts out changes the counts and not the reference.
 */
export function summarize(components: string[], hosts: HostRow[], reference: (c: string) => { reference: string | null; referenceNote: string }): ComponentSummary[] {
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
