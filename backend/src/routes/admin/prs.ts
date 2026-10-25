/**
 * PR analytics under /api/admin/prs. Mounted inside
 * adminRouter, so requireAdmin and the rate limit already ran. Reads work with
 * an admin token; edits (groups, the token nomination, a manual sync) need a
 * signed-in session, like the other admin writes.
 */
import { Router, type Request, type Response } from 'express';
import { prisma } from '../../db';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { readGithubAccess } from '../../services/credentialStore';
import { parseGroup } from '../../services/prAnalytics/groups';
import { BASES, VIEWS, WINDOWS, parseChoice, type Basis, type View } from '../../services/prAnalytics/stats';
import { prSummary, prContributors, prTrend, prGroups, prIngestStatus, prReviews, prReviewers, prReviewTrend } from '../../services/prAnalytics/queries';
import { REVIEW_TREND_MAX_WEEKS } from '../../services/prAnalytics/reviews';
import { getSettings, kickIngester, markGroupsChanged } from '../../services/prAnalytics/ingester';

/** group, view and basis from the query string, or a 400. */
function common(req: Request, res: Response): { group: string; view: View; basis: Basis } | null {
  const group = typeof req.query.group === 'string' ? req.query.group : '';
  const view = parseChoice(req.query.view, VIEWS, 'credited');
  const basis = parseChoice(req.query.basis, BASES, 'merged');
  if (!group) { res.status(400).json({ error: 'group is required' }); return null; }
  if (!view) { res.status(400).json({ error: `view must be one of ${VIEWS.join(', ')}` }); return null; }
  if (!basis) { res.status(400).json({ error: `basis must be one of ${BASES.join(', ')}` }); return null; }
  return { group, view, basis };
}

function intParam(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export function prsRouter(): Router {
  const router = Router();

  router.get('/prs/groups', asyncHandler(async (_req, res) => { res.json(await prGroups()); }));
  router.get('/prs/status', asyncHandler(async (_req, res) => { res.json(await prIngestStatus()); }));

  router.get('/prs/summary', asyncHandler(async (req, res) => {
    const c = common(req, res); if (!c) return;
    const out = await prSummary(c.group, c.view, c.basis);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));
  router.get('/prs/contributors', asyncHandler(async (req, res) => {
    const c = common(req, res); if (!c) return;
    const days = intParam(req.query.window, 30, 1, 30);
    if (days === null || !(WINDOWS as readonly number[]).includes(days)) { res.status(400).json({ error: `window must be one of ${WINDOWS.join(', ')}` }); return; }
    const limit = intParam(req.query.limit, 10, 1, 100);
    if (limit === null) { res.status(400).json({ error: 'limit must be 1 to 100' }); return; }
    const out = await prContributors(c.group, c.view, c.basis, days, limit);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));
  router.get('/prs/trend', asyncHandler(async (req, res) => {
    const c = common(req, res); if (!c) return;
    const weeks = intParam(req.query.weeks, 26, 1, 78);
    if (weeks === null) { res.status(400).json({ error: 'weeks must be 1 to 78' }); return; }
    const out = await prTrend(c.group, c.view, c.basis, weeks);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));

  // Reviews: every PR in
  // the group, people as reviewers, so the view and basis don't apply.
  const groupOf = (req: Request, res: Response): string | null => {
    const group = typeof req.query.group === 'string' ? req.query.group : '';
    if (!group) res.status(400).json({ error: 'group is required' });
    return group || null;
  };
  router.get('/prs/reviews', asyncHandler(async (req, res) => {
    const group = groupOf(req, res); if (!group) return;
    const out = await prReviews(group);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));
  router.get('/prs/reviewers', asyncHandler(async (req, res) => {
    const group = groupOf(req, res); if (!group) return;
    const days = intParam(req.query.window, 30, 1, 30);
    if (days === null || !(WINDOWS as readonly number[]).includes(days)) { res.status(400).json({ error: `window must be one of ${WINDOWS.join(', ')}` }); return; }
    const limit = intParam(req.query.limit, 10, 1, 100);
    if (limit === null) { res.status(400).json({ error: 'limit must be 1 to 100' }); return; }
    const out = await prReviewers(group, days, limit);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));
  router.get('/prs/reviews/trend', asyncHandler(async (req, res) => {
    const group = groupOf(req, res); if (!group) return;
    const weeks = intParam(req.query.weeks, REVIEW_TREND_MAX_WEEKS, 1, REVIEW_TREND_MAX_WEEKS);
    if (weeks === null) { res.status(400).json({ error: `weeks must be 1 to ${REVIEW_TREND_MAX_WEEKS}` }); return; }
    const out = await prReviewTrend(group, weeks);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));

  router.put('/prs/groups/:slug', requireAdminSession, asyncHandler(async (req, res) => {
    const g = parseGroup({ ...(req.body ?? {}), slug: req.params.slug });
    if ('error' in g) { res.status(400).json({ error: g.error }); return; }
    const data = { name: g.name, members: g.members as object[], excluded: g.excluded, sort: g.sort };
    await prisma.repoGroup.upsert({ where: { slug: g.slug }, create: { slug: g.slug, ...data }, update: data });
    markGroupsChanged(); kickIngester();
    res.json(g);
  }));
  router.delete('/prs/groups/:slug', requireAdminSession, asyncHandler(async (req, res) => {
    const found = await prisma.repoGroup.findUnique({ where: { slug: req.params.slug } });
    if (!found) { res.status(404).json({ error: 'No such group' }); return; }
    await prisma.$transaction([
      prisma.repoGroupMember.deleteMany({ where: { groupSlug: found.slug } }),
      prisma.repoGroupPr.deleteMany({ where: { groupSlug: found.slug } }),
      prisma.repoGroup.delete({ where: { slug: found.slug } }),
    ]);
    markGroupsChanged();
    res.json({ deleted: found.slug });
  }));

  // Nominate your own stored GitHub token for ingestion, or clear the nomination.
  router.put('/prs/token', requireAdminSession, asyncHandler(async (req, res) => {
    const use = (req.body as { use?: unknown } | undefined)?.use;
    if (use !== true && use !== false) { res.status(400).json({ error: 'use must be true or false' }); return; }
    await getSettings();
    if (use) {
      const access = await readGithubAccess(req.user!.id);
      if (!access) { res.status(400).json({ error: 'Connect GitHub in your termag settings first' }); return; }
      await prisma.prAnalyticsSettings.update({ where: { id: 'settings' }, data: { tokenUserId: req.user!.id } });
      kickIngester();
    } else {
      await prisma.prAnalyticsSettings.update({ where: { id: 'settings' }, data: { tokenUserId: null } });
    }
    res.json(await prIngestStatus());
  }));
  router.post('/prs/sync', requireAdminSession, asyncHandler(async (_req, res) => {
    kickIngester();
    res.json({ started: true });
  }));

  return router;
}
