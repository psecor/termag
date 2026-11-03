/**
 * Tool update runs (phase 2): the
 * `software_update_runs` rows, the `tool-update` RPC that starts one on a box,
 * the box's policy fetch and report, the relaunch of the agent panes a run
 * stopped, and the admin Software tab's preview, requests and history. Each
 * takes a component and looks it up in the registry (components.ts): Claude
 * Code and Codex.
 *
 * The rules are pure and tested beside this: claudeUpdatePolicy.ts (Claude
 * Code's policy flag), run.ts (states, expiry, the policy answer, the
 * report), panes.ts (pane → workstream) and fleet.ts (scope and pacing).
 * This file reads, writes and sends.
 *
 * A box's run goes through its agent: the policy and report endpoints take
 * an instance-bound agent token, so such a host's key is the instance id. The
 * orchestrator host (hostKey `orchestrator`) takes a run through a root unit
 * and files instead (orchestrator.ts, phase 2e); the routes hand it there.
 */
import { Prisma, type Instance, type SoftwareUpdateRun, type User } from '@prisma/client';
import { prisma } from '../../db';
import { PROVIDERS } from '../../providers/registry';
import { AgentNotConnectedError, AgentReplyError, inventoryHosts, instanceAgentTransport, isInstanceAgentConnected, sendToInstanceAgent } from '../agentRegistry';
import { ensureAgentSessionsAndLaunch } from '../agentRuntime';
import { isParkedSpawn } from '../agentSpawnStore';
import { refreshHostInventory } from '../software/collector';
import { getStatus } from '../status';
import { sessionName } from '../tmux';
import type { ClaudeUpdateRestart } from '../claudeUpdatePolicy';
import { TOOL_REGISTRY, type ToolComponent, type ToolDescriptor } from './components';
import {
  RUN_EXPIRE_MS, RUN_STALE_MS, isInFlight, isRunId, policyAnswer, reportCreate, reportUpdate,
  type PolicyAnswer, type ReportedPane, type RunTrigger, type ToolUpdateReport,
} from './run';
import { agentPaneIndex, planRelaunches, sessionCounts, type PaneSkip } from './panes';
import { ORCHESTRATOR_HOST, orchestratorPreview, requestOrchestratorUpdate, syncOrchestratorRuns } from './orchestrator';
import { behindReference, hostRefusal, selectFleet, slotsFree, type FleetScope, type FleetSelection, type HostFacts } from './fleet';

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
type Box = Pick<Instance, 'id' | 'name' | 'kind'>;
const ldBox = (b: Box) => ({ id: b.id, name: b.name, kind: b.kind });

// ── the RPC ─────────────────────────────────────────────────────────────────

/**
 * What became of a `tool-update` RPC: `started` (the agent said so),
 * `refused` (the agent answered with an error, or nothing was sent), or
 * `uncertain` (a timeout or a dropped connection after the send: the agent
 * may have started the unit; Devin on #975).
 */
export type SendOutcome = { started: true } | { refused: string } | { uncertain: string };

/**
 * `tool-update {component, run}` to the box's agent, which starts the
 * component's unit (termag-claude-update@<run>.service for Claude Code,
 * termag-codex-update@<run>.service for Codex) and answers
 * `{started: true}` or `{error}`. Only a listed component and the run id
 * cross: the box fetches its own policy, so no version or command is ever
 * sent.
 */
export async function sendToolUpdate(instanceId: string, component: ToolComponent, runId: string): Promise<SendOutcome> {
  if (!TOOL_REGISTRY[component]) return { refused: 'not a tool termag updates' };
  if (!isRunId(runId)) return { refused: 'not a run id' };
  const capability = TOOL_REGISTRY[component].capability;
  if (!(instanceAgentTransport(instanceId)?.capabilities ?? []).includes(capability)) return { refused: `the agent does not announce ${capability}` };
  if (!isInstanceAgentConnected(instanceId)) return { refused: 'the box agent is not connected' };
  try {
    const reply = await sendToInstanceAgent(instanceId, 'tool-update', { component, run: runId }, 15_000);
    if (reply?.started === true) return { started: true };
    return { refused: typeof reply?.error === 'string' ? reply.error.slice(0, 500) : 'the agent did not start the unit' };
  } catch (err) {
    // The agent's `{error}` reply rejects as AgentReplyError: a refusal
    // (Bugbot on #975). Only a timeout or a dropped socket after the send is
    // uncertain; "not connected" means nothing was sent (checked above too;
    // this covers the race). Anything else, unexpected, is uncertain too:
    // holding the box is the safe side.
    if (err instanceof AgentReplyError || err instanceof AgentNotConnectedError) return { refused: err.message.slice(0, 500) };
    return { uncertain: errMsg(err) };
  }
}

