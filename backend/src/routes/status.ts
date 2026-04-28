import { Router, RequestHandler } from 'express';
import { setStatus, getStatus, notifyStatusChange } from '../services/status';
import { AgentStatus } from '../types/index';
import { getAllNotificationTargets } from '../slack/lts';
import { getSlackApp } from '../slack/app';
import { getDiscordClient } from '../discord/app';
import { capturePaneForSlack, formatPaneForSlack } from '../services/tmux';
import { formatPaneForDiscord } from '../discord/formatting';
import { recordHeartbeat } from '../services/humanActivity';
import { requireAuth } from '../middleware/auth';

// Track working start time and last notification per session
const statusTracking = new Map<string, {
  workingStartedAt: number | null;
  lastNotifiedAt: number | null;
}>();

const NOTIFY_COOLDOWN = 30_000; // 30s between notifications
const MIN_WORKING_DURATION = 30_000; // only notify "finished" if worked > 30s

export function statusRouter(): Router {
  const router = Router();

  const postStatus: RequestHandler = async (req, res) => {
    const { session, status, message, notify, source, waitingReason, activityScore, tokenBurst, activeTurn, threadId } = req.body as {
      session?: string;
      status?: AgentStatus['status'];
      message?: string;
      notify?: boolean;
      source?: AgentStatus['source'];
      waitingReason?: AgentStatus['waitingReason'];
      activityScore?: number;
      tokenBurst?: number;
      activeTurn?: boolean;
      threadId?: string;
    };

    if (!session || !status) {
      res.status(400).json({ error: 'session and status required' });
      return;
    }

    const validStatuses: AgentStatus['status'][] = ['working', 'waiting', 'idle', 'not_running'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'invalid status' });
      return;
    }

    console.log(`[STATUS] POST session=${session} status=${status} notify=${notify} source=${source ?? 'unknown'} waitingReason=${waitingReason ?? 'null'} message=${message?.slice(0, 50)}`);

    const updated = setStatus(session, status, {
      message,
      source,
      waitingReason,
      activityScore,
      tokenBurst,
      activeTurn,
      threadId,
    });
    notifyStatusChange(session);

    // Track working duration
    const now = Date.now();
    const existing = statusTracking.get(session) || { workingStartedAt: null, lastNotifiedAt: null };

    if (status === 'working' && !existing.workingStartedAt) {
      existing.workingStartedAt = now;
    }

    const workingDuration = (status !== 'working' && existing.workingStartedAt)
      ? now - existing.workingStartedAt
      : 0;

    if (status !== 'working') {
      existing.workingStartedAt = null;
    }

    // Notifications to all registered platforms
    if (notify) {
      const targets = await getAllNotificationTargets(session);
      const timeSinceNotify = existing.lastNotifiedAt ? now - existing.lastNotifiedAt : Infinity;

      if (targets.length > 0 && timeSinceNotify > NOTIFY_COOLDOWN) {
        const pane = await capturePaneForSlack(session);

        for (const target of targets) {
          try {
            if (target.platform === 'slack') {
              const slackApp = getSlackApp();
              if (!slackApp) continue;

              if (status === 'waiting') {
                existing.lastNotifiedAt = now;
                const { trackPaneMessage, addReactionHints } = await import('../slack/events');
                const msg = await slackApp.client.chat.postMessage({
                  channel: target.channel,
                  ...formatPaneForSlack(pane, message || null, session, 'idle'),
                });
                trackPaneMessage(target.channel, msg.ts, session, target.userId);
                await addReactionHints(slackApp.client, target.channel, msg.ts, pane);
              } else if (status === 'idle' && workingDuration > MIN_WORKING_DURATION) {
                existing.lastNotifiedAt = now;
                await slackApp.client.chat.postMessage({
                  channel: target.channel,
                  text: `Done — \`${session}\``,
                });
              }
            } else if (target.platform === 'discord') {
              const discord = getDiscordClient();
              if (!discord) continue;

              const channel = await discord.channels.fetch(target.channel);
              if (!channel?.isTextBased() || !('send' in channel)) continue;

              if (status === 'waiting') {
                existing.lastNotifiedAt = now;
                const { trackDiscordPaneMessage, addDiscordReactionHints } = await import('../discord/events');
                const msg = await (channel as any).send(formatPaneForDiscord(pane, message || null, session));
                trackDiscordPaneMessage(target.channel, msg.id, session, target.userId);
                await addDiscordReactionHints(msg, pane);
              } else if (status === 'idle' && workingDuration > MIN_WORKING_DURATION) {
                existing.lastNotifiedAt = now;
                await (channel as any).send(`Done — \`${session}\``);
              }
            }
          } catch (err) {
            console.error(`[STATUS] ${target.platform} notification failed:`, (err as Error).message);
          }
        }
      }
    }

    statusTracking.set(session, existing);

    res.json({ ok: true, status: updated });
  };

  const getStatusHandler: RequestHandler = (req, res) => {
    const status = getStatus(req.params.session);
    res.json(status);
  };

  const heartbeat: RequestHandler = (req, res) => {
    const { project } = req.body as { project?: string };
    if (!project || typeof project !== 'string') {
      res.status(400).json({ error: 'project required' });
      return;
    }
    recordHeartbeat(req.user!.unixUsername, project);
    res.json({ ok: true });
  };

  router.post('/', postStatus);
  router.post('/heartbeat', requireAuth, heartbeat);
  router.get('/:session', getStatusHandler);

  return router;
}
