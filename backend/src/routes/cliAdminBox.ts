/**
 * The gate for every admin route on /api/cli/v1 that a box's own token can
 * reach (so far the bug-report reads and triage, routes/cliBugReports.ts).
 * A new admin CLI route mounts behind cliAdminBox and inherits all of it:
 *
 *   - a box credential with a box: a device sign-in, and a legacy per-user
 *     `tmag_` token (box-kind, no box, can sit on a laptop), get 403
 *     `box_credential_required`;
 *   - an owner who is an admin, re-read on every request (403 `admin_required`);
 *   - a box that hosts no project with a ProjectShare, to anyone, re-read on
 *     every request (403 `box_shared`). A share is a shell as the owner on the
 *     owner's box, so a sharee could use the
 *     box's token as the admin;
 *   - then an admin_audit_log row on finish with the box, as requireAdmin
 *     writes one for /api/admin.
 *
 * requireAdmin never accepts a box token; this is the only way one reaches
 * admin data.
 */
import type { RequestHandler, Response } from 'express';
import { asyncHandler } from '../middleware/errors';
import { auditOutcome, summarizeArgs, type AuditEntry } from '../middleware/admin';
import type { CliAuth } from './cliApi';

export interface CliAdminBox {
  /** Whether the user is a termag admin right now (services/admin/adminAccess.ts isAdminUser). */
  isAdmin: (userId: string) => Promise<boolean>;
  /** Whether any project on the box has a ProjectShare. */
  boxHasSharedProject: (boxId: string) => Promise<boolean>;
  /** Writes an admin_audit_log row (middleware/admin.ts recordAudit). */
  audit: (entry: AuditEntry) => void;
}

/** What the refusals name: the commands' subject, and where the web UI does the same. */
export interface AdminBoxSubject {
  /** e.g. "bug reports" */
  what: string;
  /** e.g. "/admin/bugs" */
  webPath: string;
}

function forbidden(res: Response, error: string, code: string): void {
  res.status(403).json({ error, code });
}

export function cliAdminBox(deps: CliAdminBox, subject: AdminBoxSubject): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const { user, credential } = res.locals.cliAuth as CliAuth;
    if (credential.kind !== 'box' || !credential.boxId) {
      forbidden(res, `Admin commands for ${subject.what} work with an admin's box credential only; on a laptop, open ${subject.webPath}`, 'box_credential_required');
      return;
    }
    if (!await deps.isAdmin(user.id)) {
      forbidden(res, `Only termag admins can use the admin commands for ${subject.what}`, 'admin_required');
      return;
    }
    if (await deps.boxHasSharedProject(credential.boxId)) {
      forbidden(res, `Admin commands don't run from a box with shared projects: everyone a project on it is shared with has a shell here as you. Use the web UI, ${subject.webPath}, on your own machine`, 'box_shared');
      return;
    }
    // The handlers name the admin who made a change from req.user.
    req.user = { id: user.id } as Express.User;
    const entry = {
      actorId: user.id, tokenId: credential.tokenId ?? null, boxId: credential.boxId,
      surface: 'rest' as const, action: `${req.method} /api/cli/v1${req.path}`, args: summarizeArgs(req),
    };
    res.once('finish', () => deps.audit({ ...entry, outcome: auditOutcome(res.statusCode), status: res.statusCode }));
    next();
  });
}