// ── rows ────────────────────────────────────────────────────────────────────

/** Runs the fleet pacer holds and has not sent yet: requested, but not asked of their box, so not expiring. */
const queued = new Map<string, { runId: string; instanceId: string; boxName: string; component: ToolComponent }>();

/**
 * A run still `requested` RUN_EXPIRE_MS after it was asked of its box, with no
 * policy fetch, is `expired`. Run lazily, before anything reads or counts runs.
 */
export async function expireStaleRuns(now: number = Date.now()): Promise<number> {
  const r = await prisma.softwareUpdateRun.updateMany({
    where: { status: 'requested', requestedAt: { lt: new Date(now - RUN_EXPIRE_MS) }, ...(queued.size ? { id: { notIn: [...queued.keys()] } } : {}) },
    data: { status: 'expired', finishedAt: new Date(now), detail: 'the box did not fetch its policy within 15 minutes' },
  });
  return r.count;
}

type Db = Pick<typeof prisma, 'softwareUpdateRun'>;

/**
 * The box's run of the component in flight, newest first, if any. A run the
 * fleet pacer holds is in flight whatever its age: it is still going to be
 * sent, and its 15-minute clock only starts when it is (Bugbot on #975).
 */
async function runInFlightFor(hostKey: string, component: ToolComponent, now: number, db: Db = prisma): Promise<SoftwareUpdateRun | null> {
  const rows = await db.softwareUpdateRun.findMany({
    where: { hostKey, component, status: { in: ['requested', 'running'] } },
    orderBy: { requestedAt: 'desc' },
  });
  return rows.find(r => queued.has(r.id) || isInFlight(r, now)) ?? null;
}

/** Runs in flight across the fleet, every component: the pacing is about boxes, not tools. */
async function fleetInFlight(now: number): Promise<number> {
  const rows = await prisma.softwareUpdateRun.findMany({
    where: { status: { in: ['requested', 'running'] }, requestedAt: { gte: new Date(now - RUN_STALE_MS - 24 * 3600_000) } },
    select: { id: true, status: true, requestedAt: true, startedAt: true },
  });
  return rows.filter(r => !queued.has(r.id) && isInFlight(r, now)).length;
}

/**
 * Write a requested run, unless the box already has one of the component in
 * flight: then null. At most one run per (box, component) at a time, or two
 * units would stop and resume the box's sessions twice. The check and the
 * insert run under a transaction-scoped advisory lock on the box and
 * component, so two spawns, two admins or two orchestrator processes cannot
 * both pass the check (Bugbot on #975). A lock rather than a partial unique
 * index because the schema is synced with `prisma db push`, which cannot
 * express one and drops indexes the schema does not declare.
 */
async function claimRun(box: Box, component: ToolComponent, trigger: RunTrigger, restart: ClaudeUpdateRestart, target: string, requestedById: string | null, now: number): Promise<SoftwareUpdateRun | null> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tool-update:${box.id}:${component}`}))`;
    if (await runInFlightFor(box.id, component, now, tx)) return null;
    return tx.softwareUpdateRun.create({
      data: { hostKey: box.id, instanceId: box.id, component, trigger, restart, status: 'requested', target, requestedById },
    });
  }, { timeout: 20_000, maxWait: 10_000 });
}

