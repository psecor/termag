/**
 * Agent handoff routes: hand an agent pane off — the
 * agent writes a handoff, its context is cleared or compacted in place or the
 * pane restarts (optionally on another provider), and the next agent starts
 * on the handoff. The routes record the request; the handoff sweep
 * (services/agentHandoffSweep.ts) does the rest when the pane is idle.
 *
 *   POST /api/projects/:projectId/workstreams/:id/handoff   a person (web, mobile)
 *   POST /api/handoffs                    an agent hands its own pane off (MetaTerm `handoff`)
 *   POST /api/handoffs/:id/written        the agent's handoff (MetaTerm `handoff_written`)
 *   GET  /api/handoffs/:id                one, with its body
 *   GET  /api/handoffs?projectId=&workstream=   the last few for a workstream
 *   POST /api/handoffs/:id/abort          before the pane has been touched
 *
 * Owner only, like Switch agent: a collaborator cannot reset someone else's
 * agent. Behind the agent-handoff-enabled flag (off unless TERMAG_FLAGS turns it
 * on), read for the owner and the box.
 */
import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requireAuthOrAgentToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { refuseParkedBox } from '../middleware/parkedBox';
import { refuseUnreadySetup } from '../middleware/unreadySetup';
import {
  ABORTABLE_HANDOFF_STATES,
  HANDOFF_FLAG,
  HANDOFF_SURFACES,
  OPEN_HANDOFF_STATES,
  buildHandoffPrompt,
  canHandOffFrom,
  canRestartInto,
  handoffPromptPath,
  parseHandoffRequest,
  parseWritten,
  planMode,
  type HandoffInitiator,
  type HandoffRequest,
  type HandoffSurface,
} from '../services/agentHandoff';
import { publishHandoff } from '../services/agentHandoffSweep';
import { isProjectAgentConnected, sendForProject } from '../services/agentRegistry';
import { resolveAgentProvider } from '../services/agentRuntime';
import { findSecretsInText } from '../services/askPublish';
import { powerStateError } from '../services/boxPowerPolicy';
import { boolVariation } from '../services/featureFlags';
import { resolveProjectRoot } from '../services/projectPaths';
import { getStatus } from '../services/status';
import * as tmux from '../services/tmux';
import { PROVIDERS } from '../providers/registry';
import { RouteResult, sendResult } from './routeResult';
import { resolveCaller } from './spawns';

type HandoffRow = NonNullable<Awaited<ReturnType<typeof prisma.agentHandoff.findUnique>>>;

function handoffView(r: HandoffRow, withBody = false) {
  return {
    id: r.id,
    projectId: r.projectId,
    workstream: r.workstream,
    session: r.session,
    mode: r.mode,
    requestedMode: r.requestedMode,
    fromProvider: r.fromProvider,
    toProvider: r.toProvider,
    initiator: r.initiator,
    surface: r.surface,
    state: r.state,
    reason: r.reason,
    note: r.note,
    hasBody: !!r.body,
    ...(withBody ? { body: r.body } : {}),
    createdAt: r.createdAt,
    writtenAt: r.writtenAt,
    resetAt: r.resetAt,
    launchedAt: r.launchedAt,
    doneAt: r.doneAt,
  };
}

/** The refusal for a handoff whose text carries something secret-shaped, or null. */
function secretRefusal(body: string): RouteResult | null {
  const found = findSecretsInText(body);
  if (!found.length) return null;
  return { status: 422, body: { error: `the handoff contains what looks like a secret (${found.join(', ')}); rewrite it without the value and try again`, code: 'handoff_secret' } };
}

interface Target {
  projectId: string;
  workstream: string;
}

