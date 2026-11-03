/**
 * Bug reports under /api/cli/v1, for `termag bug report`:
 *
 *   POST /bug-reports    file one; 201 with its id
 *
 * Write-only: any other method is 405. Reading and triage are admin-only,
 * under /api/admin/bug-reports, and duplicates are the admins' to mark.
 *
 * A box's own credential reports as its box and owner, a device sign-in as
 * its person. At most REPORTS_PER_HOUR per box in any hour (per person for a
 * sign-in with no box), counted in the database so a restart does not reset it.
 * Every text field is redacted of secret-shaped strings before it is stored.
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import {
  RATE_WINDOW_MS, REPORTS_PER_HOUR, parseBugReportInput, underRateLimit, type BugReportStore,
} from '../services/bugReports';
import type { CliAuth } from './cliApi';

export interface CliBugReports {
  store: BugReportStore;
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

  router.all('/bug-reports', bearer, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      error: 'Bug reports are write-only from the CLI: file one with POST. Admins read and triage them at /admin/bugs',
      code: 'method_not_allowed',
    });
  });
}
