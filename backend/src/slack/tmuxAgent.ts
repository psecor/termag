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
import { PrismaClient } from '@prisma/client';
import { sendForProject, ProjectHost } from '../services/agentRegistry';
import { sessionName as buildSessionName, cleanPaneText, formatPaneForSlack } from '../services/tmux';

const prisma = new PrismaClient();

const ROLES = ['agent', 'ctrl', 'data', 'data-ctrl'] as const;

// sessionName → resolved host. Short TTL keeps poll loops from hammering the DB
// while still picking up new projects within a minute.
const hostCache = new Map<string, { host: ProjectHost | null; at: number }>();
const HOST_TTL_MS = 60_000;

/**
 * Resolve which agent owns a tmux session. Session names are
 * `<owner>-<project>-<role>` / `<owner>-<project>-<workstream>-<role>`; rather
 * than parse (roles like `data-ctrl` contain dashes), we match against names
 * rebuilt from the owner's projects. Falls back to the owner's legacy agent for
 * sessions that don't map to a known project (e.g. `/t attach <arbitrary>`).
 */
async function hostForSession(session: string): Promise<ProjectHost | null> {
  const cached = hostCache.get(session);
  if (cached && Date.now() - cached.at < HOST_TTL_MS) return cached.host;

  let host: ProjectHost | null = null;
  const owner = session.split('-')[0];
  if (owner) {
    const user = await prisma.user.findUnique({ where: { unixUsername: owner } });
    if (user) {
      const projects = await prisma.project.findMany({
        where: { userId: user.id },
        include: { workstreams: true },
      });
      outer: for (const p of projects) {
        const wsNames = p.workstreams.length ? p.workstreams.map(w => w.name) : ['main'];
        for (const ws of wsNames) {
          for (const role of ROLES) {
            if (session === buildSessionName(owner, p.name, role, ws)) {
              host = { userId: user.id, instanceId: p.instanceId };
              break outer;
            }
          }
        }
      }
      if (!host) host = { userId: user.id, instanceId: null };
    }
  }
  hostCache.set(session, { host, at: Date.now() });
  return host;
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
