import * as tmux from './tmux';
import { isProjectAgentConnected, sendForProject } from './agentRegistry';
import { registerPollerSession, unregisterPollerSession } from './tmuxPoller';
import { PROVIDERS } from '../providers/registry';
import { classifyForeground } from './foregroundProbe';
import { refuseUnreadySessions, SessionGateError, type SetupAdmission } from './sessionGate';
import { prisma } from '../db';


/**
 * Ask the right agent (the project's box if any, else the user's legacy
 * agent) whether an agent process is running in a given tmux session.
 *
 *   'running'     — foreground command looks like an agent (claude, codex, etc.)
 *   'not-running' — session doesn't exist or pane is just a shell
 *   'busy'        — git or a git-* helper is the process-group leader. A
 *                   checkout fetch has to be that leader: a subshell wrapping
 *                   it shows up here as bash or zsh and looks idle.
 *   'unknown'     — RPC failed; we can't tell. Callers should NOT relaunch
 *                   into "unknown" because typing keys into a session whose
 *                   state we can't verify could clobber an active prompt.
 */
async function probeAgentSession(
  project: { userId: string; instanceId: string | null },
  sessionName: string,
): Promise<'running' | 'not-running' | 'unknown' | 'busy'> {
  try {
    const result = await sendForProject(project, 'tmux-foreground-cmd', { sessionName });
    return classifyForeground(result?.cmd);
  } catch {
    return 'unknown';
  }
}

export function resolveAgentProvider(
  workflowProvider?: string | null,
  userDefaultProvider?: string | null,
): string {
  return workflowProvider ?? userDefaultProvider ?? 'claude';
}

interface AgentRuntimeContext {
  userId: string;
  unixUsername: string;
  projectName: string;
  provider: string;
  /** The project's instanceId, or null if it lives on the user's legacy agent. */
  instanceId: string | null;
  /** Workstream name — 'main' for single-workstream projects (the default). */
  workstream: string;
  /**
   * The box's `Instance.hostHome`. Omitted by callers that don't have the
   * instance loaded, which resolves the project dir the way it always was.
   */
  hostHome?: string | null;
  /**
   * Shell to run in the agent pane BEFORE the agent's launch command (joined
   * with `&&`, so a failure leaves the pane at a prompt showing the error
   * rather than starting the agent in a half-made dir). Used for the pane
   * checkout of a repo project (services/projectTemplates.ts). Only honoured
   * on first launch; reconnects relaunch the bare agent. What keeps
   * reconstruction from typing the bare resume into that pane first is the
   * session gate: the project stays `pending` until this launch has typed the
   * clone, and reconstruction skips it until then.
   */
  preLaunch?: string;
  /** Lets the setup owner (services/projectClone.ts) launch before it commits the move. */
  admission?: SetupAdmission;
}

/** What a launch did: typed the agent, or left a pane that already had one, git, or an unreadable state. */
export type LaunchOutcome = 'launched' | 'running' | 'busy' | 'unknown';

