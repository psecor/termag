/**
 * Removing a workstream's git worktree from the orchestrator's own disk (the
 * path for projects with no box). Lives apart from the route so the real-git
 * test below can exercise it without Prisma or Slack.
 */
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Returns a warning string if the branch couldn't be deleted (e.g. unmerged
// work without --force); null on success or when no branch was given.
//
// A worktree directory that is already gone (removed by hand, or by a `git
// worktree remove` run outside termag) counts as removed: `git worktree
// remove` would fail with "is not a working tree", and the route treats any
// failure here as a 409 *before* deleting the Workstream row — which left an
// orphan the UI could never remove. Prune git's stale bookkeeping instead and
// go on to the branch. The agent RPC (`git-worktree-remove` in agent/agent.js) mirrors this.
export async function gitWorktreeRemoveLocal(
  projDir: string,
  worktreeName: string,
  branch: string | null,
  force: boolean,
): Promise<string | null> {
  const worktreePath = `${projDir}/.worktrees/${worktreeName}`;
  if (!existsSync(worktreePath)) {
    await execAsync(`git -C ${shellEscape(projDir)} worktree prune`);
  } else {
    const forceFlag = force ? ' --force' : '';
    await execAsync(
      `git -C ${shellEscape(projDir)} worktree remove${forceFlag} ${shellEscape(worktreePath)}`,
    );
  }
  if (!branch) return null;
  const flag = force ? '-D' : '-d';
  try {
    await execAsync(
      `git -C ${shellEscape(projDir)} branch ${flag} ${shellEscape(branch)}`,
    );
    return null;
  } catch (err) {
    return lastGitError((err as Error).message);
  }
}

/** The line of git's stderr to show as the warning: the last `error:` /
 *  `fatal:` line when there is one, else the last non-`hint:` line. git
 *  follows "error: the branch … is not fully merged" with advice — a bare
 *  "If you are sure you want to delete it…" line in 2.43, `hint:`-prefixed
 *  lines in newer versions — and the user should see the reason, not the advice. */
export function lastGitError(message: string): string | null {
  const lines = message.trim().split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('hint:'));
  const errors = lines.filter(l => /^(error|fatal):/.test(l));
  return (errors.length ? errors : lines).pop() ?? null;
}
