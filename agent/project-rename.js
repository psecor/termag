'use strict';
/**
 * The box half of a project rename (the `project-rename` RPC): rename the
 * project's tmux sessions and move its directory. The backend computes every
 * name and path; this only carries them out.
 *
 * A session or directory that isn't there is skipped, so a retry after a
 * partial failure converges. The directory never moves onto an existing one,
 * and that is checked before anything is renamed. Worktrees under
 * `.worktrees/` record absolute paths, so after a move `git worktree repair`
 * points them at the new location.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {{ sessions: Array<{ from: string, to: string }>, fromDir: string, toDir: string }} plan
 * @param {{ execFile: (cmd: string, args: string[]) => Promise<unknown>, fs?: typeof fs.promises }} deps
 */
async function renameProject(plan, deps) {
  const fsp = deps.fs ?? fs.promises;
  const exists = (p) => fsp.stat(p).then(() => true, () => false);

  const moveDir = Boolean(plan.fromDir && plan.toDir && plan.fromDir !== plan.toDir)
    && await exists(plan.fromDir);
  if (moveDir && await exists(plan.toDir)) throw new Error(`${plan.toDir} already exists`);

  let renamedSessions = 0;
  for (const { from, to } of plan.sessions ?? []) {
    if (!from || !to || from === to) continue;
    try {
      await deps.execFile('tmux', ['rename-session', '-t', `=${from}`, '--', to]);
      renamedSessions++;
    } catch { /* no such session */ }
  }

  if (moveDir) {
    await fsp.mkdir(path.dirname(plan.toDir), { recursive: true });
    await fsp.rename(plan.fromDir, plan.toDir);
    const worktrees = path.join(plan.toDir, '.worktrees');
    const names = await fsp.readdir(worktrees).catch(() => []);
    if (names.length) {
      await deps.execFile('git', ['-C', plan.toDir, 'worktree', 'repair', ...names.map(n => path.join(worktrees, n))])
        .catch(() => {});
    }
  }
  return { ok: true, renamedSessions, movedDir: moveDir };
}

module.exports = { renameProject };
