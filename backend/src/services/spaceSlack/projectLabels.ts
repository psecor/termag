/**
 * What to call a project termag manages for a space, where it must be named
 * rather than hidden: destructive and ownership confirmations (box remove,
 * stop and hibernate warnings), admin inventory, usage and cost
 * (projectKind.ts, inProjectLists). "space orchestrator for <space>".
 */
import { prisma } from '../../db';
import { LISTED_PROJECT_KINDS, projectKindTraits } from '../projectKind';

export function orchestratorLabel(spaceName: string | null | undefined): string {
  return spaceName ? `space orchestrator for ${spaceName}` : 'space orchestrator';
}

/** Each managed project's label, by project id; normal projects have none. */
export async function managedProjectLabels(projects: ReadonlyArray<{ id: string; kind?: string | null }>): Promise<Map<string, string>> {
  const managed = projects.filter(p => !projectKindTraits(p.kind).inProjectLists).map(p => p.id);
  if (managed.length === 0) return new Map();
  const rows = await prisma.spaceSlack.findMany({
    where: { projectId: { in: managed } },
    select: { projectId: true, space: { select: { name: true } } },
  });
  const spaceOf = new Map(rows.map(r => [r.projectId, r.space.name]));
  return new Map(managed.map(id => [id, orchestratorLabel(spaceOf.get(id))]));
}

/**
 * The live managed projects on each box, labelled, for a box's stop and
 * hibernate warnings: `{ instanceId -> [{ id, name, label }] }`.
 */
export async function managedProjectsByBox(instanceIds: readonly string[]): Promise<Map<string, Array<{ id: string; name: string; label: string }>>> {
  const out = new Map<string, Array<{ id: string; name: string; label: string }>>();
  if (instanceIds.length === 0) return out;
  const rows = await prisma.project.findMany({
    where: { instanceId: { in: [...instanceIds] }, archived: false, kind: { notIn: LISTED_PROJECT_KINDS } },
    select: { id: true, name: true, kind: true, instanceId: true },
    orderBy: { name: 'asc' },
  });
  const labels = await managedProjectLabels(rows);
  for (const r of rows) {
    if (!r.instanceId) continue;
    const list = out.get(r.instanceId) ?? [];
    list.push({ id: r.id, name: r.name, label: labels.get(r.id) ?? orchestratorLabel(null) });
    out.set(r.instanceId, list);
  }
  return out;
}

/** `{id, name}` rows with `label` added where the project is a managed one. */
export async function withManagedLabels<P extends { id: string; name: string; kind?: string | null }>(
  projects: readonly P[],
): Promise<Array<{ id: string; name: string; label?: string }>> {
  const labels = await managedProjectLabels(projects);
  return projects.map(p => ({ id: p.id, name: p.name, ...(labels.has(p.id) ? { label: labels.get(p.id)! } : {}) }));
}
