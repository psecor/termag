import * as tmux from './tmux';
import { isProjectAgentConnected, sendForProject } from './agentRegistry';
import { registerPollerSession, unregisterPollerSession } from './tmuxPoller';
import { PROVIDERS, ALL_PROCESS_NAMES } from '../providers/registry';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Ask the right agent (the project's box if any, else the user's legacy
 * agent) whether an agent process is running in a given tmux session.
 *
 *   'running'     — foreground command looks like an agent (claude, codex, etc.)
 *   'not-running' — session doesn't exist or pane is just a shell
 *   'unknown'     — RPC failed; we can't tell. Callers should NOT relaunch
 *                   into "unknown" because typing keys into a session whose
 *                   state we can't verify could clobber an active prompt.
 */
async function probeAgentSession(
  project: { userId: string; instanceId: string | null },
  sessionName: string,
): Promise<'running' | 'not-running' | 'unknown'> {
  try {
    const result = await sendForProject(project, 'tmux-foreground-cmd', { sessionName });
    const cmd = (result?.cmd ?? '').toLowerCase();
    if (!cmd) return 'not-running';
    const looksLikeAgent = ALL_PROCESS_NAMES.some(a => cmd.includes(a))
      || ['node', 'python'].some(a => cmd.includes(a));
    return looksLikeAgent ? 'running' : 'not-running';
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
}

export async function ensureAgentSessionsAndLaunch({
  userId,
  unixUsername,
  projectName,
  provider,
  instanceId,
}: AgentRuntimeContext): Promise<void> {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const projDir = tmux.projectDir(unixUsername, projectName);
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent');
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl');
  const project = { userId, instanceId };

  if (isProjectAgentConnected(project)) {
    await sendForProject(project, 'tmux-create', { sessionName: mainSession, cwd: projDir });
    await sendForProject(project, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
    await new Promise(resolve => setTimeout(resolve, 500));

    if (config.needsBridge) {
      await sendForProject(project, 'codex-session-start', { sessionName: mainSession, cwd: projDir });
    } else {
      await sendForProject(project, 'tmux-send-keys', { sessionName: mainSession, keys: config.launchCommand, withEnter: true });
    }

    if (config.needsPoller) {
      registerPollerSession(mainSession, provider);
    }
    return;
  }

  // No agent connected for this project — fall back to local tmux (orchestrator
  // host). Only meaningful for legacy projects that live on the orchestrator
  // itself; instance-bound projects with a disconnected agent fail loudly here
  // because the orchestrator can't see the box's tmux server.
  if (instanceId) {
    throw new Error('Box agent not connected; cannot launch sessions');
  }

  await tmux.ensureProjectDir(unixUsername, projectName);
  const mainCreated = await tmux.ensureSession(mainSession, projDir);
  await tmux.ensureSession(ctrlSession, projDir);

  if (!mainCreated) return;

  await new Promise(resolve => setTimeout(resolve, 500));
  if (config.needsBridge) {
    await tmux.sendKeys(mainSession, config.launchCommand);
  } else {
    await tmux.sendKeys(mainSession, config.launchCommand);
  }

  if (config.needsPoller) {
    registerPollerSession(mainSession, provider);
  }
}

/**
 * Reconstruct all tmux sessions for a user's legacy agent (Mac / secorp.net).
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
  const projects = await prisma.project.findMany({
    where: { userId, archived: false, instanceId },
    include: { workflows: true },
  });

  if (projects.length === 0) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const defaultProvider = user?.defaultAgentProvider ?? 'claude';

  let launched = 0;

  for (const project of projects) {
    const projectHost = { userId, instanceId };

    for (const wf of project.workflows) {
      try {
        if (wf.type === 'agent') {
          const provider = resolveAgentProvider(wf.provider, defaultProvider);
          const mainSession = tmux.sessionName(unixUsername, project.name, 'agent');

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

          const config = PROVIDERS[provider];
          let launchCmd = config?.launchCommand ?? provider;

          if (provider === 'claude') {
            launchCmd = 'claude --continue';
          }

          const projDir = tmux.projectDir(unixUsername, project.name);
          const ctrlSession = tmux.sessionName(unixUsername, project.name, 'ctrl');

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
          const mainSession = tmux.sessionName(unixUsername, project.name, 'data');
          const ctrlSession = tmux.sessionName(unixUsername, project.name, 'data-ctrl');
          const projDir = tmux.projectDir(unixUsername, project.name);

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
}: AgentRuntimeContext): Promise<void> {
  const config = PROVIDERS[provider];
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent');
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl');
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
    return;
  }

  // Box-hosted projects with no live agent — nothing we can do; sessions die
  // with the box. Legacy projects fall through to the orchestrator's local
  // tmux (the original behavior).
  if (instanceId) return;

  await tmux.killSession(mainSession);
  await tmux.killSession(ctrlSession);
}
