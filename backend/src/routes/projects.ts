import { Router, RequestHandler } from 'express';
import { WorkflowType } from '@prisma/client';
import { prisma } from '../db';
import { CHAT_PROVIDER_ID, PROVIDER_IDS, SELECTABLE_PROVIDER_IDS, isSelectableProvider } from '../providers/registry';
import { requireAuth, requireAuthOrAgentToken } from '../middleware/auth';
import { parseBulkPinBody } from './bulkPin';
import { planUnarchiveLaunches } from './unarchive';
import { buildCloneCommand, parseRepoUrl, PROJECT_TEMPLATES, templateForRepoUrl } from '../services/projectTemplates';
import { archivedLookup, archivedRepoConflict, isBranchName, recordedBranch } from '../services/repoCreate';
import { isReservedProjectName, RESERVED_NAME_ERROR } from './projectNames';
import * as tmux from '../services/tmux';
import {
  isAgentConnected,
  isProjectAgentConnected,
  sendForProject,
  sendToAgent,
} from '../services/agentRegistry';
import { getAllStatuses, moveStatus, setStatus, notifyStatusChange } from '../services/status';
import { statusKey } from '../services/statusKey';
import { createProjectChannel } from '../slack/channels';
import { setNotificationTarget } from '../slack/lts';
import { rename } from 'fs/promises';
import { ensureAgentSessionsAndLaunch, resolveAgentProvider, stopAgentSessions } from '../services/agentRuntime';
import { replaySessionIdFrom } from '../services/launchCommand';
import { ensureMainWorkstream } from '../services/workstreams';
import { agentView, applySetupEvent } from '../services/projectClone';
import { cloneRoute, needsBoxRelaunch, waitsForBoxAgent } from '../services/projectSetup';
import { ensureHostSetup, hostAgentUnavailableResponse } from '../services/hostSetup';
import { assertSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { powerStateError } from '../services/boxPowerPolicy';
import { refuseParkedBox } from '../middleware/parkedBox';
import { refuseUnreadySetup } from '../middleware/unreadySetup';
import { RouteResult, sendResult } from './routeResult';
import { boxRenameError, boxRenameRpcError, renameSessionPairs } from './projectRename';
import { isAdminUser } from '../services/admin/adminAccess';
import { revokeChats } from '../services/chatRevoke';


const CAPTURE_MIN_INTERVAL_MS = 1000;
const captureRateLimits = new Map<string, number>();

function normalizeProvider(provider?: string | null, fallback?: string | null): string {
  if (provider && PROVIDER_IDS.includes(provider)) return provider;
  return resolveAgentProvider(undefined, fallback);
}

// Make sure a data workflow's two tmux sessions exist on the project's
// host: via the box / legacy agent when connected, else directly on the
// orchestrator for legacy projects. Box-pinned projects with no connected
// agent fail loudly — the orchestrator can't see the box's tmux server.
async function ensureDataSessions(
  projectHost: { userId: string; instanceId: string | null },
  unixUsername: string,
  projectName: string,
  workstream: string,
  hostHome: string | null,
): Promise<void> {
  const mainSession = tmux.sessionName(unixUsername, projectName, 'data', workstream);
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'data-ctrl', workstream);
  const projDir = tmux.projectDirFor(
    { name: projectName, user: { unixUsername }, instance: { hostHome } },
    workstream,
  );

  if (isProjectAgentConnected(projectHost)) {
    await sendForProject(projectHost, 'tmux-create', { sessionName: mainSession, cwd: projDir });
    await sendForProject(projectHost, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
  } else if (!projectHost.instanceId) {
    await tmux.ensureProjectDir(unixUsername, projectName);
    await tmux.ensureSession(mainSession, projDir);
    await tmux.ensureSession(ctrlSession, projDir);
  } else {
    throw new Error('Box agent not connected');
  }
}

export interface CreateProjectInput {
  name?: string;
  description?: string;
  color?: string;
  initialAgent?: { enabled?: boolean; provider?: string };
  instanceId?: string | null;
  /** Start the project as a clone of this GitHub repo (services/projectTemplates.ts). */
  repoUrl?: string | null;
  defaultBranch?: string | null;
  /**
   * The browser session recording (its id) the browser sent this from.
   * The agent launch types it so the session's Claude Code spans are filed
   * under that replay (services/launchCommand.ts); anything that is not an
   * id is ignored, never an error.
   */
  replaySessionId?: string | null;
  /** The agent spawn this project is for (routes/spawns.ts): its first launch starts on that brief. */
  spawnId?: string | null;
}

export async function createProjectFor(user: Express.User, input: CreateProjectInput): Promise<RouteResult> {
  try {
    const { name, description, color, initialAgent, instanceId, repoUrl: repoUrlInput, defaultBranch } = input;
    if (!name) { return { status: 400, body: { error: 'name required' } }; }
    const replaySessionId = replaySessionIdFrom(input.replaySessionId);

    // Optional "start as a clone of <repo>". Validated here. On a box the
    // box's agent clones it (services/projectClone.ts); on this host the clone
    // runs in the agent pane ahead of the agent launch. A known template's
    // baked clone is used as a git alternate so only the delta is fetched.
    let repo: { url: string; referenceDir?: string } | null = null;
    if (repoUrlInput != null && repoUrlInput !== '') {
      const parsed = parseRepoUrl(repoUrlInput);
      if (!parsed.ok) { return { status: 400, body: { error: parsed.error } }; }
      repo = { url: parsed.url, referenceDir: templateForRepoUrl(parsed.url)?.referenceDir };
      if (!initialAgent?.enabled) { return { status: 400, body: { error: 'repoUrl requires initialAgent.enabled (the clone runs in the agent pane)' } }; }
    }
    if (defaultBranch != null) {
      if (!repo) { return { status: 400, body: { error: 'defaultBranch requires repoUrl' } }; }
      if (typeof defaultBranch !== 'string' || !isBranchName(defaultBranch)) {
        return { status: 400, body: { error: 'branch contains disallowed characters' } };
      }
    }

    // Validate project name — safe for filesystem and tmux
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return { status: 400, body: { error: 'name must be alphanumeric with dashes/underscores only' } };
    }

    if (isReservedProjectName(name)) { return { status: 400, body: { error: RESERVED_NAME_ERROR } }; }

    // A NEW explicit choice must be a selectable provider; an omitted one falls
    // back to the user default, which may legitimately be a legacy id. Checked
    // here, before any side effect, so the un-archive branch below is covered too.
    if (initialAgent?.provider && !isSelectableProvider(initialAgent.provider) && initialAgent.provider !== CHAT_PROVIDER_ID) {
      return { status: 400, body: { error: `provider must be one of: ${SELECTABLE_PROVIDER_IDS.join(', ')}` } };
    }

    // If a box was specified, confirm the caller owns it and it's live.
    // null/undefined means a legacy project (lives on the user's
    // legacy agent).
    let hostHome: string | null = null;
    let boxStatus: string | null = null;
    if (instanceId) {
      const instance = await prisma.instance.findFirst({
        where: { id: instanceId, userId: user.id },
      });
      if (!instance) {
        return { status: 400, body: { error: 'instanceId not found or not owned by you' } };
      }
      if (instance.status === 'terminated') {
        return { status: 400, body: { error: 'cannot create a project on a terminated box' } };
      }
      if (instance.status === 'failed') {
        const why = instance.provisioningError ? `: ${instance.provisioningError}` : '';
        return { status: 409, body: { error: `The box failed to launch${why}`, code: 'box-failed' } };
      }
      const powerError = powerStateError(instance.status);
      if (powerError) { return { status: 409, body: { error: powerError } }; }
      hostHome = instance.hostHome;
      boxStatus = instance.status;
    }
    const projectInstanceId = instanceId ?? null;
    // Running a project on the orchestrator host itself is admin-only;
    // everyone else must pin to a box. Covers the un-archive branch too.
    if (!projectInstanceId && !isAdminUser(user)) {
      return { status: 403, body: { error: 'Projects must run on a box; this host is admin-only' } };
    }

    const archived = await prisma.project.findFirst({
      where: { userId: user.id, name, ...archivedLookup(!!repo, projectInstanceId) },
      include: { workflows: { include: { workstream: true } } },
    });
    const archivedDisposition = archivedRepoConflict(!!repo, archived != null);
    if (archivedDisposition === 'conflict') {
      return { status: 409, body: { error: 'An archived project with this name exists on this box' } };
    }
    if (archivedDisposition === 'unarchive' && archived) {
      // Un-archiving may move the project to a different box, and archiving
      // killed its sessions anyway, so every workflow it already has must get
      // its tmux sessions (re)created on the chosen host — not just a newly
      // requested agent workflow. Without this an old project re-created on
      // a new box rendered tmux's "no sessions" in the terminal pane.
      const plan = planUnarchiveLaunches({
        existingWorkflows: archived.workflows.map(w => ({
          type: w.type, provider: w.provider, workstream: w.workstream.name,
        })),
        initialAgentEnabled: !!initialAgent?.enabled,
      });

      // Same up-front checks as fresh-create: fail before touching the row.
      // This-host + HOST_AUTOSETUP uses hostAgentUnavailableResponse (400 for
      // bad unix names, 503 + ensureHostSetup when the agent is still down);
      // box-pinned needs a connected box agent when sessions must relaunch.
      const projectHost = { userId: user.id, instanceId: projectInstanceId };
      const needsHost = plan.createAgentWorkflow || plan.relaunch.length > 0;
      if (!projectInstanceId) {
        const unavailable = hostAgentUnavailableResponse(
          user,
          isProjectAgentConnected(projectHost),
        );
        if (unavailable) {
          if (unavailable.status === 503) void ensureHostSetup(user);
          return { status: unavailable.status, body: { error: unavailable.error } };
        }
      } else if (needsHost && !isProjectAgentConnected(projectHost)) {
        return { status: 503, body: { error: 'Box agent is not connected' } };
      }

      await prisma.project.update({
        where: { id: archived.id },
        data: {
          archived: false,
          description,
          color,
          instanceId: projectInstanceId,
          repoUrl: null,
          repoDefaultBranch: null,
          setupStatus: 'none',
          setupError: null,
        },
      });

      // Make sure the project dir exists on the (possibly new) host and seed
      // AGENTS.md / CLAUDE.md there, as fresh-create does. init-wiki skips
      // when AGENTS.md already exists, so a same-box un-archive is a no-op.
      const projDir = tmux.projectDirFor({
        name, user: { unixUsername: user.unixUsername }, instance: { hostHome },
      });
      if (isProjectAgentConnected(projectHost)) {
        await sendForProject(projectHost, 'mkdir', { dir: projDir });
        sendForProject(projectHost, 'init-wiki', {
          dir: projDir, slug: name, username: user.unixUsername,
        }).catch(() => {});
      } else if (!projectInstanceId) {
        // Un-archive clears repoUrl above, so nothing is coming to check out.
        await tmux.ensureProjectDir(user.unixUsername, name, { initialCommit: true });
      }

      // Launches run in order and stop at the first failure. Sessions already
      // created for earlier workflows are left on the host as idle shells;
      // the rollback below only touches the DB. That's harmless — a retry or
      // the agent's reconnect reconstruction converges on the same names.
      let createdWorkflowId: string | null = null;
      try {
        if (plan.createAgentWorkflow) {
          const provider = normalizeProvider(initialAgent?.provider, user.defaultAgentProvider);
          const ws = await ensureMainWorkstream(archived.id);
          const created = await prisma.workflow.create({
            data: { projectId: archived.id, workstreamId: ws.id, type: 'agent', provider },
          });
          createdWorkflowId = created.id;
          await ensureAgentSessionsAndLaunch({
            userId: user.id,
            unixUsername: user.unixUsername,
            projectName: name,
            provider,
            instanceId: projectInstanceId,
            workstream: ws.name,
            hostHome,
            replaySessionId,
          });
        }

        for (const wf of plan.relaunch) {
          if (wf.type === 'agent') {
            // ensureAgentSessionsAndLaunch probes the pane first, so a
            // project un-archived onto the same box with the agent still
            // running is left alone rather than re-typing the launch command.
            await ensureAgentSessionsAndLaunch({
              userId: user.id,
              unixUsername: user.unixUsername,
              projectName: name,
              provider: normalizeProvider(wf.provider, user.defaultAgentProvider),
              instanceId: projectInstanceId,
              workstream: wf.workstream,
              hostHome,
              replaySessionId,
            });
          } else {
            await ensureDataSessions(projectHost, user.unixUsername, name, wf.workstream, hostHome);
          }
        }
      } catch (err) {
        // Don't leave the project un-archived but pointing at a host with
        // no sessions — that is exactly the state this path is fixing.
        if (createdWorkflowId) {
          await prisma.workflow.delete({ where: { id: createdWorkflowId } }).catch(() => {});
        }
        await prisma.project.update({
          where: { id: archived.id },
          data: {
            archived: true,
            description: archived.description,
            color: archived.color,
            instanceId: archived.instanceId,
            repoUrl: archived.repoUrl,
            repoDefaultBranch: archived.repoDefaultBranch,
            setupStatus: archived.setupStatus,
            setupError: archived.setupError,
          },
        }).catch(() => {});
        throw err;
      }

      const restored = await prisma.project.findUnique({
        where: { id: archived.id },
        include: { workflows: true, workstreams: { orderBy: { createdAt: 'asc' } } },
      });
      return { status: 200, body: { ...restored, restored: true } };
    }

    const provider = initialAgent?.enabled
      ? normalizeProvider(initialAgent.provider, user.defaultAgentProvider)
      : null;

    // A repo pick on a box is set up by the box's agent, which may not have
    // connected yet: the project waits as `pending` and nothing touches its
    // dir until the agent says how it can clone (services/projectClone.ts).
    const cloneBox = repo ? projectInstanceId : null;
    // An empty project on a box still booting waits the same way, so a new
    // box and its first project can be asked for together; the box's hello
    // makes the dir and sessions.
    const projectHost = { userId: user.id, instanceId: projectInstanceId };
    const setupBox = cloneBox ?? (
      projectInstanceId && boxStatus && waitsForBoxAgent(boxStatus, isProjectAgentConnected(projectHost))
        ? projectInstanceId
        : null
    );

    // The pane checkout is typed ahead of the agent's launch command. Bridge
    // providers (codex) start their agent through the bridge, which takes
    // over the pane, so there is nowhere to chain the clone. A box whose
    // agent clones durably needs no pane, and one not heard from yet decides
    // when it is.
    const view = cloneBox ? agentView(cloneBox) : null;
    const unsupported = view
      ? view.kind === 'present' && cloneRoute(view.capabilities, provider) === 'unsupported'
      : !!repo && cloneRoute([], provider) === 'unsupported';
    if (unsupported) {
      return { status: 400, body: { error: `repoUrl is not supported with ${provider}: pick a provider that launches in the pane` } };
    }

    // Create project directory + seed AGENTS.md — via the project's agent
    // (its box if pinned, else the user's legacy agent), else direct.
    const projDir = tmux.projectDirFor({
      name, user: { unixUsername: user.unixUsername }, instance: { hostHome },
    });
    if (setupBox) {
      // The box's setup creates the dir; one made ahead of a clone would be in its way.
    } else if (isProjectAgentConnected(projectHost)) {
      await sendForProject(projectHost, 'mkdir', { dir: projDir });
      // Fire-and-forget: seed wiki files (agent handles idempotency). Not for
      // repo projects — the checkout brings its own, and untracked files in
      // the dir would make the checkout refuse.
      if (!repo) {
        sendForProject(projectHost, 'init-wiki', {
          dir: projDir, slug: name, username: user.unixUsername,
        }).catch(() => {});
      }
    } else if (!projectInstanceId) {
      const unavailable = hostAgentUnavailableResponse(user, false);
      if (unavailable) {
        if (unavailable.status === 503) void ensureHostSetup(user);
        return { status: unavailable.status, body: { error: unavailable.error } };
      }
      // Legacy path: orchestrator host's own filesystem (no wiki seed ahead of a repo fetch)
      await tmux.ensureProjectDir(user.unixUsername, name, { seedWiki: !repo, initialCommit: !repo });
    } else {
      // Box-pinned project but the box's agent isn't connected. Fail loud.
      return { status: 503, body: { error: 'Box agent is not connected' } };
    }

    const project = await prisma.project.create({
      data: {
        name,
        description,
        color,
        userId: user.id,
        instanceId: projectInstanceId,
        repoUrl: repo?.url ?? null,
        setupStatus: setupBox ? 'pending' : 'none',
        // The box's hello or clone report launches later; the row carries the
        // replay to that launch (services/projectClone.ts).
        launchReplaySessionId: setupBox ? replaySessionId : null,
      },
    });

    // Link the spawn before anything can launch: the clone path's launch
    // (services/projectClone.ts) claims the brief by this project's id.
    if (input.spawnId) {
      await prisma.agentSpawn.updateMany({
        where: { id: input.spawnId, userId: user.id, childProjectName: name, childProjectId: null },
        data: { childProjectId: project.id },
      }).catch(err => console.warn('[PROJECTS] could not link the spawn:', (err as Error).message));
    }

    const branch = recordedBranch({
      instanceId: projectInstanceId,
      hasRepo: !!repo,
      defaultBranch: typeof defaultBranch === 'string' ? defaultBranch : null,
    });
    const ws = await ensureMainWorkstream(project.id, branch !== undefined ? { branch } : undefined);

    try {
      if (provider) {
        await prisma.workflow.create({
          data: { projectId: project.id, workstreamId: ws.id, type: 'agent', provider },
        });
      }
      if (setupBox) {
        // Read again now the row exists: a hello that landed since the check
        // above found nothing to redispatch, so this create has to drive it.
        const now = agentView(setupBox);
        if (now.kind === 'present') {
          const outcome = await applySetupEvent({ projectId: project.id, instanceId: setupBox }, {
            kind: 'agent-connected', capabilities: now.capabilities,
          });
          // A hello that read the row before its workflow existed set an empty
          // project up with nothing to launch. Setup events for a project run
          // one at a time, so any such hello has finished by now; the launch
          // probes first, so one the hello did make is not doubled.
          if (outcome.kind === 'ignored' && !repo && provider) {
            const after = await prisma.project.findUnique({ where: { id: project.id }, select: { setupStatus: true } });
            if (after?.setupStatus === 'none') {
              await ensureAgentSessionsAndLaunch({
                userId: user.id,
                unixUsername: user.unixUsername,
                projectName: name,
                provider,
                instanceId: projectInstanceId,
                workstream: ws.name,
                hostHome,
                replaySessionId,
                spawnId: input.spawnId,
              });
            }
          }
        }
      } else if (provider) {
        await ensureAgentSessionsAndLaunch({
          userId: user.id,
          unixUsername: user.unixUsername,
          projectName: name,
          provider,
          preLaunch: repo ? buildCloneCommand(repo.url, repo.referenceDir) : undefined,
          instanceId: projectInstanceId,
          workstream: ws.name,
          hostHome,
          replaySessionId,
          spawnId: input.spawnId,
        });
      }
    } catch (err) {
      await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
      throw err;
    }

    // Create Slack channel #proj-<user>-<project> (fire-and-forget, non-blocking).
    // If we know the creator's Slack id, also route the agent session's
    // "needs input" notifications there, matching what `/t create` does.
    createProjectChannel(user.unixUsername, name, user.slackUserId ?? undefined).then(channelId => {
      if (!channelId) return;
      prisma.project.update({
        where: { id: project.id },
        data: { slackChannelId: channelId },
      }).catch(err => console.error('[PROJECTS] Failed to save channel ID:', err.message));
      if (user.slackUserId) {
        setNotificationTarget(
          tmux.sessionName(user.unixUsername, name, 'agent'),
          { channel: channelId, userId: user.slackUserId },
          'slack',
          projectInstanceId,
        );
      }
    });

    // Re-fetch with workflows so the response shape matches the existing
    // contract (callers expect `workflows: [...]` on a freshly-created project).
    const projectWithWorkflows = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      include: { workflows: true, workstreams: { orderBy: { createdAt: 'asc' } } },
    });
    return { status: 201, body: projectWithWorkflows };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return { status: 409, body: { error: 'Project name already exists' } };
    }
    console.error('[PROJECTS create]', err);
    return { status: 500, body: { error: 'Failed to create project' } };
  }
}

