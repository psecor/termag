// The side panel's Files under the sidebar redesign (pages/chat/FilesTool.tsx):
// its Open list, this browser's file tabs and
// new tabs (chat/openItems.ts) in the person's order, which the sidebar's Files
// group listed before; and whether that list is folded, kept per browser.
import { NO_SPACE_EXPLORER, type OpenItem } from './openItems';

export const FILES_TOOL_OPEN_FOLDED_KEY = 'termag.chat.filesTool.openFolded';

type ReadStorage = Pick<Storage, 'getItem'> | null | undefined;
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'> | null | undefined;

/** A file tab or a new tab. */
export type FileTab = Extract<OpenItem, { space: string }>;

/** The file tabs and new tabs, in the person's order; sessions are the sidebar's. */
export function filesToolOpenItems(items: readonly OpenItem[]): FileTab[] {
  return items.filter((i): i is FileTab => i.kind !== 'chat');
}

/** A row's name: a file's own name, "Agents" for the agents in no space (/chat/agents), else "New tab". */
export function openItemName(item: OpenItem): string {
  if (item.kind === 'file') return item.path.slice(item.path.lastIndexOf('/') + 1) || item.path;
  if (item.kind === 'explorer' && item.space === NO_SPACE_EXPLORER) return 'Agents';
  return 'New tab';
}

/** What a row says beside its name, muted: a file's folder (none at the top), a new tab's space (none for the agents in no space). */
export function openItemWhere(item: OpenItem): string | null {
  if (item.kind === 'file') return item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : null;
  if (item.kind === 'explorer') return item.space === NO_SPACE_EXPLORER ? null : item.space;
  return null;
}

/** A row's tooltip: a file's space:path, a new tab's "<space>'s recent files and agents". */
export function openItemTip(item: OpenItem): string {
  if (item.kind === 'file') return `${item.space}:${item.path}`;
  if (item.kind === 'explorer') return item.space === NO_SPACE_EXPLORER ? 'The agents in no space' : `${item.space}'s recent files and agents`;
  return '';
}

/** Other spaces is folded until the person unfolds it (project-files-enabled); this keeps that it's open. */
export const FILES_TOOL_OTHER_OPEN_KEY = 'termag.chat.filesTool.otherOpen';

/** A yes kept per browser under `key`: only a yes is written, so no is the default. */
export function readStoredYes(storage: ReadStorage, key: string): boolean {
  try { return storage?.getItem(key) === '1'; } catch { return false; }
}

export function writeStoredYes(storage: WriteStorage, key: string, yes: boolean): void {
  try {
    if (yes) storage?.setItem(key, '1');
    else storage?.removeItem(key);
  } catch { /* private mode: not remembered */ }
}

/** Folded only once the person folded it; unfolded is the default. */
export const readOpenFolded = (storage: ReadStorage): boolean => readStoredYes(storage, FILES_TOOL_OPEN_FOLDED_KEY);
export const writeOpenFolded = (storage: WriteStorage, folded: boolean): void => writeStoredYes(storage, FILES_TOOL_OPEN_FOLDED_KEY, folded);

// ---- Project files | My files (project-files-enabled, part B) ----

/** What the tool explores: the project's files, the person's My files, or another space they reach, by name. */
export type FilesChoice = { kind: 'project' } | { kind: 'mine' } | { kind: 'other'; space: string };

/** A project the person owns, as far as Files needs it: its id and its files' space, if it has one yet. */
export interface FilesProject { id: string; filesSpace: string | null }

/**
 * Whose Project files the tool shows: the open session's project (one of the person's own), else the project whose
 * files a file page is in, else (beside My files) the project last shown. Null where Files is as before: an
 * automation's run, a session shared with you, a space that is neither.
 */
export function filesProjectOf(at: {
  /** The open session's project (Project.userProjectId), only on the person's own checkout. */
  sessionProject?: string | null;
  /** The space a file page or new tab is in. */
  space?: string | null;
  projects: readonly FilesProject[];
  myFiles: string | null;
  /** The project Files last showed Project files for, in this page. */
  lastProject?: string | null;
}): string | null {
  const { sessionProject, space, projects, myFiles, lastProject } = at;
  if (sessionProject) return projects.some(p => p.id === sessionProject) ? sessionProject : null;
  if (!space) return null;
  const owner = projects.find(p => p.filesSpace === space);
  if (owner) return owner.id;
  if (myFiles && space === myFiles && lastProject && projects.some(p => p.id === lastProject)) return lastProject;
  return null;
}