/**
 * Ask the box to start the run now: requestedAt becomes the moment it was
 * asked (the expiry counts from there), then the RPC. Only an explicit
 * refusal ends the run `refused`. An uncertain outcome leaves it `requested`,
 * holding the box, with the lost acknowledgement in `detail`: the box may be
 * updating, so it ends as any requested run does, on the box's policy fetch
 * (`running`), its report, or the 15-minute expiry from now.
 */
async function dispatch(runId: string, instanceId: string, boxName: string, component: ToolComponent): Promise<SendOutcome> {
  const moved = await prisma.softwareUpdateRun.updateMany({ where: { id: runId, status: 'requested' }, data: { requestedAt: new Date() } });
  if (moved.count === 0) return { refused: 'the run is no longer requested' };
  const reply = await sendToolUpdate(instanceId, component, runId);
  if ('refused' in reply) {
    await prisma.softwareUpdateRun.updateMany({ where: { id: runId, status: 'requested' }, data: { status: 'refused', finishedAt: new Date(), detail: reply.refused.slice(0, 2000) } });
    console.warn(`[TOOL-UPDATE] ${boxName}: ${component} run ${runId} refused: ${reply.refused}`);
  } else if ('uncertain' in reply) {
    await prisma.softwareUpdateRun.updateMany({ where: { id: runId, status: 'requested' }, data: { detail: `the box's acknowledgement was lost (${reply.uncertain}); the run holds the box until it fetches its policy, reports, or expires`.slice(0, 2000) } });
    console.warn(`[TOOL-UPDATE] ${boxName}: ${component} run ${runId} sent, acknowledgement lost: ${reply.uncertain}`);
  } else {
    console.log(`[TOOL-UPDATE] ${boxName}: ${component} run ${runId} started`);
  }
  return reply;
}

// ── the fleet pacer ─────────────────────────────────────────────────────────

const PUMP_MS = 30_000;
let pumpTimer: NodeJS.Timeout | null = null;
let pumping: Promise<void> | null = null;

/**
 * Start queued runs while fewer than FLEET_IN_FLIGHT are in flight. Runs on
 * every report (a run that ends frees a slot) and every 30 s while anything is
 * queued. In memory: a process that exits with runs still queued leaves them
 * `requested`, and they expire 15 minutes on, which the runs list shows.
 */
export function pumpFleet(): Promise<void> {
  if (pumping) return pumping;
  pumping = (async () => {
    try {
      await expireStaleRuns(Date.now());
      for (const q of [...queued.values()]) {
        // Recounted before each send: a single-host or floor run may have
        // started since the last one, and the fleet never adds ten on top.
        if (slotsFree(await fleetInFlight(Date.now())) <= 0) break;
        queued.delete(q.runId);
        await dispatch(q.runId, q.instanceId, q.boxName, q.component).catch(err => console.error(`[TOOL-UPDATE] ${q.boxName}: dispatch failed:`, errMsg(err)));
      }
    } catch (err) {
      console.error('[TOOL-UPDATE] fleet pacer failed:', errMsg(err));
    } finally {
      pumping = null;
      if (queued.size && !pumpTimer) {
        pumpTimer = setInterval(() => { void pumpFleet(); }, PUMP_MS);
        pumpTimer.unref?.();
      } else if (!queued.size && pumpTimer) {
        clearInterval(pumpTimer);
        pumpTimer = null;
      }
    }
  })();
  return pumping;
}

// ── hosts ───────────────────────────────────────────────────────────────────

type BoxWithOwner = Instance & { user: User | null };

/** The tool's version in each host's inventory: null for one it has but cannot read. */
async function inventoryVersions(tool: ToolDescriptor, hostKeys: string[]): Promise<Map<string, string | null>> {
  const rows = await prisma.hostSoftware.findMany({ where: { hostKey: { in: hostKeys }, component: tool.inventoryName }, select: { hostKey: true, version: true, ok: true } });
  return new Map(rows.map(r => [r.hostKey, r.ok ? r.version : null]));
}

