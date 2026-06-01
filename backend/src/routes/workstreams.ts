import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { requireAuth } from '../middleware/auth';
import { isProjectAgentConnected, sendForProject } from '../services/agentRegistry';
import { projectDir } from '../services/tmux';
import { stopAgentSessions, resolveAgentProvider } from '../services/agentRuntime';
import * as tmux from '../services/tmux';

const prisma = new PrismaClient();
const execAsync = promisify(exec);

const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const BRANCH_REGEX = /^[a-zA-Z0-9_./-]+$/;

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Run `git worktree add` on the orchestrator's local filesystem. Only used
// for legacy (instanceId === null) projects — boxed projects route through
// the agent's `git-worktree-add` RPC instead.
async function gitWorktreeAddLocal(
  projDir: string,
  worktreeName: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  const worktreePath = `${projDir}/.worktrees/${worktreeName}`;
  await execAsync(
    `git -C ${shellEscape(projDir)} worktree add -b ${shellEscape(branch)} ${shellEscape(worktreePath)} ${shellEscape(baseRef)}`,
  );
}

async function gitWorktreeRemoveLocal(
  projDir: string,
  worktreeName: string,
  force: boolean,
): Promise<void> {
  const worktreePath = `${projDir}/.worktrees/${worktreeName}`;
  const forceFlag = force ? ' --force' : '';
  await execAsync(
    `git -C ${shellEscape(projDir)} worktree remove${forceFlag} ${shellEscape(worktreePath)}`,
  );
}

export function workstreamsRouter(): Router {
  const router = Router();

  // GET /api/projects/:projectId/workstreams — list (main first, then alpha by createdAt)
  const list: RequestHandler = async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { id: req.params.projectId, userId: req.user!.id },
    });
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

    const workstreams = await prisma.workstream.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json(workstreams);
  };

  // POST /api/projects/:projectId/workstreams — create a new workstream
  // Body: { name, branch?, baseRef? }
  //   name      — workstream name (also default for branch + worktree dir)
  //   branch    — git branch to create; defaults to name
  //   baseRef   — commit-ish to branch off; defaults to HEAD of main worktree
  const create: RequestHandler = async (req, res) => {
    const { name, branch, baseRef } = req.body as {
      name?: string; branch?: string; baseRef?: string;
    };
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    if (!NAME_REGEX.test(name)) {
      res.status(400).json({ error: 'name must be alphanumeric with dashes/underscores only' });
      return;
    }
    if (name === 'main') {
      res.status(400).json({ error: '"main" is reserved for the default workstream' });
      return;
    }
    const branchName = branch ?? name;
    if (!BRANCH_REGEX.test(branchName)) {
      res.status(400).json({ error: 'branch contains disallowed characters' });
      return;
    }
    const ref = baseRef ?? 'HEAD';
    if (!BRANCH_REGEX.test(ref)) {
      res.status(400).json({ error: 'baseRef contains disallowed characters' });
      return;
    }

    const project = await prisma.project.findFirst({
      where: { id: req.params.projectId, userId: req.user!.id },
      include: { user: { select: { unixUsername: true } } },
    });
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

    const existing = await prisma.workstream.findUnique({
      where: { projectId_name: { projectId: project.id, name } },
    });
    if (existing) {
      res.status(409).json({ error: 'A workstream with that name already exists' });
      return;
    }

    const projDir = projectDir(project.user.unixUsername, project.name);
    const projectHost = { userId: project.userId, instanceId: project.instanceId };

    try {
      if (isProjectAgentConnected(projectHost)) {
        await sendForProject(projectHost, 'git-worktree-add', {
          projectDir: projDir,
          worktreeName: name,
          branch: branchName,
          baseRef: ref,
        });
      } else if (!project.instanceId) {
        await gitWorktreeAddLocal(projDir, name, branchName, ref);
      } else {
        res.status(503).json({ error: 'Box agent is not connected' });
        return;
      }
    } catch (err) {
      res.status(500).json({ error: `git worktree add failed: ${(err as Error).message}` });
      return;
    }

    try {
      const workstream = await prisma.workstream.create({
        data: { projectId: project.id, name, branch: branchName },
      });
      res.status(201).json(workstream);
    } catch (err) {
      // DB write lost a race — try to clean up the worktree we just created.
      if (isProjectAgentConnected(projectHost)) {
        await sendForProject(projectHost, 'git-worktree-remove', {
          projectDir: projDir, worktreeName: name, force: true,
        }).catch(() => {});
      } else if (!project.instanceId) {
        await gitWorktreeRemoveLocal(projDir, name, true).catch(() => {});
      }
      throw err;
    }
  };

  // DELETE /api/projects/:projectId/workstreams/:id
  //   ?force=1 — pass --force to git worktree remove (drops dirty changes)
  const remove: RequestHandler = async (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true';

    const workstream = await prisma.workstream.findFirst({
      where: { id: req.params.id, projectId: req.params.projectId },
      include: {
        project: { include: { user: { select: { unixUsername: true } } } },
        workflows: true,
      },
    });
    if (!workstream || workstream.project.userId !== req.user!.id) {
      res.status(404).json({ error: 'Workstream not found' }); return;
    }
    if (workstream.name === 'main') {
      res.status(400).json({ error: 'Cannot delete the main workstream' });
      return;
    }

    const { project } = workstream;
    const username = project.user.unixUsername;
    const projDir = projectDir(username, project.name);
    const projectHost = { userId: project.userId, instanceId: project.instanceId };

    // Stop tmux sessions for any agent workflows attached to this workstream
    // before tearing down the worktree. Data workflows: kill their pair too.
    for (const wf of workstream.workflows) {
      if (wf.type === 'agent') {
        await stopAgentSessions({
          userId: project.userId,
          unixUsername: username,
          projectName: project.name,
          provider: resolveAgentProvider(wf.provider, null),
          instanceId: project.instanceId,
          workstream: workstream.name,
        }).catch(() => {});
      } else {
        await tmux.killSession(tmux.sessionName(username, project.name, 'data', workstream.name)).catch(() => {});
        await tmux.killSession(tmux.sessionName(username, project.name, 'data-ctrl', workstream.name)).catch(() => {});
      }
    }

    // Remove the worktree from disk before the DB row so a failed `git
    // worktree remove` (typically: dirty worktree without --force) doesn't
    // leave us with an orphan DB row pointing at a still-live worktree.
    try {
      if (isProjectAgentConnected(projectHost)) {
        await sendForProject(projectHost, 'git-worktree-remove', {
          projectDir: projDir, worktreeName: workstream.name, force,
        });
      } else if (!project.instanceId) {
        await gitWorktreeRemoveLocal(projDir, workstream.name, force);
      } else {
        res.status(503).json({ error: 'Box agent is not connected' });
        return;
      }
    } catch (err) {
      res.status(409).json({ error: `git worktree remove failed: ${(err as Error).message}` });
      return;
    }

    // Cascade-deletes attached workflows via the schema FK.
    await prisma.workstream.delete({ where: { id: workstream.id } });
    res.json({ ok: true });
  };

  router.get('/projects/:projectId/workstreams', requireAuth, list);
  router.post('/projects/:projectId/workstreams', requireAuth, create);
  router.delete('/projects/:projectId/workstreams/:id', requireAuth, remove);

  return router;
}
