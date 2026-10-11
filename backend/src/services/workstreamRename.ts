// Renaming a workstream ("branch" in the sidebar): what has to move. Pure, so
// the plan is unit-tested; routes/workstreams.ts executes it through the
// box agent (git-worktree-move, tmux-rename-session) or local fallbacks.
//
// A workstream name appears in three places that must change together:
//   - the worktree directory  <project>/.worktrees/<name>
//   - the tmux session names  <user>-<project>-<name>-<role>
//   - the Workstream row
// The git branch is NOT renamed: it may be pushed / have a PR, and the
// workstream name is a label for the worktree, not the branch (`branch` is
// shown in the row's tooltip). `main` cannot be renamed: it has no worktree
// and its sessions carry the historical 3-segment names.
import { sessionName } from './tmux';

export const WORKSTREAM_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

export type WorkstreamRole = 'agent' | 'ctrl' | 'review' | 'data' | 'data-ctrl';

export function validateWorkstreamRename(current: string, next: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof next !== 'string') return { ok: false, error: 'name required' };
  const name = next.trim();
  if (!name) return { ok: false, error: 'name required' };
  if (!WORKSTREAM_NAME_REGEX.test(name)) return { ok: false, error: 'name must be alphanumeric with dashes/underscores only' };
  if (current === 'main') return { ok: false, error: 'The main workstream cannot be renamed' };
  if (name === 'main') return { ok: false, error: '"main" is reserved for the project\'s primary workstream' };
  if (name === current) return { ok: false, error: 'That is already the name' };
  return { ok: true, name };
}

export interface SessionRename { role: WorkstreamRole; from: string; to: string }

/** Which tmux sessions change name, derived from the workstream's workflows. */
export function planSessionRenames(
  username: string,
  projectName: string,
  from: string,
  to: string,
  workflowTypes: Array<'agent' | 'data'>,
): SessionRename[] {
  const roles: WorkstreamRole[] = [];
  for (const t of new Set(workflowTypes)) {
    // `review` (the Devin review pane, routes/review.ts) is workstream-scoped
    // and rides with the agent pair, as in project rename.
    if (t === 'agent') roles.push('agent', 'ctrl', 'review');
    else roles.push('data', 'data-ctrl');
  }
  return roles.map(role => ({
    role,
    from: sessionName(username, projectName, role, from),
    to: sessionName(username, projectName, role, to),
  }));
}
