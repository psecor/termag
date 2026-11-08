/**
 * Deployed software under /api/admin/software.
 * Mounted inside adminRouter (requireAdmin and the rate limit already ran;
 * requireAdmin audits every request).
 *
 * Tool updates (Claude Code is the
 * only tool so far): the preview, one host's run, the fleet's and the runs
 * list. They restart people's sessions, so each takes a signed-in admin
 * session, never an admin token, and answers 404 claude_update_off while the
 * tool's update is off (its policy's mode off, or missing or malformed;
 * services/toolUpdate/gate.ts). `component` is looked up in
 * services/toolUpdate/components.ts: an unknown one is 400 unknown_component.
 */
import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { softwareMatrix, softwareHost, clientVersions } from '../../services/software/queries';
import { refreshInventories } from '../../services/software/collector';
import { isRestart } from '../../services/claudeUpdatePolicy';
import { UNKNOWN_COMPONENT, toolDescriptor } from '../../services/toolUpdate/components';
import { isScope } from '../../services/toolUpdate/fleet';
import { listUpdateRuns, requestFleetUpdate, requestHostUpdate, updatePreview, type AdminAnswer } from '../../services/toolUpdate/runs';

const send = (res: Response, a: AdminAnswer<unknown>) => { res.status(a.status).json(a.body); };
const badComponent = (res: Response) => { res.status(400).json(UNKNOWN_COMPONENT); };

export function softwareRouter(): Router {
  const router = Router();
  router.get('/software', asyncHandler(async (_req, res) => { res.json(await softwareMatrix()); }));
  router.get('/software/clients', asyncHandler(async (_req, res) => { res.json(await clientVersions()); }));
  router.get('/software/hosts/:hostKey', asyncHandler(async (req, res) => {
    const out = await softwareHost(req.params.hostKey);
    if (!out) { res.status(404).json({ error: 'No such host' }); return; }
    res.json(out);
  }));
  // Ask every agent (and the orchestrator) for a fresh inventory now.
  router.post('/software/refresh', requireAdminSession, asyncHandler(async (_req, res) => {
    refreshInventories();
    res.json({ started: true });
  }));

  router.get('/software/hosts/:hostKey/update-preview', requireAdminSession, asyncHandler(async (req, res) => {
    const tool = toolDescriptor(req.query.component ?? 'claude');
    if (!tool) { badComponent(res); return; }
    send(res, await updatePreview(tool, req.params.hostKey, req.user!));
  }));
  router.post('/software/hosts/:hostKey/update', requireAdminSession, asyncHandler(async (req, res) => {
    const { component = 'claude', restart } = (req.body ?? {}) as Record<string, unknown>;
    const tool = toolDescriptor(component);
    if (!tool) { badComponent(res); return; }
    if (!isRestart(restart)) { res.status(400).json({ code: 'bad_request', error: 'restart must be none, idle or force' }); return; }
    send(res, await requestHostUpdate(tool, req.params.hostKey, restart, req.user!));
  }));
  router.post('/software/update', requireAdminSession, asyncHandler(async (req, res) => {
    const { component = 'claude', scope, restart } = (req.body ?? {}) as Record<string, unknown>;
    const tool = toolDescriptor(component);
    if (!tool) { badComponent(res); return; }
    if (!isScope(scope)) { res.status(400).json({ code: 'bad_request', error: 'scope must be below-floor, behind or all' }); return; }
    if (!isRestart(restart)) { res.status(400).json({ code: 'bad_request', error: 'restart must be none, idle or force' }); return; }
    send(res, await requestFleetUpdate(tool, scope, restart, req.user!));
  }));
  router.get('/software/updates', requireAdminSession, asyncHandler(async (req, res) => {
    const tool = toolDescriptor(req.query.component ?? 'claude');
    if (!tool) { badComponent(res); return; }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    send(res, await listUpdateRuns(tool, req.user!, limit));
  }));
  return router;
}
