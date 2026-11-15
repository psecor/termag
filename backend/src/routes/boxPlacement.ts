/**
 * GET /api/boxes/placement: where Runs on: Auto would
 * put a New session for these repositories, and every box of the caller's it
 * could go on instead, each with its state, heat, sessions and whether it has
 * the repositories. Read-only: nothing is woken, launched or claimed here.
 * Behind box-placement-enabled; off, it answers 404 box_placement_disabled.
 * With `userProjectId` (New session's project picker,
 * under user-projects-enabled) "has the repositories" is "has a checkout of
 * this project". The rule is services/boxPlacement.ts; this file reads what it needs.
 */
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { boolVariation } from '../services/featureFlags';
import { isInstanceAgentConnected } from '../services/agentRegistry';
import { isBoxProvisioningConfigured } from '../services/boxProvisioner';
import { ownerDefaultSize, repoKey } from '../services/boxSize';
import { readings, spawnLimitsFor } from '../services/spawnBudget';
import { BOX_PLACEMENT_FLAG, LISTED_STATUSES, placeSession, repoSetKey, type PlacementBoxInput } from '../services/boxPlacement';
import { placementPolicyFor } from '../services/boxPlacementPolicy';
import { checkoutRepoSet, repoSetEntryKey, userProjectsEnabled } from '../services/userProjects';
import { sendResult, type RouteResult } from './routeResult';

export const PLACEMENT_DISABLED = { error: 'Runs on: Auto is not on for you', code: 'box_placement_disabled' } as const;

/**
 * A checkout New session can branch for a project:
 * one of the project's, holding every repository the project has now. A
 * checkout made before a repository was added to the project lacks it, so
 * the session gets a new checkout; one with a repository more (Lab's Add
 * repository) is still the project's. A project with no repository matches
 * any of its checkouts.
 */
export function isProjectCheckout(
  checkout: { userProjectId: string | null; layout: string; repoUrl: string | null; repoDefaultBranch?: string | null; repos: ReadonlyArray<{ url: string; defaultBranch?: string | null; position?: number }> },
  project: { id: string; repoKeys: readonly string[] },
): boolean {
  if (checkout.userProjectId !== project.id) return false;
  const has = new Set(checkoutRepoSet({
    layout: checkout.layout, repoUrl: checkout.repoUrl, repoDefaultBranch: checkout.repoDefaultBranch ?? null,
    repos: checkout.repos.map((r, i) => ({ url: r.url, defaultBranch: r.defaultBranch ?? null, position: r.position ?? i })),
  }).map(r => r.repoKey));
  return project.repoKeys.every(k => has.has(k));
}

/**
 * The placement for `repos` (owner/name or GitHub URLs; several for a
 * multi-repo session) at `size`: the size New box would launch at, which the
 * browser knows (picked, or the repository's preselected one from GET
 * /api/instances/sizes). Without one, the owner's default size. The warm pool
 * holds each size apart, and a claim takes only its exact size (null too).
 * With `userProjectId`, under user-projects-enabled: a box has what the
 * session needs when it has a checkout of that project (isProjectCheckout),
 * and the reason names the project ("has termag"); `repos` is not read. A
 * project that isn't the caller's answers 404 user_project_not_found, an
 * archived one 409 user_project_archived.
 */
