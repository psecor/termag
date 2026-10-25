/**
 * POST /api/claude-runner/event — a box reports on a Claude Code cloud
 * session the spawn route started there.
 *
 * Caller: deploy/termag-claude-runner and its runner hooks, through the
 * gateway with the box's agent token, the same auth as a remote status write
 * (requireAuthOrAgentToken). Only an instance-bound token is accepted and the
 * order's row must belong to that box, so a box can report on its own
 * sessions only. The body's `event` picks the shape
 * (services/claudeRunnerSessions.ts, parseRunnerEvent):
 *
 *   { event: 'started', orderId, sessionId, clientPlatform? }  the runner's
 *       command hook spawned Claude Code; the row learns the platform and the
 *       session shows as running
 *   { event: 'title', orderId, title }  the first prompt's first line, once;
 *       sets the row's title column and writes no event (prompt text never
 *       enters the 30-day log); a later title for a titled row is kept out
 *   { event: 'usage', orderId, input, output, cacheRead, cacheCreate, calls?, model?, at? }
 *       the session's cumulative token usage from its own transcript, posted
 *       on every Stop and once more by the post-session hook; the newest `at`
 *       wins; sets the row's usage columns, writes no event, logs no number
 *   { event: 'ended', orderId, exitStatus, exitReason?, endedAt? }  the exit
 *       trap: completes the row and logs the owner's `ended` line
 *
 *   204  recorded; or the same end reported again, or a report from an
 *        earlier launch of a relaunched order (both ignored)
 *   400  malformed body
 *   401  no valid agent token
 *   403  a browser session or a token without an instance; or the order ran
 *        on another box
 *   404  the order is unknown here: this backend never recorded its start
 *
 * Every recorded end logs `[CLAUDE-RUNNER] order <id> for <who> ended on
 * <box> slot N after <s>s, exit <code>`, the counterpart of the spawn route's
 * start line: duration per session, per owner, from the journal. `started`
 * and `ended` also append to the session's event log and push the change to
 * the owner's browsers; so does `title`, which pushes without an event.
 */
import { Router, RequestHandler } from 'express';
import { asyncHandler } from '../middleware/errors';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { parseRunnerEvent, recordRunnerEnd, recordRunnerStarted, recordRunnerTitle, recordRunnerUsage, type RunIdentity } from '../services/claudeRunnerSessions';
import { notifyCloudSessionChange, recordSessionEvent, type SessionEventKind } from '../services/claudeSessionEvents';
import { recordProductEvent } from '../services/productEvents';

export function claudeRunnerEventsRouter(): Router {
  const router = Router();

  const unknownOrOtherBox = (res: Parameters<RequestHandler>[1], orderId: string, instanceId: string, kind: 'unknown' | 'other-box') => {
    if (kind === 'unknown') {
      console.warn(`[CLAUDE-RUNNER] order ${orderId}: report from box ${instanceId}, but no start was recorded for it`);
      res.status(404).json({ error: 'unknown order: no start was recorded for it here' });
    } else {
      console.warn(`[CLAUDE-RUNNER] order ${orderId}: report from box ${instanceId}, which did not run it`);
      res.status(403).json({ error: 'this order ran on another box' });
    }
  };

  const appendEvent = (run: RunIdentity, orderId: string, kind: SessionEventKind, detail: string | null) => {
    if (!run.sessionId) return Promise.resolve();
    return recordSessionEvent({ owner: { id: run.userId, unixUsername: run.who }, sessionId: run.sessionId, orderId, instanceId: run.instanceId, kind, detail });
  };

  const postEvent: RequestHandler = async (req, res) => {
    const instanceId = req.agentInstanceId;
    if (!instanceId) {
      res.status(403).json({ error: 'box agents only: this route takes an instance-bound agent token' });
      return;
    }
    const parsed = parseRunnerEvent(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { orderId } = parsed;

    if (parsed.event === 'started') {
      const outcome = await recordRunnerStarted(instanceId, parsed);
      if (outcome.kind === 'stale') {
        console.warn(`[CLAUDE-RUNNER] order ${orderId}: started at ${parsed.at?.toISOString()} is from before the current launch at ${outcome.startedAt.toISOString()}; ignored`);
        res.status(204).end();
        return;
      }
      if (outcome.kind !== 'started') { unknownOrOtherBox(res, orderId, instanceId, outcome.kind); return; }
      console.log(`[CLAUDE-RUNNER] order ${orderId} for ${outcome.who} serving session ${outcome.sessionId} from ${outcome.clientPlatform ?? 'unknown'} on ${outcome.boxName} slot ${outcome.slot}`);
      recordProductEvent('cloud.session.started', { user: outcome.userId, box: outcome.instanceId }, {
        provider: 'claude', kind: 'cloud', clientPlatform: outcome.clientPlatform, slot: outcome.slot,
      });
      await appendEvent(outcome, orderId, 'started', outcome.clientPlatform);
      res.status(204).end();
      return;
    }

    if (parsed.event === 'title') {
      const outcome = await recordRunnerTitle(instanceId, parsed);
      if (outcome.kind !== 'set' && outcome.kind !== 'kept') { unknownOrOtherBox(res, orderId, instanceId, outcome.kind); return; }
      // Never the text: the journal is read project-wide.
      if (outcome.kind === 'set') {
        console.log(`[CLAUDE-RUNNER] order ${orderId} for ${outcome.who}: title set`);
        if (outcome.sessionId) notifyCloudSessionChange({ id: outcome.userId, unixUsername: outcome.who }, outcome.sessionId);
      }
      res.status(204).end();
      return;
    }

    if (parsed.event === 'usage') {
      const outcome = await recordRunnerUsage(instanceId, parsed);
      if (outcome.kind !== 'set' && outcome.kind !== 'stale') { unknownOrOtherBox(res, orderId, instanceId, outcome.kind); return; }
      // No numbers in the journal: the row is the record. The owner's rows refresh.
      if (outcome.kind === 'set' && outcome.sessionId) notifyCloudSessionChange({ id: outcome.userId, unixUsername: outcome.who }, outcome.sessionId);
      res.status(204).end();
      return;
    }

    const outcome = await recordRunnerEnd(instanceId, parsed);
    switch (outcome.kind) {
      case 'ended': {
        const reason = outcome.exitReason ? ` (${outcome.exitReason})` : '';
        console.log(`[CLAUDE-RUNNER] order ${orderId} for ${outcome.who} ended on ${outcome.boxName} slot ${outcome.slot} after ${outcome.durationSec}s, exit ${outcome.exitStatus}${reason}`);
        recordProductEvent('cloud.session.ended', { user: outcome.userId, box: outcome.instanceId }, {
          provider: 'claude', kind: 'cloud', durationSec: outcome.durationSec, exitStatus: outcome.exitStatus, exitReason: outcome.exitReason, slot: outcome.slot,
        });
        await appendEvent(outcome, orderId, 'ended', outcome.exitReason ?? `exit ${outcome.exitStatus}`);
        res.status(204).end();
        return;
      }
      case 'repeat':
        res.status(204).end();
        return;
      case 'stale':
        console.warn(`[CLAUDE-RUNNER] order ${orderId}: end at ${parsed.endedAt.toISOString()} is from before the current launch at ${outcome.startedAt.toISOString()}; ignored`);
        res.status(204).end();
        return;
      case 'unknown':
      case 'other-box':
        unknownOrOtherBox(res, orderId, instanceId, outcome.kind);
        return;
    }
  };

  router.post('/event', requireAuthOrAgentToken, asyncHandler(postEvent));
  return router;
}