async function boxFacts(tool: ToolDescriptor, box: BoxWithOwner, version: string | null, now: number): Promise<Omit<HostFacts, 'floor' | 'reference'> & { run: SoftwareUpdateRun | null }> {
  const run = await runInFlightFor(box.id, tool.component, now);
  return {
    hostKey: box.id,
    connected: isInstanceAgentConnected(box.id),
    capable: (instanceAgentTransport(box.id)?.capabilities ?? []).includes(tool.capability),
    enabled: box.user ? await tool.enabled(box.user, ldBox(box)) : false,
    inFlight: !!run,
    version,
    run,
  };
}

/** The box's agent panes that run the tool, by the orchestrator's own live status. */
async function paneCounts(tool: ToolDescriptor, box: BoxWithOwner) {
  if (!box.user) return sessionCounts([]);
  const owner = box.user;
  const projects = await prisma.project.findMany({
    where: { userId: owner.id, instanceId: box.id, archived: false },
    select: { name: true, workflows: { where: { type: 'agent' }, select: { provider: true, workstream: { select: { name: true } } } } },
  });
  const statuses = projects.flatMap(p => p.workflows
    .filter(wf => tool.providers.includes(wf.provider ?? owner.defaultAgentProvider ?? 'claude'))
    .map(wf => getStatus(sessionName(owner.unixUsername, p.name, 'agent', wf.workstream.name), box.id).status));
  return sessionCounts(statuses);
}

export type AdminAnswer<T> = { status: 200 | 202; body: T } | { status: 404 | 409 | 502; body: { code: string; error?: string; runId?: string } };
// The orchestrator's answers are this shape too (orchestrator.ts).
const NO_HOST = { status: 404 as const, body: { code: 'no_such_host', error: 'No such host' } };
/** The admin API's code for a tool whose updates are off; `claude_update_off` is the contract's, kept for every tool the registry lists. */
const OFF = { status: 404 as const, body: { code: 'claude_update_off' } };

/** A non-box host (the orchestrator, a per-user agent on it): known to the inventory, but no run reaches it yet. */
async function otherHost(hostKey: string): Promise<{ connected: boolean } | null> {
  if (hostKey === 'orchestrator') return { connected: true };
  if (!hostKey.startsWith('agent:')) return null;
  const live = inventoryHosts().some(h => h.hostKey === hostKey);
  const known = live || (await prisma.hostSoftware.count({ where: { hostKey } })) > 0;
  return known ? { connected: live } : null;
}

async function loadBox(hostKey: string): Promise<BoxWithOwner | null> {
  return prisma.instance.findFirst({ where: { id: hostKey, status: { not: 'terminated' } }, include: { user: true } });
}

/**
 * GET /api/admin/software/hosts/:hostKey/update-preview: what an update of
 * this host would do. 404 claude_update_off when the tool's flag is off for
 * the host's owner and box (for a host with no box, for the admin asking),
 * which is how the UI knows to hide its actions.
 */
/** The target as the box resolves it, for a tool whose latest is pinned (latestReference); else the policy's. */
export function previewTarget(tool: Pick<ToolDescriptor, 'isVersion' | 'latestReference'>, target: string): string {
  return !tool.isVersion(target) && tool.latestReference ? tool.latestReference : target;
}

export async function updatePreview(tool: ToolDescriptor, hostKey: string, admin: User, now: number = Date.now()): Promise<AdminAnswer<Record<string, unknown>>> {
  await expireStaleRuns(now);
  const box = await loadBox(hostKey);
  if (!box) {
    const other = await otherHost(hostKey);
    if (!other) return NO_HOST;
    if (hostKey === ORCHESTRATOR_HOST && tool.component === 'claude') return orchestratorPreview(tool, admin, (await inventoryVersions(tool, [hostKey])).get(hostKey) ?? null, now);
    if (!await tool.enabled(admin, null)) return OFF;
    const policy = await tool.policy(admin, null);
    const version = (await inventoryVersions(tool, [hostKey])).get(hostKey) ?? null;
    return { status: 200, body: { hostKey, connected: other.connected, capable: false, current: version, target: previewTarget(tool, policy.target), floor: policy.floor, liveSessions: 0, busySessions: 0, runInFlight: null } };
  }
  const version = (await inventoryVersions(tool, [box.id])).get(box.id) ?? null;
  const facts = await boxFacts(tool, box, version, now);
  if (!facts.enabled) return OFF;
  const policy = await tool.policy(box.user!, ldBox(box));
  return {
    status: 200,
    body: {
      hostKey, connected: facts.connected, capable: facts.capable, current: version, target: previewTarget(tool, policy.target), floor: policy.floor,
      ...await paneCounts(tool, box),
      runInFlight: facts.run ? { id: facts.run.id, status: facts.run.status, trigger: facts.run.trigger, requestedAt: facts.run.requestedAt.toISOString() } : null,
    },
  };
}

