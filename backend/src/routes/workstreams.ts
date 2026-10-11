import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { exec } from 'child_process';
import { promisify } from 'util';
import { requireAuth } from '../middleware/auth';
import { isProjectAgentConnected, sendForProject } from '../services/agentRegistry';
import { projectDirFor } from '../services/tmux';
import { gitWorktreeRemoveLocal } from '../services/worktreeRemove';
import { ensureAgentSessionsAndLaunch, stopAgentSessions, resolveAgentProvider } from '../services/agentRuntime';
import * as tmux from '../services/tmux';
import { createChannelFor, archiveChannel } from '../slack/channels';
import { setNotificationTarget, renameNotificationTargets } from '../slack/lts';
import { PROVIDERS } from '../providers/registry';
import { refuseParkedBox } from '../middleware/parkedBox';
import { refuseUnreadySetup } from '../middleware/unreadySetup';
import { moveStatus, notifyStatusChange } from '../services/status';
import { planSessionRenames, validateWorkstreamRename } from '../services/workstreamRename';
import { isBranchName } from '../services/repoCreate';

const execAsync = promisify(exec);

const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

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
    if (!isBranchName(branchName)) {
      res.status(400).json({ error: 'branch contains disallowed characters' });
      return;
    }
    const ref = baseRef ?? 'HEAD';
    if (!isBranchName(ref)) {
      res.status(400).json({ error: 'baseRef contains disallowed characters' });
      return;
    }

    const project = await prisma.project.findFirst({
      where: { id: req.params.projectId, userId: req.user!.id },
      include: {
        user: { select: { unixUsername: true } },
        instance: { select: { hostHome: true } },
      },
    });
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.kind === 'metaterm') { res.status(400).json({ error: 'MetaTerm cannot branch off' }); return; }

    const existing = await prisma.workstream.findUnique({
      where: { projectId_name: { projectId: project.id, name } },
    });
    if (existing) {
      res.status(409).json({ error: 'A workstream with that name already exists' });
      return;
    }

    const projDir = projectDirFor(project);
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

    let workstream;
    try {
      workstream = await prisma.workstream.create({
        data: { projectId: project.id, name, branch: branchName },
      });
    } catch (err) {
      // DB write lost a race — try to clean up the worktree + branch we just
      // created so a retry isn't blocked by the half-built state.
      if (isProjectAgentConnected(projectHost)) {
        await sendForProject(projectHost, 'git-worktree-remove', {
          projectDir: projDir, worktreeName: name, branch: branchName, force: true,
        }).catch(() => {});
      } else if (!project.instanceId) {
        await gitWorktreeRemoveLocal(projDir, name, branchName, true).catch(() => {});
      }
      throw err;
    }

    // Slack channel for this workstream (#proj-<user>-<project>-<ws>), so /t
    // in that channel routes to this worktree's tmux pair. Fire-and-forget,
    // like project creation. If we know the creator's Slack id, also point
    // the agent session's "needs input" notifications at the new channel.
    createChannelFor({
      username: project.user.unixUsername,
      projectName: project.name,
      workstream: workstream.name,
      creatorSlackUserId: req.user!.slackUserId ?? undefined,
    }).then(channelId => {
      if (!channelId) return;
      prisma.workstream.update({ where: { id: workstream.id }, data: { slackChannelId: channelId } })
        .catch(err => console.error('[WORKSTREAMS] Failed to save channel ID:', err.message));
      if (req.user!.slackUserId) {
        setNotificationTarget(
          tmux.sessionName(project.user.unixUsername, project.name, 'agent', workstream.name),
          { channel: channelId, userId: req.user!.slackUserId },
          'slack',
          project.instanceId,
        );
      }
    });

    // Mirror main's workflows onto the new workstream so the user can
    // immediately attach a terminal / use the agent on the new branch.
    // Non-fatal: launch failures (agent offline, dirty pane, etc.) surface as
    // warnings on the response; the workflow rows still get created so the
    // poller and reconnect path can pick up later.
    const sessionLaunchWarnings: string[] = [];
    try {
      const mainWs = await prisma.workstream.findUnique({
        where: { projectId_name: { projectId: project.id, name: 'main' } },
      });
      if (mainWs) {
        const mainWorkflows = await prisma.workflow.findMany({
          where: { workstreamId: mainWs.id },
        });
        for (const mw of mainWorkflows) {
          await prisma.workflow.create({
            data: {
              projectId: project.id,
              workstreamId: workstream.id,
              type: mw.type,
              provider: mw.provider,
            },
          });

          if (mw.type === 'agent') {
            try {
              await ensureAgentSessionsAndLaunch({
                userId: project.userId,
                unixUsername: project.user.unixUsername,
                projectName: project.name,
                provider: resolveAgentProvider(mw.provider, null),
                instanceId: project.instanceId,
                workstream: workstream.name,
                hostHome: project.instance?.hostHome ?? null,
              });
            } catch (e) {
              sessionLaunchWarnings.push(`agent: ${(e as Error).message}`);
            }
          } else {
            // data workflow — paired tmux sessions in the worktree dir
            try {
              const dataSession = tmux.sessionName(project.user.unixUsername, project.name, 'data', workstream.name);
              const ctrlSession = tmux.sessionName(project.user.unixUsername, project.name, 'data-ctrl', workstream.name);
              const wsDir = tmux.projectDirFor(project, workstream.name);
              if (isProjectAgentConnected(projectHost)) {
                await sendForProject(projectHost, 'tmux-create', { sessionName: dataSession, cwd: wsDir });
                await sendForProject(projectHost, 'tmux-create', { sessionName: ctrlSession, cwd: wsDir });
              } else if (!project.instanceId) {
                await tmux.ensureSession(dataSession, wsDir);
                await tmux.ensureSession(ctrlSession, wsDir);
              }
            } catch (e) {
              sessionLaunchWarnings.push(`data: ${(e as Error).message}`);
            }
          }
        }
      }
    } catch (e) {
      sessionLaunchWarnings.push(`mirror: ${(e as Error).message}`);
    }

    res.status(201).json({
      ...workstream,
      ...(sessionLaunchWarnings.length > 0 ? { sessionLaunchWarnings } : {}),
    });
  };

  // POST /api/projects/:projectId/workstreams/:id/rename { name }
