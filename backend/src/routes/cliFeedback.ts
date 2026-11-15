/**
 * Feedback under /api/cli/v1, for `termag feedback`:
 *
 *   POST /feedback   { body, kind?, cliVersion?, agent…, projectId?, workstream? }
 *                    201 with its id (any credential)
 *
 * The same path as a bug report (routes/cliBugReports.ts): a box's own
 * credential logs as its box and owner, a device sign-in as its person, the
 * project and thread kept only when they are the reporter's
 * (services/cliReporter.ts). At most FEEDBACK_PER_HOUR per box in any hour
 * (per person for a sign-in with no box), counted in the database. The text is
 * redacted of secret-shaped strings before it is stored. Reading is the admin
 * page's only (/admin/feedback); there is no CLI read.
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import { reporterBase } from '../services/cliReporter';
import { FEEDBACK_PER_HOUR, RATE_WINDOW_MS, parseFeedbackInput, underRateLimit, type FeedbackStore } from '../services/feedback';
import type { CliAuth } from './cliApi';

export interface CliFeedback {
  store: FeedbackStore;
}

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliFeedbackRoutes(router: Router, deps: CliFeedback, bearer: RequestHandler, now: () => Date): void {
  router.post('/feedback', bearer, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    const parsed = parseFeedbackInput(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error, code: 'invalid_request' }); return; }
    const input = parsed.ok;

    const reporter = await deps.store.resolveReporter(reporterBase(user, credential), { projectId: input.projectId, workstream: input.workstream });
    const at = now();
    const recent = await deps.store.countRecent({ boxId: reporter.boxId, userId: user.id }, new Date(at.getTime() - RATE_WINDOW_MS));
    if (!underRateLimit(recent)) {
      res.status(429).set('Retry-After', '600').json({
        error: `At most ${FEEDBACK_PER_HOUR} pieces of feedback an hour from ${reporter.boxId ? 'one box' : 'one person'}; try again later`,
        code: 'rate_limited',
      });
      return;
    }

    const row = await deps.store.create(input, reporter);
    res.status(201).json({ id: row.id, status: row.status, redacted: row.redacted });
  }));

  router.all('/feedback', bearer, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      error: 'Feedback takes POST to log it; admins read it at /admin/feedback',
      code: 'method_not_allowed',
    });
  });
}