/** Write the prompt file the next agent reads, on the project's box. */
async function writePromptFile(row: HandoffRow, body: string, project: { name: string; instanceId: string | null; hostHome: string | null }, unixUsername: string): Promise<void> {
  const content = buildHandoffPrompt({
    id: row.id,
    projectName: project.name,
    workstream: row.workstream,
    fromProvider: row.fromProvider,
    toProvider: row.toProvider ?? row.fromProvider,
    createdAt: row.createdAt,
    note: row.note,
    body,
  });
  const home = resolveProjectRoot({ ownerUnixUser: unixUsername, hostHome: project.hostHome });
  await sendForProject({ userId: row.userId, instanceId: project.instanceId }, 'write-file', { path: handoffPromptPath(home, row.id), content, mode: 0o600 }, 5000);
}

/** Record a handoff of one workstream's agent pane. The sweep acts on it. */
export async function startHandoff(
  user: Express.User,
  target: Target,
  req: HandoffRequest,
  who: { initiator: HandoffInitiator; surface: HandoffSurface },
): Promise<RouteResult> {
  const project = await prisma.project.findFirst({
    where: { id: target.projectId, userId: user.id, archived: false },
    include: {
      instance: { select: { id: true, name: true, kind: true, hostHome: true, status: true } },
      workstreams: { where: { name: target.workstream }, include: { workflows: { select: { type: true, provider: true } } } },
    },
  });
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  if (project.kind === 'metaterm') return { status: 400, body: { error: 'MetaTerm cannot be handed off' } };
  if (!project.instanceId || !project.instance) return { status: 400, body: { error: 'Handing off needs a box project' } };
  if (!(await boolVariation(HANDOFF_FLAG, user, false, project.instance))) {
    return { status: 403, body: { error: `agent handoff is not enabled for you on this box (feature flag ${HANDOFF_FLAG})`, code: 'handoff_disabled' } };
  }
  const parked = powerStateError(project.instance.status);
  if (parked) return { status: 409, body: { error: parked } };
  const ws = project.workstreams[0];
  if (!ws) return { status: 404, body: { error: 'Workstream not found' } };
  const wf = ws.workflows.find(w => w.type === 'agent');
  if (!wf) return { status: 400, body: { error: 'This workstream has no agent' } };

  const from = resolveAgentProvider(wf.provider, user.defaultAgentProvider);
  if (!canHandOffFrom(from)) {
    return { status: 400, body: { error: `${PROVIDERS[from]?.displayName ?? from} cannot be handed off from termag: it has no way to write its handoff (the metaterm tools reach Claude Code and pi only). Switch agent restarts it without one.` } };
  }
  if (req.provider && !canRestartInto(req.provider)) {
    return { status: 400, body: { error: 'Choose one of the offered agents' } };
  }
  const plan = planMode(req.mode, from, req.provider);
  // Only a real switch is recorded: no provider means whatever the pane runs
  // when the restart happens (a Switch agent in between must not be undone).
  const toProvider = plan.mode === 'restart' && req.provider && req.provider !== from ? req.provider : null;

  const host = { userId: user.id, instanceId: project.instanceId };
  if (!isProjectAgentConnected(host)) return { status: 503, body: { error: 'Box agent is not connected' } };

  // The note lands in the prompt file beside the body, so both are scanned.
  const refusal = secretRefusal([req.body, req.note].filter(Boolean).join('\n'));
  if (refusal) return refusal;

  const session = tmux.sessionName(user.unixUsername, project.name, 'agent', ws.name);
  const now = new Date();
  // One open handoff per pane: the check and the create run under a per-pane
  // advisory lock, so two requests at once cannot both pass the check (the
  // sweep would type the request line twice and reset twice).
  const created = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`handoff:${project.id}:${ws.name}`}))`;
    const open = await tx.agentHandoff.findFirst({
      where: { userId: user.id, projectId: project.id, workstream: ws.name, state: { in: OPEN_HANDOFF_STATES } },
      select: { id: true, state: true },
    });
    if (open) return { open, row: null };
    const row = await tx.agentHandoff.create({
      data: {
        userId: user.id,
        projectId: project.id,
        workstream: ws.name,
        instanceId: project.instanceId,
        session,
        mode: plan.mode,
        requestedMode: req.mode,
        fromProvider: from,
        toProvider,
        initiator: who.initiator,
        surface: who.surface,
        note: req.note ?? null,
        reason: plan.fallback ?? null,
        contextTokensBefore: getStatus(session, project.instanceId).contextTokens ?? null,
        // An agent that wrote its handoff before asking skips the write step.
        // The row waits in `writing` (which the sweep never acts on) until its
        // prompt file is on the box: `written` would let a tick reset the pane
        // onto a file that does not exist yet.
        ...(req.body ? { body: req.body, state: 'writing', writeRequestedAt: now } : {}),
      },
    });
    return { open: null, row };
  });
  if (created.open) {
    const { open } = created;
    return { status: 409, body: { error: `a handoff of this agent is already ${open.state} (${open.id})`, code: 'handoff_open', handoffId: open.id } };
  }
  let row = created.row!;
  if (req.body) {
    try {
      await writePromptFile(row, req.body, { name: project.name, instanceId: project.instanceId, hostHome: project.instance.hostHome }, user.unixUsername);
    } catch (err) {
      row = await prisma.agentHandoff.update({ where: { id: row.id }, data: { state: 'failed', reason: `could not write the handoff on the box: ${(err as Error).message}`.slice(0, 500), doneAt: new Date() } });
      publishHandoff(row, session, project.instanceId);
      return { status: 503, body: { error: `Could not write the handoff on the box: ${(err as Error).message}` } };
    }
    // Guarded like writtenFor: an abort while the file was being written wins.
    const flipped = await prisma.agentHandoff.updateMany({ where: { id: row.id, state: 'writing' }, data: { state: 'written', writtenAt: new Date() } });
    if (flipped.count !== 1) return { status: 409, body: { error: `handoff ${row.id} was aborted while its handoff was being written`, code: 'handoff_aborted' } };
    row = (await prisma.agentHandoff.findUnique({ where: { id: row.id } }))!;
  }
  publishHandoff(row, session, project.instanceId);
  console.log(`[HANDOFF] ${user.unixUsername} ${session}: ${plan.mode}${toProvider && toProvider !== from ? ` → ${toProvider}` : ''} by ${who.initiator} via ${who.surface} (${row.id})`);
  return {
    status: 202,
    body: {
      handoff: handoffView(row),
      ...(plan.fallback ? { note: plan.fallback } : {}),
    },
  };
}

/** A person hands off one workstream's agent (the cookie route). */
async function personHandoffFor(user: Express.User, projectId: string, workstreamId: string, raw: unknown): Promise<RouteResult> {
  const parsed = parseHandoffRequest(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  if (parsed.value.body) return { status: 400, body: { error: 'body is for an agent handing itself off' } };
  const ws = await prisma.workstream.findFirst({ where: { id: workstreamId, projectId, project: { userId: user.id } }, select: { name: true } });
  if (!ws) return { status: 404, body: { error: 'Workstream not found' } };
  const surfaceRaw = (raw as { surface?: unknown } | null)?.surface;
  const surface: HandoffSurface = surfaceRaw === 'mobile' ? 'mobile' : 'web';
  return startHandoff(user, { projectId, workstream: ws.name }, parsed.value, { initiator: 'person', surface });
}

/**
 * A person hands off from the CLI or the TUI (POST /api/cli/v1/projects/:id/handoff):
 * the workstream by name (default main), `surface` cli (default) or tui. A
 * box credential (`boxId` defined; null for a per-user token, the host's)
 * reaches only the projects on its own box, like an agent's own handoff
 * (resolveCaller scopes to the token's box); a device sign-in reaches all of
 * the user's projects.
 */
export async function cliHandoffFor(user: Express.User, projectId: string, raw: unknown, boxId?: string | null): Promise<RouteResult> {
  const parsed = parseHandoffRequest(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  if (parsed.value.body) return { status: 400, body: { error: 'body is for an agent handing itself off' } };
  if (boxId !== undefined) {
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id, archived: false }, select: { instanceId: true } });
    if (!project) return { status: 404, body: { error: 'Project not found' } };
    if (project.instanceId !== boxId) {
      return { status: 403, body: { error: 'a box\'s own credential can hand off only the projects on that box; sign in with `termag login` for the others', code: 'box_scope' } };
    }
  }
  const obj = (raw && typeof raw === 'object' ? raw : {}) as { workstream?: unknown; surface?: unknown };
  const workstream = typeof obj.workstream === 'string' && obj.workstream ? obj.workstream : 'main';
  const surface: HandoffSurface = obj.surface === 'tui' ? 'tui' : 'cli';
  return startHandoff(user, { projectId, workstream }, parsed.value, { initiator: 'person', surface });
}

/** An agent hands its own pane off (MetaTerm `handoff`). */
export async function agentHandoffFor(user: Express.User, callerInstanceId: string | null | undefined, raw: unknown): Promise<RouteResult> {
  const parsed = parseHandoffRequest(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  if (!parsed.value.session) return { status: 400, body: { error: 'session required: an agent hands off its own pane (the metaterm MCP server sends it)' } };
  const found = await resolveCaller(user, parsed.value.session, callerInstanceId);
  if (!found.ok) return found.result;
  const c = found.value;
  if (c.role !== 'agent') return { status: 400, body: { error: `only an agent pane can be handed off (${c.session} is a ${c.role ?? 'unknown'} pane)` } };
  const surfaceRaw = (raw as { surface?: unknown } | null)?.surface;
  const surface = HANDOFF_SURFACES.includes(surfaceRaw as HandoffSurface) ? surfaceRaw as HandoffSurface : 'mcp';
  // A box token is the agent; a browser session naming a pane is a person,
  // and a person asks the agent for its handoff rather than writing it.
  const initiator: HandoffInitiator = callerInstanceId !== undefined ? 'agent' : 'person';
  if (initiator === 'person' && parsed.value.body) return { status: 400, body: { error: 'body is for an agent handing itself off' } };
  return startHandoff(user, { projectId: c.projectId, workstream: c.workstream }, parsed.value, { initiator, surface });
}

/** The agent's answer to "write a handoff": its text, scanned, stored and written to the box. */
export async function writtenFor(user: Express.User, callerInstanceId: string | null | undefined, id: string, raw: unknown): Promise<RouteResult> {
  const parsed = parseWritten(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const found = await resolveCaller(user, parsed.value.session, callerInstanceId);
  if (!found.ok) return found.result;
  const c = found.value;
  const row = await prisma.agentHandoff.findFirst({ where: { id, userId: user.id } });
  // Only the pane being handed off writes its handoff.
  if (!row || row.projectId !== c.projectId || row.workstream !== c.workstream || c.role !== 'agent') {
    return { status: 404, body: { error: `handoff ${id} is not one of this session's` } };
  }
  if (row.state !== 'requested' && row.state !== 'writing') {
    return { status: 409, body: { error: `handoff ${id} is ${row.state}; its handoff can no longer be written` } };
  }
  const refusal = secretRefusal(parsed.value.body);
  if (refusal) return refusal;
  const project = await prisma.project.findFirst({
    where: { id: row.projectId, userId: user.id },
    select: { name: true, instanceId: true, instance: { select: { hostHome: true } } },
  });
  if (!project) return { status: 404, body: { error: 'Project not found' } };
  try {
    await writePromptFile(row, parsed.value.body, { name: project.name, instanceId: project.instanceId, hostHome: project.instance?.hostHome ?? null }, user.unixUsername);
  } catch (err) {
    return { status: 503, body: { error: `Could not write the handoff on the box: ${(err as Error).message}` } };
  }
  const claimed = await prisma.agentHandoff.updateMany({
    where: { id, state: { in: ['requested', 'writing'] } },
    data: { state: 'written', body: parsed.value.body, writtenAt: new Date() },
  });
  if (claimed.count !== 1) return { status: 409, body: { error: `handoff ${id} moved on while it was being written` } };
  const next = await prisma.agentHandoff.findUnique({ where: { id } });
  if (next) publishHandoff(next, c.session, c.instanceId);
  const what = row.mode === 'restart'
    ? `the pane restarts${row.toProvider && row.toProvider !== row.fromProvider ? ` on ${PROVIDERS[row.toProvider]?.displayName ?? row.toProvider}` : ''}`
    : `termag types ${(row.mode === 'clear' ? PROVIDERS[row.fromProvider]?.clearCommand : PROVIDERS[row.fromProvider]?.compactCommand) ?? `/${row.mode}`}`;
  return { status: 200, body: { ok: true, handoff: id, state: 'written', note: `Saved. End your turn now: once this pane is idle, ${what} and the next agent starts on the handoff.` } };
}

