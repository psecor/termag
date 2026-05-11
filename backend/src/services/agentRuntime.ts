import * as tmux from './tmux';
import { isAgentConnected, sendToAgent } from './agentRegistry';
import { registerPollerSession, unregisterPollerSession } from './tmuxPoller';
import { PROVIDERS, ALL_PROCESS_NAMES } from '../providers/registry';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Ask the user's agent whether an agent process is running in a given tmux
 * session. Uses the foreground pane command — same heuristic as
 * tmux.isAgentRunning, but routed through the agent so it queries the
 * correct host (remote Mac, laptop, etc.) instead of the backend's local
 * tmux server.
 *
 *   'running'     — foreground command looks like an agent (claude, codex, etc.)
 *   'not-running' — session doesn't exist or pane is just a shell
 *   'unknown'     — RPC failed; we can't tell. Callers should NOT relaunch
 *                   into "unknown" because typing keys into a session whose
 *                   state we can't verify could clobber an active prompt.
 */
async function probeAgentSession(userId: string, sessionName: string): Promise<'running' | 'not-running' | 'unknown'> {
  try {
    const result = await sendToAgent(userId, 'tmux-foreground-cmd', { sessionName });
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
}

export async function ensureAgentSessionsAndLaunch({
  userId,
  unixUsername,
  projectName,
  provider,
}: AgentRuntimeContext): Promise<void> {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const projDir = tmux.projectDir(unixUsername, projectName);
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent');
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl');

  if (isAgentConnected(userId)) {
    await sendToAgent(userId, 'tmux-create', { sessionName: mainSession, cwd: projDir });
    await sendToAgent(userId, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
    await new Promise(resolve => setTimeout(resolve, 500));

    if (config.needsBridge) {
      await sendToAgent(userId, 'codex-session-start', { sessionName: mainSession, cwd: projDir });
    } else {
      await sendToAgent(userId, 'tmux-send-keys', { sessionName: mainSession, keys: config.launchCommand, withEnter: true });
    }

    if (config.needsPoller) {
      registerPollerSession(mainSession, provider);
    }
    return;
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
 * Reconstruct all tmux sessions for a user after their agent reconnects.
 * Called on agent WebSocket connect — handles post-reboot recovery.
 *
 * For each non-archived project with workflows:
 * - Agent workflows: creates agent + ctrl sessions, launches the provider
 *   (Claude gets --continue to resume the last conversation)
 * - Data workflows: creates data + data-ctrl sessions
 *
 * Skips sessions where the agent process is already running (handles
 * reconnects from network blips where sessions survived).
 */
export async function reconstructUserSessions(userId: string, unixUsername: string): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { userId, archived: false },
    include: { workflows: true },
  });

  if (projects.length === 0) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  const defaultProvider = user?.defaultAgentProvider ?? 'claude';

  let launched = 0;

  for (const project of projects) {
    for (const wf of project.workflows) {
      try {
        if (wf.type === 'agent') {
          const provider = resolveAgentProvider(wf.provider, defaultProvider);
          const mainSession = tmux.sessionName(unixUsername, project.name, 'agent');

          // Check if agent is already running in this session (network blip,
          // sleep/wake — not a full reboot). Must route through the agent
          // because the session lives on the user's host, not the backend's.
          const probe = await probeAgentSession(userId, mainSession);
          if (probe === 'running') {
            // Session survived — just re-register poller if needed
            const config = PROVIDERS[provider];
            if (config?.needsPoller) registerPollerSession(mainSession, provider);
            continue;
          }
          if (probe === 'unknown') {
            // RPC failed — don't relaunch into a session we can't see
            console.warn(`[RECONSTRUCT] Skipping ${project.name}/${wf.type}: probe failed`);
            continue;
          }

          // Session is missing or agent isn't running — reconstruct
          const config = PROVIDERS[provider];
          let launchCmd = config?.launchCommand ?? provider;

          // For Claude, use --continue to resume the last conversation
          if (provider === 'claude') {
            launchCmd = 'claude --continue';
          }

          const projDir = tmux.projectDir(unixUsername, project.name);
          const ctrlSession = tmux.sessionName(unixUsername, project.name, 'ctrl');

          await sendToAgent(userId, 'tmux-create', { sessionName: mainSession, cwd: projDir });
          await sendToAgent(userId, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });

          // Stagger launches so tmux doesn't get overwhelmed
          await new Promise(resolve => setTimeout(resolve, 500));

          if (config?.needsBridge) {
            await sendToAgent(userId, 'codex-session-start', { sessionName: mainSession, cwd: projDir });
          } else {
            await sendToAgent(userId, 'tmux-send-keys', { sessionName: mainSession, keys: launchCmd, withEnter: true });
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

          await sendToAgent(userId, 'tmux-create', { sessionName: mainSession, cwd: projDir });
          await sendToAgent(userId, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
        }
      } catch (err) {
        console.error(`[RECONSTRUCT] Failed for ${project.name}/${wf.type}:`, (err as Error).message);
        // Continue with other projects — don't let one failure block everything
      }
    }
  }

  console.log(`[RECONSTRUCT] ${unixUsername}: reconstructed ${launched} agent sessions across ${projects.length} projects`);
}

export async function stopAgentSessions({
  userId,
  unixUsername,
  projectName,
  provider,
}: AgentRuntimeContext): Promise<void> {
  const config = PROVIDERS[provider];
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent');
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl');

  if (config?.needsPoller) {
    unregisterPollerSession(mainSession);
  }

  if (isAgentConnected(userId)) {
    if (config?.needsBridge) {
      await sendToAgent(userId, 'codex-session-stop', { sessionName: mainSession }).catch(() => {});
    }
    await sendToAgent(userId, 'tmux-kill', { sessionName: mainSession }).catch(() => {});
    await sendToAgent(userId, 'tmux-kill', { sessionName: ctrlSession }).catch(() => {});
    return;
  }

  await tmux.killSession(mainSession);
  await tmux.killSession(ctrlSession);
}