async function ownedBoxProject(user: Express.User, id: string): Promise<{ projectId: string; instanceId: string } | RouteResult> {
  const project = await prisma.project.findFirst({
    where: { id, userId: user.id, archived: false },
    select: { id: true, instanceId: true },
  });
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  if (!project.instanceId) return { status: 400, body: { error: 'Only a project on a box clones its repository' } };
  return { projectId: project.id, instanceId: project.instanceId };
}

/**
 * A project left waiting on a box that failed to launch: retire that box,
 * launch (or claim) one of the same name, and move the box's waiting projects
 * onto it. Nothing exists on the failed box, so nothing is lost. A box that
 * could not be created leaves the projects on the retired one, and Retry
 * tries again from there.
 */
async function relaunchBoxFor(
  user: Express.User,
  box: { id: string; name: string; kind: string; status: string; ec2InstanceId: string | null },
): Promise<RouteResult> {
  // Loaded here, not at the top: the box routes pull in the provisioner and
  // the warm pool, which nothing else in this module needs.
  const { createBox } = await import('./instances');
  const { isBoxProvisioningConfigured, terminateBox } = await import('../services/boxProvisioner');
  if (box.status === 'failed') {
    const now = new Date();
    const retired = await prisma.instance.updateMany({
      where: { id: box.id, status: 'failed' },
      data: { status: 'terminated', terminatedAt: now },
    });
    if (retired.count === 0) return { status: 409, body: { error: 'That box changed state; try again.' } };
    await prisma.agentToken.updateMany({ where: { instanceId: box.id, revokedAt: null }, data: { revokedAt: now } });
    if (isBoxProvisioningConfigured()) {
      const row = await prisma.instance.findUnique({ where: { id: box.id } });
      if (row) void terminateBox(row);
    }
  }
  const created = await createBox(user, { name: box.name, kind: 'ec2' });
  if (created.status !== 201) return created;
  const fresh = (created.body as { instance: { id: string } }).instance;
  const waiting = await prisma.project.findMany({
    where: { instanceId: box.id, userId: user.id, archived: false, setupStatus: 'pending' },
    select: { id: true },
  });
  await prisma.project.updateMany({
    where: { id: { in: waiting.map(p => p.id) }, setupStatus: 'pending' },
    data: { instanceId: fresh.id },
  });
  console.log(`[PROJECTS] relaunched failed box ${box.name} as ${fresh.id}; moved ${waiting.length} waiting project(s)`);
  // A claimed warm box said hello long ago, so nothing else drives these.
  const view = agentView(fresh.id);
  if (view.kind === 'present') {
    for (const { id } of waiting) {
      await applySetupEvent({ projectId: id, instanceId: fresh.id }, {
        kind: 'agent-connected', capabilities: view.capabilities,
      }).catch(err => console.error(`[PROJECTS] ${id}: setup on ${fresh.id} failed:`, (err as Error).message));
    }
  }
  const first = waiting[0]
    ? await prisma.project.findUnique({ where: { id: waiting[0].id }, select: { setupStatus: true } })
    : null;
  return { status: 202, body: { setupStatus: first?.setupStatus ?? 'pending', instanceId: fresh.id } };
}

