// Spaces in the simple UI: New chat's optional space step
// and the sidebar's grouping by space. One space per box is a simple-UI
// convention only: New chat grants a box one space, and the backend stays
// many-to-many, so a box the full UI gave a second space is shown under the
// first by name with the others noted.
import type { SpaceBoxGrant, SpaceView } from '../services/api';
import { roleAtLeast, SPACE_NAME_HINT, SPACE_NAME_RE } from '../utils/spaces';

export type SpaceChoice =
  | { kind: 'none' }
  | { kind: 'existing'; name: string }
  | { kind: 'new'; name: string };

export const NO_SPACE: SpaceChoice = { kind: 'none' };

/** What the closed space control shows. No space is a real choice, so it is named, not prompted. */
export function spaceTriggerLabel(choice: SpaceChoice): string {
  if (choice.kind === 'existing') return choice.name;
  if (choice.kind === 'new') return choice.name.trim() || 'New space';
  return 'No space';
}

/** Spaces a new chat's box can be put in: the user is an editor or owner, and the space is not read-only. */
export function pickableSpaces(spaces: readonly SpaceView[]): SpaceView[] {
  return spaces
    .filter(s => !s.readOnly && s.role && roleAtLeast(s.role, 'editor'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a new chat can go in `name`; the sidebar offers its `+` only then. */
export function canStartChatIn(name: string, spaces: readonly SpaceView[]): boolean {
  return pickableSpaces(spaces).some(s => s.name === name);
}

/**
 * The choice New chat starts with: the space named in `?space=`, else the one
 * the last chat went in (`remembered`), whichever the user can still use first;
 * else none.
 */
export function initialSpaceChoice(requested: string | null, spaces: readonly SpaceView[], remembered: string | null = null): SpaceChoice {
  for (const name of [requested, remembered]) {
    if (name && canStartChatIn(name, spaces)) return { kind: 'existing', name };
  }
  return NO_SPACE;
}

/**
 * What the new-space field keeps of what was typed: lowercase, spaces and
 * underscores as dashes, nothing a space name can't hold. A trailing dash
 * stays while typing; `spaceNameOf` drops it.
 */
export function slugifySpaceName(raw: string): string {
  return raw.toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40);
}

/** The space name a choice's text stands for. */
export function spaceNameOf(text: string): string {
  return text.trim().replace(/^-+|-+$/g, '');
}

/** Why Start can't go ahead with this choice, or '' when it can. */
export function spaceChoiceError(choice: SpaceChoice, spaces: readonly SpaceView[], created: ReadonlySet<string> = new Set()): string {
  if (choice.kind === 'none') return '';
  const name = choice.kind === 'new' ? spaceNameOf(choice.name) : choice.name.trim();
  if (choice.kind === 'existing') {
    return pickableSpaces(spaces).some(s => s.name === name) ? '' : 'Pick a space';
  }
  if (!name) return 'Name the new space';
  if (!SPACE_NAME_RE.test(name)) return `A space name is ${SPACE_NAME_HINT}`;
  if (!created.has(name) && spaces.some(s => s.name === name)) return `You already have a space named ${name}; pick it from the list`;
  return '';
}

export interface SpaceGrantApi {
  create(name: string): Promise<unknown>;
  addBox(space: string, box: string): Promise<unknown>;
}

/**
 * The space a new chat goes in, creating it first for a new one. A space this
 * page already created (`created`) is not created again, so a retry after a
 * later step failed reuses it. Null for no space.
 */
export async function ensureSpace(choice: SpaceChoice, created: ReadonlySet<string>, api: SpaceGrantApi, onCreated: (name: string) => void): Promise<string | null> {
  if (choice.kind === 'none') return null;
  const name = choice.kind === 'new' ? spaceNameOf(choice.name) : choice.name.trim();
  if (choice.kind === 'new' && !created.has(name)) {
    await api.create(name);
    onCreated(name);
  }
  return name;
}

/**
 * Gives the chat's new box editor access to its space before the project
 * exists, so Claude's first turn already reaches it. The grant is an upsert,
 * so a retry is safe; the box acts with its owner's role, which the space
 * step only offers at editor or above.
 */
export async function grantBox(space: string | null, boxId: string, api: SpaceGrantApi): Promise<void> {
  if (space) await api.addBox(space, boxId);
}

/** Box id → names of the spaces it reaches, explicit grants first, then inherited, each by name. */
export function boxSpaceIndex(entries: ReadonlyArray<{ space: string; boxes: readonly SpaceBoxGrant[] }>): Map<string, string[]> {
  const explicit = new Map<string, Set<string>>();
  const inherited = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, box: string, space: string) => {
    let set = m.get(box);
    if (!set) m.set(box, set = new Set());
    set.add(space);
  };
  for (const { space, boxes } of entries) {
    for (const b of boxes) {
      add(explicit, b.id, space);
      for (const c of b.children) add(inherited, c.id, space);
    }
  }
  const out = new Map<string, string[]>();
  for (const id of new Set([...explicit.keys(), ...inherited.keys()])) {
    const own = [...(explicit.get(id) ?? [])].sort();
    const via = [...(inherited.get(id) ?? [])].filter(s => !own.includes(s)).sort();
    out.set(id, [...own, ...via]);
  }
  return out;
}

export interface SpaceGroupRow<R> { row: R; alsoIn: string[] }
export interface SpaceGroup<R> { space: string | null; rows: Array<SpaceGroupRow<R>> }

/**
 * The sidebar's chats grouped by their box's space: spaces by name, then
 * "No space" for chats whose box has none. Order within a group is the
 * order given. Empty spaces are left out.
 */
export function groupBySpace<R extends { instanceId: string | null }>(rows: readonly R[], index: ReadonlyMap<string, readonly string[]>): Array<SpaceGroup<R>> {
  const bySpace = new Map<string, Array<SpaceGroupRow<R>>>();
  const ungrouped: Array<SpaceGroupRow<R>> = [];
  for (const row of rows) {
    const spaces = row.instanceId ? index.get(row.instanceId) ?? [] : [];
    if (spaces.length === 0) { ungrouped.push({ row, alsoIn: [] }); continue; }
    const [first, ...rest] = spaces;
    let list = bySpace.get(first);
    if (!list) bySpace.set(first, list = []);
    list.push({ row, alsoIn: rest });
  }
  const groups: Array<SpaceGroup<R>> = [...bySpace.keys()].sort().map(space => ({ space, rows: bySpace.get(space)! }));
  if (ungrouped.length > 0) groups.push({ space: null, rows: ungrouped });
  return groups;
}

/**
 * The space a chat's header names: its box's first space, as the sidebar
 * groups it, with the others noted. Null when the box has none.
 */
export function spaceOfBox(instanceId: string | null | undefined, index: ReadonlyMap<string, readonly string[]>): { space: string; alsoIn: string[] } | null {
  const [space, ...alsoIn] = (instanceId && index.get(instanceId)) || [];
  return space ? { space, alsoIn } : null;
}

// Which sidebar groups are folded, by space name, kept in localStorage so a
// group stays folded across reloads. "No space" is stored as NO_SPACE_KEY,
// which no space name can be (SPACE_NAME_RE).
export const COLLAPSED_SPACES_KEY = 'termag.chat.collapsedSpaces';
const NO_SPACE_KEY = '(none)';

export function groupKey(space: string | null): string {
  return space ?? NO_SPACE_KEY;
}

export function readCollapsedSpaces(storage: Pick<Storage, 'getItem'> | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(COLLAPSED_SPACES_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Folds or unfolds one group, saves the result, and returns it. A storage failure keeps the fold for this page only. */
export function toggleCollapsedSpace(collapsed: ReadonlySet<string>, key: string, storage: Pick<Storage, 'setItem'> | null): Set<string> {
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key); else next.add(key);
  try { storage?.setItem(COLLAPSED_SPACES_KEY, JSON.stringify([...next].sort())); } catch { /* private mode, quota */ }
  return next;
}
