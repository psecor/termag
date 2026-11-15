/**
 * Session pins, the chat sidebar's Pinned section,
 * behind user-projects-enabled (the sidebar redesign rides it):
 *
 *   GET    /api/session-pins                 { pins: SessionPinView[] }, oldest first
 *   PUT    /api/session-pins/:workstreamId   pin it: 200 { pin }; 404 session_not_found,
 *                                            409 session_archived
 *   DELETE /api/session-pins/:workstreamId   unpin it: 200 { pinned: false }
 *
 * PUT and DELETE are idempotent, so a retry or a second tab's click is
 * harmless. Each is the signed-in person's own pins only, on sessions they can
 * see (their own or shared with them). A change that did something pushes
 * `{type: 'workspace', what: 'pins'}` to their other tabs, which read the list
 * again. Off, every route answers 404 `session_pins_disabled`.
 */
import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { isWorkstreamId, listSessionPins, pinSession, unpinSession } from '../services/sessionPins';
import { userProjectsEnabled } from '../services/userProjects';
import { notifyWorkspaceChange } from '../services/workspaceEvents';

export const SESSION_PINS_DISABLED = 'session_pins_disabled';

const gate: RequestHandler = asyncHandler(async (req, res, next) => {
  if (!await userProjectsEnabled(req.user!)) { res.status(404).json({ error: 'Pins are not on for you', code: SESSION_PINS_DISABLED }); return; }
  next();
});

const validId: RequestHandler = (req, res, next) => {
  if (!isWorkstreamId(req.params.workstreamId)) { res.status(400).json({ error: 'Not a session id', code: 'session_pin_invalid' }); return; }
  next();
};

export function sessionPinsRouter(): Router {
  const router = Router();

  router.get('/', requireAuth, gate, asyncHandler(async (req, res) => {
    res.json({ pins: await listSessionPins(req.user!.id) });
  }));

  router.put('/:workstreamId', requireAuth, gate, validId, asyncHandler(async (req, res) => {
    const out = await pinSession(req.user!.id, String(req.params.workstreamId));
    if (!out.ok) { res.status(out.status).json({ error: out.error, code: out.code }); return; }
    if (out.created) notifyWorkspaceChange(req.user!.id, 'pins');
    res.json({ pin: out.pin });
  }));

  router.delete('/:workstreamId', requireAuth, gate, validId, asyncHandler(async (req, res) => {
    if (await unpinSession(req.user!.id, String(req.params.workstreamId))) notifyWorkspaceChange(req.user!.id, 'pins');
    res.json({ pinned: false });
  }));

  return router;
}
