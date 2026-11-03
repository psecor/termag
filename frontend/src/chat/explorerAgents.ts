// The agents in a space's explorer (simple-ui-side-panel-enabled), beside its
// files: every agent whose box reaches the space, with the agents another
// agent started nested under it the way files nest in
// folders. Agents whose box doesn't reach the space aren't listed.

/** One agent started by another: the child session and the session that started it. */
export interface SpawnLink { projectId: string; workstream: string; parentProjectId: string; parentWorkstream: string }

export interface AgentRowLike {
  projectId: string; workstream: string; projectName: string; instanceId: string | null;
  /** An ask thread's chat: the thread's title and id (mobile/inbox.ts InboxRow). */
  askTitle?: string | null; askThreadId?: string | null;
}

export interface AgentNode<R> { row: R; children: Array<AgentNode<R>> }


const keyOf = (r: { projectId: string; workstream: string }) => `${r.projectId}|${r.workstream}`;

type Named = Pick<AgentRowLike, 'workstream' | 'askTitle' | 'askThreadId'>;

/**
 * What a workstream is called on screen: an ask thread's title in place of
 * its `ask-<thread>` name, which stays the workstream's real name (tmux
 * sessions, routes and status are keyed on it), else the name: an untitled
 * ask shows as `ask-<thread id>`.
 */
export function workstreamLabel(r: Named): string {
  return r.askTitle?.trim() || r.workstream;
}

/** The tooltip for a workstream's label: an ask thread's id and workstream, which its title hides; else null. */
export function workstreamTip(r: Named & { projectName?: string }): string | null {
  if (!r.askThreadId) return null;
  const where = r.projectName ? `${r.projectName} · ${r.workstream}` : r.workstream;
  return r.askTitle?.trim() ? `ask thread ${r.askThreadId} (${where})` : `ask thread ${r.askThreadId}`;
}

/**
 * A session's name in a list: the project, with the workstream when it is not
 * main. An ask thread is called by its title alone, else by its thread id
 * (ask-<thread id>, the workstream's name): callers name their threads and
 * nothing is derived. The project and box it runs in are the ask's plumbing
 * (both in the tooltip), and in the tree it sits under the session that sent it.
 */
export function agentLabel(r: Pick<AgentRowLike, 'projectName'> & Named): string {
  if (r.askThreadId) return workstreamLabel(r);
  return r.workstream === 'main' ? r.projectName : `${r.projectName} · ${workstreamLabel(r)}`;
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

