/**
 * Local Terminal Session (LTS) API
 *
 * Relays local tmux pane content from a Mac daemon into Slack.
 * Also handles Claude Code status hooks for all session types.
 */

import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { formatPaneForSlack } from '../services/tmux';
import { setStatus, notifyStatusChange } from '../services/status';
import type { WebClient } from '@slack/web-api';

const prismaClient = new PrismaClient();

// In-memory state
const registry = new Map<string, {
  channel: string;
  messageTs: string;
  userId: string;
  lastContent: string | null;
  claudeStatus: string | null;
  lastStatusAt: number | null;
  stableCount: number;
  status: string;
  currentCommand: string | null;
}>();

const pendingSessions: Array<{ name: string }> = [];
const pendingCommands: Array<{ name: string; command: string }> = [];
const activeLocalSessions = new Map<string, string>(); // userId → session name
const notificationTargets = new Map<string, { channel: string; userId: string }>();
const sessionStatusMap = new Map<string, { claudeStatus: string; lastStatusAt: number; workingStartedAt: number | null; lastNotifiedAt: number | null }>();
const idleTimers = new Map<string, NodeJS.Timeout>();

const CAPTURE_API_SECRET = process.env.CAPTURE_API_SECRET;

// ── Exports used by events.ts ──────────────────────

export function registerLocalSession(name: string, opts: { channel: string; messageTs: string; userId: string }): void {
  registry.set(name, { ...opts, lastContent: null, claudeStatus: null, lastStatusAt: null, stableCount: 0, status: 'running', currentCommand: null });
  pendingSessions.push({ name });
}

export function queueLocalCommand(name: string, command: string, opts?: { messageTs?: string; channel?: string }): void {
  pendingCommands.push({ name, command });
  const session = registry.get(name);
  if (session) {
    session.stableCount = 0;
    session.status = 'running';
    session.currentCommand = command;
    if (opts?.messageTs) session.messageTs = opts.messageTs;
    if (opts?.channel) session.channel = opts.channel;
  }
}

export function isLocalSession(name: string): boolean { return registry.has(name); }

export function updateLocalSessionMessage(name: string, messageTs: string, channel: string): void {
  const session = registry.get(name);
  if (session) { session.messageTs = messageTs; session.channel = channel; session.lastContent = null; session.stableCount = 0; session.status = 'running'; }
}

export function removeLocalSession(name: string): void { registry.delete(name); }

export function setActiveLocalSession(userId: string, name: string): void { activeLocalSessions.set(userId, name); }
export function getActiveLocalSession(userId: string): string | null {
  const name = activeLocalSessions.get(userId);
  return name && registry.has(name) ? name : null;
}
export function clearActiveLocalSession(userId: string): void { activeLocalSessions.delete(userId); }

export interface NotificationTargetInfo {
  platform: 'slack' | 'discord';
  channel: string;
  userId: string;
}

// Cache key: "tmuxSession:platform"
function cacheKey(tmuxName: string, platform: string): string {
  return `${tmuxName}:${platform}`;
}

export function setNotificationTarget(tmuxName: string, target: { channel: string; userId: string }, platform: 'slack' | 'discord' = 'slack'): void {
  notificationTargets.set(cacheKey(tmuxName, platform), target);
  // Persist to DB (fire-and-forget)
  prismaClient.notificationTarget.upsert({
    where: { tmuxSession_platform: { tmuxSession: tmuxName, platform } },
    update: { channel: target.channel, userId: target.userId },
    create: { tmuxSession: tmuxName, platform, channel: target.channel, userId: target.userId },
  }).catch(err => console.error('[LTS] Failed to persist notification target:', err.message));
}

export async function getNotificationTarget(tmuxName: string, platform: 'slack' | 'discord' = 'slack'): Promise<{ channel: string; userId: string } | undefined> {
  const key = cacheKey(tmuxName, platform);
  const cached = notificationTargets.get(key);
  if (cached) return cached;
  try {
    const row = await prismaClient.notificationTarget.findUnique({
      where: { tmuxSession_platform: { tmuxSession: tmuxName, platform } },
    });
    if (row) {
      const target = { channel: row.channel, userId: row.userId };
      notificationTargets.set(key, target);
      return target;
    }
  } catch (err) {
    console.error('[LTS] Failed to read notification target:', (err as Error).message);
  }
  return undefined;
}

export async function getAllNotificationTargets(tmuxName: string): Promise<NotificationTargetInfo[]> {
  try {
    const rows = await prismaClient.notificationTarget.findMany({
      where: { tmuxSession: tmuxName },
    });
    return rows.map(r => ({
      platform: r.platform as 'slack' | 'discord',
      channel: r.channel,
      userId: r.userId,
    }));
  } catch (err) {
    console.error('[LTS] Failed to read notification targets:', (err as Error).message);
    return [];
  }
}

export function listLocalSessions(): Array<{ name: string; userId: string; hasContent: boolean; claudeStatus: string | null; lastStatusAt: number | null }> {
  return Array.from(registry.entries()).map(([name, info]) => ({
    name, userId: info.userId, hasContent: info.lastContent !== null, claudeStatus: info.claudeStatus, lastStatusAt: info.lastStatusAt,
  }));
}

export function getClaudeSessionStatus(tmuxName: string): { claudeStatus: string | null; lastStatusAt: number | null } {
  return sessionStatusMap.get(tmuxName) ?? { claudeStatus: null, lastStatusAt: null };
}

// ── Express routes ─────────────────────────────────

