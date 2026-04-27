import * as tmux from './tmux';
import { isAgentConnected, sendToAgent } from './agentRegistry';
import { registerPollerSession, unregisterPollerSession } from './tmuxPoller';
import { PROVIDERS } from '../providers/registry';

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
