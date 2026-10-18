/**
 * GET /api/box-update/policy — a box asks whether it may update itself.
 * POST /api/box-update/report — a box says how its update run went.
 *
 * Caller: deploy/termag-box-update --when-enabled, what the box's update
 * service runs, through the gateway with the box's agent token, the same auth as a
 * remote status write (requireAuthOrAgentToken). The answer is the
 * box-auto-update-enabled flag for the box's owner, evaluated on the owner +
 * box multi-context the push uses (services/boxUpdatePolicy.ts).
 *
 *   200  { enabled: true } or { enabled: false, reason: 'flag-off' }
 *   401  no valid agent token (a warm-pool token has no owner to evaluate for)
 *   403  a browser session, or a token without an instance
 *
 * The script treats anything but a 200 with enabled === true as a no, so an
 * orchestrator without this route (older than the box's checkout) means no too.
 * One line per ask in the journal: the gate's audit trail.
 *
 * The report (deploy/termag-box-update, report_outcome; services/boxUpdateReport.ts)
 * is {event: "box-update", outcome, pull, reconcile, deps, agent, from?, to?, at}
 * at the end of every update run, with the same token; 204 when written on
 * the box row, 400 for a malformed body, 403 without an instance-bound
 * token, 404 for an unknown box. One journal line per report: the result
 * side of the audit trail the policy ask begins.
 */
import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { asyncHandler } from '../middleware/errors';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { boxUpdatePolicy } from '../services/boxUpdatePolicy';
import { parseBoxUpdateReport, recordBoxUpdateReport, reportDetail } from '../services/boxUpdateReport';

export function boxUpdatePolicyRouter(): Router {
  const router = Router();

  const getPolicy: RequestHandler = async (req, res) => {
    const instanceId = req.agentInstanceId;
    const owner = req.user;
    if (!instanceId || !owner) {
      res.status(403).json({ error: 'box agents only: this route takes an instance-bound agent token' });
      return;
    }
    const box = await prisma.instance.findUnique({ where: { id: instanceId }, select: { id: true, name: true, kind: true } });
    const policy = await boxUpdatePolicy(owner, box);
    console.log(`[BOX-UPDATE] policy for ${owner.unixUsername}'s box ${instanceId}: ${policy.enabled ? 'enabled' : `off (${policy.reason})`}`);
    res.json(policy);
  };

  const postReport: RequestHandler = async (req, res) => {
    const instanceId = req.agentInstanceId;
    if (!instanceId) {
      res.status(403).json({ error: 'box agents only: this route takes an instance-bound agent token' });
      return;
    }
    const parsed = parseBoxUpdateReport(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const recorded = await recordBoxUpdateReport(instanceId, parsed);
    if (!recorded) {
      res.status(404).json({ error: 'unknown box' });
      return;
    }
    const range = parsed.from && parsed.to && parsed.from !== parsed.to ? ` ${parsed.from.slice(0, 12)}..${parsed.to.slice(0, 12)}` : parsed.to ? ` at ${parsed.to.slice(0, 12)}` : '';
    console.log(`[BOX-UPDATE] ${recorded.boxName} (${recorded.owner ?? 'unowned'}) reports ${parsed.outcome}:${range} ${reportDetail(parsed)}`);
    res.status(204).end();
  };

  router.get('/policy', requireAuthOrAgentToken, asyncHandler(getPolicy));
  router.post('/report', requireAuthOrAgentToken, asyncHandler(postReport));
  return router;
}