export async function boxPlacementFor(user: Express.User, repos: string[], size: string | null, now = Date.now(), userProjectId: string | null = null): Promise<RouteResult> {
  if (!await boolVariation(BOX_PLACEMENT_FLAG, user, false)) return { status: 404, body: PLACEMENT_DISABLED };
  // With the record off, the id is ignored: placement by repositories, as before.
  const byProjectOn = !!userProjectId && await userProjectsEnabled(user);
  const project = byProjectOn
    ? await prisma.userProject.findFirst({ where: { id: userProjectId!, userId: user.id }, select: { id: true, name: true, archivedAt: true, repos: { select: { url: true } } } })
    : null;
  if (byProjectOn && !project) return { status: 404, body: { error: 'No such project', code: 'user_project_not_found' } };
  // As the create refuses it (services/userProjects.ts requestedProjectRefusal): no box to recommend for a session that can't start.
  if (project?.archivedAt) return { status: 409, body: { error: 'That project is archived', code: 'user_project_archived' } };
  const byProject = project ? { id: project.id, repoKeys: project.repos.map(r => repoSetEntryKey(r.url)) } : null;
  const wanted = repoSetKey(repos.map(r => repoKey(r)));
  const repoNames = project ? [project.name] : wanted ? wanted.split(' ').map(k => k.split('/')[1]) : [];
  const [{ policy, source }, rows] = await Promise.all([
    placementPolicyFor(user),
    prisma.instance.findMany({
      // A box the lifecycle sweep is terminating is on its way out, whatever its status says.
      where: { userId: user.id, status: { in: [...LISTED_STATUSES] }, autoTerminatedAt: null },
      select: {
        id: true, name: true, kind: true, status: true, ec2InstanceId: true,
        memUsedPct: true, diskUsedPct: true, load1: true, hostSampledAt: true,
      },
    }),
  ]);
  const ids = rows.map(r => r.id);
  const [samples, projects, poolFree] = await Promise.all([
    readings(rows),
    ids.length ? prisma.project.findMany({
      where: { userId: user.id, archived: false, kind: 'normal', instanceId: { in: ids } },
      select: {
        id: true, instanceId: true, repoUrl: true, layout: true, setupStatus: true, lastActiveAt: true, userProjectId: true,
        repos: { select: { url: true } },
      },
      orderBy: { lastActiveAt: 'desc' },
    }) : Promise.resolve([]),
    // A hint, not a promise: the claim at Send decides, and falls back to a launch.
    isBoxProvisioningConfigured()
      ? (size ? Promise.resolve(size) : ownerDefaultSize(user)).then(s =>
        prisma.instance.count({ where: { userId: null, status: 'warm', size: s ?? null } })).then(n => n > 0)
      : Promise.resolve(false),
  ]);
  const boxes: PlacementBoxInput[] = await Promise.all(rows.map(async (row, i) => {
    const mine = projects.filter(p => p.instanceId === row.id);
    // A checkout of the same repositories (or of the project), cloned (a pane clone ends at none): the newest one, as projects are sorted.
    const cloned = (p: typeof mine[number]) => p.setupStatus === 'ready' || p.setupStatus === 'none';
    const checkout = byProject ? mine.find(p => cloned(p) && isProjectCheckout(p, byProject))
      : wanted ? mine.find(p => cloned(p)
        && repoSetKey(p.layout === 'workspace' ? p.repos.map(r => repoKey(r.url)) : [p.repoUrl ? repoKey(p.repoUrl) : null]) === wanted) : undefined;
    return {
      reading: samples[i],
      limits: await spawnLimitsFor(user, { id: row.id, name: row.name, kind: row.kind }),
      status: row.status,
      connected: isInstanceAgentConnected(row.id),
      startable: row.kind === 'ec2' && !!row.ec2InstanceId,
      sessions: mine.length,
      checkoutProjectId: checkout?.id ?? null,
      lastUsedAt: mine[0]?.lastActiveAt ?? null,
    };
  }));
  return { status: 200, body: placeSession({ policy, policySource: source, boxes, repoNames, poolFree, now }) };
}

/** `?repos=a/b,c/d`, given once or more: every non-empty entry. */
export function reposQuery(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((v): v is string => typeof v === 'string')
    .flatMap(v => v.split(','))
    .map(r => r.trim())
    .filter(Boolean);
}

export function boxPlacementRouter(): Router {
  const router = Router();
  // ?repos=owner/name,owner/name (or GitHub URLs); ?size= the size New box would launch at;
  // ?userProjectId= the project New session picked, in place of its repositories.
  router.get('/placement', requireAuth, asyncHandler(async (req, res) => {
    const size = typeof req.query.size === 'string' && req.query.size.trim() ? req.query.size.trim() : null;
    const userProjectId = typeof req.query.userProjectId === 'string' && req.query.userProjectId.trim() ? req.query.userProjectId.trim() : null;
    sendResult(res, await boxPlacementFor(req.user!, reposQuery(req.query.repos), size, Date.now(), userProjectId));
  }));
  return router;
}
