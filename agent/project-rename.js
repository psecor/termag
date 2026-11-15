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
 *
 * A multi-repo project (`plan.workspace`) has no
 * repository at its root: each repository's checkout is repaired against its
 * worktree in every workstream root, and the generated guides are rewritten.
 * A failed repair puts the folder and the sessions back, so the rename is all
 * or nothing.
 *
 * With `plan.conversations` (the backend sends it to an agent announcing
 * `rename-conversations-v1`), once the rename has gone through the
 * Claude Code and pi conversations of each moved checkout move to the new
 * path's folder too (conversation-move.js), so `claude --resume` in the
 * renamed project still lists them. That runs even when the directory moved
 * on an earlier call, so a retry finishes it.
 */
const fs = require('node:fs');
const path = require('node:path');
const workspace = require('./workspace');
const conversationMove = require('./conversation-move');

/**
 * @param {{ sessions: Array<{ from: string, to: string }>, fromDir: string, toDir: string,
 *   workspace?: { repos: string[], guides?: Array<{ dir: string, content: string }> },
 *   conversations?: { home: string } }} plan
 * @param {{ execFile: (cmd: string, args: string[]) => Promise<unknown>, fs?: typeof fs.promises }} deps
 */
async function renameProject(plan, deps) {
  const fsp = deps.fs ?? fs.promises;
  const exists = (p) => fsp.stat(p).then(() => true, () => false);

  const moveDir = Boolean(plan.fromDir && plan.toDir && plan.fromDir !== plan.toDir)
    && await exists(plan.fromDir);
  if (moveDir && await exists(plan.toDir)) throw new Error(`${plan.toDir} already exists`);

  const renamed = [];
  for (const { from, to } of plan.sessions ?? []) {
    if (!from || !to || from === to) continue;
    try {
      await deps.execFile('tmux', ['rename-session', '-t', `=${from}`, '--', to]);
      renamed.push({ from, to });
    } catch { /* no such session */ }
  }

  if (moveDir) {
    await fsp.mkdir(path.dirname(plan.toDir), { recursive: true });
    await fsp.rename(plan.fromDir, plan.toDir);
  }

  if (plan.workspace) {
    const guides = await renameWorkspace(plan, moveDir, renamed, deps);
    return { ok: true, renamedSessions: renamed.length, movedDir: moveDir, guides, ...carryConversations(plan) };
  }

  if (moveDir) {
    const worktrees = path.join(plan.toDir, '.worktrees');
    const names = await fsp.readdir(worktrees).catch(() => []);
    if (names.length) {
      await deps.execFile('git', ['-C', plan.toDir, 'worktree', 'repair', ...names.map(n => path.join(worktrees, n))])
        .catch(() => {});
    }
  }
  return { ok: true, renamedSessions: renamed.length, movedDir: moveDir, ...carryConversations(plan) };
}

/** `{ conversations }` when the plan asks for them to move, else nothing. */
function carryConversations(plan) {
  const home = plan.conversations && plan.conversations.home;
  if (!home || !plan.fromDir || !plan.toDir || plan.fromDir === plan.toDir) return {};
  const repos = plan.workspace ? workspace.repoNames(plan.workspace.repos) : [];
  return { conversations: conversationMove.carryConversations({ home, fromDir: plan.fromDir, toDir: plan.toDir, repos }) };
}

async function renameWorkspace(plan, moveDir, renamed, deps) {
  if (!fs.existsSync(plan.toDir)) return 0;
  const repos = workspace.repoNames(plan.workspace.repos);
  const repair = (root) => workspace.repairWorktrees(
    { root, repos, wsRoots: workspace.workstreamRoots(root) },
    { execFile: deps.execFile },
  );
  const failed = await repair(plan.toDir);
  if (failed.length === 0) return workspace.rewriteGuides(plan.workspace.guides);

  const why = `git worktree repair failed (${failed.join('; ')})`;
  if (!moveDir) throw new Error(`${why}; the project folder is at ${plan.toDir}`);
  try {
    fs.renameSync(plan.toDir, plan.fromDir);
  } catch (err) {
    throw new Error(`${why}, and moving it back failed (${err.message}); the project folder is at ${plan.toDir}, so renaming to ${path.basename(plan.toDir)} again finishes it`);
  }
  await repair(plan.fromDir);
  for (const { from, to } of [...renamed].reverse()) {
    await deps.execFile('tmux', ['rename-session', '-t', `=${to}`, '--', from]).catch(() => {});
  }
  throw new Error(`${why}; nothing was renamed`);
}

/**
 * The box half of a workstream rename (the `git-worktree-move` RPC): move its
 * worktree from .worktrees/<from> to .worktrees/<to> with `git worktree move`,
 * which updates git's bookkeeping (.git/worktrees/<id>/gitdir) as well as the
 * directory, which a plain mv would not. The branch is untouched; the caller
 * decides whether it follows the name. It never moves onto something
 * already at <to>, which git would move the worktree *into* (<to>/<from>), as
 * mv does: a folder there may be another checkout, so it is never taken for
 * this one. With `conversations`, a move git made carries the worktree's
 * conversations in the same call; a refused move carries nothing.
 */
async function renameWorktree({ projectDir, from, to, conversations }, deps) {
  if (!projectDir || !from || !to) throw new Error('projectDir, from and to are required');
  const fromPath = `${projectDir}/.worktrees/${from}`;
  const toPath = `${projectDir}/.worktrees/${to}`;
  if ((deps.exists ?? fs.existsSync)(toPath)) throw new Error(`${toPath} already exists`);
  await deps.execFile('git', ['-C', projectDir, 'worktree', 'move', fromPath, toPath]);
  const carried = conversations && conversations.home
    ? { conversations: conversationMove.carryConversations({ home: conversations.home, fromDir: fromPath, toDir: toPath }) }
    : {};
  return { ok: true, path: toPath, ...carried };
}

module.exports = { renameProject, renameWorktree };