/**
 * POST /api/admin/software/hosts/:hostKey/update: one run, now, not queued
 * behind the fleet's pacing. 202 `{runId, acknowledged: true}` once the box's
 * agent started its unit, or `{runId, acknowledged: false}` when the RPC's
 * answer was lost (the run stays `requested` and holds the box; the runs list
 * says how it went); 409 offline, not_capable or run_in_flight before
 * anything is written; 502 agent_refused when the agent answered the RPC with
 * an error (the run is then `refused`).
 */
export async function requestHostUpdate(tool: ToolDescriptor, hostKey: string, restart: ClaudeUpdateRestart, admin: User, now: number = Date.now()): Promise<AdminAnswer<{ runId: string; acknowledged: boolean }>> {
  await expireStaleRuns(now);
  const box = await loadBox(hostKey);
  if (!box) {
    const other = await otherHost(hostKey);
    if (!other) return NO_HOST;
    if (hostKey === ORCHESTRATOR_HOST && tool.component === 'claude') return requestOrchestratorUpdate(tool, restart, admin, now, (await inventoryVersions(tool, [hostKey])).get(hostKey) ?? null) as Promise<AdminAnswer<{ runId: string; acknowledged: boolean }>>;
    if (!await tool.enabled(admin, null)) return OFF;
    return { status: 409, body: { code: 'not_capable', error: `only a box takes a ${tool.displayName} update for now` } };
  }
  const facts = await boxFacts(tool, box, null, now);
  const refusal = hostRefusal(facts);
  if (refusal === 'claude_update_off') return OFF;
  if (refusal) return { status: 409, body: { code: refusal } };
  const policy = await tool.policy(box.user!, ldBox(box));
  const run = await claimRun(box, tool.component, 'manual', restart, policy.target, admin.id, now);
  if (!run) return { status: 409, body: { code: 'run_in_flight' } };
  console.log(`[TOOL-UPDATE] ${admin.unixUsername} asks ${box.name} (${box.user?.unixUsername ?? 'unowned'}) to update ${tool.displayName} (restart ${restart}): run ${run.id}`);
  const reply = await dispatch(run.id, box.id, box.name, tool.component);
  if ('refused' in reply) return { status: 502, body: { code: 'agent_refused', error: reply.refused, runId: run.id } };
  return { status: 202, body: { runId: run.id, acknowledged: 'started' in reply } };
}

/**
 * POST /api/admin/software/update: every box the scope takes gets a run,
 * started FLEET_IN_FLIGHT at a time (pumpFleet). The rows are written at once,
 * so the answer names every run; the ones past the first slots wait in the
 * pacer, `requested`, until a slot frees. Each box is compared with its own
 * policy, for its owner and the box (a box can have its own floor).
 */