//
// Renames the row, the worktree directory and the tmux session pair(s) — the
// git branch is left alone (services/workstreamRename.ts explains). Whatever
// runs in the panes keeps running; the agent inside only notices on its next
// restart (its transcript dir is keyed on the cwd it started with, so the
// context badge pauses until then).
//
// Order: row first, because the DB write is the step that can lose a race
// (unique name) and it is the one we can undo. Then git — if it refuses
// (dirty worktree lock, name collision on disk) the row is put back and
// nothing else has moved. tmux/status/notification re-keying come last and
// are best effort per session.
  const renameWorkstream: RequestHandler = async (req, res) => {
    const workstream = await prisma.workstream.findFirst({
      where: { id: req.params.id, projectId: req.params.projectId },
      include: {
        project: { include: { user: { select: { unixUsername: true } }, instance: { select: { hostHome: true } } } },
        workflows: { select: { type: true, provider: true } },
      },
    });
    if (!workstream || workstream.project.userId !== req.user!.id) {
      res.status(404).json({ error: 'Workstream not found' }); return;
    }
    const v = validateWorkstreamRename(workstream.name, (req.body ?? {}).name);
    if (!v.ok) { res.status(400).json({ error: v.error }); return; }
    const to = v.name;
    const from = workstream.name;
    const { project } = workstream;

    const username = project.user.unixUsername;
    const projDir = projectDirFor(project);
    const projectHost = { userId: project.userId, instanceId: project.instanceId };
    const connected = isProjectAgentConnected(projectHost);
    if (!connected && project.instanceId) { res.status(503).json({ error: 'Box agent is not connected' }); return; }

    // 1. The row (unique on projectId+name; a clash surfaces here, before anything moves).
    try {
      await prisma.workstream.update({ where: { id: workstream.id }, data: { name: to } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        res.status(409).json({ error: 'A workstream with that name already exists' }); return;
      }
      throw err;
    }
    const revertRow = () => prisma.workstream.update({ where: { id: workstream.id }, data: { name: from } }).catch(e =>
      console.error('[WORKSTREAMS] rename: failed to revert row after git error:', (e as Error).message));

    // 2. The worktree directory.
    try {
      if (connected) {
        await sendForProject(projectHost, 'git-worktree-move', { projectDir: projDir, from, to });
      } else {
        await execAsync(
          `git -C ${shellEscape(projDir)} worktree move ${shellEscape(`${projDir}/.worktrees/${from}`)} ${shellEscape(`${projDir}/.worktrees/${to}`)}`,
        );
      }
    } catch (err) {
      await revertRow();
      const msg = (err as Error).message;
      // An agent that predates this RPC answers "Unknown command"; say so plainly.
      if (/Unknown command/i.test(msg)) {
        res.status(501).json({ error: 'This box\'s agent is too old to rename workstreams; update termag on the box and restart its agent' });
        return;
      }
      res.status(409).json({ error: `git worktree move failed: ${msg}` });
      return;
    }

    // 3. The tmux sessions.
    const plan = planSessionRenames(username, project.name, from, to, workstream.workflows.map(w => w.type));
    const needsBridge = workstream.workflows.some(wf =>
      wf.type === 'agent' && PROVIDERS[resolveAgentProvider(wf.provider, null)]?.needsBridge);
    let agentOutcome: 'renamed' | 'absent' | 'failed' = 'absent';
    for (const r of plan) {
      // 'renamed' — the live session now has the new name; 'absent' — there was
      // no session (a pair can be only partly alive); 'failed' — tmux refused
      // (e.g. a stale session already holds the new name). Only a real rename
      // carries the status over: otherwise the still-running old session would
      // hand its live status to an unrelated one.
      let outcome: 'renamed' | 'absent' | 'failed' = 'failed';
      try {
        if (connected) {
          const r2 = await sendForProject(projectHost, 'tmux-rename-session', { from: r.from, to: r.to });
          outcome = r2?.renamed === false ? 'absent' : 'renamed';
        } else if (!(await tmux.hasSession(r.from))) {
          outcome = 'absent';
        } else {
          await tmux.renameSession(r.from, r.to);
          outcome = 'renamed';
        }
      } catch (err) {
        console.warn(`[WORKSTREAMS] rename: tmux rename ${r.from} → ${r.to} failed: ${(err as Error).message}`);
      }
      if (r.role === 'agent') agentOutcome = outcome;
      if (r.role === 'agent' && outcome === 'renamed' && needsBridge && connected) {
        // The old bridge is keyed on (and posts under) the old name; stop it
        // before the status entry moves, or a post in between would recreate
        // the old key as a ghost. Stopped only now, after tmux agreed to the
        // rename, so a refused rename leaves the old bridge serving the pane.
        await sendForProject(projectHost, 'codex-session-stop', { sessionName: r.from }).catch(() => {});
      }
      if (outcome === 'renamed') {
        moveStatus(r.from, r.to, project.instanceId);
        notifyStatusChange(r.from, project.instanceId);
        notifyStatusChange(r.to, project.instanceId);
      }
      // Slack/Discord "needs input" routing is keyed on the session name too;
      // it belongs to the workstream, so it follows even when no session was
      // alive to rename (the next launch creates it under the new name).
      if (outcome !== 'failed') await renameNotificationTargets(r.from, r.to, project.instanceId);
    }

    // 4. Bridge-backed providers (Codex) bake the session name into the
    // bridge's argv, so the renamed pane needs a fresh bridge under the new
    // name (the old one was stopped above). Its start takes the pane over
    // (C-c, clear, relaunch), so Codex restarts; plain-pane providers keep
    // running. Started directly rather than via ensureAgentSessionsAndLaunch,
    // whose probe would see Codex in the foreground and skip the launch.
    if (connected && needsBridge && agentOutcome === 'renamed') {
      await sendForProject(projectHost, 'codex-session-start', {
        sessionName: tmux.sessionName(username, project.name, 'agent', to),
        cwd: projectDirFor(project, to),
      }).catch(e => console.error('[WORKSTREAMS] rename: bridge relaunch failed:', (e as Error).message));
    }

    const updated = await prisma.workstream.findUnique({ where: { id: workstream.id } });
    res.json(updated);
  };

// DELETE /api/projects/:projectId/workstreams/:id
  //   ?force=1 — pass --force to git worktree remove (drops dirty changes)
  const remove: RequestHandler = async (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true';

    const workstream = await prisma.workstream.findFirst({
      where: { id: req.params.id, projectId: req.params.projectId },
      include: {
        project: {
          include: {
            user: { select: { unixUsername: true } },
            instance: { select: { hostHome: true } },
          },
        },
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
    const projDir = projectDirFor(project);
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
    // leave us with an orphan DB row pointing at a still-live worktree. A
    // worktree that is already gone is not a failure (see
    // gitWorktreeRemoveLocal / the agent's git-worktree-remove): the row is
    // the only thing left to clean up, so it must be deletable.
    // The agent (or local exec) also deletes the workstream's branch as a
    // best-effort cleanup, surfacing any failure as a non-fatal warning.
    let branchDeleteWarning: string | null = null;
    try {
      if (isProjectAgentConnected(projectHost)) {
        const result = await sendForProject(projectHost, 'git-worktree-remove', {
          projectDir: projDir,
          worktreeName: workstream.name,
          branch: workstream.branch,
          force,
        });
        branchDeleteWarning = result?.branchDeleteWarning ?? null;
      } else if (!project.instanceId) {
        branchDeleteWarning = await gitWorktreeRemoveLocal(
          projDir, workstream.name, workstream.branch, force,
        );
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
    // The worktree is gone, so retire its channel (best effort, non-blocking).
    if (workstream.slackChannelId) archiveChannel(workstream.slackChannelId).catch(() => {});
    res.json({ ok: true, branchDeleteWarning });
  };

  router.get('/projects/:projectId/workstreams', requireAuth, list);
  router.post('/projects/:projectId/workstreams', requireAuth, refuseParkedBox('projectId'), refuseUnreadySetup('projectId'), create);
  router.delete('/projects/:projectId/workstreams/:id', requireAuth, refuseParkedBox('projectId'), remove);
  router.post('/projects/:projectId/workstreams/:id/rename', requireAuth, refuseParkedBox('projectId'), renameWorkstream);

  return router;
}