/** The choice a place opens on: a file page's own (My files or another space), else Project files. */
export function initialFilesChoice(space: string | null | undefined, project: FilesProject | null, myFiles: string | null): FilesChoice {
  if (space && myFiles && space === myFiles) return { kind: 'mine' };
  if (space && project?.filesSpace !== space && space !== myFiles) return { kind: 'other', space };
  return { kind: 'project' };
}

/**
 * Other spaces: the spaces the person reaches that are neither a project's files of theirs nor their My files, by
 * name (team spaces, spaces shared with them).
 */
export function otherSpaces(spaces: ReadonlyArray<{ name: string }>, projects: readonly FilesProject[], myFiles: string | null): string[] {
  const taken = new Set<string>(projects.flatMap(p => (p.filesSpace ? [p.filesSpace] : [])));
  if (myFiles) taken.add(myFiles);
  return spaces.map(s => s.name).filter(n => !taken.has(n)).sort((a, b) => a.localeCompare(b));
}

// ---- Move to My files / Move to Project files (spacesApi.moveTo, POST /api/spaces/:space/files/move-to) ----

export type FilesPlace = 'Project files' | 'My files';

/** What a refused move says, by the route's code; the file stays where it was. `exists` asks first instead (FilesTool). */
export function moveFailureText(err: { code?: string; error?: string } | null | undefined, o: { name: string; path: string; from: FilesPlace; to: FilesPlace }): string {
  const { name, path, from, to } = o;
  switch (err?.code) {
    case 'exists': return `${to} already has ${path}.`;
    // Both places end in "files", so the possessive is a bare apostrophe.
    case 'destination_shared': return `${to}' ${path} is shared with everyone on termag. Make it private first, then move ${name} again.`;
    case 'changed_while_moving': return `${name} changed while it moved, so the newer version stayed in ${from}; ${to} has the one you moved.`;
    case 'changed': return `${name} changed since this list was read. Refresh, then move it again.`;
    case 'memory_path': return `Agents' memory (.termag/) stays where it is.`;
    case 'same_space': return `${name} is already in ${to}.`;
    case 'file_not_found': return `${name} isn't in ${from} any more.`;
    case 'move_too_large': return `Files over 5 GiB can't be moved yet.`;
    default: return err?.error ? `Couldn't move ${name}: ${err.error}` : `Couldn't move ${name}.`;
  }
}

/** A move that copied but couldn't remove the original (`ok: false`): it's in both. */
export function moveHalfDoneText(o: { name: string; from: FilesPlace; to: FilesPlace }): string {
  return `${o.name} is in ${o.to} now, but couldn't be removed from ${o.from}, so it's in both.`;
}

// ---- Use an existing space (Settings → My files; a project's menu: Use an existing space for files…) ----

/**
 * The spaces one can choose: their own, neither the one in that role now nor one already in a role (`taken`: their
 * projects' files and their My files), by name. The server refuses one in a role anyway (409 space_in_use).
 */
export function usableSpaces(spaces: ReadonlyArray<{ name: string; role: string }>, current: string | null, taken: readonly string[] = []): string[] {
  const out = new Set<string>(taken);
  if (current) out.add(current);
  return spaces.filter(s => s.role === 'owner' && !out.has(s.name)).map(s => s.name).sort((a, b) => a.localeCompare(b));
}

/** Why a choice was refused, by the route's code (409 space_in_use, 403 space_not_owned, 404 space_not_found). */
export function useSpaceErrorText(err: { code?: string; error?: string } | null | undefined): string {
  switch (err?.code) {
    case 'space_in_use': return "That one is already a project's files or your My files. Pick another.";
    case 'space_not_owned': return 'Only one you own can be used. Pick another.';
    case 'space_not_found': return "That one doesn't exist any more. Pick another.";
    default: return err?.error ?? "Couldn't save that. Try again.";
  }
}