export async function ensureAgentSessionsAndLaunch({
  userId,
  unixUsername,
  projectName,
  provider,
  instanceId,
  workstream,
  hostHome,
  preLaunch,
  admission,
}: AgentRuntimeContext): Promise<LaunchOutcome> {
  // Before any RPC: tmux-create makes the dir and git-inits it, which would
  // poison a clone still in progress. A name with no live row is not gated.
  const setup = await prisma.project.findFirst({
    where: { userId, instanceId: instanceId ?? null, name: projectName, archived: false },
    select: { id: true, setupStatus: true },
  });
  const refusal = setup && refuseUnreadySessions(setup, admission);
  if (refusal) throw new SessionGateError(refusal);

  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const projDir = tmux.projectDirFor(
    { name: projectName, user: { unixUsername }, instance: { hostHome: hostHome ?? null } },
    workstream,
  );
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent', workstream);
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl', workstream);
  const project = { userId, instanceId };

  if (isProjectAgentConnected(project)) {
    await sendForProject(project, 'tmux-create', { sessionName: mainSession, cwd: projDir });
    await sendForProject(project, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
    await new Promise(resolve => setTimeout(resolve, 500));

    // Don't re-launch the agent CLI if it (or any known agent process) is
    // already running in the pane. Skipping on 'unknown' too, since blindly
    // typing into a session whose state we can't verify risks clobbering an
    // active prompt. Same logic as reconstructAgentSessions — keeps the
    // re-create-an-existing-project path from typing `claude` (or `devin`,
    // `cursor`, etc.) into a pane that already has one running.
    const probe = await probeAgentSession(project, mainSession);
    if (probe === 'running' || probe === 'unknown' || probe === 'busy') {
      if (probe === 'unknown') {
        console.warn(`[LAUNCH] ${projectName}: probe failed, skipping send-keys to avoid clobber`);
      }
      if (probe === 'busy') {
        console.warn(`[LAUNCH] ${projectName}: git is in the foreground, skipping send-keys`);
      }
      if (probe !== 'busy' && config.needsPoller) registerPollerSession(mainSession, provider);
      return probe;
    }

    if (config.needsBridge) {
      // The bridge owns the pane (its start sends C-c, clears, launches), so a
      // pre-launch command cannot be chained ahead of it. POST /api/projects
      // rejects repoUrl for bridge providers; this is the belt and braces.
      if (preLaunch) console.warn(`[LAUNCH] ${projectName}: preLaunch ignored for bridge provider ${provider}`);
      await sendForProject(project, 'codex-session-start', { sessionName: mainSession, cwd: projDir });
    } else {
      const keys = preLaunch ? `${preLaunch} && ${config.launchCommand}` : config.launchCommand;
      await sendForProject(project, 'tmux-send-keys', { sessionName: mainSession, keys, withEnter: true });
    }

    if (config.needsPoller) {
      registerPollerSession(mainSession, provider);
    }
    return 'launched';
  }

  // No agent connected for this project — fall back to local tmux (orchestrator
  // host). Only meaningful for legacy projects that live on the orchestrator
  // itself; instance-bound projects with a disconnected agent fail loudly here
  // because the orchestrator can't see the box's tmux server.
  if (instanceId) {
    throw new Error('Box agent not connected; cannot launch sessions');
  }

  // Legacy local-orchestrator path: only meaningful for the main workstream.
  // Non-main workstreams are git worktrees layered over an existing repo and
  // are managed by the CRUD route, not seeded here.
  if (workstream === 'main') {
    // No wiki seed ahead of a repo fetch (see ensureProjectDir).
    await tmux.ensureProjectDir(unixUsername, projectName, { seedWiki: !preLaunch });
  }
  const mainCreated = await tmux.ensureSession(mainSession, projDir);
  await tmux.ensureSession(ctrlSession, projDir);

  if (!mainCreated) return 'running';

  await new Promise(resolve => setTimeout(resolve, 500));
  await tmux.sendKeys(mainSession, preLaunch ? `${preLaunch} && ${config.launchCommand}` : config.launchCommand);

  if (config.needsPoller) {
    registerPollerSession(mainSession, provider);
  }
  return 'launched';
}

/**
 * Reconstruct all tmux sessions for a user's legacy agent.
 * Called from agentRegistry.registerAgent when a non-instance-bound agent
 * connects.
 */
export async function reconstructUserSessions(userId: string, unixUsername: string): Promise<void> {
  await reconstructAgentSessions(userId, unixUsername, null);
}

/**
 * Reconstruct tmux sessions for one specific box's agent. Called when an
 * instance-bound agent connects (after a box reboot / replacement). Only
 * touches projects pinned to this instance.
 */
export async function reconstructInstanceSessions(
  instanceId: string,
  userId: string,
  unixUsername: string,
): Promise<void> {
  await reconstructAgentSessions(userId, unixUsername, instanceId);
}

/**
 * Reconstruct tmux sessions for one agent. Filters projects so the legacy
 * agent only sees legacy projects (instanceId IS NULL) and an instance
 * agent only sees its own projects (instanceId = X). Avoids cross-talk
 * where one agent would try to recreate sessions belonging to another box.
 */
async function reconstructAgentSessions(
  userId: string,
  unixUsername: string,
  instanceId: string | null,
): Promise<void> {
  // hostHome is read here rather than passed in: registerAgent schedules this
  // 2s after connect while the `hello` that supplies it is a fire-and-forget
  // write, so the freshest value is whatever the DB holds right now.
  const projects = await prisma.project.findMany({
    where: { userId, archived: false, instanceId },
    include: {
      workflows: { include: { workstream: true } },
      instance: { select: { hostHome: true } },
    },
  });

  if (projects.length === 0) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const defaultProvider = user?.defaultAgentProvider ?? 'claude';

  let launched = 0;

  for (const project of projects) {
    const projectHost = { userId, instanceId };
    const unready = refuseUnreadySessions(project);
    if (unready) {
      console.log(`[RECONSTRUCT] Skipping ${project.name}: setup is ${unready.setupStatus}`);
      continue;
    }

    for (const wf of project.workflows) {
      const wsName = wf.workstream.name;
      try {
        if (wf.type === 'agent') {
          const provider = resolveAgentProvider(wf.provider, defaultProvider);
          const mainSession = tmux.sessionName(unixUsername, project.name, 'agent', wsName);

          const probe = await probeAgentSession(projectHost, mainSession);
          if (probe === 'running') {
            const config = PROVIDERS[provider];
            if (config?.needsPoller) registerPollerSession(mainSession, provider);
            continue;
          }
          if (probe === 'unknown') {
            console.warn(`[RECONSTRUCT] Skipping ${project.name}/${wf.type}: probe failed`);
            continue;
          }
          if (probe === 'busy') {
            console.warn(`[RECONSTRUCT] Skipping ${project.name}/${wf.type}: git is in the foreground`);
            continue;
          }

          // Relaunch into an existing cwd: resume the last session there when
          // the provider knows how (claude --continue, pi
          // --continue), else a fresh launch.
          const config = PROVIDERS[provider];
          const launchCmd = config?.resumeCommand ?? config?.launchCommand ?? provider;

          const projDir = tmux.projectDirFor(
            { name: project.name, user: { unixUsername }, instance: project.instance },
            wsName,
          );
          const ctrlSession = tmux.sessionName(unixUsername, project.name, 'ctrl', wsName);

          await sendForProject(projectHost, 'tmux-create', { sessionName: mainSession, cwd: projDir });
          await sendForProject(projectHost, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });

          await new Promise(resolve => setTimeout(resolve, 500));

          if (config?.needsBridge) {
            await sendForProject(projectHost, 'codex-session-start', { sessionName: mainSession, cwd: projDir });
          } else {
            await sendForProject(projectHost, 'tmux-send-keys', { sessionName: mainSession, keys: launchCmd, withEnter: true });
          }

          if (config?.needsPoller) {
            registerPollerSession(mainSession, provider);
          }

          launched++;
        } else {
          // Data workflow — just ensure sessions exist
          const mainSession = tmux.sessionName(unixUsername, project.name, 'data', wsName);
          const ctrlSession = tmux.sessionName(unixUsername, project.name, 'data-ctrl', wsName);
          const projDir = tmux.projectDirFor(
            { name: project.name, user: { unixUsername }, instance: project.instance },
            wsName,
          );

          await sendForProject(projectHost, 'tmux-create', { sessionName: mainSession, cwd: projDir });
          await sendForProject(projectHost, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
        }
      } catch (err) {
        console.error(`[RECONSTRUCT] Failed for ${project.name}/${wf.type}:`, (err as Error).message);
      }
    }
  }

  const scope = instanceId ? `instance ${instanceId}` : `${unixUsername} (legacy)`;
  console.log(`[RECONSTRUCT] ${scope}: reconstructed ${launched} agent sessions across ${projects.length} projects`);
}

export async function stopAgentSessions({
  userId,
  unixUsername,
  projectName,
  provider,
  instanceId,
  workstream,
}: AgentRuntimeContext): Promise<void> {
  const config = PROVIDERS[provider];
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent', workstream);
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl', workstream);
  // The Devin review pane (routes/review.ts) hangs off the agent workflow and
  // must die with it, or Devin keeps burning tokens in a pane nobody can see.
  const reviewSession = tmux.sessionName(unixUsername, projectName, 'review', workstream);
  const project = { userId, instanceId };

  if (config?.needsPoller) {
    unregisterPollerSession(mainSession);
  }

  if (isProjectAgentConnected(project)) {
    if (config?.needsBridge) {
      await sendForProject(project, 'codex-session-stop', { sessionName: mainSession }).catch(() => {});
    }
    await sendForProject(project, 'tmux-kill', { sessionName: mainSession }).catch(() => {});
    await sendForProject(project, 'tmux-kill', { sessionName: ctrlSession }).catch(() => {});
    await sendForProject(project, 'tmux-kill', { sessionName: reviewSession }).catch(() => {});
    return;
  }

  // Box-hosted projects with no live agent — nothing we can do; sessions die
  // with the box. Legacy projects fall through to the orchestrator's local
  // tmux (the original behavior).
  if (instanceId) return;

  await tmux.killSession(mainSession);
  await tmux.killSession(ctrlSession);
  await tmux.killSession(reviewSession);
}
