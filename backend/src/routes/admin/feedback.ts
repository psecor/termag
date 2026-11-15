/**
 * Feedback about termag under /api/admin/feedback.
 * Mounted inside adminRouter, so requireAdmin, the rate limit and the audit
 * log already ran. Reads work with an admin token; marking feedback seen
 * needs a signed-in session, like the other admin writes.
 *
 *   GET   /feedback            ?status=&kind=&q=&limit=, newest first, with the
 *                              reporter, box and project names: the whole list
 *                              is the page, there is no detail route;
 *                              `more` says whether older ones matched too
 *   GET   /feedback/counts     feedback per status (the nav badge reads `new`)
 *   PATCH /feedback/:id        { status: 'seen' | 'new' }
 */
import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { fillCounts, parseFeedbackFilter, parseStatusChange, type FeedbackRow, type FeedbackStore } from '../../services/feedback';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

type Names = Awaited<ReturnType<FeedbackStore['names']>>;

function item(r: FeedbackRow, names: Names) {
  return {
    id: r.id,
    body: r.body,
    kind: r.kind,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    seenAt: r.seenAt?.toISOString() ?? null,
    seenBy: r.seenById ? names.users[r.seenById] ?? r.seenById : null,
    reporter: names.users[r.reporterUserId] ?? r.reporterUserId,
    reporterUserId: r.reporterUserId,
    credential: r.credential,
    box: r.boxId ? names.boxes[r.boxId] ?? r.boxId : null,
    boxId: r.boxId,
    project: r.projectId ? names.projects[r.projectId] ?? r.projectId : null,
    projectId: r.projectId,
    workstream: r.workstream,
    threadId: r.threadId,
    agentProvider: r.agentProvider,
    agentModel: r.agentModel,
    agentVersion: r.agentVersion,
    cliVersion: r.cliVersion,
    boxAgentCommit: r.boxAgentCommit,
    redacted: r.redacted,
  };
}

async function namesFor(store: FeedbackStore, rows: FeedbackRow[]): Promise<Names> {
  return store.names({
    users: [...new Set(rows.flatMap(r => r.seenById ? [r.reporterUserId, r.seenById] : [r.reporterUserId]))],
    boxes: [...new Set(rows.flatMap(r => r.boxId ? [r.boxId] : []))],
    projects: [...new Set(rows.flatMap(r => r.projectId ? [r.projectId] : []))],
  });
}

export interface FeedbackHandlers {
  list: RequestHandler;
  counts: RequestHandler;
  /** Reads req.user as the admin who made the change. */
  setStatus: RequestHandler;
}

export function feedbackHandlers(store: FeedbackStore, now: () => Date = () => new Date()): FeedbackHandlers {
  const list = asyncHandler(async (req, res) => {
    const filter = parseFeedbackFilter(req.query as Record<string, unknown>);
    if ('error' in filter) { res.status(400).json({ error: filter.error }); return; }
    // One row past the limit says whether there are more, so the tab can say
    // the list stopped without claiming so when exactly `limit` match.
    const fetched = await store.list({ ...filter.ok, limit: filter.ok.limit + 1 });
    const rows = fetched.slice(0, filter.ok.limit);
    const names = await namesFor(store, rows);
    res.json({ feedback: rows.map(r => item(r, names)), more: fetched.length > rows.length });
  });

  const counts = asyncHandler(async (_req, res) => {
    res.json({ counts: fillCounts(await store.countsByStatus()) });
  });

  const setStatus = asyncHandler(async (req, res) => {
    const id = req.params.id;
    const row = ID_RE.test(id) ? await store.get(id) : null;
    if (!row) { res.status(404).json({ error: 'No such feedback' }); return; }
    const status = parseStatusChange(req.body);
    if ('error' in status) { res.status(400).json({ error: status.error }); return; }
    const updated = await store.setStatus(id, status.ok, req.user!.id, now());
    res.json({ feedback: item(updated, await namesFor(store, [updated])) });
  });

  return { list, counts, setStatus };
}

export function feedbackRouter(store: FeedbackStore, now: () => Date = () => new Date()): Router {
  const router = Router();
  const h = feedbackHandlers(store, now);
  router.get('/feedback', h.list);
  // Before any /:id route, which would take "counts" for an id.
  router.get('/feedback/counts', h.counts);
  router.patch('/feedback/:id', requireAdminSession, h.setStatus);
  return router;
}