export async function retryCloneFor(user: Express.User, id: string): Promise<RouteResult> {
  try {
    const project = await prisma.project.findFirst({
      where: { id, userId: user.id, archived: false },
      select: { setupStatus: true, instance: true },
    });
    if (project && needsBoxRelaunch(project.setupStatus, project.instance)) {
      return await relaunchBoxFor(user, project.instance!);
    }
    const target = await ownedBoxProject(user, id);
    if ('status' in target) return target;
    const outcome = await applySetupEvent(target, { kind: 'retry' });
    if (outcome.kind === 'refused') return { status: 409, body: { error: outcome.error } };
    if (outcome.kind !== 'applied') return { status: 409, body: { error: 'Only a failed clone can be retried.' } };
    const view = agentView(target.instanceId);
    if (view.kind === 'present') {
      await applySetupEvent(target, { kind: 'agent-connected', capabilities: view.capabilities }).catch(err => {
        console.error(`[CLONE] ${target.projectId}: dispatch after retry failed:`, (err as Error).message);
      });
    }
    const row = await prisma.project.findUnique({ where: { id: target.projectId }, select: { setupStatus: true } });
    return { status: 202, body: { setupStatus: row?.setupStatus ?? 'pending' } };
  } catch (err) {
    console.error('[PROJECTS clone retry]', err);
    return { status: 500, body: { error: 'Failed to retry the clone' } };
  }
}

