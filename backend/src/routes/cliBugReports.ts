/**
 * Bug reports under /api/cli/v1, for `termag bug`:
 *
 *   POST  /bug-reports            file one; 201 with its id (any credential)
 *   GET   /bug-reports            list, as GET /api/admin/bug-reports   } an admin's
 *   GET   /bug-reports/counts     reports per status                   } box only:
 *   GET   /bug-reports/:id        one, with its history                } `bug list`,
 *   PATCH /bug-reports/:id        { status?, duplicateOf?, link?, note? } `show`, `triage`
 *
 * The four reads and the triage are the admin routes' own handlers
 * (routes/admin/bugs.ts), behind the shared admin-box gate
 * (routes/cliAdminBox.ts): a box's own token (`tmag_…`) whose owner is an
 * admin, from a box with no shared project, each call an audit row with the
 * box.
 *
 * A box's own credential reports as its box and owner, a device sign-in as
 * its person. At most REPORTS_PER_HOUR per box in any hour (per person for a
 * sign-in with no box), counted in the database so a restart does not reset it.
 * Every text field is redacted of secret-shaped strings before it is stored.
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import { rateLimit } from '../middleware/rateLimit';
import { bugHandlers } from './admin/bugs';
import { cliAdminBox, type CliAdminBox } from './cliAdminBox';
import {
  RATE_WINDOW_MS, REPORTS_PER_HOUR, parseBugReportInput, underRateLimit, type BugReportStore,
} from '../services/bugReports';
import type { CliAuth } from './cliApi';

export interface CliBugReports {
  store: BugReportStore;
  /** The reads' and the triage's gate (routes/cliAdminBox.ts). */
  adminBox: CliAdminBox;
}

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliBugReportRoutes(router: Router, deps: CliBugReports, bearer: RequestHandler, now: () => Date): void {
  router.post('/bug-reports', bearer, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    const parsed = parseBugReportInput(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error, code: 'invalid_request' }); return; }
    const input = parsed.ok;

    const base = { reporterUserId: user.id, credential: credential.kind, boxId: credential.kind === 'box' ? credential.boxId : null };
    const reporter = await deps.store.resolveReporter(base, { projectId: input.projectId, workstream: input.workstream });
    const at = now();
    const recent = await deps.store.countRecent({ boxId: reporter.boxId, userId: user.id }, new Date(at.getTime() - RATE_WINDOW_MS));
    if (!underRateLimit(recent)) {
      res.status(429).set('Retry-After', '600').json({
        error: `At most ${REPORTS_PER_HOUR} bug reports an hour from ${reporter.boxId ? 'one box' : 'one person'}; try again later`,
        code: 'rate_limited',
      });
      return;
    }

    const report = await deps.store.create(input, reporter);
    res.status(201).json({
      id: report.id,
      status: report.status,
      redacted: report.redacted,
    });
  }));

  // The same per-caller budget as /api/admin, keyed by the owner.
  const admin = [bearer, cliAdminBox(deps.adminBox, { what: 'bug reports', webPath: '/admin/bugs' }), rateLimit({ capacity: 60, perMinute: 120 })];
  const h = bugHandlers(deps.store, now);
  router.get('/bug-reports', ...admin, h.list);
  // Before /:id, which would take "counts" for an id.
  router.get('/bug-reports/counts', ...admin, h.counts);
  router.get('/bug-reports/:id', ...admin, h.detail);
  router.patch('/bug-reports/:id', ...admin, h.triage);

  router.all('/bug-reports', bearer, (_req, res) => {
    res.status(405).set('Allow', 'GET, POST').json({
      error: 'Bug reports take POST to file one, and GET from an admin\'s box to read them',
      code: 'method_not_allowed',
    });
  });
}