export async function requestFleetUpdate(tool: ToolDescriptor, scope: FleetScope, restart: ClaudeUpdateRestart, admin: User, now: number = Date.now()): Promise<AdminAnswer<{ runs: Array<{ hostKey: string; runId: string }>; skipped: FleetSelection['skipped'] }>> {
  if (!await tool.enabled(admin, null)) return OFF;
  await expireStaleRuns(now);
  const boxes = await prisma.instance.findMany({ where: { status: { not: 'terminated' }, userId: { not: null } }, include: { user: true }, orderBy: { name: 'asc' } });
  const versions = await inventoryVersions(tool, boxes.map(b => b.id));
  const fleetVersions = [...versions.values()];
  const policies = new Map(await Promise.all(boxes.map(async b => [b.id, await tool.policy(b.user!, ldBox(b))] as const)));
  const facts = await Promise.all(boxes.map(async (b): Promise<HostFacts> => {
    const policy = policies.get(b.id)!;
    return { ...await boxFacts(tool, b, versions.get(b.id) ?? null, now), floor: policy.floor, reference: behindReference(policy.target, fleetVersions, tool.isVersion, tool.latestReference) };
  }));
  const selection = selectFleet(facts, scope);
  const byId = new Map(boxes.map(b => [b.id, b]));
  const runs: Array<{ hostKey: string; runId: string }> = [];
  for (const hostKey of selection.hosts) {
    const box = byId.get(hostKey)!;
    const policy = policies.get(hostKey)!;
    const run = await claimRun(box, tool.component, 'manual', restart, policy.target, admin.id, now);
    if (!run) { selection.skipped.push({ hostKey, reason: 'run_in_flight' }); continue; }
    queued.set(run.id, { runId: run.id, instanceId: box.id, boxName: box.name, component: tool.component });
    runs.push({ hostKey, runId: run.id });
  }
  console.log(`[TOOL-UPDATE] ${admin.unixUsername} asks the fleet to update ${tool.displayName} (${scope}, restart ${restart}): ${runs.length} runs, ${selection.skipped.length} skipped`);
  void pumpFleet();
  return { status: 202, body: { runs, skipped: selection.skipped } };
}

/** GET /api/admin/software/updates: the component's newest runs first, with the box and the admin who asked. */
export async function listUpdateRuns(tool: ToolDescriptor, admin: User, limit: number, now: number = Date.now()): Promise<AdminAnswer<{ runs: Array<Record<string, unknown>> }>> {
  if (!await tool.enabled(admin, null)) return OFF;
  await expireStaleRuns(now);
  await syncOrchestratorRuns();
  const rows = await prisma.softwareUpdateRun.findMany({ where: { component: tool.component }, orderBy: { requestedAt: 'desc' }, take: limit });
  const boxes = new Map((await prisma.instance.findMany({ where: { id: { in: [...new Set(rows.map(r => r.hostKey))] } }, select: { id: true, name: true, user: { select: { unixUsername: true } } } })).map(b => [b.id, b]));
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.requestedById).filter((x): x is string => !!x))] } }, select: { id: true, unixUsername: true } })).map(u => [u.id, u.unixUsername]));
  return {
    status: 200,
    body: {
      runs: rows.map(r => ({
        id: r.id, hostKey: r.hostKey, hostName: boxes.get(r.hostKey)?.name ?? null, owner: boxes.get(r.hostKey)?.user?.unixUsername ?? null,
        component: r.component, trigger: r.trigger, restart: r.restart, status: r.status, queued: queued.has(r.id),
        outcome: r.outcome, target: r.target, fromVersion: r.fromVersion, toVersion: r.toVersion, detail: r.detail, sessions: r.sessions,
        requestedBy: r.requestedById ? users.get(r.requestedById) ?? null : null,
        requestedAt: r.requestedAt.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null,
      })),
    },
  };
}

/**
 * The runner backstop's floor run (claudeRunner.ts): a box below the floor
 * whose wrapper cannot enforce it gets one run of the tool, restart idle,
 * unless one is in flight. Only a tool with `runnerFloor`. Never throws.
 */
export async function requestFloorRun(tool: ToolDescriptor, box: Box, owner: User, now: number = Date.now()): Promise<void> {
  try {
    if (!tool.runnerFloor) return;
    if (!(instanceAgentTransport(box.id)?.capabilities ?? []).includes(tool.capability)) return;
    await expireStaleRuns(now);
    if (await runInFlightFor(box.id, tool.component, now)) return;
    const policy = await tool.policy(owner, ldBox(box));
    const run = await claimRun(box, tool.component, 'floor', 'idle', policy.target, null, now);
    if (!run) return;
    console.log(`[TOOL-UPDATE] ${box.name} (${owner.unixUsername}) is below the ${tool.displayName} floor ${policy.floor}: run ${run.id}`);
    await dispatch(run.id, box.id, box.name, tool.component);
  } catch (err) {
    console.error(`[TOOL-UPDATE] ${box.name}: floor run failed:`, errMsg(err));
  }
}