export async function startEmptyFor(user: Express.User, id: string): Promise<RouteResult> {
  try {
    const target = await ownedBoxProject(user, id);
    if ('status' in target) return target;
    if (!isProjectAgentConnected({ userId: user.id, instanceId: target.instanceId })) {
      return { status: 503, body: { error: 'Box agent is not connected' } };
    }
    const outcome = await applySetupEvent(target, { kind: 'start-empty' });
    if (outcome.kind === 'refused') return { status: 409, body: { error: outcome.error } };
    if (outcome.kind === 'ignored') return { status: 409, body: { error: 'Only a failed clone can start empty.' } };
    const project = await prisma.project.findUnique({
      where: { id: target.projectId },
      include: { workflows: true, workstreams: { orderBy: { createdAt: 'asc' } } },
    });
    return { status: 200, body: project };
  } catch (err) {
    console.error('[PROJECTS clone start-empty]', err);
    return { status: 500, body: { error: 'Failed to start the project empty' } };
  }
}

export async function renameOwnedProject(user: Express.User, id: string, newName: unknown): Promise<RouteResult> {
  try {
    if (!newName || typeof newName !== 'string') { return { status: 400, body: { error: 'name required' } }; }

    if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
      return { status: 400, body: { error: 'name must be alphanumeric with dashes/underscores only' } };
    }
    if (isReservedProjectName(newName)) { return { status: 400, body: { error: RESERVED_NAME_ERROR } }; }

    const project = await prisma.project.findFirst({
      where: { id, userId: user.id },
      include: {
        workflows: { include: { workstream: true } },
        instance: { select: { hostHome: true, status: true } },
      },
    });
    if (!project) { return { status: 404, body: { error: 'Not found' } }; }
    if (project.kind === 'metaterm') { return { status: 400, body: { error: 'MetaTerm cannot be renamed' } }; }

    const oldName = project.name;
    if (oldName === newName) { return { status: 200, body: { ok: true } }; }

    const taken = await prisma.project.findFirst({
      where: { userId: user.id, instanceId: project.instanceId, name: newName },
      select: { id: true },
    });
    if (taken) return { status: 409, body: { error: 'A project with that name already exists' } };

    const username = user.unixUsername;
    const projectHost = { userId: user.id, instanceId: project.instanceId };
    const agentConnected = isProjectAgentConnected(projectHost);
    if (project.instance) {
      const refused = boxRenameError(project.instance.status, agentConnected);
      if (refused) return refused;
    }

    const providerRestarts: Array<{ provider: string; workstream: string }> = [];
    for (const wf of project.workflows) {
      if (wf.type !== 'agent' || !agentConnected) continue;
      const provider = resolveAgentProvider(wf.provider, user.defaultAgentProvider);
      if (provider === 'codex') {
        await sendForProject(projectHost, 'codex-session-stop', {
          sessionName: tmux.sessionName(username, oldName, 'agent', wf.workstream.name),
        }).catch(() => {});
      }
      providerRestarts.push({ provider, workstream: wf.workstream.name });
    }
    // The Codex bridges stopped above follow the sessions' names, so they come
    // back under whichever name the project ends up with.
    const restartCodex = async (projectName: string) => {
      for (const restart of providerRestarts) {
        if (restart.provider !== 'codex') continue;
        await ensureAgentSessionsAndLaunch({
          userId: user.id,
          unixUsername: username,
          projectName,
          provider: restart.provider,
          instanceId: project.instanceId,
          workstream: restart.workstream,
          hostHome: project.instance?.hostHome ?? null,
        }).catch(() => {});
      }
    };

    const sessions = renameSessionPairs(
      username, oldName, newName,
      project.workflows.map(wf => ({ type: wf.type, workstream: wf.workstream.name })),
    );
    if (project.instance) {
      // The box holds the sessions and the directory, so it renames both.
      const pathOf = (name: string) => tmux.projectDirFor({
        name, user: { unixUsername: username }, instance: { hostHome: project.instance!.hostHome },
      });
      try {
        await sendForProject(projectHost, 'project-rename', {
          sessions, fromDir: pathOf(oldName), toDir: pathOf(newName),
        });
      } catch (err) {
        await restartCodex(oldName);
        return boxRenameRpcError(err instanceof Error ? err.message : String(err));
      }
    } else {
      for (const { from, to } of sessions) {
        try {
          await tmux.renameSession(from, to);
        } catch { /* session may not exist */ }
      }
      try {
        await rename(tmux.projectDir(username, oldName), tmux.projectDir(username, newName));
      } catch { /* dir may not exist yet */ }
    }

    for (const { from, to } of sessions) {
      // A live session keeps its status and meta under the new name, as a
      // workstream rename does: a busy agent stays busy, so the stop that ends
      // its turn is still stamped, and a stopped one keeps its stoppedAt for
      // the sidebar marker. Nothing live (or an exited
      // agent) seeds idle as before, keeping any stop time it had.
      const live = getAllStatuses().get(statusKey(project.instanceId, from));
      if (!moveStatus(from, to, project.instanceId)) {
        setStatus(to, 'idle', { instanceId: project.instanceId, stoppedAt: live?.stoppedAt });
      }
      notifyStatusChange(to, project.instanceId);
    }

    // Update DB
    await prisma.project.update({
      where: { id: project.id },
      data: { name: newName },
    });

    const updated = await prisma.project.findUnique({
      where: { id: project.id },
      include: { workflows: true, workstreams: { orderBy: { createdAt: 'asc' } } },
    });
    await restartCodex(newName);
    return { status: 200, body: updated };
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return { status: 409, body: { error: 'A project with that name already exists' } };
    }
    return { status: 500, body: { error: 'Failed to rename project' } };
  }
}

