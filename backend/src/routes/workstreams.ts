import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { exec } from 'child_process';
import { promisify } from 'util';
import { requireAuth } from '../middleware/auth';
import { isProjectAgentConnected, projectAgentCapabilities, sendForProject } from '../services/agentRegistry';
import { projectDirFor } from '../services/tmux';
import { gitWorktreeRemoveLocal } from '../services/worktreeRemove';
import { ensureAgentSessionsAndLaunch, stopAgentSessions, stopAgentPane, resolveAgentProvider } from '../services/agentRuntime';
import { ensureProjectRepo } from '../services/gitRepo';
import * as tmux from '../services/tmux';
import { createChannelFor, archiveChannel } from '../slack/channels';
import { setNotificationTarget, renameNotificationTargets } from '../slack/lts';
import { PROVIDERS, isSelectableProvider } from '../providers/registry';
import { refuseParkedBox } from '../middleware/parkedBox';
import { refuseUnreadySetup } from '../middleware/unreadySetup';
import { clearMilestoneTimer, moveStatus, notifyStatusChange, setStatus, updateStatusMeta } from '../services/status';
import type { LaunchOutcome } from '../services/agentRuntime';
import { planSessionRenames, validateWorkstreamRename } from '../services/workstreamRename';
import { isBranchName } from '../services/repoCreate';
import { powerStateError } from '../services/boxPowerPolicy';
import { refuseUnreadySessions } from '../services/sessionGate';
import { RouteResult, sendResult } from './routeResult';
import { revokeChats } from '../services/chatRevoke';

const execAsync = promisify(exec);

// Capped at 64 so a name can never exceed what the chat relay accepts
// (services/chatRunner.ts WORKSTREAM_RE), which would silently drop frames.
const NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

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
  initRepo: boolean,
): Promise<void> {
  // Projects created before repo setup was automatic can still have an unborn
  // HEAD (or no repo at all), which `worktree add` can't work with. Give them
  // one before branching off, unless a repository is still to be checked out.
  if (initRepo) await ensureProjectRepo(projDir);
  const worktreePath = `${projDir}/.worktrees/${worktreeName}`;
  await execAsync(
    `git -C ${shellEscape(projDir)} worktree add -b ${shellEscape(branch)} ${shellEscape(worktreePath)} ${shellEscape(baseRef)}`,
  );
}

/** What to tell the user when a switch recorded the new agent but did not type it into the pane. */
export function launchWarning(launch: LaunchOutcome, provider: string): string | null {
  const name = PROVIDERS[provider]?.displayName ?? provider;
  switch (launch) {
    case 'launched': return null;
    case 'unknown': return `Switched to ${name}, but the agent pane could not be checked, so ${name} was not started. Start it from the pane.`;
    case 'busy': return `Switched to ${name}, but git was running in the agent pane, so ${name} was not started. Start it from the pane when git finishes.`;
    case 'running': return `Switched to ${name}, but an agent was already running in the new pane, so ${name} was not started.`;
  }
}

export interface CreateWorkstreamInput {
  /** Workstream name (also the default for branch + worktree dir). */
  name?: string;
  /** Git branch to create; defaults to name. */
  branch?: string;
  /** Commit-ish to branch off; defaults to HEAD of the main worktree. */
  baseRef?: string;
  /**
   * The agent provider for the new workstream's agent workflow, instead of
   * main's (an agent spawn). Adds an agent workflow
   * when main has none. Validated by the caller.
   */
  provider?: string;
  /** The agent spawn this workstream is for (routes/spawns.ts): its agent starts on that brief. */
  spawnId?: string;
  /**
   * A pull request to check out (routes/prs.ts, "New workstream for #N"):
   * the worktree goes on the PR's own branch (`branch`) from
   * `pull/<number>/head` through the agent's git-worktree-add-pr, instead of
   * a new branch off `baseRef`. An agent-made worktree already on that branch
   * is adopted, and the workstream takes its directory's name.
   */
  pr?: { number: number; sameRepo: boolean; headOid: string };
}

/**
 * The backend's own check on a PR's branch name, before the box's stricter
 * `git check-ref-format`: present, not an option, no control characters.
 */
export function isPrBranchName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !value.startsWith('-') && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Branching off a repo project whose pane checkout has not landed (still running, or it failed). */
export const CHECKOUT_NOT_LANDED =
  "This project's repository is not checked out yet. Wait for the checkout in its main terminal to finish, or re-run it there.";

