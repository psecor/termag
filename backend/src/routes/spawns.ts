/**
 * Agent spawn routes: an agent starts another agent in
 * a new workstream or project, with a brief, and the child reports back.
 *
 *   POST /api/spawns          start one (spawnFor)
 *   GET  /api/spawns          the caller session's children and its own parent
 *   POST /api/spawns/report   a spawned agent reports its state
 *   GET  /api/spawns/budget   the limits, usage and hints for the caller (spawn_budget)
 *   GET  /api/spawns/usage    the dashboard's Spawned agents section (usageFor)
 *   GET  /api/spawns/parents  which session started each live child (parentsFor; the simple UI's explorer)
 *   POST /api/spawns/:id/dismiss  park or retire a child (dismissFor)
 *   POST /api/spawns/:id/resume   bring a parked child back (owner only)
 *   POST /api/spawns/:id/adopt    take an orphan as foster parent (adoptFor; "Orphans")
 *   PUT  /api/spawns/orphan-home  where orphans go when no ancestor is alive (owner only)
 *
 * Box token or browser session (requireAuthOrAgentToken). Access is the
 * token's user throughout: the parent session the MCP server names is used
 * for attribution, limits and the nudge, and must be one of that user's own.
 * Behind the agent-spawn-enabled flag (off unless TERMAG_FLAGS turns it on).
 * The limits come from the agent-spawn-limits flag (services/spawnLimits.ts),
 * read for the box the child runs on, and every request and refusal lands in
 * spawn_events.
 */
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import {
  SPAWN_FLAG,
  buildBrief,
  chooseSpawnProvider,
  parseReport,
  parseSpawnRequest,
  slugFromTask,
  spawnPromptPath,
  taskTitle,
  uniqueName,
  type SpawnRequest,
} from '../services/agentSpawn';
import { isProjectAgentConnected, sendForProject } from '../services/agentRegistry';
import { boolVariation } from '../services/featureFlags';
import { BOX_SELECT, buildBudget, readings, spawnLimitsFor, userBoxReadings } from '../services/spawnBudget';
import { buildSpawnTrees, tokensBySpawn, treeTotals } from '../services/spawnTrees';
import { checkoutCheck, parkSpawn, resumeSpawn, retireSpawn } from '../services/spawnActions';
import { lifecycleLabel } from '../services/spawnLifecycle';
import { adoptSpawn } from '../services/spawnOrphanSweep';
import { effectiveParent, parseOrphanHome } from '../services/spawnOrphans';
import { recordSpawnEvent } from '../services/spawnEvents';
import { watchSpawnedSession } from '../services/spawnStatusLog';
import { boxHeat, boxHints, boxRefusal, limitRefusal, rebudget, suggestBox, type BoxReading, type Budget, type SpawnLimits } from '../services/spawnLimits';
import { powerStateError } from '../services/boxPowerPolicy';
import { resolveProjectRoot } from '../services/projectPaths';
import { isAmbiguousSession, resolveSessionProject } from '../services/sessionResolver';
import { getStatus } from '../services/status';
import * as tmux from '../services/tmux';
import { createProjectFor } from './projects';
import { RouteResult, sendResult } from './routeResult';
import { createWorkstreamFor } from './workstreams';

const ROLES = ['agent', 'ctrl', 'data', 'data-ctrl', 'review'] as const;
const HOUR_MS = 60 * 60 * 1000;

export interface CallerSession {
  session: string;
  projectId: string;
  projectName: string;
  workstream: string;
  role: string | null;
  instanceId: string | null;
  provider: string | null;
}

export type Found<T> = { ok: true; value: T } | { ok: false; result: RouteResult };

/**
 * The caller's own pane as one of the user's projects, or a 404. A box token
 * scopes the lookup to its own box (session names repeat across boxes).
 */
export async function resolveCaller(user: Express.User, session: string, callerInstanceId: string | null | undefined): Promise<Found<CallerSession>> {
  const notYours = { ok: false as const, result: { status: 404, body: { error: `session ${session} is not one of your project sessions`, code: 'not_found' } } };
  const resolved = await resolveSessionProject(session, callerInstanceId ?? undefined);
  if (!resolved || isAmbiguousSession(resolved) || resolved.userId !== user.id || !resolved.projectId || !resolved.workstream) {
    return notYours;
  }
  const project = await prisma.project.findFirst({
    where: { id: resolved.projectId, userId: user.id, archived: false },
    include: { workstreams: { where: { name: resolved.workstream }, include: { workflows: true } } },
  });
  if (!project) return notYours;
  const role = ROLES.find(r => tmux.sessionName(user.unixUsername, project.name, r, resolved.workstream!) === session) ?? null;
  const agentWorkflow = project.workstreams[0]?.workflows.find(w => w.type === 'agent');
  return {
    ok: true,
    value: {
      session,
      projectId: project.id,
      projectName: project.name,
      workstream: resolved.workstream,
      role,
      instanceId: project.instanceId,
      provider: agentWorkflow?.provider ?? null,
    },
  };
}

interface Lineage {
  /** How deep the caller already is: the depth of the spawn that made its workstream, else 0. */
  depth: number;
  /** The tree the caller belongs to, if a spawn made it. */
  rootSpawnId: string | null;
}

async function lineageOf(userId: string, caller: CallerSession | null): Promise<Lineage> {
  if (!caller) return { depth: 0, rootSpawnId: null };
  const own = await prisma.agentSpawn.findFirst({
    where: { userId, childProjectId: caller.projectId, childWorkstream: caller.workstream },
    orderBy: { createdAt: 'desc' },
    select: { id: true, depth: true, rootSpawnId: true },
  });
  return own ? { depth: own.depth, rootSpawnId: own.rootSpawnId ?? own.id } : { depth: 0, rootSpawnId: null };
}

/**
 * May this spawn go onto this box? The flag and the limits are both read for
 * the box the child runs on: that is the box being acted on. A box running
 * hot or at capacity is refused with a suggestion; a project target can move
 * to the suggested box, a workstream lives where its project does.
 */