export async function archiveOwnedProject(user: Express.User, id: string): Promise<RouteResult> {
  try {
    const project = await prisma.project.findFirst({
      where: { id, userId: user.id },
      include: { workflows: { include: { workstream: true } }, workstreams: { select: { id: true } } },
    });
    if (!project) { return { status: 404, body: { error: 'Not found' } }; }
    if (project.kind === 'metaterm') { return { status: 400, body: { error: 'MetaTerm cannot be archived' } }; }

    const host = { userId: user.id, instanceId: project.instanceId };
    // Before the archive commits. A connected box that still has a chat turn
    // running refuses; an offline one is stopped on the next hello.
    const blocked = await revokeChats(
      (type, payload) => sendForProject(host, type, payload),
      isProjectAgentConnected(host),
      project.id,
      project.workstreams.map(w => w.id),
    );
    if (blocked) return { status: 409, body: { error: blocked } };

    const username = user.unixUsername;

    // Kill all tmux sessions for this project — via the project's agent.
    for (const wf of project.workflows) {
      const wsName = wf.workstream.name;
      if (wf.type === 'agent') {
        await stopAgentSessions({
          userId: user.id,
          unixUsername: username,
          projectName: project.name,
          provider: resolveAgentProvider(wf.provider, user.defaultAgentProvider),
          instanceId: project.instanceId,
          workstream: wsName,
        });
      } else {
        await tmux.killSession(tmux.sessionName(username, project.name, 'data', wsName));
        await tmux.killSession(tmux.sessionName(username, project.name, 'data-ctrl', wsName));
      }
    }

    // Delete workflows from DB
    await prisma.workflow.deleteMany({ where: { projectId: project.id } });

    // Mark as archived (keep record + directory + browser tabs)
    await prisma.project.update({
      where: { id: project.id },
      data: { archived: true },
    });

    return { status: 200, body: { ok: true } };
  } catch {
    return { status: 500, body: { error: 'Failed to archive project' } };
  }
}