/** The agent capability git-worktree-add-pr needs (agent/git-worktree-pr.js). */
export const WORKTREE_PR_CAPABILITY = 'worktree-pr-v1';
// Longer than the agent can take (agent/git-worktree-pr.js MAX_DURATION_MS: two
// 90 s fetches, a 90 s checkout and the ref steps: 510 s), so the orchestrator
// never gives up on a checkout the agent then finishes.
const PR_CHECKOUT_TIMEOUT_MS = 600_000;

/**
 * Create a workstream in one of the user's own projects: the worktree on its
 * host, the row, its Slack channel, and a copy of main's workflows launched
 * in it. Shared by the cookie route and agent spawns (routes/spawns.ts).
 */
export async function createWorkstreamFor(user: Express.User, projectId: string, input: CreateWorkstreamInput): Promise<RouteResult> {
  const { name, branch, baseRef, provider, spawnId, pr } = input;
  if (!name) return { status: 400, body: { error: 'name required' } };
  if (!NAME_REGEX.test(name)) {
    return { status: 400, body: { error: 'name must be alphanumeric with dashes/underscores only, at most 64 characters' } };
  }
  if (name === 'main') {
    return { status: 400, body: { error: '"main" is reserved for the default workstream' } };
  }
  const branchName = branch ?? name;
  // A PR's branch is GitHub's, and may use anything git allows: the box judges it with
  // `git check-ref-format` (agent/git-worktree-pr.js) and only ever passes it as an argument.
  if (!(pr ? isPrBranchName(branchName) : isBranchName(branchName))) {
    return { status: 400, body: { error: 'branch contains disallowed characters' } };
  }
  const ref = baseRef ?? 'HEAD';
  if (!isBranchName(ref)) {
    return { status: 400, body: { error: 'baseRef contains disallowed characters' } };
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: user.id },
    include: {
      user: { select: { unixUsername: true } },
      instance: { select: { hostHome: true, status: true } },
    },
  });
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  if (project.kind === 'metaterm') return { status: 400, body: { error: 'MetaTerm cannot branch off' } };
  // What refuseParkedBox / refuseUnreadySetup check on the cookie route, for callers without it (spawns).
  const parked = project.instance ? powerStateError(project.instance.status) : null;
  if (parked) return { status: 409, body: { error: parked } };
  const unready = refuseUnreadySessions(project);
  if (unready) return { status: 409, body: { error: unready.message } };

  const existing = await prisma.workstream.findUnique({
    where: { projectId_name: { projectId: project.id, name } },
  });
  if (existing) {
    return { status: 409, body: { error: 'A workstream with that name already exists' } };
  }

  const projDir = projectDirFor(project);
  const projectHost = { userId: project.userId, instanceId: project.instanceId };

  // The workstream's name: the one asked for, or an adopted worktree's directory.
  let wsName: string = name;
  // An adopted or reused worktree is not ours to remove if the row cannot be written.
  let createdWorktree = true;
  if (pr) {
    if (!isProjectAgentConnected(projectHost)) return { status: 503, body: { error: 'Box agent is not connected' } };
    if (!projectAgentCapabilities(projectHost).includes(WORKTREE_PR_CAPABILITY)) {
      return { status: 409, body: { error: "This box's agent cannot check out a pull request yet: update termag on the box and restart its agent." } };
    }
    let got: { adopted?: unknown; existing?: unknown };
    try {
      got = await sendForProject(projectHost, 'git-worktree-add-pr', {
        projectDir: projDir, worktreeName: name, branch: branchName, number: pr.number, sameRepo: pr.sameRepo, headOid: pr.headOid,
      }, PR_CHECKOUT_TIMEOUT_MS);
    } catch (err) {
      return { status: 500, body: { error: `Could not check out the pull request: ${(err as Error).message}` } };
    }
    if (typeof got?.adopted === 'string') {
      if (!NAME_REGEX.test(got.adopted) || got.adopted === 'main') {
        return { status: 409, body: { error: `${branchName} is checked out in .worktrees/${got.adopted}, which cannot be a workstream name` } };
      }
      wsName = got.adopted;
      createdWorktree = false;
      const taken = await prisma.workstream.findUnique({ where: { projectId_name: { projectId: project.id, name: wsName } } });
      if (taken) return { status: 409, body: { error: `${branchName} is already the workstream ${wsName}` } };
    } else if (got?.existing) {
      createdWorktree = false;
    }
  } else {
    // The first-commit backstop runs only for a project with no repository to
    // check out. A pane checkout sets setupStatus to none as soon as it is
    // typed, so the setup gate above lets this through while the fetch runs,
    // and a local first commit would own the branch name its `checkout --track`
    // needs. Start empty clears repoUrl, so an abandoned clone does get one.
    const initRepo = !project.repoUrl;
    try {
      if (isProjectAgentConnected(projectHost)) {
        await sendForProject(projectHost, 'git-worktree-add', {
          projectDir: projDir,
          worktreeName: name,
          branch: branchName,
          baseRef: ref,
          initRepo,
        });
      } else if (!project.instanceId) {
        await gitWorktreeAddLocal(projDir, name, branchName, ref, initRepo);
      } else {
        return { status: 503, body: { error: 'Box agent is not connected' } };
      }
    } catch (err) {
      const message = (err as Error).message;
      if (!initRepo && /invalid reference: HEAD/.test(message)) {
        return { status: 409, body: { error: CHECKOUT_NOT_LANDED } };
      }
      return { status: 500, body: { error: `git worktree add failed: ${message}` } };
    }
  }

  let workstream;
  try {
    workstream = await prisma.workstream.create({
      data: { projectId: project.id, name: wsName, branch: branchName },
    });
  } catch (err) {
    // DB write lost a race — try to clean up the worktree + branch we just
    // created so a retry isn't blocked by the half-built state. A PR's
    // branch is not deleted: it is the PR's, and may hold the user's work.
    if (!createdWorktree) throw err;
    if (isProjectAgentConnected(projectHost)) {
      await sendForProject(projectHost, 'git-worktree-remove', {
        projectDir: projDir, worktreeName: wsName, branch: pr ? undefined : branchName, force: true,
      }).catch(() => {});
    } else if (!project.instanceId) {
      await gitWorktreeRemoveLocal(projDir, wsName, pr ? null : branchName, true).catch(() => {});
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
    creatorSlackUserId: user.slackUserId ?? undefined,
  }).then(channelId => {
    if (!channelId) return;
    prisma.workstream.update({ where: { id: workstream.id }, data: { slackChannelId: channelId } })
      .catch(err => console.error('[WORKSTREAMS] Failed to save channel ID:', err.message));
    if (user.slackUserId) {
      setNotificationTarget(
        tmux.sessionName(project.user.unixUsername, project.name, 'agent', workstream.name),
        { channel: channelId, userId: user.slackUserId },
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
    const mainWorkflows = mainWs
      ? await prisma.workflow.findMany({ where: { workstreamId: mainWs.id } })
      : [];
    const workflows = mainWorkflows.map(w => ({
      type: w.type,
      provider: w.type === 'agent' && provider ? provider : w.provider,
    }));
    if (provider && !workflows.some(w => w.type === 'agent')) {
      workflows.unshift({ type: 'agent', provider });
    }
    for (const mw of workflows) {
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
            spawnId,
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
  } catch (e) {
    sessionLaunchWarnings.push(`mirror: ${(e as Error).message}`);
  }

  return {
    status: 201,
    body: {
      ...workstream,
      ...(sessionLaunchWarnings.length > 0 ? { sessionLaunchWarnings } : {}),
    },
  };
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
  // Body: { name, branch?, baseRef? } (createWorkstreamFor)
  const create: RequestHandler = async (req, res) => {
    const { name, branch, baseRef } = req.body as {
      name?: string; branch?: string; baseRef?: string;
    };
    sendResult(res, await createWorkstreamFor(req.user!, req.params.projectId, { name, branch, baseRef }));
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

// POST /api/projects/:projectId/workstreams/:id/agent  { provider }
  //
  // Switch the agent one workstream runs: rewrite its agent Workflow's provider,
  // stop what runs in its agent pane, and launch the new agent there — the
  // same state as if the workstream had been created with that agent. The
  // ctrl shell and Review pane are left alone. Without this the only way to
  // change agents was to start a different CLI by hand, which left the row
  // saying the old one: the badge stayed wrong, and an agent reconnect would
  // relaunch the OLD agent's resume command into the pane.
  //
  // Order: row first (cheap to undo), then the pane — a box that refuses the
  // stop gets the row put back, so nothing has moved. The launch comes last; a
  // failed launch leaves the new provider recorded and the pane at a shell,
  // which is what the next reconnect (or a re-try) repairs.
  const switchAgent: RequestHandler = async (req, res) => {
    const requested = (req.body ?? {}).provider;
    if (typeof requested !== 'string' || !isSelectableProvider(requested)) {
      res.status(400).json({ error: 'Choose one of the offered agents' }); return;
    }
    const workstream = await prisma.workstream.findFirst({
      where: { id: req.params.id, projectId: req.params.projectId },
      include: {
        project: {
          include: {
            user: { select: { unixUsername: true, defaultAgentProvider: true } },
            instance: { select: { hostHome: true } },
          },
        },
        workflows: { select: { id: true, type: true, provider: true } },
      },
    });
    if (!workstream || workstream.project.userId !== req.user!.id) {
      res.status(404).json({ error: 'Workstream not found' }); return;
    }
    const { project } = workstream;
    if (project.kind === 'metaterm') {
      res.status(400).json({ error: 'MetaTerm always runs Claude' }); return;
    }
    const wf = workstream.workflows.find(w => w.type === 'agent');
    if (!wf) { res.status(400).json({ error: 'This workstream has no agent' }); return; }

    const from = resolveAgentProvider(wf.provider, project.user.defaultAgentProvider);
    if (from === requested) { res.json({ ok: true, provider: requested, changed: false }); return; }

    const projectHost = { userId: project.userId, instanceId: project.instanceId };
    if (project.instanceId && !isProjectAgentConnected(projectHost)) {
      res.status(503).json({ error: 'Box agent is not connected' }); return;
    }
    const ctx = {
      userId: project.userId,
      unixUsername: project.user.unixUsername,
      projectName: project.name,
      instanceId: project.instanceId,
      workstream: workstream.name,
      hostHome: project.instance?.hostHome ?? null,
    };
    const session = tmux.sessionName(ctx.unixUsername, project.name, 'agent', workstream.name);

    // 1. The row.
    await prisma.workflow.update({ where: { id: wf.id }, data: { provider: requested } });

    // 2. The pane.
    try {
      await stopAgentPane({ ...ctx, provider: from });
    } catch (err) {
      await prisma.workflow.update({ where: { id: wf.id }, data: { provider: wf.provider } }).catch(e =>
        console.error('[WORKSTREAMS] switch agent: failed to revert row:', (e as Error).message));
      res.status(502).json({ error: `Could not stop ${PROVIDERS[from]?.displayName ?? from}: ${(err as Error).message}` });
      return;
    }

    // 3. The old agent's status: not_running ends its working-time span (booked
    // to the old provider) and drops its rate-limit badge, so the row does not
    // show a stale "working" until the new agent's first post. What the old
    // agent left that the merge would otherwise carry over goes too: a pending
    // "PR opened" prompt (explicit null) and its context reading (only
    // clearable as a metadata write — setStatus keeps it via `??`). The Review
    // pane's ring state stays: that pane is still running.
    setStatus(session, 'not_running', { milestone: null }, undefined, project.instanceId);
    clearMilestoneTimer(session, project.instanceId);
    updateStatusMeta(session, { contextTokens: undefined }, project.instanceId);
    notifyStatusChange(session, project.instanceId);

    // 4. The new agent, as a first launch (not a resume: its last session in
    // this directory, if any, is not what was running a moment ago). The pane
    // was just recreated, so anything but 'launched' means the agent was NOT
    // typed into it — say so instead of reporting a plain success.
    try {
      const launch = await ensureAgentSessionsAndLaunch({ ...ctx, provider: requested });
      res.json({ ok: true, provider: requested, changed: true, launch, warning: launchWarning(launch, requested) });
    } catch (err) {
      res.status(502).json({
        error: `Switched to ${PROVIDERS[requested]?.displayName ?? requested}, but it did not start: ${(err as Error).message}`,
        provider: requested,
      });
    }
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

    // The chat key is the workstream id, not its name. Stop the turn before
    // the row is deleted and before the worktree goes, so Claude is not still
    // writing into a tree this request is removing.
    const blocked = await revokeChats(
      (type, payload) => sendForProject(projectHost, type, payload),
      isProjectAgentConnected(projectHost),
      project.id,
      [workstream.id],
    );
    if (blocked) { res.status(409).json({ error: blocked }); return; }

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
  router.post('/projects/:projectId/workstreams/:id/agent', requireAuth, refuseParkedBox('projectId'), refuseUnreadySetup('projectId'), switchAgent);

  return router;
}
