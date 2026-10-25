// The agents in a space's explorer (simple-ui-side-panel-enabled), beside its
// files: every agent whose box reaches the space, with the agents another
// agent started nested under it the way files nest in
// folders. Agents whose box doesn't reach the space aren't listed.

/** One agent started by another: the child session and the session that started it. */
export interface SpawnLink { projectId: string; workstream: string; parentProjectId: string; parentWorkstream: string }

export interface AgentRowLike { projectId: string; workstream: string; projectName: string; instanceId: string | null }

export interface AgentNode<R> { row: R; children: Array<AgentNode<R>> }


const keyOf = (r: { projectId: string; workstream: string }) => `${r.projectId}|${r.workstream}`;

export function agentLabel(r: Pick<AgentRowLike, 'projectName' | 'workstream'>): string {
  return r.workstream === 'main' ? r.projectName : `${r.projectName} · ${r.workstream}`;
}

const byLabel = <R extends AgentRowLike>(a: R, b: R) => agentLabel(a).localeCompare(agentLabel(b));

/**
 * `rows` as a tree, by name at each level: an agent whose starter is in
 * `rows` too is under it, every other agent is at the top.
 */
export function agentForest<R extends AgentRowLike>(rows: readonly R[], links: readonly SpawnLink[]): Array<AgentNode<R>> {
  const here = new Map(rows.map(r => [keyOf(r), r]));
  const parentOf = new Map<string, string>();
  for (const l of links) {
    const child = keyOf(l);
    const parent = `${l.parentProjectId}|${l.parentWorkstream}`;
    if (child !== parent && here.has(child) && here.has(parent)) parentOf.set(child, parent);
  }
  // A loop in the links (a parent under its own child) puts its members at the top.
  const rooted = (k: string) => {
    const seen = new Set([k]);
    for (let p = parentOf.get(k); p; p = parentOf.get(p)) {
      if (seen.has(p)) return false;
      seen.add(p);
    }
    return true;
  };
  const kids = new Map<string, R[]>();
  const top: R[] = [];
  for (const r of rows) {
    const k = keyOf(r);
    const p = parentOf.get(k);
    if (p && rooted(k)) kids.set(p, [...(kids.get(p) ?? []), r]);
    else top.push(r);
  }
  const node = (r: R): AgentNode<R> => ({ row: r, children: (kids.get(keyOf(r)) ?? []).sort(byLabel).map(node) });
  return [...top].sort(byLabel).map(node);
}

/** A space's agents for its explorer, as a tree: only those whose box reaches `space`. */
export function explorerAgents<R extends AgentRowLike>(
  rows: readonly R[], space: string, index: ReadonlyMap<string, readonly string[]>, links: readonly SpawnLink[],
): Array<AgentNode<R>> {
  return agentForest(rows.filter(r => r.instanceId != null && (index.get(r.instanceId) ?? []).includes(space)), links);
}

/** The agents among `nodes` (at any depth) whose name has every word of `query`, in tree order. */
export function searchAgents<R extends AgentRowLike>(nodes: ReadonlyArray<AgentNode<R>>, query: string): R[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: R[] = [];
  const walk = (list: ReadonlyArray<AgentNode<R>>) => {
    for (const n of list) {
      const name = agentLabel(n.row).toLowerCase();
      if (words.every(w => name.includes(w))) out.push(n.row);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

