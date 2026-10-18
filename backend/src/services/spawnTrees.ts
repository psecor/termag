/**
 * Spawn rows as trees, for the dashboard's Agents section.
 * Pure: routes/spawns.ts reads the rows
 * and token totals and calls in here.
 *
 * A tree is everything sharing a rootSpawnId. A node's parent is the spawn
 * whose child workstream the node was spawned from; a root's parent is an
 * agent nobody spawned, shown by its session name.
 */

export interface TreeInput {
  id: string;
  rootSpawnId: string | null;
  depth: number;
  createdAt: Date;
  childProjectId: string | null;
  childWorkstream: string;
  parentProjectId: string | null;
  parentWorkstream: string | null;
}

export interface TreeNode<T> {
  spawn: T;
  /** 0 for the root, 1 for its children, … */
  level: number;
}

export interface SpawnTree<T> {
  rootId: string;
  createdAt: Date;
  /** Depth-first, oldest sibling first, so the list reads top to bottom as the tree. */
  nodes: TreeNode<T>[];
}

const where = (projectId: string | null, workstream: string | null) => `${projectId ?? ''}\u0000${workstream ?? 'main'}`;

export function buildSpawnTrees<T extends TreeInput>(rows: T[]): SpawnTree<T>[] {
  const byRoot = new Map<string, T[]>();
  for (const r of rows) {
    const root = r.rootSpawnId ?? r.id;
    const list = byRoot.get(root) ?? [];
    list.push(r);
    byRoot.set(root, list);
  }
  const trees: SpawnTree<T>[] = [];
  for (const [rootId, members] of byRoot) {
    // Each member is the child of whichever member made the workstream it was spawned from.
    const madeHere = new Map<string, T>();
    for (const m of members) if (m.childProjectId) madeHere.set(where(m.childProjectId, m.childWorkstream), m);
    const children = new Map<string, T[]>();
    const tops: T[] = [];
    for (const m of members) {
      const parent = m.parentProjectId ? madeHere.get(where(m.parentProjectId, m.parentWorkstream)) : undefined;
      if (parent && parent.id !== m.id) {
        const list = children.get(parent.id) ?? [];
        list.push(m);
        children.set(parent.id, list);
      } else {
        tops.push(m);
      }
    }
    const byAge = (a: T, b: T) => a.createdAt.getTime() - b.createdAt.getTime();
    const nodes: TreeNode<T>[] = [];
    const seen = new Set<string>();
    const walk = (m: T, level: number) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      nodes.push({ spawn: m, level });
      for (const c of (children.get(m.id) ?? []).sort(byAge)) walk(c, level + 1);
    };
    for (const t of tops.sort(byAge)) walk(t, 0);
    const first = nodes[0]?.spawn;
    trees.push({ rootId, createdAt: first ? first.createdAt : new Date(0), nodes });
  }
  return trees.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export interface TokenRow {
  projectId: string | null;
  workstream: string | null;
  date: string;
  input: bigint | number;
  output: bigint | number;
  cacheRead: bigint | number;
  cacheCreate: bigint | number;
  reasoning: bigint | number;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * A spawned workstream's tokens from the day it was spawned, keyed by
 * (project, workstream). Reasoning folds into output, as the usage report
 * does. A main-workstream child (a project target) counts its project's main.
 */
export function tokensBySpawn<T extends TreeInput>(spawns: T[], rows: TokenRow[]): Map<string, TokenTotals> {
  const out = new Map<string, TokenTotals>();
  const want = new Map<string, { id: string; since: string }[]>();
  for (const s of spawns) {
    if (!s.childProjectId) continue;
    const key = where(s.childProjectId, s.childWorkstream);
    const list = want.get(key) ?? [];
    list.push({ id: s.id, since: s.createdAt.toISOString().slice(0, 10) });
    want.set(key, list);
  }
  for (const r of rows) {
    for (const w of want.get(where(r.projectId, r.workstream)) ?? []) {
      if (r.date < w.since) continue;
      const t = out.get(w.id) ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      t.input += Number(r.input);
      t.output += Number(r.output) + Number(r.reasoning);
      t.cacheRead += Number(r.cacheRead);
      t.cacheCreate += Number(r.cacheCreate);
      out.set(w.id, t);
    }
  }
  return out;
}
