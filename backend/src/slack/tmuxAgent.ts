/**
 * Agent-routed tmux helpers for the Slack `/t` surface.
 *
 * The backend runs as the `termag` user, but a project's tmux sessions live on
 * the per-user agent (a different unix user, often a different box). tmux is
 * per-user, so the backend cannot drive those sessions in-process — it must go
 * through the agent. These wrappers mirror the signatures of the in-process
 * helpers in ../services/tmux but route every tmux op via sendForProject(...).
 *
 * The target agent ("host") is resolved from the session name (owner →
 * termag user → project's instanceId), cached briefly so poll loops don't
 * re-query the DB on every tick.
 */
import { sendForProject, ProjectHost } from '../services/agentRegistry';
import { cleanPaneText, formatPaneForSlack } from '../services/tmux';
import { resolveSessionProject } from '../services/sessionResolver';

/**
 * Resolve which agent owns a tmux session — thin wrapper over the shared
 * session resolver (rebuilds candidate names from the owner's projects to avoid
 * dash-parsing ambiguity, and caches). Falls back to the owner's legacy agent
 * (instanceId null) for sessions that don't map to a known project.
 */
async function hostForSession(session: string): Promise<ProjectHost | null> {
  const r = await resolveSessionProject(session);
  return r ? { userId: r.userId, instanceId: r.instanceId } : null;
}

/** Capture a pane's text via the owning agent. Mirrors tmux.capturePaneForSlack. */
export async function capturePaneForSlack(session: string, lines = 200): Promise<string> {
  const host = await hostForSession(session);
  if (!host) return '(unable to capture pane)';
  try {
    const r = await sendForProject(host, 'tmux-capture', { sessionName: session, lines });
    return cleanPaneText(typeof r?.content === 'string' ? r.content : '');
  } catch {
    return '(unable to capture pane)';
  }
}

/** Mirrors tmux.hasSession. */
export async function hasSession(session: string): Promise<boolean> {
  const host = await hostForSession(session);
  if (!host) return false;
  try {
    const r = await sendForProject(host, 'tmux-has-session', { sessionName: session });
    return !!r?.exists;
  } catch {
    return false;
  }
}

/** Mirrors tmux.sendKeys. */
export async function sendKeys(session: string, command: string, withEnter = true): Promise<void> {
  const host = await hostForSession(session);
  if (!host) return;
  try {
    await sendForProject(host, 'tmux-send-keys', { sessionName: session, keys: command, withEnter });
  } catch {
    /* ignore — best effort */
  }
}

/** List tmux sessions on a given agent (no session name to resolve from). */
export async function listSessionsViaAgent(host: ProjectHost): Promise<string[]> {
  try {
    const r = await sendForProject(host, 'tmux-list', {});
    return Array.isArray(r?.sessions) ? r.sessions : [];
  } catch {
    return [];
  }
}

/**
 * Poll a pane until output stabilizes, updating the Slack message as it goes.
 * Mirrors tmux.pollUntilStable but captures through the agent.
 */
export async function pollUntilStable(
  client: { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } },
  channelId: string,
  messageTs: string,
  session: string,
  command: string | null,
  maxSeconds = 30,
): Promise<void> {
  const POLL_MS = 1500;
  const MIN_UPDATE_MS = 1100;
  const STABLE_THRESHOLD = 3;
  const MAX_POLLS = Math.ceil((maxSeconds * 1000) / POLL_MS);

  let lastContent: string | null = null;
  let lastSentContent: string | null = null;
  let lastSentAt = 0;
  let stableCount = 0;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    const pane = await capturePaneForSlack(session);

    if (pane !== lastContent) {
      lastContent = pane;
      stableCount = 0;
      const now = Date.now();
      if (pane !== lastSentContent && now - lastSentAt >= MIN_UPDATE_MS) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            ...formatPaneForSlack(pane, command, session, 'running'),
          });
          lastSentContent = pane;
          lastSentAt = Date.now();
        } catch (err) {
          console.error('[SLACK] poll update failed:', (err as Error).message);
        }
      }
    } else {
      stableCount++;
      if (stableCount >= STABLE_THRESHOLD) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            ...formatPaneForSlack(pane, command, session, 'done'),
          });
        } catch (err) {
          console.error('[SLACK] poll finalize failed:', (err as Error).message);
        }
        return;
      }
    }
  }

  try {
    const pane = await capturePaneForSlack(session);
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      ...formatPaneForSlack(pane, command, session, 'timeout'),
    });
  } catch (err) {
    console.error('[SLACK] poll timeout update failed:', (err as Error).message);
  }
}
