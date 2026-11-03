// In-flight changes on the context card:
// which chat events mean the agent may have changed a
// file, and the card's groups of files from the box's answer.
import type { ChangedFile, InflightChanges } from '../services/api';

/**
 * Whether a chat event ends a tool call or the turn: a `user` event carrying a
 * tool_result (an Edit, a Write, a Bash call that committed or pushed), or the
 * turn's `result`. Any of those may change what the checkout holds.
 */
export function endsToolCall(event: unknown): boolean {
  const ev = event as { type?: unknown; message?: { content?: unknown } } | null;
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type === 'result') return true;
  if (ev.type !== 'user' || !Array.isArray(ev.message?.content)) return false;
  return ev.message!.content.some(b => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result');
}

/** The box lists at most this many files a group (agent git-changes.js MAX_FILES). */
export const MAX_LISTED = 200;

export interface ChangeGroup {
  key: 'uncommitted' | 'committed';
  label: string;
  files: ChangedFile[];
  additions: number;
  deletions: number;
  /** The box cut this list at MAX_LISTED: there are more files than it holds, and the totals are a floor. */
  cut: boolean;
  /** Commits whose files the box couldn't list (`partial`): the group has them and no files. */
  unlisted: number;
}

const sum = (files: ChangedFile[], k: 'additions' | 'deletions') => files.reduce((n, f) => n + (f[k] ?? 0), 0);

/**
 * The card's in-flight groups, those with files: what isn't committed, then
 * what is committed and not pushed (a branch never pushed counts from origin's
 * default branch, so all of its commits are). None when the box couldn't say.
 * Commits whose files the box couldn't list (`partial`) still make a group.
 */
export function inflightGroups(changes: InflightChanges | null | undefined): ChangeGroup[] {
  if (!changes?.available) return [];
  const unlisted = changes.partial && changes.committed.length === 0 ? changes.commits : 0;
  const groups: ChangeGroup[] = [
    { key: 'uncommitted', label: 'Not committed', files: changes.uncommitted, additions: 0, deletions: 0, cut: false, unlisted: 0 },
    { key: 'committed', label: 'Not pushed', files: changes.committed, additions: 0, deletions: 0, cut: false, unlisted },
  ];
  return groups.filter(g => g.files.length > 0 || g.unlisted > 0).map(g => ({
    ...g, additions: sum(g.files, 'additions'), deletions: sum(g.files, 'deletions'),
    cut: changes.truncated && g.files.length >= MAX_LISTED,
  }));
}

/** The card's letter for a file: git's own, with an untracked file shown as added. */
export function fileKind(status: string): string {
  return status === '?' ? 'A' : /^[ACDMRT]$/.test(status) ? status : 'M';
}

/**
 * What Changes says for a session with no PR and nothing listed. With the flag
 * off, its PR's changes are all it shows; on, the box's answer says why there
 * is nothing: none in flight, still reading, or the box can't say.
 */
export function noPrChangesText(on: boolean, changes: InflightChanges | null | undefined): string {
  if (!on) return 'Its pull request’s changes show here.';
  if (!changes) return 'Reading its changes…';
  if (changes.available) return 'No changes yet';
  if (changes.reason === 'offline') return 'Its box is off, so its changes can’t be read';
  if (changes.reason === 'outdated-agent') return 'Its box can’t list changes until it updates';
  return 'Couldn’t read its changes from the box';
}