// ── the box's side ──────────────────────────────────────────────────────────

/** GET /api/tool-update/policy for the box `instanceId`, owned by `owner`, and one tool. Starts the run when it may. */
export async function boxPolicy(tool: ToolDescriptor, instanceId: string, owner: User, asked: string | null, now: number = Date.now()): Promise<PolicyAnswer> {
  const box = await prisma.instance.findUnique({ where: { id: instanceId }, select: { id: true, name: true, kind: true } });
  const run = asked && isRunId(asked) ? await prisma.softwareUpdateRun.findUnique({ where: { id: asked } }) : null;
  const ctx = box ? ldBox(box) : null;
  const [enabled, policy] = await Promise.all([tool.enabled(owner, ctx), tool.policy(owner, ctx)]);
  const answer = policyAnswer({ component: tool.component, asked, run, hostKey: instanceId, enabled, policy, now });
  if (answer.status === 200 && run) {
    if (answer.start) {
      const moved = await prisma.softwareUpdateRun.updateMany({ where: { id: run.id, status: 'requested' }, data: { status: 'running', startedAt: new Date(now) } });
      // Another fetch of the same run got there first: answer as the run now
      // stands (a retry within the window gets it back, anything else none).
      if (moved.count === 0) {
        const fresh = await prisma.softwareUpdateRun.findUnique({ where: { id: run.id } });
        return policyAnswer({ component: tool.component, asked, run: fresh, hostKey: instanceId, enabled, policy, now });
      }
    } else if (answer.expire) {
      await prisma.softwareUpdateRun.updateMany({ where: { id: run.id, status: 'requested' }, data: { status: 'expired', finishedAt: new Date(now), detail: 'the box fetched its policy more than 15 minutes after the run was asked for' } });
    }
  }
  return answer;
}

/** The counts as a JSON column: none is SQL NULL. */
const sessionsJson = (r: ToolUpdateReport) => (r.sessions ? { ...r.sessions } : Prisma.DbNull);

export type ReportResult =
  | { status: 404; body: { code: 'no_such_run' | 'no_such_box' } }
  /** `repeat`: the run had already ended (a box retrying a report whose 204 it never saw); nothing was written. */
  | { status: 204; runId: string; box: Instance & { user: User | null }; repeat?: true };

/**
 * POST /api/tool-update/report: end the run (or record a boot or guard
 * run), then, after the answer, refresh the host's inventory and relaunch the
 * agent panes the run stopped (afterReport). A run of another component, or
 * another box's, is no such run. A `requested`, `running` or `expired` run
 * takes a report; one that already has an outcome (done, failed, refused)
 * answers 204 with nothing written and no afterReport, so a retried report
 * never relaunches panes twice (Devin on #975).
 */
export async function recordToolUpdateReport(instanceId: string, r: ToolUpdateReport, now: Date = new Date()): Promise<ReportResult> {
  const box = await prisma.instance.findUnique({ where: { id: instanceId }, include: { user: true } });
  if (!box) return { status: 404, body: { code: 'no_such_box' } };
  let runId: string;
  if (r.run) {
    const run = await prisma.softwareUpdateRun.findUnique({ where: { id: r.run } });
    if (!run || run.hostKey !== instanceId || run.component !== r.component) return { status: 404, body: { code: 'no_such_run' } };
    const written = await prisma.softwareUpdateRun.updateMany({
      // An expired run had no policy fetch, not a report: its first report is
      // the real outcome (Bugbot on #975). Only a run with one already
      // (done, failed, refused) is a repeat.
      where: { id: run.id, status: { in: ['requested', 'running', 'expired'] } },
      data: { ...reportUpdate(run, r, now), sessions: sessionsJson(r) },
    });
    if (written.count === 0) return { status: 204, runId: run.id, box, repeat: true };
    runId = run.id;
  } else {
    runId = (await prisma.softwareUpdateRun.create({ data: { ...reportCreate(box.id, box.id, r, now), sessions: sessionsJson(r) } })).id;
  }
  return { status: 204, runId, box };
}

