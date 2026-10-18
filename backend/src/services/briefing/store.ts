/**
 * Briefing rows: views for the API, and the reads the window and the routes
 * share. Rows hold the composed content and the ledger's totals only; no
 * transcript or pane text is ever written here.
 */
import type { Briefing } from '@prisma/client';
import { prisma } from '../../db';
import type { BriefingContent, BriefingView, LedgerTotals } from './types';

export type BriefingRow = Pick<Briefing,
  'id' | 'trigger' | 'status' | 'error' | 'since' | 'until' | 'tz' | 'windowLabel' | 'windowBasis' | 'instanceId' | 'content' | 'stats' | 'createdAt' | 'finishedAt'>;

/** Every project id a view mentions, for one names lookup. */
export function referencedProjectIds(rows: Pick<Briefing, 'content'>[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    const c = r.content as BriefingContent | null;
    for (const x of [...(c?.carryovers ?? []), ...(c?.suggestions ?? [])]) if (x.projectId) ids.add(x.projectId);
  }
  return [...ids];
}

export function toView(
  row: BriefingRow,
  boxNames: ReadonlyMap<string, string>,
  projects: ReadonlyMap<string, { name: string; archived: boolean }>,
): BriefingView {
  const content = (row.content as BriefingContent | null) ?? null;
  const mine: BriefingView['projects'] = {};
  for (const x of [...(content?.carryovers ?? []), ...(content?.suggestions ?? [])]) {
    const p = x.projectId ? projects.get(x.projectId) : undefined;
    if (x.projectId && p) mine[x.projectId] = p;
  }
  return {
    id: row.id,
    trigger: row.trigger as BriefingView['trigger'],
    status: row.status as BriefingView['status'],
    error: row.error,
    window: { since: row.since.toISOString(), until: row.until.toISOString(), tz: row.tz, label: row.windowLabel, basis: row.windowBasis as BriefingView['window']['basis'] },
    boxName: row.instanceId ? boxNames.get(row.instanceId) ?? null : null,
    content,
    stats: (row.stats as LedgerTotals | null) ?? null,
    projects: mine,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** Views for rows of one user, resolving box and project names in two queries. */
export async function viewsFor(userId: string, rows: BriefingRow[]): Promise<BriefingView[]> {
  const boxIds = [...new Set(rows.map(r => r.instanceId).filter((x): x is string => !!x))];
  const projectIds = referencedProjectIds(rows);
  const [boxes, projects] = await Promise.all([
    boxIds.length ? prisma.instance.findMany({ where: { id: { in: boxIds } }, select: { id: true, name: true } }) : [],
    projectIds.length ? visibleProjects(userId, projectIds) : [],
  ]);
  const boxMap = new Map(boxes.map(b => [b.id, b.name]));
  const projectMap = new Map(projects.map(p => [p.id, { name: p.name, archived: p.archived }]));
  return rows.map(r => toView(r, boxMap, projectMap));
}

/** Projects the user owns or has been shared, among `ids` (all of them when ids is null). */
export async function visibleProjects(userId: string, ids: string[] | null): Promise<Array<{ id: string; name: string; archived: boolean }>> {
  const idFilter = ids ? { id: { in: ids } } : {};
  const [owned, shared] = await Promise.all([
    prisma.project.findMany({ where: { userId, ...idFilter }, select: { id: true, name: true, archived: true } }),
    prisma.projectShare.findMany({ where: { userId, project: idFilter }, select: { project: { select: { id: true, name: true, archived: true } } } }),
  ]);
  return [...owned, ...shared.map(s => s.project)];
}

export async function previousDone(userId: string): Promise<{ createdAt: Date; until: Date } | null> {
  return prisma.briefing.findFirst({
    where: { userId, status: 'done' },
    orderBy: { until: 'desc' },
    select: { createdAt: true, until: true },
  });
}

/**
 * The card's two rows: the newest done briefing, and the newest row after it
 * that is still running or did not finish (so the card can say so).
 */
export async function latestFor(userId: string): Promise<{ latest: BriefingView | null; pending: BriefingView | null }> {
  const latest = await prisma.briefing.findFirst({ where: { userId, status: 'done' }, orderBy: { createdAt: 'desc' } });
  const pending = await prisma.briefing.findFirst({
    where: { userId, status: { in: ['running', 'failed', 'skipped'] }, ...(latest ? { createdAt: { gt: latest.createdAt } } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  const views = await viewsFor(userId, [latest, pending].filter((r): r is Briefing => !!r));
  return {
    latest: latest ? views[0] : null,
    pending: pending ? views[latest ? 1 : 0] : null,
  };
}

export async function listFor(userId: string, limit: number): Promise<BriefingView[]> {
  const rows = await prisma.briefing.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
  return viewsFor(userId, rows);
}

export async function viewById(userId: string, id: string): Promise<BriefingView | null> {
  const row = await prisma.briefing.findFirst({ where: { id, userId } });
  return row ? (await viewsFor(userId, [row]))[0] : null;
}