export function projectsRouter(): Router {
  const router = Router();

  const list: RequestHandler = async (req, res) => {
    try {
      res.json(await listProjectsFor(req.user!.id));
    } catch {
      res.status(500).json({ error: 'Failed to list projects' });
    }
  };

  const create: RequestHandler = async (req, res) => {
    // spawnId is the spawn route's alone: a browser body naming one would
    // link that spawn's brief to this project (routes/spawns.ts).
    const { spawnId: _spawnId, ...input } = (req.body ?? {}) as CreateProjectInput;
    sendResult(res, await createProjectFor(req.user!, input));
  };

  const update: RequestHandler = async (req, res) => {
    try {
      const { name, description, color, archived } = req.body;
      const existing = await prisma.project.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
      if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
      // MetaTerm is a managed singleton: only cosmetic fields may change here.
      // Its name is what its tmux sessions are keyed on, and archiving must go
      // through the guarded archive route (which refuses it too).
      if (existing.kind === 'metaterm' && (name !== undefined || archived !== undefined)) {
        res.status(400).json({ error: 'MetaTerm cannot be renamed or archived' });
        return;
      }
      if (name !== undefined && isReservedProjectName(String(name))) {
        res.status(400).json({ error: RESERVED_NAME_ERROR });
        return;
      }
      if (archived === true && !existing.archived) {
        const workstreams = await prisma.workstream.findMany({ where: { projectId: existing.id }, select: { id: true } });
        const host = { userId: req.user!.id, instanceId: existing.instanceId };
        const blocked = await revokeChats(
          (type, payload) => sendForProject(host, type, payload),
          isProjectAgentConnected(host),
          existing.id,
          workstreams.map(w => w.id),
        );
        if (blocked) { res.status(409).json({ error: blocked }); return; }
      }
      await prisma.project.update({
        where: { id: existing.id },
        data: { name, description, color, archived },
      });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to update project' });
    }
  };

  // Archive a project: kill all tmux sessions, delete workflows, keep directory and DB record
  const archive: RequestHandler = async (req, res) => {
    sendResult(res, await archiveOwnedProject(req.user!, req.params.id));
  };

  const addWorkflow: RequestHandler = async (req, res) => {
    try {
      const { type, provider: providerInput } = req.body as {
        type: WorkflowType;
        provider?: string;
      };
      if (!['agent', 'data'].includes(type)) {
        res.status(400).json({ error: 'type must be agent or data' });
        return;
      }
      if (type === 'data' && providerInput) {
        res.status(400).json({ error: 'provider is only valid for agent workflows' });
        return;
      }

      const project = await prisma.project.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
        include: { instance: { select: { hostHome: true } } },
      });
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      if (project.kind === 'metaterm') { res.status(400).json({ error: 'MetaTerm workflows are managed automatically' }); return; }

      if (type === 'agent' && providerInput && !isSelectableProvider(providerInput)) {
        res.status(400).json({ error: `provider must be one of: ${SELECTABLE_PROVIDER_IDS.join(', ')}` });
        return;
      }
      const provider = type === 'agent'
        ? normalizeProvider(providerInput, req.user!.defaultAgentProvider)
        : null;

      const ws = await ensureMainWorkstream(project.id);
      const workflow = await prisma.workflow.create({
        data: { projectId: project.id, workstreamId: ws.id, type, provider },
      });

      try {
        if (type === 'agent') {
          await ensureAgentSessionsAndLaunch({
            userId: req.user!.id,
            unixUsername: req.user!.unixUsername,
            projectName: project.name,
            provider: provider!,
            instanceId: project.instanceId,
            workstream: ws.name,
            hostHome: project.instance?.hostHome ?? null,
          });
        } else {
          await ensureDataSessions(
            { userId: req.user!.id, instanceId: project.instanceId },
            req.user!.unixUsername,
            project.name,
            ws.name,
            project.instance?.hostHome ?? null,
          );
        }
      } catch (err) {
        await prisma.workflow.delete({ where: { id: workflow.id } }).catch(() => {});
        throw err;
      }

      res.status(201).json(workflow);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') {
        res.status(409).json({ error: 'Workflow type already exists for this project' });
        return;
      }
      res.status(500).json({ error: 'Failed to create workflow' });
    }
  };

  const removeWorkflow: RequestHandler = async (req, res) => {
    try {
      const type = req.params.type as WorkflowType;
      const project = await prisma.project.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
        include: { workflows: { include: { workstream: true } } },
      });
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      if (project.kind === 'metaterm') { res.status(400).json({ error: 'MetaTerm workflows are managed automatically' }); return; }
      const workflow = project.workflows.find(w => w.type === type);
      const provider = normalizeProvider(workflow?.provider, req.user!.defaultAgentProvider);
      const wsName = workflow?.workstream.name ?? 'main';

      await prisma.workflow.deleteMany({ where: { projectId: project.id, type } });

      if (type === 'agent') {
        await stopAgentSessions({
          userId: req.user!.id,
          unixUsername: req.user!.unixUsername,
          projectName: project.name,
          provider,
          instanceId: project.instanceId,
          workstream: wsName,
        });
      } else {
        await tmux.killSession(tmux.sessionName(req.user!.unixUsername, project.name, 'data', wsName));
        await tmux.killSession(tmux.sessionName(req.user!.unixUsername, project.name, 'data-ctrl', wsName));
      }

      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete workflow' });
    }
  };

  const renameProject: RequestHandler = async (req, res) => {
    sendResult(res, await renameOwnedProject(req.user!, req.params.id, req.body?.name));
  };

  const togglePin: RequestHandler = async (req, res) => {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
      });
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const updated = await prisma.project.update({
        where: { id: project.id },
        data: { pinned: !project.pinned },
      });
      res.json({ pinned: updated.pinned });
    } catch {
      res.status(500).json({ error: 'Failed to toggle pin' });
    }
  };

  // Bulk pin/unpin. Unlike togglePin, the target state is explicit so a mixed
  // selection ends up uniform. Scoped to the caller's owned projects (same guard
  // togglePin uses), so collaborator/foreign ids are silently skipped.
  const bulkPin: RequestHandler = async (req, res) => {
    try {
      const parsed = parseBulkPinBody(req.body);
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const result = await prisma.project.updateMany({
        where: { id: { in: parsed.projectIds }, userId: req.user!.id },
        data: { pinned: parsed.pinned },
      });
      res.json({ updated: result.count });
    } catch {
      res.status(500).json({ error: 'Failed to update pins' });
    }
  };

  // Capture pane content for a project session — works for projects you own
  // OR projects shared with you. Routes through the owner's agent so the
  // requester sees what's actually on screen for the owner's tmux.
  // Auth: session cookie OR Bearer agent token (so an agent on a user's box
  // can curl this directly).
  const capture: RequestHandler = async (req, res) => {
    const result = await captureFor(req.user!.id, req.params.id, req.params.role, req.query, req.agentInstanceId ?? 'browser');
    res.status(result.status).json(result.body);
  };

  router.get('/', requireAuthOrAgentToken, list);
  // Starter repos for "first project" (first-run wizard). Before any /:id route.
  router.get('/templates', requireAuth, (_req, res) => {
    res.json(PROJECT_TEMPLATES.map(t => ({ id: t.id, label: t.label, repoUrl: t.repoUrl, blurb: t.blurb })));
  });
  router.post('/', requireAuth, create);
  // Must precede the `/:id` routes — `/bulk/pin` would otherwise match
  // `/:id/pin` with id="bulk".
  router.post('/bulk/pin', requireAuth, bulkPin);
  router.put('/:id', requireAuth, update);
  router.post('/:id/rename', requireAuth, renameProject);
  router.post('/:id/pin', requireAuth, togglePin);
  router.post('/:id/archive', requireAuth, archive);
  router.post('/:id/workflows', requireAuth, refuseParkedBox('id'), refuseUnreadySetup('id'), addWorkflow);
  router.post('/:id/clone/retry', requireAuth, refuseParkedBox('id'), async (req, res) => {
    sendResult(res, await retryCloneFor(req.user!, req.params.id));
  });
  router.post('/:id/clone/start-empty', requireAuth, refuseParkedBox('id'), async (req, res) => {
    sendResult(res, await startEmptyFor(req.user!, req.params.id));
  });
  router.delete('/:id/workflows/:type', requireAuth, removeWorkflow);
  router.get('/:id/sessions/:role/capture', requireAuthOrAgentToken, capture);

  return router;
}