async function admit(
  user: Express.User,
  caller: CallerSession | null,
  lineage: Lineage,
  targetInstanceId: string,
  target: 'workstream' | 'project',
): Promise<Found<Budget>> {
  const box = await prisma.instance.findUnique({ where: { id: targetInstanceId }, select: { id: true, name: true, kind: true } });
  if (!(await boolVariation(SPAWN_FLAG, user, false, box))) {
    return { ok: false, result: { status: 403, body: { error: `agent spawn is not enabled for you on this box (feature flag ${SPAWN_FLAG})`, code: 'spawn_disabled', reason: 'flag' } } };
  }
  const parent = caller ? { projectId: caller.projectId, workstream: caller.workstream } : null;
  const budget = await buildBudget(user, parent, lineage.depth, targetInstanceId);
  const limit = limitRefusal({
    parentDepth: lineage.depth, openChildren: budget.used.openHere ?? 0,
    spawnsLastHour: budget.used.lastHour, running: budget.used.running,
  }, budget.limits);
  if (limit) return { ok: false, result: { status: 429, body: { error: limit.error, code: 'spawn_limit', reason: limit.reason, budget } } };
  const busy = budget.box ? boxRefusal(budget.box, budget.limits, Date.now()) : null;
  if (busy) {
    let other: { box: BoxReading; limits: SpawnLimits } | null = null;
    if (target === 'project') {
      // Each candidate under the limits the flag serves that box, not the refused one's.
      const candidates = await Promise.all((await userBoxReadings(user.id)).filter(b => b.id !== targetInstanceId).map(async b => {
        const row = await prisma.instance.findUnique({ where: { id: b.id }, select: { id: true, name: true, kind: true } });
        return { box: b, limits: await spawnLimitsFor(user, row) };
      }));
      other = suggestBox(candidates, targetInstanceId, Date.now());
    }
    const hint = other
      ? { box: { id: other.box.id, name: other.box.name, memUsedPct: other.box.memUsedPct, liveAgents: other.box.liveAgents, capacity: other.limits.boxCapacity } }
      : null;
    const next = other
      ? `; box ${other.box.name} has room: retry with boxId=${other.box.id}`
      : target === 'workstream'
        ? '; this project lives on that box: wait, stop a finished agent, or spawn a new project elsewhere (target: "project")'
        : '; none of your other boxes has room either: wait, or stop a finished agent';
    return { ok: false, result: { status: 409, body: { error: busy.error + next, code: busy.reason, reason: busy.reason, hint, budget } } };
  }
  return { ok: true, value: budget };
}

/**
 * Who is asking: a box's agent token (`instanceId`, null for a token with no
 * box) or a browser session (`undefined`, as req.agentInstanceId is then).
 */
export async function spawnFor(user: Express.User, callerInstanceId: string | null | undefined, raw: unknown): Promise<RouteResult> {
  // The box the child would run on, once the request names one: what the log files a refusal under.
  const seen: SpawnSeen = { targetInstanceId: null };
  const result = await spawnUnrecorded(user, callerInstanceId, raw, seen);
  // The log sees every request, so a refusal is countable whatever stopped it.
  const body = (result.body ?? {}) as { reason?: unknown; code?: unknown };
  const target = (raw as { target?: unknown } | null)?.target === 'project' ? 'project' : 'workstream';
  const instanceId = seen.targetInstanceId ?? callerInstanceId ?? null;
  await recordSpawnEvent({ kind: 'requested', userId: user.id, instanceId, detail: { target } });
  if (result.status >= 400) {
    const reason = typeof body.reason === 'string' ? body.reason : typeof body.code === 'string' ? body.code : `http_${result.status}`;
    await recordSpawnEvent({ kind: 'refused', userId: user.id, reason, instanceId, detail: { status: result.status, target } });
  }
  return result;
}

interface SpawnSeen {
  targetInstanceId: string | null;
}

async function spawnUnrecorded(user: Express.User, callerInstanceId: string | null | undefined, raw: unknown, seen: SpawnSeen): Promise<RouteResult> {
  const parsed = parseSpawnRequest(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error, code: 'invalid' } };
  const req = parsed.value;

  // An agent must say which pane it is, or the depth and per-parent limits
  // would have nothing to count. A person in the browser has no pane.
  const agentCaller = callerInstanceId !== undefined;
  if (agentCaller && !req.from) {
    return { status: 400, body: { error: 'from.session required: an agent spawns from its own pane (the metaterm MCP server sends it)', code: 'no_pane' } };
  }

  let caller: CallerSession | null = null;
  if (req.from) {
    const found = await resolveCaller(user, req.from.session, callerInstanceId);
    if (!found.ok) return found.result;
    caller = found.value;
  }
  if (agentCaller && caller?.role !== 'agent') {
    return { status: 400, body: { error: `only an agent pane can spawn (${req.from!.session} is a ${caller?.role ?? 'unknown'} pane)`, code: 'no_pane' } };
  }

  const provider = chooseSpawnProvider(req.provider, caller?.provider, user.defaultAgentProvider);
  if (!provider.ok) return { status: 400, body: { error: provider.error, code: 'invalid' } };

  const lineage = await lineageOf(user.id, caller);
  return req.target === 'project'
    ? spawnProject(user, callerInstanceId, req, caller, lineage, provider.value, seen)
    : spawnWorkstream(user, req, caller, lineage, provider.value, seen);
}

interface ChildPlan {
  /** Known up front for a workstream target; a project target's is set once the create returns. */
  projectId: string | null;
  projectName: string;
  workstream: string;
  branch: string | null;
  baseRef: string | null;
  instanceId: string | null;
  home: string;
  host: { userId: string; instanceId: string | null };
}

/** Write the row and the prompt file. The row exists before the child does, so the launch can claim it. */
async function recordAndWriteBrief(
  user: Express.User,
  req: SpawnRequest,
  caller: CallerSession | null,
  lineage: Lineage,
  provider: string,
  child: ChildPlan,
): Promise<Found<{ id: string }>> {
  const brief = buildBrief({
    relationship: req.relationship,
    parent: caller ? { session: caller.session, projectName: caller.projectName, workstream: caller.workstream } : null,
    child: { projectName: child.projectName, workstream: child.workstream, branch: child.branch, baseRef: child.baseRef },
    task: req.task,
    context: req.context,
    doneWhen: req.doneWhen,
  });
  const row = await prisma.agentSpawn.create({
    data: {
      userId: user.id,
      relationship: req.relationship,
      parentProjectId: caller?.projectId ?? null,
      parentWorkstream: caller?.workstream ?? null,
      parentRole: caller?.role ?? null,
      parentSession: caller?.session ?? null,
      parentInstanceId: caller?.instanceId ?? null,
      childProjectId: child.projectId,
      childProjectName: child.projectName,
      childWorkstream: child.workstream,
      childInstanceId: child.instanceId,
      // A commit id only: a branch name moves, and the retire check needs where it started.
      baseSha: child.baseRef && /^[0-9a-f]{7,40}$/.test(child.baseRef) ? child.baseRef : null,
      provider,
      title: taskTitle(req.task),
      brief,
      depth: lineage.depth + 1,
      rootSpawnId: lineage.rootSpawnId,
    },
    select: { id: true },
  });
  // A root is its own tree.
  if (!lineage.rootSpawnId) await prisma.agentSpawn.update({ where: { id: row.id }, data: { rootSpawnId: row.id } });
  // Its status history starts now, not at the sweep's next refresh: its first turn is often over by then.
  watchSpawnedSession({
    spawnId: row.id, userId: user.id, rootSpawnId: lineage.rootSpawnId ?? row.id, instanceId: child.instanceId,
    session: tmux.sessionName(user.unixUsername, child.projectName, 'agent', child.workstream),
  });
  await recordSpawnEvent({
    kind: 'created', spawnId: row.id, rootSpawnId: lineage.rootSpawnId ?? row.id, userId: user.id, instanceId: child.instanceId,
    parentProjectId: caller?.projectId ?? null, parentWorkstream: caller?.workstream ?? null,
    detail: { depth: lineage.depth + 1, provider, relationship: req.relationship, target: child.projectId ? 'workstream' : 'project' },
  });
  try {
    await sendForProject(child.host, 'write-file', { path: spawnPromptPath(child.home, row.id), content: brief, mode: 0o600 }, 5000);
  } catch (err) {
    await failSpawn(row.id, user.id, `could not write the brief: ${(err as Error).message}`);
    return { ok: false, result: { status: 503, body: { error: `Could not write the brief on the box: ${(err as Error).message}`, code: 'brief_write' } } };
  }
  return { ok: true, value: row };
}

