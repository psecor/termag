/**
 * /api/admin — read-only org-wide views (phase 0) plus admin management
 * (tokens, admins, audit) from ./manage.ts. Every route sits behind
 * requireAdmin (session role or admin bearer) and a per-caller rate limit.
 * Handlers are thin: parse → call the shared query → json. The MCP server
 * (mcp/adminServer.ts) calls the same query functions.
 */
import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../../middleware/admin';
import { asyncHandler } from '../../middleware/errors';
import { rateLimit } from '../../middleware/rateLimit';
import { parseRange } from '../../services/admin/range';
import { listInstances, fleetOverview, provisioningStats, getInstance } from '../../services/admin/fleetQueries';
import { listUsers, getUser, activeUsers } from '../../services/admin/userQueries';
import { tokenReport, parseTokenGroups, worktimeReport, parseWorktimeGroups } from '../../services/admin/usageQueries';
import { listProjects, projectCounts, liveSessions, summarizeSessions } from '../../services/admin/inventoryQueries';
import { computeSignals } from '../../services/admin/signalsData';
import { systemHealth } from '../../services/admin/systemQueries';
import { adminCloudSessions, capacity, cloudReport, cloudSummary, orchestratorHealth, parseReportGroup, pipelineHealth } from '../../services/admin/claudeRunnerQueries';
import { manageRouter } from './manage';

function rangeOr400(req: Request, res: Response) {
  const r = parseRange(req.query as Record<string, unknown>);
  if ('error' in r) { res.status(400).json({ error: r.error }); return null; }
  return r;
}

export function adminRouter(): Router {
  const router = Router();
  router.use(requireAdmin, rateLimit({ capacity: 60, perMinute: 120 }));

  router.get('/overview', asyncHandler(async (req, res) => {
    const range = rangeOr400(req, res); if (!range) return;
    // One live-session scan (a tmux-list RPC per connected host) shared with the signals.
    const sessions = await liveSessions();
    const [fleet, projects, tokens, worktime, users, signals, cloud] = await Promise.all([
      fleetOverview(), projectCounts(), tokenReport(range, ['day']), worktimeReport(range, ['day']),
      activeUsers(range), computeSignals(Date.now(), { sessions }), cloudSummary(),
    ]);
    res.json({
      range: { id: range.id, since: range.sinceKey, until: range.untilKey },
      fleet, projects, sessions: summarizeSessions(sessions),
      // Claude Code cloud sessions right now: no tmux-list behind these.
      cloud: { running: cloud.running, starting: cloud.starting, queued: cloud.queued },
      tokens: { days: tokens.rows.sort((a, b) => a.keys[0].localeCompare(b.keys[0])), totals: tokens.totals, prior: tokens.prior },
      worktime: { days: worktime.rows.sort((a, b) => a.keys[0].localeCompare(b.keys[0])), totals: worktime.totals, prior: worktime.prior },
      users: { registered: users.registered, active: users.totals },
      signals: signals.signals,
      generatedAt: new Date().toISOString(),
    });
  }));

  router.get('/fleet/instances', asyncHandler(async (req, res) => {
    res.json(await listInstances({ includeTerminated: req.query.all === '1' || req.query.all === 'true' }));
  }));
  router.get('/fleet/overview', asyncHandler(async (_req, res) => { res.json(await fleetOverview()); }));
  router.get('/fleet/provisioning', asyncHandler(async (req, res) => {
    const range = rangeOr400(req, res); if (!range) return;
    res.json(await provisioningStats(range));
  }));
  router.get('/fleet/instances/:id', asyncHandler(async (req, res) => {
    const box = await getInstance(req.params.id);
    if (!box) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(box);
  }));

  router.get('/users', asyncHandler(async (req, res) => {
    const range = rangeOr400(req, res); if (!range) return;
    res.json(await listUsers(range));
  }));
  router.get('/users/active', asyncHandler(async (req, res) => {
    const range = rangeOr400(req, res); if (!range) return;
    res.json(await activeUsers(range));
  }));
  router.get('/users/:id', asyncHandler(async (req, res) => {
    const range = rangeOr400(req, res); if (!range) return;
    const user = await getUser(req.params.id, range);
    if (!user) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(user);
  }));

  router.get('/projects', asyncHandler(async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const staleDays = q.staleDays ? parseInt(q.staleDays, 10) : undefined;
    res.json(await listProjects({
      userId: q.userId, instanceId: q.instanceId, provider: q.provider, kind: q.kind,
      archived: q.archived === '1' || q.archived === 'true',
      staleDays: staleDays && Number.isFinite(staleDays) && staleDays > 0 ? staleDays : undefined,
    }));
  }));
  router.get('/projects/counts', asyncHandler(async (_req, res) => { res.json(await projectCounts()); }));

  router.get('/sessions/live', asyncHandler(async (_req, res) => {
    const rows = await liveSessions();
    res.json({ summary: summarizeSessions(rows), rows, generatedAt: new Date().toISOString() });
  }));

  router.get('/usage/tokens', asyncHandler(async (req, res) => {
    const range = rangeOr400(req, res); if (!range) return;
    res.json(await tokenReport(range, parseTokenGroups(req.query.groupBy as string | string[] | undefined)));
  }));
  router.get('/usage/worktime', asyncHandler(async (req, res) => {
    const range = rangeOr400(req, res); if (!range) return;
    res.json(await worktimeReport(range, parseWorktimeGroups(req.query.groupBy as string | string[] | undefined)));
  }));

  router.get('/signals', asyncHandler(async (_req, res) => { res.json(await computeSignals()); }));
  router.get('/system', asyncHandler(async (_req, res) => { res.json(await systemHealth()); }));
  // Claude Code cloud sessions:
  // the orchestrator's loopback health and the org-wide runs, no titles.
  router.get('/claude-runner/health', asyncHandler(async (_req, res) => { res.json(await orchestratorHealth()); }));
  router.get('/claude-runner/sessions', asyncHandler(async (req, res) => {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const limit = Number(req.query.limit) || 50;
    res.json(await adminCloudSessions(days, new Date(), limit));
  }));
  // History: runs and events of the range, grouped; per-box pipeline health.
  router.get('/claude-runner/report', asyncHandler(async (req, res) => {
    const range = rangeOr400(req, res); if (!range) return;
    res.json(await cloudReport(range, parseReportGroup(req.query.groupBy)));
  }));
  router.get('/claude-runner/pipeline', asyncHandler(async (_req, res) => { res.json(await pipelineHealth()); }));
  router.get('/claude-runner/summary', asyncHandler(async (_req, res) => { res.json(await cloudSummary()); }));
  router.get('/claude-runner/capacity', asyncHandler(async (_req, res) => { res.json(await capacity()); }));

  router.use(manageRouter());
  return router;
}