/**
 * Every live project the user owns or has been shared, with its workflows and
 * workstreams (main first). GET /api/projects and the TUI's
 * GET /api/cli/v1/lobby both answer with this.
 */
export async function listProjectsFor(userId: string) {
  const projectInclude = {
    workflows: true,
    workstreams: { orderBy: { createdAt: 'asc' as const } },
    user: { select: { unixUsername: true } },
  };
  const owned = await prisma.project.findMany({
    where: { userId, archived: false },
    include: projectInclude,
    orderBy: [{ pinned: 'desc' }, { name: 'asc' }],
  });

  const shares = await prisma.projectShare.findMany({
    where: { userId },
    include: { project: { include: projectInclude } },
  });

  return [
    ...owned.map(p => ({
      id: p.id, name: p.name, description: p.description, color: p.color,
      archived: p.archived, pinned: p.pinned, lastActiveAt: p.lastActiveAt,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
      userId: p.userId, instanceId: p.instanceId, kind: p.kind, repoUrl: p.repoUrl,
      repoDefaultBranch: p.repoDefaultBranch, setupStatus: p.setupStatus, setupError: p.setupError,
      workflows: p.workflows, workstreams: p.workstreams,
      ownerUsername: p.user.unixUsername, role: 'owner' as const,
    })),
    ...shares
      .filter(s => !s.project.archived)
      .map(s => ({
        id: s.project.id, name: s.project.name, description: s.project.description,
        color: s.project.color, archived: s.project.archived,
        pinned: s.project.pinned, lastActiveAt: s.project.lastActiveAt,
        createdAt: s.project.createdAt, updatedAt: s.project.updatedAt,
        userId: s.project.userId, instanceId: s.project.instanceId, kind: s.project.kind,
        repoUrl: s.project.repoUrl,
        repoDefaultBranch: s.project.repoDefaultBranch,
        setupStatus: s.project.setupStatus, setupError: s.project.setupError,
        workflows: s.project.workflows,
        workstreams: s.project.workstreams,
        ownerUsername: s.project.user.unixUsername, role: 'collaborator' as const,
      })),
  ];
}