async function failSpawn(id: string, userId: string, error: string, status?: number): Promise<void> {
  await prisma.agentSpawn.update({ where: { id }, data: { state: 'failed', error: error.slice(0, 1000) } }).catch(() => {});
  await recordSpawnEvent({ kind: 'failed', spawnId: id, userId, reason: status ? `http_${status}` : 'error' });
}

/** A shared handler's failure, tagged for the log unless it already says why. */
function withCode(result: RouteResult, code: string): RouteResult {
  const body = (result.body ?? {}) as Record<string, unknown>;
  return typeof body.code === 'string' ? result : { status: result.status, body: { ...body, code } };
}

function errorOf(result: RouteResult): string {
  const e = (result.body as { error?: unknown } | undefined)?.error;
  return typeof e === 'string' ? e : `HTTP ${result.status}`;
}

async function spawnWorkstream(
  user: Express.User,
  req: SpawnRequest,
  caller: CallerSession | null,
  lineage: Lineage,
  provider: string,
  seen: SpawnSeen,
): Promise<RouteResult> {
  const projectId = req.projectId ?? caller?.projectId;
  if (!projectId) return { status: 400, body: { error: 'projectId required when the call names no session of yours (from.session)', code: 'invalid' } };
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: user.id, archived: false },
    include: { workstreams: { select: { name: true } }, instance: { select: { hostHome: true, status: true } } },
  });
  if (!project) return { status: 404, body: { error: 'Project not found', code: 'not_found' } };
  if (!project.instanceId) return { status: 400, body: { error: 'Spawning needs a box project', code: 'invalid' } };
  seen.targetInstanceId = project.instanceId;
  // Parked before connected: a stopped box's agent is gone, and that is a 409, not a 503.
  const parked = project.instance ? powerStateError(project.instance.status) : null;
  if (parked) return { status: 409, body: { error: parked, code: 'parked' } };
  const host = { userId: user.id, instanceId: project.instanceId };
  if (!isProjectAgentConnected(host)) return { status: 503, body: { error: 'Box agent is not connected', code: 'box_offline' } };
  const admitted = await admit(user, caller, lineage, project.instanceId, 'workstream');
  if (!admitted.ok) return admitted.result;

  const name = req.name ?? uniqueName(slugFromTask(req.task), project.workstreams.map(w => w.name));
  // The caller's HEAD is a commit in this repository only when it works in this project.
  const baseRef = req.baseRef ?? (caller?.projectId === project.id ? req.from?.head : undefined) ?? null;
  const child: ChildPlan = {
    projectId: project.id,
    projectName: project.name,
    workstream: name,
    branch: name,
    baseRef,
    instanceId: project.instanceId,
    home: resolveProjectRoot({ ownerUnixUser: user.unixUsername, hostHome: project.instance?.hostHome }),
    host,
  };
  const row = await recordAndWriteBrief(user, req, caller, lineage, provider, child);
  if (!row.ok) return row.result;

  const result = await createWorkstreamFor(user, project.id, { name, baseRef: baseRef ?? undefined, provider, spawnId: row.value.id })
    .catch((err: Error): RouteResult => ({ status: 500, body: { error: err.message } }));
  if (result.status !== 201) {
    await failSpawn(row.value.id, user.id, errorOf(result), result.status);
    return withCode(result, 'create_failed');
  }
  const warnings = (result.body as { sessionLaunchWarnings?: string[] }).sessionLaunchWarnings ?? [];
  return created(user, row.value.id, project.id, project.name, name, project.instanceId, warnings, req, admitted.value);
}

async function spawnProject(
  user: Express.User,
  callerInstanceId: string | null | undefined,
  req: SpawnRequest,
  caller: CallerSession | null,
  lineage: Lineage,
  provider: string,
  seen: SpawnSeen,
): Promise<RouteResult> {
  const boxId = req.boxId ?? callerInstanceId ?? caller?.instanceId;
  if (!boxId) return { status: 400, body: { error: 'boxId required when the call comes from no box', code: 'invalid' } };
  const box = await prisma.instance.findFirst({ where: { id: boxId, userId: user.id }, select: { id: true, hostHome: true, status: true } });
  if (!box) return { status: 404, body: { error: 'Box not found', code: 'not_found' } };
  seen.targetInstanceId = box.id;
  // What createProjectFor checks too, with its codes, but the brief is written before it runs.
  if (box.status === 'failed') return { status: 409, body: { error: 'The box failed to launch', code: 'box-failed' } };
  if (box.status === 'terminated') return { status: 400, body: { error: 'cannot spawn onto a terminated box', code: 'box_terminated' } };
  const parked = powerStateError(box.status);
  if (parked) return { status: 409, body: { error: parked, code: 'parked' } };
  const host = { userId: user.id, instanceId: box.id };
  // The brief is written before the project exists, so the box must be up now.
  if (!isProjectAgentConnected(host)) return { status: 503, body: { error: 'Box agent is not connected', code: 'box_offline' } };
  const admitted = await admit(user, caller, lineage, box.id, 'project');
  if (!admitted.ok) return admitted.result;

  // Archived names too: createProjectFor would un-archive one rather than make a new project.
  const taken = await prisma.project.findMany({ where: { userId: user.id, instanceId: box.id }, select: { name: true } });
  if (req.name && taken.some(p => p.name.toLowerCase() === req.name!.toLowerCase())) {
    return { status: 409, body: { error: `a project named ${req.name} already exists on this box (it may be archived); pick another name`, code: 'name_taken' } };
  }
  const name = req.name ?? uniqueName(slugFromTask(req.task), taken.map(p => p.name));
  const child: ChildPlan = {
    projectId: null,
    projectName: name,
    workstream: 'main',
    branch: null,
    baseRef: null,
    instanceId: box.id,
    home: resolveProjectRoot({ ownerUnixUser: user.unixUsername, hostHome: box.hostHome }),
    host,
  };
  const row = await recordAndWriteBrief(user, req, caller, lineage, provider, child);
  if (!row.ok) return row.result;

  const result = await createProjectFor(user, {
    name, instanceId: box.id, initialAgent: { enabled: true, provider }, repoUrl: req.repoUrl ?? null, spawnId: row.value.id,
  });
  if (result.status !== 201) {
    await failSpawn(row.value.id, user.id, errorOf(result), result.status);
    return withCode(result, 'create_failed');
  }
  // createProjectFor linked the row (childProjectId) before its first launch.
  const projectId = (result.body as { id: string }).id;
  return created(user, row.value.id, projectId, name, 'main', box.id, [], req, admitted.value);
}