export function ltsRouter(
  slackClient: WebClient | null,
  publishHomeViewFn: ((userId: string) => Promise<void>) | null,
  refreshAllFn: (() => Promise<void>) | null,
): Router {
  const router = Router();

  const authMw: RequestHandler = (req, res, next) => {
    if (!CAPTURE_API_SECRET) { res.status(500).json({ error: 'CAPTURE_API_SECRET not configured' }); return; }
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== CAPTURE_API_SECRET) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  };

  router.use(authMw);

  // Daemon polls for new sessions
  router.get('/pending', ((_req, res) => {
    res.json({ sessions: pendingSessions.splice(0) });
  }) as RequestHandler);

  // Daemon sends pane updates
  const updateHandler: RequestHandler = async (req, res) => {
    const { name, content } = req.body;
    if (!name || content === undefined) { res.status(400).json({ error: 'name and content required' }); return; }

    const session = registry.get(name);
    if (!session) { res.status(404).json({ error: `Session ${name} not registered` }); return; }

    if (content === session.lastContent) {
      session.stableCount = (session.stableCount || 0) + 1;
      if (session.stableCount === 3 && session.status !== 'idle') {
        session.status = 'idle';
        const cmd = session.currentCommand;
        session.currentCommand = null;
        if (slackClient) {
          try {
            await slackClient.chat.update({
              channel: session.channel, ts: session.messageTs,
              ...formatPaneForSlack(content, cmd, `local:${name}`, 'done'),
            });
          } catch (err) { console.error(`[LTS] Finalize failed for ${name}:`, (err as Error).message); }
        }
      }
      res.json({ updated: false });
      return;
    }

    session.lastContent = content;
    session.stableCount = 0;
    session.status = 'running';

    if (slackClient) {
      try {
        await slackClient.chat.update({
          channel: session.channel, ts: session.messageTs,
          ...formatPaneForSlack(content, session.currentCommand, `local:${name}`, 'running'),
        });
        res.json({ updated: true });
      } catch (err) {
        res.status(500).json({ error: 'Failed to update Slack' });
      }
    } else {
      res.json({ updated: false });
    }
  };
  router.post('/update', updateHandler);

  // Claude Code hooks post status
  const statusHandler: RequestHandler = async (req, res) => {
    const { session: name, status, message, notify, notification_type } = req.body;
    const VALID = ['working', 'idle', 'waiting', 'not_running'];
    if (!name || !VALID.includes(status)) { res.status(400).json({ error: 'invalid' }); return; }

    const now = Date.now();
    const existing = sessionStatusMap.get(name) || { workingStartedAt: null, lastNotifiedAt: null };

    let workingStartedAt = existing.workingStartedAt;
    if (status === 'working' && sessionStatusMap.get(name)?.claudeStatus !== 'working') workingStartedAt = now;
    else if (status !== 'working') workingStartedAt = null;

    const workingDuration = (status !== 'working' && existing.workingStartedAt) ? now - existing.workingStartedAt : 0;

    sessionStatusMap.set(name, { claudeStatus: status, lastStatusAt: now, workingStartedAt, lastNotifiedAt: existing.lastNotifiedAt });

    // Also update termag's web status system
    setStatus(name, status as any, message);
    notifyStatusChange(name);

    // Auto-revert working→idle after 5 min
    if (idleTimers.has(name)) clearTimeout(idleTimers.get(name)!);
    if (status === 'working') {
      idleTimers.set(name, setTimeout(async () => {
        idleTimers.delete(name);
        const entry = sessionStatusMap.get(name);
        if (entry?.claudeStatus === 'working') {
          entry.claudeStatus = 'idle';
          entry.lastStatusAt = Date.now();
          setStatus(name, 'idle');
          notifyStatusChange(name);
          try { if (refreshAllFn) await refreshAllFn(); } catch { /* ok */ }
        }
      }, 5 * 60_000));
    }

    // Refresh home views
    const ltsSession = registry.get(name);
    if (ltsSession) {
      ltsSession.claudeStatus = status;
      ltsSession.lastStatusAt = now;
      if (publishHomeViewFn) try { await publishHomeViewFn(ltsSession.userId); } catch { /* ok */ }
    } else if (refreshAllFn) {
      try { await refreshAllFn(); } catch { /* ok */ }
    }

    // Slack notifications
    if (notify && slackClient) {
      const target = notificationTargets.get(name);
      if (target) {
        const entry = sessionStatusMap.get(name)!;
        const timeSinceNotify = entry.lastNotifiedAt ? now - entry.lastNotifiedAt : Infinity;

        if (status === 'waiting' && timeSinceNotify > 30_000) {
          entry.lastNotifiedAt = now;
          const text = message ? `⚠️ Claude needs input — \`${name}\`\n_${message}_` : `⚠️ Claude needs input — \`${name}\``;
          try { await slackClient.chat.postMessage({ channel: target.channel, text }); } catch { /* ok */ }
        } else if (status === 'idle' && workingDuration > 30_000) {
          entry.lastNotifiedAt = now;
          try { await slackClient.chat.postMessage({ channel: target.channel, text: `✅ Claude finished — \`${name}\`` }); } catch { /* ok */ }
        }
      }
    }

    res.json({ ok: true });
  };
  router.post('/status', statusHandler);

  // Daemon polls for commands
  router.get('/commands', ((_req, res) => {
    res.json({ commands: pendingCommands.splice(0) });
  }) as RequestHandler);

  return router;
}