/**
 * Capture a project session's pane, for its owner or a collaborator. Routes
 * through the owner's agent so the requester sees what is on screen in the
 * owner's tmux. Backs the cookie/agent-token capture route and the CLI's.
 */
export async function captureFor(
  userId: string, projectId: string, role: string, query: Record<string, unknown>,
  /** Who is asking, for the rate-limit key: a bearer token's box id, 'cli', or 'browser'. */
  callerId: string = 'browser',
): Promise<{ status: number; body: unknown }> {
  const requestedLines = parseInt(query.lines as string, 10);
  const lines = Number.isFinite(requestedLines)
    ? Math.max(1, Math.min(1000, requestedLines))
    : 200;
  const workstream = typeof query.workstream === 'string' && query.workstream
    ? query.workstream
    : 'main';
  // ?styled=1 keeps SGR escapes (tmux `-e`) so a reader can tell dimmed
  // ghost-text from typed input. Best effort: agents predating the flag
  // ignore it and return plain text (their reply carries no `styled`).
  const styled = query.styled === '1' || query.styled === 'true';

  // Owner-or-share + allowlist-by-reconstruction live in assertSessionAccess,
  // shared with the MetaTerm list / send-keys routes. 404 on any denial.
  let access;
  try {
    access = await assertSessionAccess(userId, projectId, role, workstream);
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  const sessionName = access.session;
  const ownerHost = access.host;

  // Per caller, not per user: a bearer-token caller (MetaTerm's MCP server,
  // keyed by its box) and a browser (the phone client polling at up to 1/s)
  // each get their own budget, so neither can starve the other with 429s.
  const rateKey = `${userId}:${callerId}:${sessionName}`;
  const now = Date.now();
  const last = captureRateLimits.get(rateKey) ?? 0;
  if (now - last < CAPTURE_MIN_INTERVAL_MS) {
    return { status: 429, body: { error: 'Rate limited (max 1 capture/sec per caller and session)' } };
  }
  captureRateLimits.set(rateKey, now);

  if (!isProjectAgentConnected(ownerHost)) {
    return { status: 503, body: { error: "Owner's agent is offline" } };
  }

  try {
    const result = await sendForProject(ownerHost, 'tmux-capture', { sessionName, lines, styled });
    return { status: 200, body: { session: sessionName, content: result.content ?? '', styled: result.styled === true } };
  } catch (err) {
    return { status: 503, body: { error: `Capture failed: ${(err as Error).message}` } };
  }
}
