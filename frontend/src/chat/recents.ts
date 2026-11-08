// What a new tab lists in its main pane (beside the
// panel's Files): the space's files and agents the person had open, most
// recently opened first, then the space's other agents, most recently active
// first. Picking one shows it in that tab. An agent is the space's when it
// belongs to it (chatSpaces.ts chatHomeSpace), not when its box reaches it,
// or when it belongs to none and its tab was opened from the space (OpenItem.openedIn).
import { chatHomeSpace, type ChatPlace } from './chatSpaces';
import { itemKey, type OpenItem } from './openItems';

export const RECENTS_MAX = 20;

export type Recent =
  | { kind: 'chat'; projectId: string; workstream: string }
  | { kind: 'file'; space: string; path: string };

export interface RecentAgent extends ChatPlace { projectId: string; workstream: string; lastActiveAt: number | null }

/**
 * `space`'s recents: its file and agent tabs by `openedAt`, newest first,
 * one per thing shown, then `agents` that belong to the space and that no
 * tab shows, by `lastActiveAt`, newest first (never active last).
 */
export function spaceRecents(
  items: readonly OpenItem[],
  space: string,
  agents: readonly RecentAgent[],
  spaces: ReadonlyArray<{ id: string; name: string }>,
  index: ReadonlyMap<string, readonly string[]>,
  max = RECENTS_MAX,
): Recent[] {
  const homeOf = new Map(agents.map(a => [`${a.projectId}|${a.workstream}`, chatHomeSpace(a, spaces, index)]));
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
    const home = item.kind === 'chat' ? homeOf.get(`${item.projectId}|${item.workstream}`) : undefined;
    if (item.kind === 'chat' && (home === space || (home === null && item.openedIn === space))) {
      add({ kind: 'chat', projectId: item.projectId, workstream: item.workstream });
    }
  }
  for (const a of [...agents].sort((x, y) => (y.lastActiveAt ?? -Infinity) - (x.lastActiveAt ?? -Infinity))) {
    if (homeOf.get(`${a.projectId}|${a.workstream}`) === space) add({ kind: 'chat', projectId: a.projectId, workstream: a.workstream });
  }
  return out.slice(0, max);
}
