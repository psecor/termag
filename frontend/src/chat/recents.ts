// What a new tab lists in its main pane (simple-ui-side-panel-enabled, beside the
// panel's Files): the space's files and agents the person had open, most
// recently opened first, then the space's other agents, most recently active
// first. Picking one shows it in that tab.
import { chatSpace, itemKey, type OpenItem } from './openItems';

export const RECENTS_MAX = 20;

export type Recent =
  | { kind: 'chat'; projectId: string; workstream: string; space: string }
  | { kind: 'file'; space: string; path: string };

export interface RecentAgent { projectId: string; workstream: string; instanceId: string | null; lastActiveAt: number | null }

/**
 * `space`'s recents: its file and agent tabs by `openedAt`, newest first,
 * one per thing shown, then `agents` whose box reaches the space and that no
 * tab shows, by `lastActiveAt`, newest first (never active last).
 */
export function spaceRecents(
  items: readonly OpenItem[],
  space: string,
  agents: readonly RecentAgent[],
  known: ReadonlySet<string>,
  index: ReadonlyMap<string, readonly string[]>,
  max = RECENTS_MAX,
): Recent[] {
  const boxOf = new Map(agents.map(a => [`${a.projectId}|${a.workstream}`, a.instanceId]));
  const out: Recent[] = [];
  const seen = new Set<string>();
  const add = (r: Recent) => {
    const k = itemKey(r);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  for (const item of [...items].sort((a, b) => b.openedAt - a.openedAt)) {
    if (item.kind === 'file' && item.space === space) add({ kind: 'file', space, path: item.path });
    if (item.kind === 'chat') {
      const box = boxOf.get(`${item.projectId}|${item.workstream}`);
      if (box === undefined) continue;
      if (chatSpace(item, box, known, index) === space) add({ kind: 'chat', projectId: item.projectId, workstream: item.workstream, space });
    }
  }
  const reaches = (box: string | null) => box != null && (index.get(box) ?? []).includes(space);
  for (const a of [...agents].sort((x, y) => (y.lastActiveAt ?? -Infinity) - (x.lastActiveAt ?? -Infinity))) {
    if (reaches(a.instanceId)) add({ kind: 'chat', projectId: a.projectId, workstream: a.workstream, space });
  }
  return out.slice(0, max);
}
