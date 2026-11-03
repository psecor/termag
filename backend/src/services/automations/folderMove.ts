/**
 * The one-off move of automations from their old folders to the fixed one,
 * `.termag/automations/<automation id>` (spaceFolder.ts). Run by scripts/moveAutomationFolders.ts after the deploy;
 * dry by default, and safe to run again.
 *
 * Moved, because the notes are what the runs have learned and starting
 * fresh would throw that away: only the files termag itself keeps there
 * (MOVED_FILES), with the space's own server-side copy then delete, as
 * `termag space mv` does, so no byte passes through the orchestrator.
 * Anything else in the old folder (a run's outputs/, a person's files) stays
 * where people may link to it. The copy is the current version; the old
 * path's earlier versions stay in the bucket under it (noncurrent versions
 * never expire).
 *
 * The row keeps its old folder, which the runs keep using, until every file
 * is across; only then does it say the fixed one. So a row that is skipped
 * (a run live or just finished, whose push may still be landing), refused (a
 * file already at the fixed path) or failed part way is still whole, and the
 * next run of the script picks it up.
 */
import { legacyFolderOf, spaceFolderFor } from './spaceFolder';

/** The files termag keeps in an automation's folder (spaceSync.ts), relative to it; runs/ is a folder. */
export const MOVED_FILES = ['memory/MEMORY.md', 'state.json', 'README.md'] as const;
export const MOVED_FOLDERS = ['runs/'] as const;
/** A run that finished this recently may still be pushing its notes to the old folder. */
export const SETTLE_MS = 15 * 60_000;

export interface MovableRow { id: string; projectId: string; userId: string; spaceName: string | null; spaceFolder: string | null }

export interface FolderObjects {
  /** The paths (relative to the space) under `prefix`, every page. */
  listPaths(prefix: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  copy(from: string, to: string): Promise<void>;
  /** The paths it could not delete. */
  remove(paths: string[]): Promise<string[]>;
}

export interface FolderMoveDeps {
  rows(): Promise<MovableRow[]>;
  /** Whether a run is live, or finished within SETTLE_MS. */
  busy(automationId: string): Promise<boolean>;
  /** The space's objects, or null when the space is gone. */
  space(name: string): Promise<{ id: string; objects: FolderObjects } | null>;
  setFolder(automationId: string, folder: string): Promise<void>;
  /** A `file.mv` event in the space's audit, as the move route records one. */
  event(spaceId: string, actorUserId: string, path: string, note: string): Promise<void>;
}

export type MoveOutcome =
  | { id: string; result: 'moved'; from: string; to: string; files: string[] }
  | { id: string; result: 'would_move'; from: string; to: string; files: string[] }
  | { id: string; result: 'skipped'; reason: 'busy' | 'space_gone' }
  | { id: string; result: 'refused'; reason: 'target_exists'; paths: string[] }
  | { id: string; result: 'failed'; reason: string };

export const MOVE_NOTE = "termag moved the automation's files to its fixed folder";

/** The rows to look at: in a space, and not yet in their fixed folder. */
export function needsMove(r: MovableRow): boolean {
  return !!r.spaceName && r.spaceFolder !== spaceFolderFor(r.id);
}

/** The files of `listed` (paths under `from/`) that termag moves, relative to the folder. */
export function movedOf(from: string, listed: string[]): string[] {
  const prefix = `${from}/`;
  return listed
    .filter(p => p.startsWith(prefix))
    .map(p => p.slice(prefix.length))
    .filter(rel => (MOVED_FILES as readonly string[]).includes(rel) || MOVED_FOLDERS.some(d => rel.startsWith(d) && rel.length > d.length && !rel.slice(d.length).includes('/')))
    .sort();
}

export async function moveAutomationFolders(deps: FolderMoveDeps, opts: { apply: boolean }): Promise<MoveOutcome[]> {
  const out: MoveOutcome[] = [];
  for (const r of (await deps.rows()).filter(needsMove)) {
    // An unbackfilled row (a space, no folder) has its notes where the one-file mirror put them.
    const from = r.spaceFolder ?? legacyFolderOf(r);
    const to = spaceFolderFor(r.id);
    try {
      if (await deps.busy(r.id)) { out.push({ id: r.id, result: 'skipped', reason: 'busy' }); continue; }
      const space = await deps.space(r.spaceName!);
      if (!space) { out.push({ id: r.id, result: 'skipped', reason: 'space_gone' }); continue; }
      const files = movedOf(from, await space.objects.listPaths(`${from}/`));
      const taken: string[] = [];
      for (const rel of files) if (await space.objects.exists(`${to}/${rel}`)) taken.push(`${to}/${rel}`);
      if (taken.length) { out.push({ id: r.id, result: 'refused', reason: 'target_exists', paths: taken }); continue; }
      if (!opts.apply) { out.push({ id: r.id, result: 'would_move', from, to, files }); continue; }
      for (const rel of files) await space.objects.copy(`${from}/${rel}`, `${to}/${rel}`);
      // A run that started meanwhile reads and writes the old folder: back the copies out and leave the row.
      if (await deps.busy(r.id)) {
        await space.objects.remove(files.map(rel => `${to}/${rel}`));
        out.push({ id: r.id, result: 'skipped', reason: 'busy' });
        continue;
      }
      // Every file is at the fixed path: the row may say so. A delete that fails leaves a stale copy, not a lost one.
      await deps.setFolder(r.id, to);
      const left = await space.objects.remove(files.map(rel => `${from}/${rel}`));
      if (files.length) await deps.event(space.id, r.userId, `${from}/ -> ${to}/`, MOVE_NOTE);
      if (left.length) out.push({ id: r.id, result: 'failed', reason: `moved, but could not delete ${left.join(', ')}` });
      else out.push({ id: r.id, result: 'moved', from, to, files });
    } catch (err) {
      out.push({ id: r.id, result: 'failed', reason: (err as Error).message });
    }
  }
  return out;
}
