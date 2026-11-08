/**
 * GET /api/tool-update/policy?component=<c>[&run=<id>|&atStart=1] — a box asks what its
 * update of one tool may do. `atStart=1` (Docker's boot unit, before docker.service):
 * the run queued for the box's start, if any, which the fetch starts.
 * POST /api/tool-update/report — a box says how a run went, `component` in the body.
 *
 * Caller: the tool's recipe on the box (Claude Code: deploy/termag-claude-update,
 * `--run`, `--boot` and the runner guard), with the box's agent token, the
 * same auth as GET /api/box-update/policy (routes/boxUpdatePolicy.ts). The
 * component is looked up in services/toolUpdate/components.ts; the rules are
 * services/toolUpdate/run.ts, the reads and writes services/toolUpdate/runs.ts.
 *
 *
 *   policy  200 { floor, target, restart, drainSec, run: null | { id, component } }
 *               restart comes from the run only for this box's requested run of the
 *               component with the tool's flag on, which starts it, or for a retry
 *               of a fetch that started it under 5 minutes ago; else "none".
 *           404 { code: "no_such_run" }  an unknown run, another box's or another tool's
 *   report  204, then the host's inventory is refreshed and the reported agent
 *               panes relaunched (only those, only at a shell); 204 and nothing
 *               else for a run that has already ended (a retried report)
 *           400 a malformed body, 404 { code: "no_such_run" | "no_such_box" }
 *   both    400 { code: "unknown_component" }, 401 no valid agent token,
 *           403 a token without an instance
 *
 * One journal line per ask and per report; a failed or partial report's line
 * carries its detail, on one line and capped (logDetail).
 */
import { Router, RequestHandler } from 'express';
import { asyncHandler } from '../middleware/errors';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { UNKNOWN_COMPONENT, toolDescriptor } from '../services/toolUpdate/components';
import { parseToolUpdateReport } from '../services/toolUpdate/run';
import { afterReport, boxPolicy, recordToolUpdateReport } from '../services/toolUpdate/runs';

/** How much of a report's detail the journal line carries: the recipe's notes come in its first few hundred characters. */
export const LOG_DETAIL_MAX = 400;

/**
 * A report's detail for the journal line: one line (control characters,
 * newlines among them, and Unicode line breaks become spaces, runs of space
 * one), at most LOG_DETAIL_MAX characters. The box writes it, so it must not
 * forge a line of its own.
 */
export function logDetail(detail: string | null | undefined): string {
  const flat = (detail ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return flat.length > LOG_DETAIL_MAX ? `${flat.slice(0, LOG_DETAIL_MAX - 1)}…` : flat;
}

export function toolUpdateRouter(): Router {
  const router = Router();

  const getPolicy: RequestHandler = async (req, res) => {
    const instanceId = req.agentInstanceId;
    const owner = req.user;
    if (!instanceId || !owner) {
      res.status(403).json({ error: 'box agents only: this route takes an instance-bound agent token' });
      return;
    }
    const tool = toolDescriptor(req.query.component);
    if (!tool) {
      res.status(400).json(UNKNOWN_COMPONENT);
      return;
    }
    const asked = typeof req.query.run === 'string' && req.query.run !== '' ? req.query.run : null;
    // A tool updated at the box's start (Docker): its boot unit asks for the run queued for this start.
    const atStart = req.query.atStart === '1';
    const answer = await boxPolicy(tool, instanceId, owner, asked, Date.now(), atStart);
    if (answer.status === 404) {
      console.log(`[TOOL-UPDATE] ${tool.component} policy for ${owner.unixUsername}'s box ${instanceId}: no such run ${asked}`);
      res.status(404).json(answer.body);
      return;
    }
    const b = answer.body;
    console.log(`[TOOL-UPDATE] ${tool.component} policy for ${owner.unixUsername}'s box ${instanceId}: floor ${b.floor}, target ${b.target}, restart ${b.restart}${b.run ? `, run ${b.run.id} started` : asked ? `, run ${asked} not started` : atStart ? ', no run queued for this start' : ''}`);
    res.json(b);
  };

  const postReport: RequestHandler = async (req, res) => {
    const instanceId = req.agentInstanceId;
    if (!instanceId) {
      res.status(403).json({ error: 'box agents only: this route takes an instance-bound agent token' });
      return;
    }
    const parsed = parseToolUpdateReport(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed.code ? { ...UNKNOWN_COMPONENT } : { error: parsed.error });
      return;
    }
    const recorded = await recordToolUpdateReport(instanceId, parsed);
    if (recorded.status === 404) {
      res.status(404).json(recorded.body);
      return;
    }
    if (recorded.repeat) {
      console.log(`[TOOL-UPDATE] ${recorded.box.name}: a repeated report for ${parsed.component} run ${recorded.runId}, which has ended; nothing written`);
      res.status(204).end();
      return;
    }
    const versions = parsed.fromVersion || parsed.toVersion ? ` ${parsed.fromVersion ?? '?'} -> ${parsed.toVersion ?? '?'}` : '';
    const agents = parsed.panes.filter(p => p.role === 'agent').length;
    // A run that did not do all it was asked says why, as the admin Software tab does.
    const why = parsed.outcome === 'failed' || parsed.outcome === 'partial' ? logDetail(parsed.detail) : '';
    console.log(`[TOOL-UPDATE] ${recorded.box.name} (${recorded.box.user?.unixUsername ?? 'unowned'}) reports ${parsed.component} ${parsed.trigger} run ${recorded.runId}: ${parsed.outcome}${versions}, ${agents} agent pane(s) to relaunch${why ? `; detail: ${why}` : ''}`);
    res.status(204).end();
    void afterReport(recorded.box, parsed, recorded.run);
  };

  router.get('/policy', requireAuthOrAgentToken, asyncHandler(getPolicy));
  router.post('/report', requireAuthOrAgentToken, asyncHandler(postReport));
  return router;
}
