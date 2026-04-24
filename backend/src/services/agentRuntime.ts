import { AgentProvider } from '@prisma/client';
import * as tmux from './tmux';
import { isAgentConnected, sendToAgent } from './agentRegistry';

export function resolveAgentProvider(
  workflowProvider?: AgentProvider | null,
  userDefaultProvider?: AgentProvider | null,
): AgentProvider {
  return workflowProvider ?? userDefaultProvider ?? 'claude';
}

interface AgentRuntimeContext {
  userId: string;
  unixUsername: string;
  projectName: string;
  provider: AgentProvider;
}

export async function ensureAgentSessionsAndLaunch({
  userId,
  unixUsername,
  projectName,
  provider,
}: AgentRuntimeContext): Promise<void> {
  const projDir = tmux.projectDir(unixUsername, projectName);
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent');
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl');

  if (isAgentConnected(userId)) {
    await sendToAgent(userId, 'tmux-create', { sessionName: mainSession, cwd: projDir });
    await sendToAgent(userId, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
    await new Promise(resolve => setTimeout(resolve, 500));

    if (provider === 'codex') {
      await sendToAgent(userId, 'codex-session-start', { sessionName: mainSession, cwd: projDir });
    } else {
      await sendToAgent(userId, 'tmux-send-keys', { sessionName: mainSession, keys: 'claude', withEnter: true });
    }
    return;
  }

  await tmux.ensureProjectDir(unixUsername, projectName);
  const mainCreated = await tmux.ensureSession(mainSession, projDir);
  await tmux.ensureSession(ctrlSession, projDir);

  if (!mainCreated) return;

  await new Promise(resolve => setTimeout(resolve, 500));
  if (provider === 'codex') {
    await tmux.sendKeys(mainSession, 'codex --no-alt-screen -a on-request');
  } else {
    await tmux.sendKeys(mainSession, 'claude');
  }
}

export async function stopAgentSessions({
  userId,
  unixUsername,
  projectName,
  provider,
}: AgentRuntimeContext): Promise<void> {
  const mainSession = tmux.sessionName(unixUsername, projectName, 'agent');
  const ctrlSession = tmux.sessionName(unixUsername, projectName, 'ctrl');

  if (isAgentConnected(userId)) {
    if (provider === 'codex') {
      await sendToAgent(userId, 'codex-session-stop', { sessionName: mainSession }).catch(() => {});
    }
    await sendToAgent(userId, 'tmux-kill', { sessionName: mainSession }).catch(() => {});
    await sendToAgent(userId, 'tmux-kill', { sessionName: ctrlSession }).catch(() => {});
    return;
  }

  await tmux.killSession(mainSession);
  await tmux.killSession(ctrlSession);
}