async function created(
  user: Express.User,
  spawnId: string,
  projectId: string,
  projectName: string,
  workstream: string,
  instanceId: string | null,
  warnings: string[],
  req: SpawnRequest,
  budget: Budget,
): Promise<RouteResult> {
  const row = await prisma.agentSpawn.findUnique({ where: { id: spawnId }, select: { launchedAt: true } });
  const launched = !!row?.launchedAt;
  const notes = [...warnings];
  // A repo project launches after its clone; anything else should have launched by now.
  if (!launched && !req.repoUrl) notes.push('the agent has not started on its brief yet (pane busy, or the box is still setting up)');
  const session = tmux.sessionName(user.unixUsername, projectName, 'agent', workstream);
  console.log(`[SPAWN] ${user.unixUsername} ${req.from?.session ?? '(no session)'} → ${session} (${req.relationship}, ${spawnId})${launched ? '' : ' not launched yet'}`);
  return {
    status: 201,
    body: {
      spawn: { id: spawnId, relationship: req.relationship, state: launched ? 'running' : 'starting' },
      project: { id: projectId, name: projectName },
      workstream,
      session,
      instanceId,
      launched,
      // As admitted, so counting this spawn: one more this hour and running,
      // with the near-limit hint for those counts.
      budget: rebudget(budget),
      ...(notes.length ? { warnings: notes } : {}),
    },
  };
}

type SpawnRow = Awaited<ReturnType<typeof prisma.agentSpawn.findMany>>[number];

function spawnView(user: Express.User, s: SpawnRow) {
  const childSession = tmux.sessionName(user.unixUsername, s.childProjectName, 'agent', s.childWorkstream);
  return {
    id: s.id,
    relationship: s.relationship,
    state: s.state,
    title: s.title,
    provider: s.provider,
    depth: s.depth,
    child: {
      projectId: s.childProjectId,
      projectName: s.childProjectName,
      workstream: s.childWorkstream,
      session: childSession,
      status: getStatus(childSession, s.childInstanceId).status,
    },
    parent: s.parentSession
      ? { projectId: s.parentProjectId, workstream: s.parentWorkstream, session: s.parentSession }
      : null,
    // Who takes its reports when its parent went away.
    // An orphan's foster went away too: it is shown as orphaned, not as adopted.
    foster: s.fosterProjectId && !s.orphanedAt
      ? { projectId: s.fosterProjectId, workstream: s.fosterWorkstream ?? 'main', by: s.adoptedBy, at: s.adoptedAt }
      : null,
    orphanedAt: s.orphanedAt,
    report: s.report,
    error: s.error,
    createdAt: s.createdAt,
    launchedAt: s.launchedAt,
    reportedAt: s.reportedAt,
    nudgedAt: s.nudgedAt,
    rootSpawnId: s.rootSpawnId,
    endedAt: s.endedAt,
    parkedAt: s.parkedAt,
    retiredAt: s.retiredAt,
    keptReason: s.keptReason,
    lifecycle: lifecycleLabel(s),
  };
}

