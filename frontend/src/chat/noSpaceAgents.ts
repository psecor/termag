// The explorer of agents in no space (simple-ui-side-panel-enabled,
// pages/chat/AgentsExplorer.tsx): a space's explorer has its agents beside
// its files, and agents in no space (chatSpaces.ts chatHomeSpace) have no
// file store, so theirs lists only agents, nested as a space's are
// (explorerAgents.ts). For a person with no spaces, or with spaces off, that
// is every agent.
import { chatHomeSpace, type ChatPlace } from './chatSpaces';
import { agentForest, type AgentNode, type AgentRowLike, type SpawnLink } from './explorerAgents';
import { itemKey, type OpenItem } from './openItems';
import { RECENTS_MAX, type RecentAgent } from './recents';

/** Whether a box's spaces are known yet (boxesKnown); by default, every box's. */
export type BoxKnown = (box: string | null) => boolean;
const allKnown: BoxKnown = () => true;

/**
 * Whether a chat is in no space (chatHomeSpace null). One the server hasn't
 * fixed yet goes by its box, and a box whose spaces aren't known yet
 * (`boxKnown`: a new box while the index reloads) is left out rather than
 * shown in no space.
 */
function inNoSpace(
  place: ChatPlace, spaces: ReadonlyArray<{ id: string; name: string }>, index: ReadonlyMap<string, readonly string[]>, boxKnown: BoxKnown,
): boolean {
  return (place.spaceFixed || boxKnown(place.instanceId)) && chatHomeSpace(place, spaces, index) === null;
}

/** The agents in `rows` that belong to none of the user's `spaces`. */
export function noSpaceRows<R extends AgentRowLike & ChatPlace>(
  rows: readonly R[], spaces: ReadonlyArray<{ id: string; name: string }>, index: ReadonlyMap<string, readonly string[]>, boxKnown: BoxKnown = allKnown,
): R[] {
  return rows.filter(r => inNoSpace(r, spaces, index, boxKnown));
}

/** Boxes seen while the index was current: it had them then, in a space or in none. For the page's life. */
const settledBoxes = new Set<string>();

/**
 * Remembers `boxes` as settled when the index is `current`. The sidebar
 * (OpenItems.tsx) calls it on every change, so the boxes are known even
 * when Agents and the side panel first open during a reload.
 */
export function noteSettledBoxes(boxes: Iterable<string | null | undefined>, current: boolean): void {
  if (current) for (const b of boxes) if (b) settledBoxes.add(b);
}

/**
 * Which boxes' spaces are known. While the index reloads for a new box
 * (useChatSpaces' `current` false) it lacks that box, and it never has
 * boxes in no space, so absence alone means nothing: a box is known when
 * the index is current, or has it, or it was among `boxes` while the
 * index was current. With no spaces at all, every box is in no space.
 */
export function boxesKnown(
  boxes: Iterable<string | null | undefined>, index: ReadonlyMap<string, readonly string[]>, current: boolean, hasSpaces: boolean,
): BoxKnown {
  noteSettledBoxes(boxes, current);
  if (current || !hasSpaces) return allKnown;
  return box => box == null || index.has(box) || settledBoxes.has(box);
}

/** The explorer's tree: the agents in no space, an agent another started under it. */
export function noSpaceAgents<R extends AgentRowLike & ChatPlace>(
  rows: readonly R[], spaces: ReadonlyArray<{ id: string; name: string }>, index: ReadonlyMap<string, readonly string[]>, links: readonly SpawnLink[],
  boxKnown: BoxKnown = allKnown,
): Array<AgentNode<R>> {
  return agentForest(noSpaceRows(rows, spaces, index, boxKnown), links);
}

export type NoSpaceRecent = { kind: 'chat'; projectId: string; workstream: string };

/**
 * A new tab's recents (as recents.spaceRecents for a space): the agents in
 * no space that a tab shows, most recently opened first, then the others,
 * most recently active first (never active last).
 */
export function noSpaceRecents(
  items: readonly OpenItem[],
  agents: readonly RecentAgent[],
  spaces: ReadonlyArray<{ id: string; name: string }>,
  index: ReadonlyMap<string, readonly string[]>,
  max = RECENTS_MAX,
  boxKnown: BoxKnown = allKnown,
): NoSpaceRecent[] {
  const here = new Map(agents.filter(a => inNoSpace(a, spaces, index, boxKnown)).map(a => [`${a.projectId}|${a.workstream}`, a]));
  const out: NoSpaceRecent[] = [];
  const seen = new Set<string>();
  const add = (a: { projectId: string; workstream: string }) => {
    const r: NoSpaceRecent = { kind: 'chat', projectId: a.projectId, workstream: a.workstream };
    const k = itemKey(r);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  for (const item of [...items].sort((a, b) => b.openedAt - a.openedAt)) {
    if (item.kind !== 'chat') continue;
    const a = here.get(`${item.projectId}|${item.workstream}`);
    if (a) add(a);
  }
  for (const a of [...here.values()].sort((x, y) => (y.lastActiveAt ?? -Infinity) - (x.lastActiveAt ?? -Infinity))) add(a);
  return out.slice(0, max);
}
