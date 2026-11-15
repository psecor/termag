// Which sessions leave the redesigned sidebar's list for Archived
// ("What Archive archives"). Pure, so it's tested
// on its own; pages/chat/ProjectsList.tsx draws the two.
import type { SpawnLink } from './explorerAgents';

interface ArchivableRow {
  key: string;
  projectId: string;
  workstream: string;
  /** Archived from its card or a space's Files (Workstream.explorerArchivedAt). */
  explorerArchived?: boolean;
  shared: boolean;
}

/**
 * The keys of the sessions Archived lists: each one the person archived, with
 * every session under it (its asks and spawns, by `links`), unless it or one
 * under it `keep`s (it's working, needs you or is open), as a space's Files
 * splits them (chat/explorerAgents.ts splitArchived), so a parent and its
 * working child stay together. A shared session stays where it is: its owner
 * archived it, and only the owner can unarchive it.
 */
export function archivedOutKeys<R extends ArchivableRow>(rows: readonly R[], links: readonly SpawnLink[], keep: (r: R) => boolean): Set<string> {
  const byKey = new Map(rows.map(r => [r.key, r]));
  const children = new Map<string, string[]>();
  for (const l of links) {
    const parent = `${l.parentProjectId}|${l.parentWorkstream}`;
    const child = `${l.projectId}|${l.workstream}`;
    if (!byKey.has(parent) || !byKey.has(child) || parent === child) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  // Whether it, or any session under it, keeps; a link loop counts each session once.
  const live = (key: string, seen = new Set<string>()): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    const r = byKey.get(key);
    return (r !== undefined && keep(r)) || (children.get(key) ?? []).some(k => live(k, seen));
  };
  const out = new Set<string>();
  const take = (key: string) => {
    if (out.has(key)) return;
    out.add(key);
    for (const k of children.get(key) ?? []) take(k);
  };
  for (const r of rows) if (r.explorerArchived && !r.shared && !live(r.key)) take(r.key);
  return out;
}

/**
 * The archived sessions to clear when `key` is unarchived: it, and every session under it in Archived that carries
 * a mark of its own, so the whole subtree comes back together (only its top offers Unarchive).
 */
export function unarchiveKeys<R extends ArchivableRow>(key: string, archived: readonly R[], links: readonly SpawnLink[]): R[] {
  const byKey = new Map(archived.map(r => [r.key, r]));
  const children = new Map<string, string[]>();
  for (const l of links) {
    const parent = `${l.parentProjectId}|${l.parentWorkstream}`;
    const child = `${l.projectId}|${l.workstream}`;
    if (byKey.has(parent) && byKey.has(child) && parent !== child) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const out: R[] = [];
  const seen = new Set<string>();
  const walk = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    const r = byKey.get(k);
    if (r?.explorerArchived) out.push(r);
    for (const c of children.get(k) ?? []) walk(c);
  };
  walk(key);
  return out;
}