/** With a session: its children and the spawn that made it. Without: the user's last week of spawns. */
export async function listSpawnsFor(user: Express.User, callerInstanceId: string | null | undefined, session: unknown): Promise<RouteResult> {
  if (typeof session === 'string' && session) {
    const found = await resolveCaller(user, session, callerInstanceId);
    if (!found.ok) return found.result;
    const c = found.value;
    const [children, parent, orphans] = await Promise.all([
      prisma.agentSpawn.findMany({
        // Its own children, less any fostered elsewhere, plus those it adopted.
        // Orphans are listed once, under orphans.
        where: {
          userId: user.id,
          orphanedAt: null,
          OR: [
            { parentProjectId: c.projectId, parentWorkstream: c.workstream, fosterProjectId: null },
            { fosterProjectId: c.projectId, fosterWorkstream: c.workstream },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.agentSpawn.findFirst({
        where: { userId: user.id, childProjectId: c.projectId, childWorkstream: c.workstream },
        orderBy: { createdAt: 'desc' },
      }),
      // The user's orphans nobody adopted, so an agent can take one (adopt_spawn).
      prisma.agentSpawn.findMany({ where: { userId: user.id, orphanedAt: { not: null }, retiredAt: null }, orderBy: { orphanedAt: 'desc' }, take: 20 }),
    ]);
    const lineage = await lineageOf(user.id, c);
    const budget = await buildBudget(user, { projectId: c.projectId, workstream: c.workstream }, lineage.depth, c.instanceId);
    return {
      status: 200,
      body: {
        session, children: children.map(s => spawnView(user, s)), spawnedBy: parent ? spawnView(user, parent) : null, budget,
        // Its own project and workstream: its children's stored parent session is stale after a rename.
        caller: { projectId: c.projectId, workstream: c.workstream },
        // Not their reports: those are for whoever adopts them.
        orphans: orphans.map(s => ({ ...spawnView(user, s), report: s.report ? { status: (s.report as { status?: unknown }).status } : null })),
      },
    };
  }
  const rows = await prisma.agentSpawn.findMany({
    where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 7 * 24 * HOUR_MS) } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return { status: 200, body: { children: rows.map(s => spawnView(user, s)), spawnedBy: null } };
}

/**
 * Park or retire one spawn early. The owner may, in
 * the browser; an agent token may only for its own children, from its own
 * agent pane. A retire still has to pass the check that nothing would be
 * lost; it just does not wait for the work to land.
 */
export async function dismissFor(user: Express.User, callerInstanceId: string | null | undefined, spawnId: string, raw: unknown): Promise<RouteResult> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as { action?: unknown; session?: unknown };
  const action = body.action;
  if (action !== 'park' && action !== 'retire') return { status: 400, body: { error: 'action must be park or retire', code: 'invalid' } };
  const s = await prisma.agentSpawn.findFirst({ where: { id: spawnId, userId: user.id } });
  if (!s) return { status: 404, body: { error: 'spawn not found', code: 'not_found' } };
  // Finished or parked only: a running child is working, and a blocked or
  // needs_input one is waiting on someone.
  if (s.state !== 'done' && !s.parkedAt) {
    return { status: 409, body: { error: `it is still ${s.state.replace(/_/g, ' ')}: dismiss a child once it has reported done`, code: 'not_finished' } };
  }
  let by: 'owner' | 'parent' = 'owner';
  if (callerInstanceId !== undefined) {
    if (typeof body.session !== 'string' || !body.session) return { status: 400, body: { error: 'session required: an agent dismisses from its own pane', code: 'no_pane' } };
    const found = await resolveCaller(user, body.session, callerInstanceId);
    if (!found.ok) return found.result;
    const c = found.value;
    // Its foster, once one adopted it, in place of the original parent.
    const to = effectiveParent(s);
    if (c.role !== 'agent' || !to || c.projectId !== to.projectId || c.workstream !== to.workstream) {
      return { status: 403, body: { error: 'only the agent it reports to (or its owner) can dismiss it', code: 'not_parent' } };
    }
    by = 'parent';
  }
  if (action === 'park') {
    const r = await parkSpawn(s, by);
    return r.ok ? { status: 200, body: { ok: true, spawn: s.id, lifecycle: 'parked', note: r.detail ?? 'its agent CLI is stopped; the worktree and conversation are kept' } } : { status: r.status, body: { error: r.error } };
  }
  const r = await retireSpawn(s, by, await checkoutCheck(s));
  return r.ok ? { status: 200, body: { ok: true, spawn: s.id, lifecycle: 'retired', note: r.detail ?? 'its workstream is removed; anything pushed stays on origin' } } : { status: r.status, body: { error: r.error, code: r.status === 409 ? 'kept' : undefined } };
}

/** Bring a parked spawn back on its conversation. Owner only, in the browser. */
export async function resumeFor(user: Express.User, callerInstanceId: string | null | undefined, spawnId: string): Promise<RouteResult> {
  if (callerInstanceId !== undefined) return { status: 403, body: { error: 'resume is the owner\'s, from the dashboard', code: 'forbidden' } };
  const s = await prisma.agentSpawn.findFirst({ where: { id: spawnId, userId: user.id } });
  if (!s) return { status: 404, body: { error: 'spawn not found', code: 'not_found' } };
  const r = await resumeSpawn(s);
  return r.ok ? { status: 200, body: { ok: true, spawn: s.id, note: r.detail ?? 'started again on its conversation' } } : { status: r.status, body: { error: r.error } };
}

/**
 * Take a spawn as its foster parent. An
 * agent token, from its own agent pane, may take an orphan nobody adopted;
 * the owner, in the browser, may move any unretired spawn to one of their
 * own sessions ({projectId, workstream}).
 */
export async function adoptFor(user: Express.User, callerInstanceId: string | null | undefined, spawnId: string, raw: unknown): Promise<RouteResult> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as { session?: unknown; projectId?: unknown; workstream?: unknown };
  const s = await prisma.agentSpawn.findFirst({ where: { id: spawnId, userId: user.id } });
  if (!s) return { status: 404, body: { error: 'spawn not found', code: 'not_found' } };
  if (s.retiredAt) return { status: 409, body: { error: 'it is retired: nothing left to adopt', code: 'retired' } };
  let to: { projectId: string; workstream: string; label: string };
  let by: 'agent' | 'owner';
  if (callerInstanceId !== undefined) {
    if (typeof body.session !== 'string' || !body.session) return { status: 400, body: { error: 'session required: an agent adopts from its own pane', code: 'no_pane' } };
    const found = await resolveCaller(user, body.session, callerInstanceId);
    if (!found.ok) return found.result;
    const c = found.value;
    if (c.role !== 'agent') return { status: 403, body: { error: 'only an agent pane can adopt', code: 'not_agent' } };
    if (!s.orphanedAt) return { status: 409, body: { error: 'it is not an orphan: its parent (or a foster) still takes its reports', code: 'not_orphan' } };
    to = { projectId: c.projectId, workstream: c.workstream, label: c.session };
    by = 'agent';
  } else {
    const target = await ownSession(user, body.projectId, body.workstream);
    if (!target.ok) return target.result;
    to = target.value;
    by = 'owner';
  }
  if (to.projectId === s.childProjectId && to.workstream === s.childWorkstream) {
    return { status: 400, body: { error: 'a spawn cannot adopt itself', code: 'invalid' } };
  }
  const r = await adoptSpawn(s, { projectId: to.projectId, workstream: to.workstream, role: 'agent' }, by);
  if (!r.ok) return { status: 409, body: { error: 'it changed hands meanwhile: list it again', code: 'conflict' } };
  return { status: 200, body: { ok: true, spawn: s.id, foster: to.label, note: s.reportedAt && !s.nudgedAt ? 'its unread report is announced to the foster when that pane is next idle' : 'its reports now come to the foster' } };
}

/** One of the user's own live sessions, by project and workstream ('main' by default). */
async function ownSession(user: Express.User, projectId: unknown, workstream: unknown): Promise<Found<{ projectId: string; workstream: string; label: string }>> {
  if (typeof projectId !== 'string' || !projectId) return { ok: false, result: { status: 400, body: { error: 'projectId required', code: 'invalid' } } };
  const ws = typeof workstream === 'string' && workstream ? workstream : 'main';
  const p = await prisma.project.findFirst({
    where: { id: projectId, userId: user.id, archived: false },
    select: { id: true, name: true, workstreams: { where: { name: ws, archived: false }, select: { name: true } } },
  });
  if (!p) return { ok: false, result: { status: 404, body: { error: 'project not found', code: 'not_found' } } };
  if (ws !== 'main' && !p.workstreams.length) return { ok: false, result: { status: 404, body: { error: `no workstream ${ws} in ${p.name}`, code: 'not_found' } } };
  return { ok: true, value: { projectId: p.id, workstream: ws, label: ws === 'main' ? p.name : `${p.name}/${ws}` } };
}

/** Set or clear the orphan home: {projectId, workstream} or {projectId: null}. Owner only. */
export async function orphanHomeFor(user: Express.User, callerInstanceId: string | null | undefined, raw: unknown): Promise<RouteResult> {
  if (callerInstanceId !== undefined) return { status: 403, body: { error: 'the orphan home is the owner\'s setting, in the browser', code: 'forbidden' } };
  const body = (raw && typeof raw === 'object' ? raw : {}) as { projectId?: unknown; workstream?: unknown };
  if (body.projectId === null) {
    await prisma.user.update({ where: { id: user.id }, data: { spawnOrphanHome: Prisma.DbNull } });
    return { status: 200, body: { ok: true, orphanHome: null } };
  }
  const target = await ownSession(user, body.projectId, body.workstream);
  if (!target.ok) return target.result;
  const home = { projectId: target.value.projectId, workstream: target.value.workstream };
  await prisma.user.update({ where: { id: user.id }, data: { spawnOrphanHome: home } });
  return { status: 200, body: { ok: true, orphanHome: { ...home, label: target.value.label } } };
}

/** The caller's limits, usage and hints: spawn_budget, and the dashboard later. */
const USAGE_DAYS = 7;
const MAX_TREES = 20;
const SAMPLE_HOURS = 24;

/**
 * The dashboard's Agents section: the
 * user's budget and hints, their spawn trees of the last week plus any older
 * one still running, with tokens per node, refusals by reason, and each ready
 * box's load over the last day. Owner only; no brief text (the report is the
 * owner's own agents' words, shown to the owner).
 */
export async function usageFor(user: Express.User): Promise<RouteResult> {
  const now = Date.now();
  const since = new Date(now - USAGE_DAYS * 24 * HOUR_MS);
  const [recent, running, refusals, boxRows, budget, orphanRows, homeRow, projects] = await Promise.all([
    prisma.agentSpawn.findMany({ where: { userId: user.id, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 300 }),
    // A still-running tree shows however old it is: its own query, so a busy
    // week of newer spawns cannot crowd it out.
    prisma.agentSpawn.findMany({ where: { userId: user.id, endedAt: null, state: { not: 'failed' } }, orderBy: { createdAt: 'desc' }, take: 300 }),
    prisma.spawnEvent.groupBy({ by: ['reason'], where: { userId: user.id, kind: 'refused', at: { gte: since } }, _count: { _all: true } }),
    prisma.instance.findMany({ where: { userId: user.id, status: 'ready' }, select: BOX_SELECT, orderBy: { name: 'asc' } }),
    buildBudget(user, null, 0, null, now),
    // Orphans nobody adopted, however old: they wait here for someone.
    prisma.agentSpawn.findMany({ where: { userId: user.id, orphanedAt: { not: null }, retiredAt: null }, orderBy: { orphanedAt: 'desc' }, take: 50 }),
    prisma.user.findUnique({ where: { id: user.id }, select: { spawnOrphanHome: true } }),
    // The sessions an orphan can be adopted into, and the orphan home picked from.
    prisma.project.findMany({
      where: { userId: user.id, archived: false },
      select: { id: true, name: true, workstreams: { where: { archived: false }, select: { name: true }, orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' },
      take: 200,
    }),
  ]);
  const sessions = projects.flatMap(p => [
    { projectId: p.id, workstream: 'main', label: p.name },
    ...p.workstreams.filter(w => w.name !== 'main').map(w => ({ projectId: p.id, workstream: w.name, label: `${p.name}/${w.name}` })),
  ]);
  const home = parseOrphanHome(homeRow?.spawnOrphanHome);
  const homeLabel = home ? sessions.find(x => x.projectId === home.projectId && x.workstream === home.workstream)?.label ?? null : null;

  const rows = [...new Map([...recent, ...running].map(r => [r.id, r])).values()];
  const childProjects = [...new Set(rows.map(r => r.childProjectId).filter((id): id is string => !!id))];
  const oldest = rows.reduce((d, r) => (r.createdAt < d ? r.createdAt : d), new Date(now));
  const tokenRows = childProjects.length
    ? await prisma.tokenUsageDay.findMany({
      where: { userId: user.id, projectId: { in: childProjects }, date: { gte: oldest.toISOString().slice(0, 10) }, estimated: false },
      select: { projectId: true, workstream: true, date: true, input: true, output: true, cacheRead: true, cacheCreate: true, reasoning: true },
    })
    : [];
  const tokens = tokensBySpawn(rows, tokenRows);
  const allTrees = buildSpawnTrees(rows);
  // The sessions that started the trees, archived projects included (the sessions list above leaves those out).
  const originIds = [...new Set(allTrees.slice(0, MAX_TREES).map(t => t.nodes[0]?.spawn.parentProjectId).filter((id): id is string => !!id))];
  const originProjects = originIds.length
    ? await prisma.project.findMany({ where: { id: { in: originIds }, userId: user.id }, select: { id: true, name: true } })
    : [];
  const projectName = new Map([...projects, ...originProjects].map(p => [p.id, p.name]));
  const trees = allTrees.slice(0, MAX_TREES).map(t => {
    // The tree's real root only: a root older than the window is not fetched, and the oldest
    // node then is a mid-tree agent whose parent is a spawned session, not the one that started it.
    const first = t.nodes[0]?.spawn;
    const root = first && first.id === t.rootId ? first : null;
    return {
      rootId: t.rootId,
      createdAt: t.createdAt,
      // The session that started it, for the dashboard's parent row; null when it came from the browser.
      origin: root?.parentProjectId && root.parentSession
        ? {
          projectId: root.parentProjectId,
          workstream: root.parentWorkstream ?? 'main',
          session: root.parentSession,
          label: (() => {
            const name = projectName.get(root.parentProjectId);
            if (!name) return root.parentSession;
            return root.parentWorkstream && root.parentWorkstream !== 'main' ? `${name}/${root.parentWorkstream}` : name;
          })(),
        }
        : null,
      nodes: t.nodes.map(n => ({ level: n.level, parentId: n.parentId, ...spawnView(user, n.spawn), tokens: tokens.get(n.spawn.id) ?? null })),
    };
  });

  const boxReadings = await readings(boxRows);
  const samples = boxRows.length
    ? await prisma.hostSample.findMany({
      where: { instanceId: { in: boxRows.map(b => b.id) }, at: { gte: new Date(now - SAMPLE_HOURS * HOUR_MS) } },
      orderBy: { at: 'asc' },
      select: { instanceId: true, at: true, memUsedPct: true, load1: true, cores: true, liveAgents: true },
    })
    : [];
  // The user-level budget has no box, so each ready box adds its own hints,
  // in box order (flattened below, so they don't reshuffle between polls).
  const boxResults = await Promise.all(boxReadings.map(async b => {
    const row = boxRows.find(r => r.id === b.id)!;
    const limits = await spawnLimitsFor(user, { id: row.id, name: row.name, kind: row.kind });
    const heat = boxHeat(b, limits, now);
    return { hints: boxHints(b, limits, now), box: {
      id: b.id,
      name: b.name,
      memUsedPct: b.memUsedPct,
      diskUsedPct: b.diskUsedPct,
      loadPerCore: b.load1 !== null && b.cores ? Math.round((b.load1 / b.cores) * 100) / 100 : null,
      liveAgents: b.liveAgents,
      capacity: limits.boxCapacity,
      // This box's own threshold: the flag is read per box, so it can differ from the user-level one.
      hotMemPct: limits.hot.memPct,
      sampledAt: b.sampledAt,
      heat: heat.unknown ? 'unknown' : heat.hot.length ? 'hot' : heat.warm.length ? 'warm' : 'ok',
      heatReasons: [...heat.hot, ...heat.warm],
      samples: samples.filter(s => s.instanceId === b.id).map(s => ({
        at: s.at, memUsedPct: s.memUsedPct, liveAgents: s.liveAgents,
        loadPerCore: s.load1 !== null && s.cores ? Math.round((s.load1 / s.cores) * 100) / 100 : null,
      })),
    } };
  }));
  const boxes = boxResults.map(r => r.box);
  const boxHintList = boxResults.flatMap(r => r.hints);

  return {
    status: 200,
    body: {
      budget: { ...budget, hints: [...boxHintList, ...budget.hints] },
      trees,
      treesTotal: allTrees.length,
      refusals: refusals
        .map(r => ({ reason: r.reason ?? 'unknown', count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      boxes,
      days: USAGE_DAYS,
      orphans: orphanRows.map(s => spawnView(user, s)),
      // A home whose session is gone shows as unset-but-stored (label null), so it can be changed.
      orphanHome: home ? { ...home, label: homeLabel } : null,
      sessions,
    },
  };
}

export async function budgetFor(user: Express.User, callerInstanceId: string | null | undefined, session: unknown): Promise<RouteResult> {
  if (typeof session === 'string' && session) {
    const found = await resolveCaller(user, session, callerInstanceId);
    if (!found.ok) return found.result;
    const c = found.value;
    const lineage = await lineageOf(user.id, c);
    return { status: 200, body: await buildBudget(user, { projectId: c.projectId, workstream: c.workstream }, lineage.depth, c.instanceId) };
  }
  return { status: 200, body: await buildBudget(user, null, 0, callerInstanceId ?? null) };
}

/**
 * Which session started each of the user's children that still has its
 * workstream: the simple UI's explorer nests a child under its starter. The
 * original parent, not a foster one: the tree is where it came from.
 */
export async function parentsFor(user: Express.User): Promise<RouteResult> {
  const rows = await prisma.agentSpawn.findMany({
    where: { userId: user.id, retiredAt: null, childProjectId: { not: null }, parentProjectId: { not: null }, parentWorkstream: { not: null } },
    select: { childProjectId: true, childWorkstream: true, parentProjectId: true, parentWorkstream: true },
    orderBy: { createdAt: 'desc' },
    // Before the cap, so a child's respawns can't crowd older children out.
    distinct: ['childProjectId', 'childWorkstream'],
    take: 1000,
  });
  const seen = new Set<string>();
  const links = [];
  for (const r of rows) {
    const key = `${r.childProjectId}|${r.childWorkstream}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ projectId: r.childProjectId!, workstream: r.childWorkstream, parentProjectId: r.parentProjectId!, parentWorkstream: r.parentWorkstream! });
  }
  return { status: 200, body: { links } };
}

/** A spawned agent says where it stands. The latest report wins. */
export async function reportFor(user: Express.User, callerInstanceId: string | null | undefined, raw: unknown): Promise<RouteResult> {
  const parsed = parseReport(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const r = parsed.value;
  const found = await resolveCaller(user, r.session, callerInstanceId);
  if (!found.ok) return found.result;
  const c = found.value;
  const spawn = await prisma.agentSpawn.findFirst({
    where: { userId: user.id, childProjectId: c.projectId, childWorkstream: c.workstream, state: { not: 'failed' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, parentSession: true, relationship: true, provider: true, createdAt: true, reportedAt: true, rootSpawnId: true, fosterProjectId: true, fosterWorkstream: true, orphanedAt: true },
  });
  if (!spawn) return { status: 404, body: { error: 'this session was not started by an agent spawn, so there is no one to report to' } };
  const now = new Date();
  await prisma.agentSpawn.update({
    where: { id: spawn.id },
    data: {
      state: r.status,
      report: { status: r.status, summary: r.summary, ...(r.refs ? { refs: r.refs } : {}), at: now.toISOString() },
      reportedAt: now,
      // A new report is a new notice: the nudge sweep picks up rows not yet nudged.
      nudgedAt: null,
    },
  });
  console.log(`[SPAWN] ${r.session} reported ${r.status} to ${spawn.parentSession ?? '(no parent session)'} (${spawn.id})`);
  await recordSpawnEvent({
    kind: 'reported', spawnId: spawn.id, rootSpawnId: spawn.rootSpawnId, userId: user.id, reason: r.status, instanceId: c.instanceId,
    detail: {
      provider: spawn.provider, relationship: spawn.relationship, first: !spawn.reportedAt,
      secondsSinceCreated: Math.round((now.getTime() - spawn.createdAt.getTime()) / 1000),
    },
  });
  const nudge = spawn.orphanedAt
    ? 'your parent is gone and nobody has adopted you yet: the owner sees this report on the dashboard'
    : spawn.relationship === 'delegate' && spawn.fosterProjectId
      ? 'your parent is gone; the agent that adopted you is told when its pane is next idle'
      : spawn.relationship === 'delegate' && spawn.parentSession
        ? 'the parent agent is told when its pane is next idle'
        : 'the parent can read it with list_spawns';
  return { status: 200, body: { ok: true, spawn: spawn.id, state: r.status, note: nudge } };
}

const TREE_EVENTS = 5000;
const TREE_NODES = 500;

/**
 * One spawn tree for the network view: its nodes with their live pane status and tokens, the session that
 * started its root (the origin), the tree's events oldest first (ids, kinds
 * and reasons: never report or pane text), and its totals. The owner's own
 * trees only; the page polls it.
 */
export async function treeFor(user: Express.User, rootId: string, now: number = Date.now()): Promise<RouteResult> {
  const rows = await prisma.agentSpawn.findMany({
    where: { userId: user.id, OR: [{ rootSpawnId: rootId }, { id: rootId }] },
    orderBy: { createdAt: 'asc' },
    take: TREE_NODES + 1,
  });
  const nodesTruncated = rows.length > TREE_NODES;
  if (nodesTruncated) rows.length = TREE_NODES;
  const trees = buildSpawnTrees(rows.map(r => ({ ...r, rootSpawnId: r.rootSpawnId ?? r.id })).filter(r => r.rootSpawnId === rootId));
  if (!trees.length) return { status: 404, body: { error: 'spawn tree not found', code: 'not_found' } };
  return { status: 200, body: await treeView(user, { scope: 'tree', rootId, trees, rows, nodesTruncated }, now) };
}

/** How far back a session's view reaches, besides any tree still running. */
const SESSION_DAYS = 7;
const SESSION_ROOTS = 50;

/**
 * Every tree one session started: a person's own session, or any other that spawned roots, as the
 * origin with its trees beneath it, oldest first. The last week's, plus any
 * still running. The owner's own sessions only.
 */
export async function sessionTreeFor(user: Express.User, projectId: string, workstream: string, now: number = Date.now()): Promise<RouteResult> {
  const since = new Date(now - SESSION_DAYS * 24 * HOUR_MS);
  const roots = await prisma.agentSpawn.findMany({
    where: {
      userId: user.id, parentProjectId: projectId, parentWorkstream: workstream, depth: 1,
      OR: [{ createdAt: { gte: since } }, { endedAt: null, retiredAt: null, state: { not: 'failed' } }],
    },
    orderBy: { createdAt: 'desc' },
    take: SESSION_ROOTS + 1,
    select: { id: true },
  });
  if (!roots.length) return { status: 404, body: { error: 'no spawn trees from that session', code: 'not_found' } };
  // Whole trees, newest first, up to the node cap: a session's view is about its recent work,
  // and a tree cut in half would lose its root (and with it the origin and its edges). The
  // newest tree always fits; one bigger than the cap keeps its oldest, from its root down.
  const candidates = roots.slice(0, SESSION_ROOTS).map(r => r.id);
  const sizes = new Map((await prisma.agentSpawn.groupBy({
    by: ['rootSpawnId'], where: { userId: user.id, rootSpawnId: { in: candidates } }, _count: { _all: true },
  })).map(g => [g.rootSpawnId, g._count._all]));
  const rootIds: string[] = [];
  let total = 0;
  for (const id of candidates) {
    const n = Math.max(1, sizes.get(id) ?? 1);
    if (rootIds.length && total + n > TREE_NODES) break;
    rootIds.push(id);
    total += n;
  }
  // The page says when it holds only the newest trees: more than the 50, or older ones left out.
  const rootsTruncated = roots.length > SESSION_ROOTS || rootIds.length < candidates.length;
  const rows = await prisma.agentSpawn.findMany({
    where: { userId: user.id, OR: [{ rootSpawnId: { in: rootIds } }, { id: { in: rootIds } }] },
    orderBy: { createdAt: 'asc' },
    take: TREE_NODES + 1,
  });
  const nodesTruncated = rows.length > TREE_NODES;
  if (nodesTruncated) rows.length = TREE_NODES;
  const wanted = new Set(rootIds);
  // Oldest tree first, so a new tree adds rows at the bottom instead of reshuffling.
  const trees = buildSpawnTrees(rows.map(r => ({ ...r, rootSpawnId: r.rootSpawnId ?? r.id })).filter(r => wanted.has(r.rootSpawnId)))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (!trees.length) return { status: 404, body: { error: 'no spawn trees from that session', code: 'not_found' } };
  const body = await treeView(user, { scope: 'session', rootId: `session:${projectId}:${workstream}`, trees, rows, nodesTruncated, newestEvents: true }, now);
  return { status: 200, body: { ...body, rootsTruncated } };
}

type TreeRows = Awaited<ReturnType<typeof prisma.agentSpawn.findMany>>;

/** One or more trees, with the session that started them, their events, fosters and totals, for the network view. */
async function treeView(
  user: Express.User,
  t: {
    scope: 'tree' | 'session'; rootId: string; trees: ReturnType<typeof buildSpawnTrees<TreeRows[number]>>; rows: TreeRows; nodesTruncated: boolean;
    /** Keep the newest events when there are too many (a session's view), not the oldest (one tree's, from its start). */
    newestEvents?: boolean;
  },
  now: number,
) {
  const nodes = t.trees.flatMap(tree => tree.nodes);
  const ids = nodes.map(n => n.spawn.id);
  const childProjects = [...new Set(t.rows.map(r => r.childProjectId).filter((id): id is string => !!id))];
  const root = t.trees[0].nodes[0].spawn;
  const first = t.trees.reduce((d, tree) => (tree.createdAt < d ? tree.createdAt : d), root.createdAt);
  const [tokenRows, events, originProject] = await Promise.all([
    childProjects.length
      ? prisma.tokenUsageDay.findMany({
        where: { userId: user.id, projectId: { in: childProjects }, date: { gte: first.toISOString().slice(0, 10) }, estimated: false },
        select: { projectId: true, workstream: true, date: true, input: true, output: true, cacheRead: true, cacheCreate: true, reasoning: true },
      })
      : [],
    prisma.spawnEvent.findMany({
      where: { userId: user.id, spawnId: { in: ids } },
      // An adoption's foster is in its parent fields, so replay can draw the edge from then on.
      select: { spawnId: true, kind: true, reason: true, at: true, parentProjectId: true, parentWorkstream: true },
      orderBy: { at: t.newestEvents ? 'desc' : 'asc' },
      take: TREE_EVENTS + 1,
    }).then(es => (t.newestEvents ? es.reverse() : es)),
    root.parentProjectId
      ? prisma.project.findFirst({ where: { id: root.parentProjectId, userId: user.id }, select: { name: true, instanceId: true, user: { select: { unixUsername: true } } } })
      : null,
  ]);
  const tokens = tokensBySpawn(t.rows, tokenRows);
  // Fosters outside the tree (an orphan home, a session the owner picked), named on their nodes.
  const fosterIds = [...new Set(nodes.map(n => n.spawn.fosterProjectId).filter((id): id is string => !!id))];
  const fosterProjects = fosterIds.length
    ? await prisma.project.findMany({ where: { id: { in: fosterIds }, userId: user.id }, select: { id: true, name: true } })
    : [];
  const fosters = nodes.flatMap(n => {
    const p = n.spawn.fosterProjectId ? fosterProjects.find(x => x.id === n.spawn.fosterProjectId) : undefined;
    const ws = n.spawn.fosterWorkstream ?? 'main';
    return p ? [{ projectId: p.id, workstream: ws, label: ws === 'main' ? p.name : `${p.name}/${ws}` }] : [];
  });
  // Rebuilt from the project's name now, so a renamed session still reads its live status.
  const originSession = root.parentSession && originProject
    ? tmux.sessionName(originProject.user.unixUsername, originProject.name, (root.parentRole ?? 'agent') as Parameters<typeof tmux.sessionName>[2], root.parentWorkstream ?? 'main')
    : root.parentSession;
  const origin = root.parentSession && originSession
    ? {
      projectId: root.parentProjectId,
      workstream: root.parentWorkstream ?? 'main',
      session: originSession,
      label: originProject ? (root.parentWorkstream && root.parentWorkstream !== 'main' ? `${originProject.name}/${root.parentWorkstream}` : originProject.name) : root.parentSession,
      status: getStatus(originSession, originProject?.instanceId ?? null).status,
    }
    : null;
  return {
    scope: t.scope,
    rootId: t.rootId,
    // Each tree's root, oldest first: the origin's own children.
    rootIds: t.trees.map(tree => tree.rootId),
    createdAt: first,
    origin,
    nodes: nodes.map(n => ({ level: n.level, parentId: n.parentId, ...spawnView(user, n.spawn), tokens: tokens.get(n.spawn.id) ?? null })),
    // Oldest first either way; the cap drops the newest for one tree, the oldest for a session.
    events: t.newestEvents ? events.slice(-TREE_EVENTS) : events.slice(0, TREE_EVENTS),
    eventsTruncated: events.length > TREE_EVENTS,
    eventsLimit: TREE_EVENTS,
    // The oldest TREE_NODES only: the totals count those.
    nodesTruncated: t.nodesTruncated,
    fosters,
    totals: treeTotals(nodes.map(n => n.spawn), tokens, now),
    at: new Date(now),
  };
}

export function spawnsRouter(): Router {
  const router = Router();
  router.post('/spawns', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await spawnFor(req.user!, req.agentInstanceId, req.body));
  }));
  router.get('/spawns', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await listSpawnsFor(req.user!, req.agentInstanceId, req.query.session));
  }));
  router.get('/spawns/usage', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await usageFor(req.user!));
  }));
  router.get('/spawns/parents', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await parentsFor(req.user!));
  }));
  router.get('/spawns/trees/:rootId', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await treeFor(req.user!, req.params.rootId));
  }));
  router.get('/spawns/sessions/:projectId/:workstream/trees', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await sessionTreeFor(req.user!, req.params.projectId, req.params.workstream));
  }));
  router.post('/spawns/:id/dismiss', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await dismissFor(req.user!, req.agentInstanceId, req.params.id, req.body));
  }));
  router.post('/spawns/:id/resume', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await resumeFor(req.user!, req.agentInstanceId, req.params.id));
  }));
  router.post('/spawns/:id/adopt', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await adoptFor(req.user!, req.agentInstanceId, req.params.id, req.body));
  }));
  router.put('/spawns/orphan-home', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await orphanHomeFor(req.user!, req.agentInstanceId, req.body));
  }));
  router.get('/spawns/budget', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await budgetFor(req.user!, req.agentInstanceId, req.query.session));
  }));
  router.post('/spawns/report', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await reportFor(req.user!, req.agentInstanceId, req.body));
  }));
  return router;
}
