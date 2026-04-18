import { Router, RequestHandler } from 'express';
import { setStatus, getStatus, notifyStatusChange } from '../services/status';
import { AgentStatus } from '../types/index';
import { getNotificationTarget } from '../slack/lts';
import { getSlackApp } from '../slack/app';
import { capturePaneForSlack, formatPaneForSlack } from '../services/tmux';

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
    const { session, status, message, notify } = req.body as {
      session?: string;
      status?: AgentStatus['status'];
      message?: string;
      notify?: boolean;
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

    console.log(`[STATUS] POST session=${session} status=${status} notify=${notify} message=${message?.slice(0, 50)}`);

    const updated = setStatus(session, status, message);
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

    // Slack notifications
    if (notify) {
      const target = await getNotificationTarget(session);
      const slackApp = getSlackApp();
      console.log(`[STATUS] Notify check: target=${target ? target.channel : 'none'} slackApp=${!!slackApp}`);

      if (target && slackApp) {
        const timeSinceNotify = existing.lastNotifiedAt ? now - existing.lastNotifiedAt : Infinity;

        if (status === 'waiting' && timeSinceNotify > NOTIFY_COOLDOWN) {
          existing.lastNotifiedAt = now;
          try {
            // Capture pane and send as a rich message with reaction hints
            const pane = await capturePaneForSlack(session);
            const { trackPaneMessage, addReactionHints } = await import('../slack/events');
            const msg = await slackApp.client.chat.postMessage({
              channel: target.channel,
              ...formatPaneForSlack(pane, message || null, session, 'idle'),
            });
            trackPaneMessage(target.channel, msg.ts, session, target.userId);
            await addReactionHints(slackApp.client, target.channel, msg.ts, pane);
          } catch (err) {
            console.error('[STATUS] Slack notification failed:', (err as Error).message);
          }
        } else if (status === 'idle' && workingDuration > MIN_WORKING_DURATION) {
          existing.lastNotifiedAt = now;
          try {
            await slackApp.client.chat.postMessage({
              channel: target.channel,
              text: `Done — \`${session}\``,
            });
          } catch (err) {
            console.error('[STATUS] Slack notification failed:', (err as Error).message);
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

  router.post('/', postStatus);
  router.get('/:session', getStatusHandler);

  return router;
}