/** After a report's answer: the inventory, the panes, the pacer. Never throws. */
export async function afterReport(box: Instance & { user: User | null }, r: ToolUpdateReport): Promise<void> {
  void refreshHostInventory(box.id).catch(err => console.warn(`[TOOL-UPDATE] ${box.name}: inventory refresh failed: ${errMsg(err)}`));
  if (box.user) {
    try {
      const results = await relaunchReportedPanes(TOOL_REGISTRY[r.component], box, box.user, r.panes);
      const relaunched = results.filter(x => x.outcome === 'launched');
      if (results.length) console.log(`[TOOL-UPDATE] ${box.name}: relaunched ${relaunched.length} of ${results.length} reported pane(s): ${results.map(x => `${x.session}=${x.outcome}${x.resume === undefined ? '' : x.resume ? '(resume)' : '(fresh)'}`).join(' ')}`);
    } catch (err) {
      console.error(`[TOOL-UPDATE] ${box.name}: pane relaunch failed: ${errMsg(err)}`);
    }
  }
  if (queued.size) void pumpFleet();
}

export type PaneResult = { session: string; outcome: 'launched' | 'running' | 'busy' | 'unknown' | PaneSkip | 'parked-spawn' | 'chat-runner' | 'failed'; resume?: boolean };

/**
 * Relaunch exactly the reported agent panes of the tool's providers, each
 * through the launch path (ensureAgentSessionsAndLaunch), which probes first
 * and types only into a pane at a shell, honours a spawn's or a handoff's
 * claim on the pane, and takes the pane lock. `resume` only when the pane had
 * a conversation: the provider's resumeCommand (a bridge provider's, Codex's,
 * by the reported id), else a fresh launch. A parked
 * spawn stays parked, as reconnect reconstruction leaves it. One pane at a time.
 */
export async function relaunchReportedPanes(tool: ToolDescriptor, box: Pick<Instance, 'id' | 'name' | 'hostHome'>, owner: User, panes: ReportedPane[]): Promise<PaneResult[]> {
  if (!panes.some(p => p.role === 'agent')) return [];
  const projects = await prisma.project.findMany({
    where: { userId: owner.id, instanceId: box.id, archived: false },
    select: { id: true, name: true, workflows: { select: { type: true, provider: true, backend: true, model: true, workstream: { select: { name: true, askThread: { select: { id: true } } } } } } },
  });
  const plans = planRelaunches(panes, agentPaneIndex(projects, owner.unixUsername, owner.defaultAgentProvider ?? 'claude'), owner.unixUsername, tool.providers);
  const out: PaneResult[] = [];
  for (const plan of plans) {
    if (plan.action === 'skip') { if (plan.reason !== 'not-agent') out.push({ session: plan.session, outcome: plan.reason }); continue; }
    const t = plan.target;
    const provider = PROVIDERS[t.provider];
    if (provider?.chatRunner) { out.push({ session: plan.session, outcome: 'chat-runner' }); continue; }
    if (await isParkedSpawn(owner.id, t.projectId, t.workstream)) { out.push({ session: plan.session, outcome: 'parked-spawn' }); continue; }
    // A provider that resumes a conversation by id (Cursor) needs the id the box saw.
    const resume = plan.resume && (!!provider?.resumeCommand || (!!provider?.resumeById && !!plan.sessionId));
    try {
      const outcome = await ensureAgentSessionsAndLaunch({
        userId: owner.id, unixUsername: owner.unixUsername, projectName: t.projectName, provider: t.provider,
        instanceId: box.id, workstream: t.workstream, hostHome: box.hostHome, resume,
        // A bridge provider's pane (Codex) resumes the reported conversation by id.
        ...(resume && (provider?.needsBridge || provider?.resumeById) && plan.sessionId ? { resumeSessionId: plan.sessionId } : {}),
      });
      out.push({ session: plan.session, outcome, resume });
    } catch (err) {
      console.warn(`[TOOL-UPDATE] ${box.name}: relaunching ${plan.session} failed: ${errMsg(err)}`);
      out.push({ session: plan.session, outcome: 'failed' });
    }
  }
  return out;
}
