/**
 * Bug reports under /api/admin/bug-reports. Mounted
 * inside adminRouter, so requireAdmin, the rate limit and the audit log
 * already ran: every change here is an admin_audit_log row as well as a
 * bug_report_events row. Reads work with an admin token; triage needs a
 * signed-in session, like the other admin writes.
 *
 * The same handlers also serve an admin's box (routes/cliBugReports.ts): on
 * /api/cli/v1/bug-reports, with the box's own token, behind its own admin
 * check and audit row. Nothing else under /api/admin takes a box token.
 *
 *   GET   /bug-reports            ?status=&area=&severity=&q=&limit=, new first
 *   GET   /bug-reports/counts     reports per status (the nav badge reads `new`)
 *   GET   /bug-reports/:id        one, with its history, duplicates and names
 *   PATCH /bug-reports/:id        { status?, duplicateOf?, link?, note? }
 */
import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { fillCounts, parseBugFilter, parseTriageChange, sortNewFirst, type BugReportRow, type BugReportStore } from '../../services/bugReports';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function summary(r: BugReportRow) {
  return { id: r.id, title: r.title, status: r.status, severity: r.severity, area: r.area, createdAt: r.createdAt.toISOString() };
}

export interface BugHandlers {
  list: RequestHandler;
  counts: RequestHandler;
  detail: RequestHandler;
  /** Reads req.user as the admin who made the change. */
  triage: RequestHandler;
}

export function bugHandlers(store: BugReportStore, now: () => Date = () => new Date()): BugHandlers {
  const list = asyncHandler(async (req, res) => {
    const filter = parseBugFilter(req.query as Record<string, unknown>);
    if ('error' in filter) { res.status(400).json({ error: filter.error }); return; }
    const rows = sortNewFirst(await store.list(filter.ok));
    const names = await store.names({
      users: [...new Set(rows.map(r => r.reporterUserId))],
      boxes: [...new Set(rows.flatMap(r => r.boxId ? [r.boxId] : []))],
      projects: [],
    });
    res.json({
      reports: rows.map(r => ({
        ...summary(r),
        reporter: names.users[r.reporterUserId] ?? r.reporterUserId,
        box: r.boxId ? names.boxes[r.boxId] ?? r.boxId : null,
        agentProvider: r.agentProvider,
        linkUrl: r.linkUrl,
        duplicateOfId: r.duplicateOfId,
      })),
    });
  });

  const counts = asyncHandler(async (_req, res) => {
    res.json({ counts: fillCounts(await store.countsByStatus()) });
  });

  const detail = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const report = ID_RE.test(id) ? await store.get(id) : null;
    if (!report) { res.status(404).json({ error: 'No such bug report' }); return; }
    const [events, duplicates, duplicateOf] = await Promise.all([
      store.events(id), store.duplicatesOf(id), report.duplicateOfId ? store.get(report.duplicateOfId) : null,
    ]);
    const names = await store.names({
      users: [...new Set([report.reporterUserId, ...events.map(e => e.actorId)])],
      boxes: report.boxId ? [report.boxId] : [],
      projects: report.projectId ? [report.projectId] : [],
    });
    res.json({
      report: { ...report, createdAt: report.createdAt.toISOString(), triagedAt: report.triagedAt?.toISOString() ?? null },
      reporter: {
        user: names.users[report.reporterUserId] ?? report.reporterUserId,
        box: report.boxId ? names.boxes[report.boxId] ?? report.boxId : null,
        project: report.projectId ? names.projects[report.projectId] ?? report.projectId : null,
      },
      events: events.map(e => ({ ...e, actor: names.users[e.actorId] ?? e.actorId, createdAt: e.createdAt.toISOString() })),
      duplicateOf: duplicateOf ? summary(duplicateOf) : null,
      duplicates: duplicates.map(summary),
    });
  });

  const triage = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const report = ID_RE.test(id) ? await store.get(id) : null;
    if (!report) { res.status(404).json({ error: 'No such bug report' }); return; }
    const change = parseTriageChange(req.body, id);
    if ('error' in change) { res.status(400).json({ error: change.error }); return; }
    if (change.ok.duplicateOfId) {
      const original = await store.get(change.ok.duplicateOfId);
      if (!original) { res.status(400).json({ error: `No bug report ${change.ok.duplicateOfId} to be a duplicate of` }); return; }
      // Point at the root, so duplicates never chain.
      if (original.duplicateOfId === id) { res.status(400).json({ error: `${original.id} is already a duplicate of this report` }); return; }
      if (original.duplicateOfId) change.ok.duplicateOfId = original.duplicateOfId;
    }
    const updated = await store.triage(id, change.ok, req.user!.id, now());
    res.json({ report: { ...updated, createdAt: updated.createdAt.toISOString(), triagedAt: updated.triagedAt?.toISOString() ?? null } });
  });

  return { list, counts, detail, triage };
}

export function bugsRouter(store: BugReportStore, now: () => Date = () => new Date()): Router {
  const router = Router();
  const h = bugHandlers(store, now);
  router.get('/bug-reports', h.list);
  // Before /:id, which would take "counts" for an id.
  router.get('/bug-reports/counts', h.counts);
  router.get('/bug-reports/:id', h.detail);
  router.patch('/bug-reports/:id', requireAdminSession, h.triage);
  return router;
}
