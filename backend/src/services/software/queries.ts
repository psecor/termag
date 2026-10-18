/**
 * Software tab reads. Shared by REST
 * (routes/admin/software.ts) and MCP.
 */
import { prisma } from '../../db';
import { isInstanceAgentConnected, inventoryHosts } from '../agentRegistry';
import { targetBoxCommit } from '../boxUpdate';
import { newestOrchestratorImage } from '../prDeploy';
import { termagVersion } from '../termagVersion';
import { collectorStatus } from './collector';
import {
  COMMIT_COMPONENTS, commitState, hooksState, termagReference, newestVersion, sortComponents, toolState, compareVersions, type SoftwareState,
} from './versions';

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
const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : null);

export async function softwareMatrix() {
  const [rows, boxes, agentUsers, boxTarget, orchImage, running] = await Promise.all([
    prisma.hostSoftware.findMany(),
    prisma.instance.findMany({ where: { status: { not: 'terminated' } }, select: { id: true, name: true, kind: true, status: true, user: { select: { unixUsername: true } } } }),
    prisma.hostSoftware.findMany({ where: { hostKind: 'agent' }, distinct: ['hostKey'], select: { hostKey: true } }),
    targetBoxCommit().catch(() => null),
    newestOrchestratorImage().catch(() => null),
    termagVersion(),
  ]);
  const liveAgents = new Set(inventoryHosts().filter(h => h.hostKind === 'agent').map(h => h.hostKey));
  const userIds = agentUsers.map(a => a.hostKey.slice('agent:'.length));
  const users = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, unixUsername: true } })).map(u => [u.id, u.unixUsername]));

  const byHost = new Map<string, typeof rows>();
  for (const r of rows) { const l = byHost.get(r.hostKey) ?? []; l.push(r); byHost.set(r.hostKey, l); }

  // References. Tools: the newest version anywhere in the fleet (decided 2026-10-15).
  const components = sortComponents([...new Set(rows.map(r => r.component))]);
  const toolRef = new Map<string, string | null>();
  for (const c of components) if (!COMMIT_COMPONENTS.has(c) && c !== 'hooks') toolRef.set(c, newestVersion(rows.filter(r => r.component === c && r.ok).map(r => r.version)));
  const refs = { boxImageCommit: boxTarget, orchestratorImageCommit: orchImage?.sha ?? null, runningCommit: running.sha };
  const termagRef = (kind: HostRow['kind']) => termagReference(kind, refs);

  const stateOf = (kind: HostRow['kind'], component: string, r: (typeof rows)[number], host: typeof rows): SoftwareState => {
    if (component === 'termag' || component === 'image') return r.ok ? commitState(r.version, termagRef(kind)) : 'unknown';
    if (component === 'termag-checkout') { const running = host.find(x => x.component === 'termag'); return r.ok ? commitState(r.version, running?.version ?? null) : 'unknown'; }
    if (component === 'hooks') return hooksState(r.version);
    return toolState({ version: r.version, ok: r.ok, path: r.path }, toolRef.get(component) ?? null);
  };

  const hostList: HostRow[] = [
    { hostKey: 'orchestrator', kind: 'orchestrator' as const, name: 'orchestrator', owner: null, boxKind: null, status: null, connected: true },
    ...boxes.map(b => ({ hostKey: b.id, kind: 'box' as const, name: b.name, owner: b.user?.unixUsername ?? null, boxKind: b.kind, status: b.status, connected: isInstanceAgentConnected(b.id) })),
    ...agentUsers.map(a => ({ hostKey: a.hostKey, kind: 'agent' as const, name: `${users.get(a.hostKey.slice(6)) ?? 'unknown'} (orchestrator agent)`, owner: users.get(a.hostKey.slice(6)) ?? null, boxKind: null, status: null, connected: liveAgents.has(a.hostKey) })),
  ].map(h => {
    const host = byHost.get(h.hostKey) ?? [];
    const cells: Record<string, Cell> = {};
    for (const r of host) cells[r.component] = { version: r.version, raw: r.raw, path: r.path, state: stateOf(h.kind, r.component, r, host), observedAt: r.observedAt.toISOString() };
    const inv = host.filter(r => r.source === 'agent' || r.source === 'self').map(r => r.observedAt.getTime());
    return { ...h, lastInventoryAt: inv.length ? new Date(Math.max(...inv)).toISOString() : null, cells };
  });

  const summary: ComponentSummary[] = components.map(c => {
    const counts = EMPTY_COUNTS();
    const spread = new Map<string, number>();
    for (const h of hostList) {
      const cell = h.cells[c];
      if (!cell) continue;
      counts[cell.state]++;
      const v = COMMIT_COMPONENTS.has(c) ? short(cell.version) : cell.version;
      if (v) spread.set(v, (spread.get(v) ?? 0) + 1);
    }
    const reference = COMMIT_COMPONENTS.has(c) ? null : c === 'hooks' ? 'current' : toolRef.get(c) ?? null;
    const referenceNote = c === 'termag' || c === 'image'
      ? `boxes: ${boxTarget ? `newest box image ${short(boxTarget)}` : `no box image known, so the orchestrator's running ${short(running.sha) ?? 'commit'}`} · orchestrator and its agents: ${orchImage?.sha ? `newest orchestrator image ${short(orchImage.sha)}` : `no image known, so its running ${short(running.sha) ?? 'commit'}`}`
      : c === 'termag-checkout' ? 'each host\'s running commit: a different checkout means pulled but not restarted'
      : c === 'hooks' ? 'the last box update\'s Claude hooks step'
      : 'the newest version anywhere in the fleet';
    return {
      component: c, reference, referenceNote, counts,
      spread: [...spread].map(([version, hosts]) => ({ version, hosts })).sort((a, b) => b.hosts - a.hosts || (compareVersions(b.version, a.version) ?? 0)),
    };
  });

  return {
    components, summary, hosts: hostList,
    targets: { boxCommit: boxTarget, orchestratorImageCommit: orchImage?.sha ?? null, runningCommit: running.sha },
    collector: collectorStatus(),
    generatedAt: new Date().toISOString(),
  };
}

export async function softwareHost(hostKey: string) {
  const m = await softwareMatrix();
  const host = m.hosts.find(h => h.hostKey === hostKey);
  if (!host) return null;
  const changes = await prisma.softwareChange.findMany({ where: { hostKey }, orderBy: { at: 'desc' }, take: 100 });
  return { host, changes: changes.map(c => ({ component: c.component, from: c.from, to: c.to, at: c.at.toISOString() })) };
}

export async function clientVersions() {
  const [rows, running] = await Promise.all([prisma.clientVersion.findMany({ orderBy: { lastSeenAt: 'desc' } }), termagVersion()]);
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.userId))] } }, select: { id: true, unixUsername: true } })).map(u => [u.id, u.unixUsername]));
  const newest = new Map<string, string | null>();
  for (const k of ['cli', 'tui', 'metaterm']) newest.set(k, newestVersion(rows.filter(r => r.kind === k).map(r => r.version)));
  return {
    runningCommit: running.sha,
    clients: rows.map(r => {
      const state: SoftwareState = r.kind === 'web' || r.kind === 'mobile'
        ? (r.version === 'unknown' ? 'unknown' : commitState(r.version, running.sha))
        : toolState({ version: r.version, ok: true }, newest.get(r.kind) ?? null);
      return { userId: r.userId, user: users.get(r.userId) ?? null, kind: r.kind, version: r.version, state, lastSeenAt: r.lastSeenAt.toISOString() };
    }),
  };
}
