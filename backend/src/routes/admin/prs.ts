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
import { parseTeam, parseTeamMember, SEED_START, type ParsedMember } from '../../services/prAnalytics/teams';
import { exportProblem, syncTeams } from '../../services/prAnalytics/teamSync';
import { BASES, VIEWS, WINDOWS, parseChoice, type Basis, type View } from '../../services/prAnalytics/stats';
import { prSummary, prContributors, prTrend, prGroups, prIngestStatus, prReviews, prReviewers, prReviewTrend, prTeamRepos, prTeams, loadTeamRoster, prTeamReviews, prTeamReviewers, prTeamReviewTrend, ALL_REPOS, type TeamRoster } from '../../services/prAnalytics/queries';
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

  // Teams: a roster of people. `group` is optional:
  // omitted, the view spans every ingested repo its people touch.
  const teamCommon = async (req: Request, res: Response): Promise<{ team: TeamRoster; group: string; view: View; basis: Basis } | null> => {
    const key = typeof req.query.team === 'string' ? req.query.team.trim().toLowerCase() : '';
    if (!key) { res.status(400).json({ error: 'team is required' }); return null; }
    const group = typeof req.query.group === 'string' && req.query.group.trim() ? req.query.group.trim() : ALL_REPOS;
    const view = parseChoice(req.query.view, VIEWS, 'credited');
    const basis = parseChoice(req.query.basis, BASES, 'merged');
    if (!view) { res.status(400).json({ error: `view must be one of ${VIEWS.join(', ')}` }); return null; }
    if (!basis) { res.status(400).json({ error: `basis must be one of ${BASES.join(', ')}` }); return null; }
    const roster = await loadTeamRoster(key);
    if (!roster) { res.status(404).json({ error: 'No such team' }); return null; }
    return { team: roster, group, view, basis };
  };

  router.get('/prs/teams', asyncHandler(async (_req, res) => { res.json(await prTeams()); }));
  router.get('/prs/team-summary', asyncHandler(async (req, res) => {
    const t = await teamCommon(req, res); if (!t) return;
    const out = await prSummary(t.group, t.view, t.basis, new Date(), t.team);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json({ ...out, team: t.team.key });
  }));
  router.get('/prs/team-members', asyncHandler(async (req, res) => {
    const days = intParam(req.query.window, 30, 1, 30);
    if (days === null || !(WINDOWS as readonly number[]).includes(days)) { res.status(400).json({ error: `window must be one of ${WINDOWS.join(', ')}` }); return; }
    const t = await teamCommon(req, res); if (!t) return;
    const out = await prContributors(t.group, t.view, t.basis, days, 100, new Date(), t.team);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json({ ...out, team: t.team.key });
  }));
  router.get('/prs/team-repos', asyncHandler(async (req, res) => {
    const days = intParam(req.query.window, 30, 1, 30);
    if (days === null || !(WINDOWS as readonly number[]).includes(days)) { res.status(400).json({ error: `window must be one of ${WINDOWS.join(', ')}` }); return; }
    const t = await teamCommon(req, res); if (!t) return;
    const out = await prTeamRepos(t.group, t.view, t.basis, days, t.team);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));
  router.get('/prs/team-trend', asyncHandler(async (req, res) => {
    const weeks = intParam(req.query.weeks, 26, 1, 78);
    if (weeks === null) { res.status(400).json({ error: 'weeks must be 1 to 78' }); return; }
    const t = await teamCommon(req, res); if (!t) return;
    const out = await prTrend(t.group, t.view, t.basis, weeks, new Date(), t.team);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json({ ...out, team: t.team.key });
  }));

  // Reviews given (by team members) and received (on the team's PRs).
  const sideOf = (req: Request, res: Response): 'given' | 'received' | null => {
    const side = req.query.side;
    if (side !== 'given' && side !== 'received') { res.status(400).json({ error: 'side must be given or received' }); return null; }
    return side;
  };
  router.get('/prs/team-reviews', asyncHandler(async (req, res) => {
    const side = sideOf(req, res); if (!side) return;
    const t = await teamCommon(req, res); if (!t) return;
    const out = await prTeamReviews(t.group, side, t.team);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));
  router.get('/prs/team-reviewers', asyncHandler(async (req, res) => {
    const side = sideOf(req, res); if (!side) return;
    const days = intParam(req.query.window, 30, 1, 30);
    if (days === null || !(WINDOWS as readonly number[]).includes(days)) { res.status(400).json({ error: `window must be one of ${WINDOWS.join(', ')}` }); return; }
    const limit = intParam(req.query.limit, 10, 1, 100);
    if (limit === null) { res.status(400).json({ error: 'limit must be 1 to 100' }); return; }
    const t = await teamCommon(req, res); if (!t) return;
    const out = await prTeamReviewers(t.group, side, t.team, days, limit);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));
  router.get('/prs/team-reviews/trend', asyncHandler(async (req, res) => {
    const weeks = intParam(req.query.weeks, REVIEW_TREND_MAX_WEEKS, 1, REVIEW_TREND_MAX_WEEKS);
    if (weeks === null) { res.status(400).json({ error: `weeks must be 1 to ${REVIEW_TREND_MAX_WEEKS}` }); return; }
    const t = await teamCommon(req, res); if (!t) return;
    const out = await prTeamReviewTrend(t.group, t.team, weeks);
    if (!out) { res.status(404).json({ error: 'No such group' }); return; }
    res.json(out);
  }));

  // Save a team and its manual roster: the editor's list replaces the manual
  // memberships, leaving synced ones (the org-tree's) alone. One transaction, so
  // a mid-failure never leaves the team with no manual rows; `hidden` is kept
  // unless the body sets it.
  router.put('/prs/teams/:key', requireAdminSession, asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const t = parseTeam({ ...body, key: req.params.key });
    if ('error' in t) { res.status(400).json({ error: t.error }); return; }
    const list = Array.isArray(body.members) ? body.members : [];
    const members: ParsedMember[] = [];
    for (const m of list) {
      // Manual members are entered as a login, not a join date: the start is a floor (openStart).
      const parsed = parseTeamMember({ start: SEED_START, openStart: true, ...(m as object) });
      if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
      members.push(parsed);
    }
    await prisma.$transaction(async tx => {
      const existing = await tx.team.findUnique({ where: { key: t.key }, select: { hidden: true } });
      const hidden = typeof body.hidden === 'boolean' ? body.hidden : existing?.hidden ?? t.hidden;
      await tx.team.upsert({ where: { key: t.key }, create: { ...t, hidden }, update: { name: t.name, parent: t.parent, hidden, sort: t.sort } });
      await tx.teamMembership.deleteMany({ where: { teamKey: t.key, source: 'manual' } });
      if (members.length) {
        await tx.teamMembership.createMany({ data: members.map(m => ({ teamKey: t.key, login: m.login, name: m.name || null, email: m.email || null, start: m.start, end: m.end, openStart: m.openStart, source: 'manual' })), skipDuplicates: true });
      }
    });
    res.json({ ...t, members: members.map(m => m.login) });
  }));
  router.delete('/prs/teams/:key', requireAdminSession, asyncHandler(async (req, res) => {
    const key = String(req.params.key).toLowerCase();
    const found = await prisma.team.findUnique({ where: { key } });
    if (!found) { res.status(404).json({ error: 'No such team' }); return; }
    await prisma.team.delete({ where: { key } });
    res.json({ deleted: key });
  }));

  // Pull the whole registry and every roster from the org-tree (Sync).
  router.post('/prs/teams/sync', requireAdminSession, asyncHandler(async (_req, res) => {
    try {
      res.json(await syncTeams());
    } catch (err) {
      res.status(502).json({ error: `org-tree sync failed: ${(err as Error).message}` });
    }
  }));

  // The same sync from an export an admin uploads (the org-explorer box's
  // `teams-export.json`), for a deployment that can reach neither the export
  // file nor the API. Its body limit is set ahead of the global parser
  // (index.ts, TEAMS_EXPORT_BODY_LIMIT).
  router.post('/prs/teams/import', requireAdminSession, asyncHandler(async (req, res) => {
    const problem = exportProblem(req.body);
    if (problem) { res.status(400).json({ error: problem }); return; }
    // A failure past the checks says why, as the sync route does, not a bare 500 (Devin, #1094).
    try {
      res.json(await syncTeams({ exportData: req.body }));
    } catch (err) {
      res.status(500).json({ error: `team import failed: ${(err as Error).message}` });
    }
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
