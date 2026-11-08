/**
 * An admin ends one preview link
 * (SR15): `POST /api/admin/preview-links/end` with `{ id }` or `{ name }`.
 * Mounted inside adminRouter, so requireAdmin and the admin_audit_log row
 * already apply. Session-only (requireAdminSession), as quarantine is: an admin
 * bearer token is a read credential a model or script holds, and this acts on
 * someone else's link. The service is services/previewLinkAdmin.ts.
 */
import { Router } from 'express';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { adminEndPreviewLink, prismaPreviewLinkAdminDeps, type PreviewLinkAdminDeps } from '../../services/previewLinkAdmin';
import { sendResult } from '../routeResult';

export function previewLinksAdminRouter(deps: PreviewLinkAdminDeps = prismaPreviewLinkAdminDeps): Router {
  const router = Router();
  router.post('/preview-links/end', requireAdminSession, asyncHandler(async (req, res) => {
    sendResult(res, await adminEndPreviewLink(deps, req.user!, req.body));
  }));
  return router;
}
