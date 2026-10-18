/**
 * Projects and live sessions, org-wide.
 */
import { prisma } from '../../db';
import { collectSessionRows, inventoryInclude, type SessionRow } from '../sessionInventory';

export interface ProjectFilters {
  userId?: string; instanceId?: string; provider?: string;
  archived?: boolean;        // default false
  staleDays?: number;        // only projects with lastActiveAt older than N days
  kind?: string;             // default: all
}

export async function listProjects(f: ProjectFilters) {
  const rows = await prisma.project.findMany({
    where: {
      archived: f.archived ?? false,
      ...(f.userId ? { userId: f.userId } : {}),
      ...(f.instanceId ? { instanceId: f.instanceId === 'legacy' ? null : f.instanceId } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.staleDays ? { lastActiveAt: { lt: new Date(Date.now() - f.staleDays * 86_400_000) } } : {}),
    },
    include: {
      user: { select: { id: true, unixUsername: true } },
      instance: { select: { id: true, name: true, status: true } },
      workflows: { where: { type: 'agent' }, select: { provider: true } }, // one per workstream
      _count: { select: { workstreams: { where: { archived: false } }, shares: true } },
    },
    orderBy: { lastActiveAt: 'desc' },
  });
  return rows
    .map(p => ({
      id: p.id, name: p.name, kind: p.kind, archived: p.archived, pinned: p.pinned,
      owner: { id: p.user.id, unixUsername: p.user.unixUsername },
      instance: p.instance ? { id: p.instance.id, name: p.instance.name, status: p.instance.status } : null,
      // Each workstream has its own agent workflow, so a project can run more than one provider.
      provider: p.workflows[0]?.provider ?? null,
      providers: [...new Set(p.workflows.map(w => w.provider).filter((x): x is string => !!x))],
      workstreams: p._count.workstreams, shares: p._count.shares,
      createdAt: p.createdAt.toISOString(), lastActiveAt: p.lastActiveAt.toISOString(),
      slackChannel: !!p.slackChannelId,
    }))
    .filter(p => !f.provider || p.providers.includes(f.provider));
}

export async function projectCounts() {
  const [byKind, archived, byProvider, workstreams, shares, invites] = await Promise.all([
    prisma.project.groupBy({ by: ['kind', 'archived'], _count: true }),
    prisma.project.count({ where: { archived: true } }),
    prisma.workflow.groupBy({ by: ['provider'], where: { type: 'agent', project: { archived: false } }, _count: true }),
    prisma.workstream.count({ where: { archived: false, project: { archived: false } } }),
    prisma.projectShare.count(),
    prisma.projectInvite.groupBy({ by: ['status'], _count: true }),
  ]);
  return {
    total: byKind.reduce((s, r) => s + r._count, 0),
    active: byKind.filter(r => !r.archived).reduce((s, r) => s + r._count, 0),
    archived,
    byKind: Object.fromEntries(byKind.filter(r => !r.archived).map(r => [r.kind, r._count])),
    byProvider: Object.fromEntries(byProvider.map(r => [r.provider ?? 'unknown', r._count])),
    workstreams, shares,
    invites: Object.fromEntries(invites.map(r => [r.status, r._count])),
  };
}

/** Every non-archived project's sessions across every user. One tmux-list RPC per connected host. */
export async function liveSessions(): Promise<SessionRow[]> {
  const projects = await prisma.project.findMany({ where: { archived: false }, include: inventoryInclude });
  return collectSessionRows(projects.map(p => ({ p, access: 'admin' })));
}

export function summarizeSessions(rows: SessionRow[]) {
  const agent = rows.filter(r => r.role === 'agent');
  const by = (key: (r: SessionRow) => string | null) => {
    const out: Record<string, number> = {};
    for (const r of agent) { const k = key(r) ?? 'unknown'; out[k] = (out[k] ?? 0) + 1; }
    return out;
  };
  return {
    agentPanes: agent.length,
    alive: agent.filter(r => r.alive).length,
    byStatus: by(r => r.status),
    byProvider: by(r => r.provider),
    byHost: by(r => r.instanceId ?? 'orchestrator'),
    rateLimited: agent.filter(r => r.rateLimited).length,
    offlineHosts: new Set(rows.filter(r => !r.connected).map(r => `${r.ownerUserId}:${r.instanceId ?? ''}`)).size,
  };
}