export async function getHandoffFor(user: Express.User, id: string): Promise<RouteResult> {
  const row = await prisma.agentHandoff.findFirst({ where: { id, userId: user.id } });
  if (!row) return { status: 404, body: { error: 'Handoff not found' } };
  return { status: 200, body: handoffView(row, true) };
}

async function listHandoffsFor(user: Express.User, projectId: unknown, workstream: unknown): Promise<RouteResult> {
  if (typeof projectId !== 'string' || !projectId) return { status: 400, body: { error: 'projectId required' } };
  const rows = await prisma.agentHandoff.findMany({
    where: { userId: user.id, projectId, workstream: typeof workstream === 'string' && workstream ? workstream : 'main' },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  return { status: 200, body: { handoffs: rows.map(r => handoffView(r)) } };
}

async function abortFor(user: Express.User, id: string): Promise<RouteResult> {
  const row = await prisma.agentHandoff.findFirst({ where: { id, userId: user.id } });
  if (!row) return { status: 404, body: { error: 'Handoff not found' } };
  const claimed = await prisma.agentHandoff.updateMany({
    where: { id, state: { in: ABORTABLE_HANDOFF_STATES } },
    data: { state: 'aborted', reason: 'aborted by the owner', doneAt: new Date() },
  });
  if (claimed.count !== 1) return { status: 409, body: { error: `handoff ${id} is ${row.state}; it can only be aborted before the pane is reset` } };
  const next = await prisma.agentHandoff.findUnique({ where: { id } });
  if (next) {
    // Rebuilt rather than read back, like the sweep's: a rename since the
    // request would leave the strip on a dead status key.
    const project = await prisma.project.findFirst({ where: { id: next.projectId, userId: user.id }, select: { name: true, instanceId: true } });
    const session = project ? tmux.sessionName(user.unixUsername, project.name, 'agent', next.workstream) : next.session;
    publishHandoff(next, session, project?.instanceId ?? next.instanceId);
  }
  return { status: 200, body: next ? handoffView(next) : { id, state: 'aborted' } };
}

export function handoffsRouter(): Router {
  const router = Router();
  router.post('/projects/:projectId/workstreams/:id/handoff', requireAuth, refuseParkedBox('projectId'), refuseUnreadySetup('projectId'), asyncHandler(async (req, res) => {
    sendResult(res, await personHandoffFor(req.user!, req.params.projectId, req.params.id, req.body));
  }));
  router.post('/handoffs', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await agentHandoffFor(req.user!, req.agentInstanceId, req.body));
  }));
  router.post('/handoffs/:id/written', requireAuthOrAgentToken, asyncHandler(async (req, res) => {
    sendResult(res, await writtenFor(req.user!, req.agentInstanceId, req.params.id, req.body));
  }));
  router.get('/handoffs/:id', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await getHandoffFor(req.user!, req.params.id));
  }));
  router.get('/handoffs', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await listHandoffsFor(req.user!, req.query.projectId, req.query.workstream));
  }));
  router.post('/handoffs/:id/abort', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await abortFor(req.user!, req.params.id));
  }));
  return router;
}
