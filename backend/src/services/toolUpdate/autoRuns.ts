/**
 * Automatic tool updates, the leader work
 * ("Triggers": floor breach, connect after a resume, nightly). Every 15
 * minutes, and on a box's hello, each tool listed in AUTO_UPDATE is decided
 * for each ready owned box (auto.ts, autoUpdateDecision), and the runs it
 * decides are written and queued behind the fleet pacer (runs.ts
 * queueAutoRun, pumpFleet), so automatic runs never take the fleet past
 * FLEET_IN_FLIGHT. A pass queues at most the pacer's free slots, most urgent
 * first; the rest wait for the next pass, decided afresh, so a nightly run
 * never waits in the queue into the owner's morning.
 *
 * Off by default, per tool and per owner and box: with a tool's auto off
 * (its policy's mode is off or manual; missing or malformed, it is off), the
 * sweep reads nothing past the policy and writes nothing for it. Updating it
 * must be on too (mode not off): else a run would get restart none.
 */
import type { Instance, User } from '@prisma/client';
import { prisma } from '../../db';
import { instanceAgentTransport, isInstanceAgentConnected, onBoxAgentHello, type BoxAgentHelloEvent } from '../agentRegistry';
import { jsonVariation } from '../featureFlags';
import type { FlagBox } from '../featureFlags';
import { validTimeZone } from '../userTimeZone';
import { TOOL_REGISTRY, type ToolComponent, type ToolDescriptor, type ToolUpdatePolicy } from './components';
import { behindReference, slotsFree } from './fleet';
import { ORCHESTRATOR_HOST } from './orchestrator';
import { dropQueuedAutoRuns, expireStaleRuns, fleetInFlight, pumpFleet, queueAutoRun, queuedRuns, runInFlightFor } from './runs';
import { isInFlight } from './run';
import { resumeMarker } from './coldStart';
import { DEFAULT_NIGHTLY_SCHEDULE, SCHEDULE_FLAG, UNABLE, autoUpdateDecision, parseNightlySchedule, scheduleOverrides, scheduleText, type NightlySchedule, breachAfter, failedFloorRun, byPriority, liveBreachSince, nightlyClockStart, reasonText, resumePending, type Breach, type BreachEvent, type AutoDecision, type AutoFacts, type AutoReason, type AutoSkip, type FloorRunRow, type UnreachedAttempt } from './auto';

/**
 * The tools the sweep updates on its own, each when its descriptor's `auto`
 * says so for the owner and the box (components.ts, gate.ts): its policy
 * flag's mode is auto. A tool joins with one entry here;
 * a tool not listed is never updated
 * automatically.
 */
export const AUTO_UPDATE: readonly ToolComponent[] = [
  'claude', 'codex', 'cursor', 'devin', 'pi', 'gh', 'aws', 'node',
  // Python has no sessions (providers: []), so it takes the sessionless path
  // as gh and the AWS CLI do and needs no SWEEP_TRAITS entry: no quiet window,
  // never force, no resume run, and it restarts no agent.
  'python',
  // Docker is sessionless too, and updated only at the box's start: its runs
  // are queued for that start and take no pacer slot (runs.ts queueAutoRun).
  'docker',
];

/**
 * How the sweep treats a tool beyond its registry entry, for the few that
 * need it. `neverForce`: a floor breach never escalates to `force`. Node's
 * force would stop every Claude Code, Codex and pi session on the box at once
 * (its providers, components.ts), mid-turn, so its floor runs stay `idle`.
 * `restartsAgent`: its run restarts the termag agent whatever its restart
 * says (deploy/termag-node-update), so its never-quiet fallback needs the
 * owner's known night (#1163).
 */
export const SWEEP_TRAITS: Partial<Record<ToolComponent, { neverForce?: true; restartsAgent?: true }>> = {
  node: { neverForce: true, restartsAgent: true },
};

export const AUTO_UPDATE_SWEEP_MS = 15 * 60_000;
/** A box that just connected is left this long first: its session reconstruction starts 2 s after connect (as boxUpdate.ts waits). */
export const HELLO_SETTLE_MS = 60_000;

type BoxRow = Instance & { user: User | null };
const ldBox = (b: Pick<Instance, 'id' | 'name' | 'kind'>): FlagBox => ({ id: b.id, name: b.name, kind: b.kind });
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One box and tool in a pass: the run it got, or why not. `paced`: due, but the pacer had no slot this pass. */
export interface PassEntry {
  hostKey: string; boxName: string; owner: string; component: ToolComponent;
  outcome: 'queued' | 'paced' | 'claimed-elsewhere' | 'stopped' | AutoSkip;
  trigger?: string; restart?: string; reason?: string; runId?: string;
}

interface Candidate { tool: ToolDescriptor; box: BoxRow; facts: AutoFacts; breach: Breach | null; decision: Extract<AutoDecision, { run: true }>; target: string; reason: AutoReason }

let lastPass: { at: string; entries: PassEntry[] } | null = null;
/** The test schedule last logged per owner: the log says when one starts, changes or ends. */
const loggedSchedules = new Map<string, string>();
/** Bumped by every stop: a pass that started under an older one is a displaced leader's (Devin on #1163). */
let generation = 0;
/** The passes run one after another: the last one asked for, which the next waits on. */
let chain: Promise<unknown> = Promise.resolve();
/** A pass asked for and not finished, by what it covers: `*` the fleet, else one box's id. */
const pending = new Map<string, Promise<PassEntry[]>>();

/** How far back the sweep reads runs that never reached a box: past the longest backoff (BACKOFF_MAX_MS) several times over. */
const UNREACHED_WINDOW_MS = 7 * 24 * 3600_000;

/**
 * Per box, for the tool, of any trigger but the runner guard's (which only
 * enforces the floor): `reached`, the newest run its box started (its policy
 * fetch), and `unreached`, the runs asked for since then that never reached
 * it (expired unsent, or refused: a refusal may have been made before
 * anything was sent; Devin on #1163). AutoFacts lastRunAt, unreached.
 */
async function lastRuns(component: ToolComponent, hostKeys: string[], now: number): Promise<{ reached: Map<string, Date>; unreached: Map<string, UnreachedAttempt[]>; floorRuns: Map<string, FloorRunRow[]> }> {
  const base = { component, hostKey: { in: hostKeys }, trigger: { not: 'guard' } };
  const window = { gte: new Date(now - UNREACHED_WINDOW_MS) };
  const [reached, missed, floor] = await Promise.all([
    prisma.softwareUpdateRun.findMany({ where: { ...base, startedAt: { not: null } }, orderBy: { requestedAt: 'desc' }, distinct: ['hostKey'], select: { hostKey: true, requestedAt: true, startedAt: true } }),
    prisma.softwareUpdateRun.findMany({
      where: { ...base, startedAt: null, status: { in: ['expired', 'refused'] }, requestedAt: window },
      select: { hostKey: true, trigger: true, requestedAt: true },
    }),
    // The floor runs that reached a box, for the failing-floor backoff (failedFloorRun): which of them
    // left it below the floor depends on the box's current policy, so gather decides.
    prisma.softwareUpdateRun.findMany({
      where: { component, hostKey: { in: hostKeys }, trigger: 'floor', startedAt: { not: null }, requestedAt: window },
      select: { hostKey: true, requestedAt: true, startedAt: true, status: true, outcome: true, fromVersion: true, toVersion: true },
    }),
  ]);
  const floorRuns = new Map<string, FloorRunRow[]>();
  for (const r of floor) floorRuns.set(r.hostKey, [...(floorRuns.get(r.hostKey) ?? []), r]);
  // When it reached the box: its start, where a run waits days for it (Docker's, at the box's start;
  // Bugbot on #1305); for every other tool a moment after it was asked for.
  const last = new Map(reached.map(r => [r.hostKey, r.startedAt ?? r.requestedAt]));
  const unreached = new Map<string, UnreachedAttempt[]>();
  for (const r of missed) {
    // A run that reached the box since starts the backoff over (#1163).
    const since = last.get(r.hostKey);
    if (since && r.requestedAt.getTime() <= since.getTime()) continue;
    const list = unreached.get(r.hostKey) ?? [];
    list.push({ trigger: r.trigger, at: r.requestedAt });
    unreached.set(r.hostKey, list);
  }
  return { reached: last, unreached, floorRuns };
}

/**
 * The owner's nightly schedule (tool-auto-update-schedule, read for the
 * owner): today's when the flag is off, missing, malformed or unreadable.
 * Read once per owner per pass, and only for an owner with some tool's
 * flag on. A schedule that moves anything is logged when it changes, not
 * every pass.
 */
async function ownerSchedule(user: User): Promise<NightlySchedule> {
  let schedule: NightlySchedule;
  try {
    schedule = parseNightlySchedule(await jsonVariation(SCHEDULE_FLAG, user, null));
  } catch (err) {
    console.warn(`[TOOL-AUTO] ${user.unixUsername}: could not read ${SCHEDULE_FLAG}, keeping the default schedule: ${errMsg(err)}`);
    return DEFAULT_NIGHTLY_SCHEDULE;
  }
  const moved = scheduleOverrides(schedule);
  const text = moved.window || moved.every || moved.quiet ? `test schedule from ${SCHEDULE_FLAG}: ${scheduleText(schedule)} (${validTimeZone(user.timeZone) ?? 'no time zone'})` : null;
  if (text !== (loggedSchedules.get(user.id) ?? null)) {
    console.log(`[TOOL-AUTO] ${user.unixUsername}: ${text ?? `default schedule again (${SCHEDULE_FLAG} moves nothing)`}`);
    if (text) loggedSchedules.set(user.id, text); else loggedSchedules.delete(user.id);
  }
  return schedule;
}

/** Every host's version of the tool, the matrix's whole fleet: the reference "behind" is counted against. */
async function fleetInventory(tool: ToolDescriptor): Promise<Array<string | null>> {
  const rows = await prisma.hostSoftware.findMany({ where: { component: tool.inventoryName }, select: { version: true, ok: true } });
  return rows.map(r => (r.ok ? r.version : null));
}

async function inventory(tool: ToolDescriptor, hostKeys: string[]): Promise<Map<string, string | null>> {
  const rows = await prisma.hostSoftware.findMany({ where: { hostKey: { in: hostKeys }, component: tool.inventoryName }, select: { hostKey: true, version: true, ok: true } });
  return new Map(rows.map(r => [r.hostKey, r.ok ? r.version : null]));
}

/**
 * The facts for one box and tool, with its auto already on for it, from the
 * policy that decided that.
 * `settling`: connected under a minute ago, outside its hello's own pass.
 * Writes when the sweep first saw the box; the breach is written after the
 * pass (saveBreach), once it is known whether a floor run was queued.
 */
async function gather(tool: ToolDescriptor, box: BoxRow & { user: User }, policy: ToolUpdatePolicy, version: string | null, lastRunAt: Date | null, unreached: UnreachedAttempt[], floorRuns: FloorRunRow[], schedule: NightlySchedule, now: number, settled: boolean, fleetVersions: Array<string | null> = []) {
  // The policy the pass read for this box and tool decided auto; it decides enabled too.
  const updateOn = await tool.enabled(box.user, ldBox(box), policy);
  const nowDate = new Date(now);
  const key = { hostKey: box.id, component: tool.component };
  const prev = await prisma.toolAutoUpdateState.findUnique({ where: { hostKey_component: key } });
  // Every pass stamps lastSeenAt; a gap (the flag off, no leader) starts the nightly clock again.
  const firstSeenAt = nightlyClockStart(prev, nowDate);
  const state = await prisma.toolAutoUpdateState.upsert({
    where: { hostKey_component: key },
    create: { ...key, firstSeenAt, lastSeenAt: nowDate },
    update: { firstSeenAt, lastSeenAt: nowDate },
  });
  const breach: Breach | null = state.breachFloor ? { floor: state.breachFloor, since: state.breachSince, seenAt: state.breachSeenAt } : null;
  // A box that connected moments ago counts as not yet connected, unless this
  // is its hello's own pass, which has waited HELLO_SETTLE_MS already.
  const justConnected = !settled && (!!box.lastConnectedAt && now - box.lastConnectedAt.getTime() < HELLO_SETTLE_MS || helloedJustNow(box.id));
  const connected = isInstanceAgentConnected(box.id);
  const marker = resumeMarker(box);
  const facts: AutoFacts = {
    autoOn: true,
    updateOn,
    connected,
    settling: justConnected,
    capable: (instanceAgentTransport(box.id)?.capabilities ?? []).includes(tool.capability),
    inFlight: !!(await runInFlightFor(box.id, tool.component, now)),
    version,
    floor: policy.floor,
    // A tool updated at the box's start (Docker) compares with the newest in the fleet under latest, as the
    // Software tab's "behind" does: a box already there gets no run queued for its next start.
    reference: tool.atStart ? behindReference(policy.target, fleetVersions, tool.isVersion, tool.latestReference)
      : tool.isVersion(policy.target) ? policy.target : tool.latestReference ?? null,
    policyRestart: policy.restart,
    sessionless: tool.providers.length === 0,
    mayForce: !SWEEP_TRAITS[tool.component]?.neverForce,
    forceAfterHours: policy.forceAfterHours,
    breachSince: liveBreachSince(breach, policy.floor, now),
    // A resume from hibernation (the stored marker), else a cold start read from the row (coldStart.ts).
    resumed: connected && !!marker && resumePending(marker.at, lastRunAt, now),
    resumeKind: marker?.kind,
    resumedAt: marker?.at ?? null,
    lastRunAt,
    unreached,
    failedFloorRuns: floorRuns.filter(r => failedFloorRun(r, policy.floor, isInFlight(r, now))).map(r => r.requestedAt),
    restartsAgent: !!SWEEP_TRAITS[tool.component]?.restartsAgent,
    firstSeenAt: state.firstSeenAt,
    lastActivityAt: box.lastActivityAt,
    timeZone: validTimeZone(box.user.timeZone),
    schedule,
  };
  return { facts, policy, breach };
}

/** The breach record after the pass, written only when it changed. */
async function saveBreach(tool: ToolDescriptor, box: Pick<Instance, 'id'>, prev: Breach | null, facts: Pick<AutoFacts, 'version' | 'floor'>, event: BreachEvent, now: number): Promise<void> {
  const next = breachAfter(prev, facts.version, facts.floor, event, new Date(now));
  if (!next && !prev) return;
  await prisma.toolAutoUpdateState.update({
    where: { hostKey_component: { hostKey: box.id, component: tool.component } },
    data: { breachFloor: next?.floor ?? null, breachSince: next?.since ?? null, breachSeenAt: next?.seenAt ?? null },
  });
}

/**
 * One pass, over every ready owned box or only `onlyBox` (a hello). Never
 * throws for one box; returns what each box and tool got. Passes never
 * overlap, and none is dropped: each waits for the one before it. Only the
 * same request is shared: a fleet pass asked for while one is pending gets
 * that one, and so does a second hello of the same box. A hello's pass during
 * a fleet pass runs after it, so a box the fleet pass left as `settling` gets
 * its own pass (Bugbot on #1163).
 */
export function runAutoUpdateSweep(opts: { now?: number; onlyBox?: string } = {}): Promise<PassEntry[]> {
  const key = opts.onlyBox ?? '*';
  const already = pending.get(key);
  if (already) return already;
  const run = chain.then(() => sweep(opts.now ?? Date.now(), opts.onlyBox)).finally(() => { pending.delete(key); });
  pending.set(key, run);
  chain = run.catch(() => {});
  return run;
}

async function sweep(now: number, onlyBox?: string): Promise<PassEntry[]> {
  // The leader generation this pass belongs to: a stop while it runs ends it before it claims or sends anything (Devin on #1163).
  const gen = generation;
  const tools = AUTO_UPDATE;
  const entries: PassEntry[] = [];
  if (!tools.length) return entries;
  const boxes = (await prisma.instance.findMany({
    where: { status: 'ready', userId: { not: null }, ...(onlyBox ? { id: onlyBox } : {}) },
    include: { user: true }, orderBy: { name: 'asc' },
  // The orchestrator host's own Claude Code has its own nightly run (orchestrator.ts, phase 2e): never a box here.
  })).filter((b): b is BoxRow & { user: User } => !!b.user && b.id !== ORCHESTRATOR_HOST);
  if (!boxes.length) return entries;
  await expireStaleRuns(now);
  const candidates: Candidate[] = [];
  /**
   * Boxes with a resume marker some tool looked at this pass, and those where
   * a tool could not act on it yet: one that could not take a run (offline,
   * not capable, updates off), or whose run waits for a slot or failed to queue.
   */
  const resumeSeen = new Set<string>();
  const resumeWaits = new Set<string>();
  /** Each owner's nightly schedule, read once for the pass, on first need. */
  const schedules = new Map<string, Promise<NightlySchedule>>();
  const scheduleFor = (u: User): Promise<NightlySchedule> => {
    let s = schedules.get(u.id);
    if (!s) { s = ownerSchedule(u); schedules.set(u.id, s); }
    return s;
  };

  for (const component of tools) {
    const tool = TOOL_REGISTRY[component];
    const entry = (box: BoxRow & { user: User }, outcome: PassEntry['outcome']): PassEntry => ({ hostKey: box.id, boxName: box.name, owner: box.user.unixUsername, component, outcome });
    // The tool's auto first, per box: its inventory and run history are read only for the boxes it is
    // on for, and not at all when it is on for none, so a tool whose auto is off costs no query (Devin on #1294).
    // Its policy is read once here, and the same value decides auto, enabled and the run (gather).
    const on: Array<BoxRow & { user: User }> = [];
    const policies = new Map<string, ToolUpdatePolicy>();
    for (const box of boxes) {
      try {
        const ctx = ldBox(box);
        const policy = await tool.policy(box.user, ctx);
        if (await tool.auto(box.user, ctx, policy)) { on.push(box); policies.set(box.id, policy); }
        else entries.push(entry(box, 'auto-off'));
      } catch (err) {
        console.error(`[TOOL-AUTO] ${box.name}: ${tool.displayName}: deciding failed:`, errMsg(err));
        // A tool that could not even decide has not acted on a resume: the marker waits for a later pass (Bugbot on #1163).
        if (box.resumedFromHibernationAt) resumeWaits.add(box.id);
      }
    }
    if (!on.length) continue;
    const onIds = on.map(b => b.id);
    const [versions, runs] = await Promise.all([inventory(tool, onIds), lastRuns(component, onIds, now)]);
    // A tool updated at the box's start (Docker) compares with the whole fleet's newest, as the Software
    // tab's "behind" does, not only the boxes its auto flag is on for (Bugbot on #1305).
    const fleetVersions = tool.atStart ? await fleetInventory(tool) : [];
    for (const box of on) {
      try {
        const schedule = await scheduleFor(box.user);
        const { facts, policy, breach } = await gather(tool, box, policies.get(box.id)!, versions.get(box.id) ?? null, runs.reached.get(box.id) ?? null, runs.unreached.get(box.id) ?? [], runs.floorRuns.get(box.id) ?? [], schedule, now, !!onlyBox, fleetVersions);
        if (box.resumedFromHibernationAt) resumeSeen.add(box.id);
        // Its resume is not done until a run of it has reached the box since the marker, queued or not (resumePending; Bugbot on #1163).
        if (facts.resumed && !facts.sessionless) resumeWaits.add(box.id);
        const decision = autoUpdateDecision(facts, now);
        if (!decision.run) {
          entries.push(entry(box, decision.skip));
          const unable = UNABLE.includes(decision.skip);
          // A tool that could not take a run, or not yet, keeps the box's resume marker for a later pass (resumePending caps it at a day).
          if (unable || decision.skip === 'settling') resumeWaits.add(box.id);
          await saveBreach(tool, box, breach, facts, unable ? 'unable' : 'other', now);
          continue;
        }
        candidates.push({ tool, box, facts, breach, decision, target: policy.target, reason: decision.reason });
      } catch (err) {
        console.error(`[TOOL-AUTO] ${box.name}: ${tool.displayName}: deciding failed:`, errMsg(err));
        // A tool that could not even decide has not acted on a resume: the marker waits for a later pass (Bugbot on #1163).
        if (box.resumedFromHibernationAt) resumeWaits.add(box.id);
      }
    }
  }

  // The pacer's free slots, counted once for the pass: what is in flight and
  // what it already holds. The pacer recounts before each send.
  // (Only when there is something to queue: a pass with no candidate reads nothing more.)
  let free = candidates.length ? Math.max(0, slotsFree(await fleetInFlight(now)) - queuedRuns()) : 0;
  candidates.sort(byPriority);
  for (const c of candidates) {
    const base = { hostKey: c.box.id, boxName: c.box.name, owner: c.box.user!.unixUsername, component: c.tool.component, trigger: c.decision.trigger, restart: c.decision.restart };
    const reason = reasonText(c.reason, c.facts, now);
    if (gen !== generation) { entries.push({ ...base, outcome: 'stopped', reason }); resumeWaits.add(c.box.id); continue; }
    // A run of a tool updated at the box's start (Docker) is only written now: it takes no slot.
    if (free <= 0 && !c.tool.atStart) {
      entries.push({ ...base, outcome: 'paced', reason });
      resumeWaits.add(c.box.id);
      await saveBreach(c.tool, c.box, c.breach, c.facts, 'other', now).catch(err => console.warn(`[TOOL-AUTO] ${c.box.name}: could not record the breach: ${errMsg(err)}`));
      continue;
    }
    // A box that said hello while this fleet pass was gathering is settling now: its own hello pass decides it.
    if (!onlyBox && helloedJustNow(c.box.id)) {
      entries.push({ ...base, outcome: 'settling', reason });
      resumeWaits.add(c.box.id);
      continue;
    }
    try {
      const run = await queueAutoRun(c.tool, c.box, c.decision.trigger, c.decision.restart, c.target, reason, now);
      // The run is queued whatever becomes of the breach write: record it first, so the pacer is started for it (Devin on #1163).
      if (run) { if (!c.tool.atStart) free--; entries.push({ ...base, outcome: 'queued', reason, runId: run.id }); }
      await saveBreach(c.tool, c.box, c.breach, c.facts, run && c.decision.trigger === 'floor' ? 'attempted' : 'other', now)
        .catch(err => console.warn(`[TOOL-AUTO] ${c.box.name}: ${c.tool.displayName}: could not record the breach: ${errMsg(err)}`));
      if (!run) { entries.push({ ...base, outcome: 'claimed-elsewhere', reason }); continue; }
      console.log(`[TOOL-AUTO] ${c.box.name} (${c.box.user!.unixUsername}): ${c.tool.displayName} ${c.decision.trigger} run ${run.id}, restart ${c.decision.restart}: ${reason}`);
    } catch (err) {
      console.error(`[TOOL-AUTO] ${c.box.name}: ${c.tool.displayName}: queueing the run failed:`, errMsg(err));
      resumeWaits.add(c.box.id);
    }
  }

  // A resume marker is spent once no tool with its flag on still owes the box
  // its resume: each has had a run reach the box since the marker, or had
  // none due for another reason. A run only queued does not spend it, so one
  // that expires unsent (a leader restart) is asked for again. Kept while any
  // tool could not act yet. Cleared only if it is still the marker read, so a
  // newer resume keeps its own (Bugbot on #1163).
  for (const box of boxes) {
    if (gen !== generation) break;
    if (!resumeSeen.has(box.id) || resumeWaits.has(box.id)) continue;
    await prisma.instance.updateMany({ where: { id: box.id, resumedFromHibernationAt: box.resumedFromHibernationAt }, data: { resumedFromHibernationAt: null } })
      .catch(err => console.warn(`[TOOL-AUTO] ${box.name}: could not clear the resume marker: ${errMsg(err)}`));
  }

  if (gen === generation && entries.some(e => e.outcome === 'queued')) void pumpFleet();
  if (!onlyBox) lastPass = { at: new Date(now).toISOString(), entries };
  return entries;
}

// ── wiring ──────────────────────────────────────────────────────────────────

let sweepTimer: NodeJS.Timeout | null = null;
let unsubscribeHello: (() => void) | null = null;
const pendingHellos = new Set<NodeJS.Timeout>();
/**
 * When each box last said hello, on the process's own clock, as it arrives:
 * the row's lastConnectedAt is read once at the start of a fleet pass, so a
 * box that reconnects during the pass is caught here (Bugbot on #1163).
 */
const helloAt = new Map<string, number>();
const helloedJustNow = (id: string): boolean => { const t = helloAt.get(id); return t !== undefined && Date.now() - t < HELLO_SETTLE_MS; };

/** A box's hello: one pass over that box once it has settled, which is where a resumed box gets its run. */
function onHello(ev: BoxAgentHelloEvent, settleMs: number): void {
  helloAt.set(ev.instance.id, Date.now());
  // The connection that said hello: a box that reconnects during the wait
  // gets its own hello and its own full minute (Bugbot on #1163).
  const conn = instanceAgentTransport(ev.instance.id)?.conn ?? null;
  const timer = setTimeout(() => {
    pendingHellos.delete(timer);
    if (!sweepTimer || !isInstanceAgentConnected(ev.instance.id)) return;
    const live = instanceAgentTransport(ev.instance.id);
    if (!live || live.conn !== conn || live.agentCommit !== ev.agentCommit) return;
    runAutoUpdateSweep({ onlyBox: ev.instance.id }).catch(err => console.error(`[TOOL-AUTO] ${ev.instance.name}: hello pass failed:`, errMsg(err)));
  }, settleMs);
  timer.unref?.();
  pendingHellos.add(timer);
}

/**
 * Leader work (index.ts), as box-update's sweep is: only the process holding
 * a box's agent socket can send it the RPC, and the pacer's queue is in memory.
 */
export function startToolAutoUpdateSweep(opts: { sweepMs?: number; settleMs?: number } = {}): void {
  if (sweepTimer) return;
  const settleMs = opts.settleMs ?? HELLO_SETTLE_MS;
  unsubscribeHello = onBoxAgentHello(ev => onHello(ev, settleMs));
  sweepTimer = setInterval(() => {
    runAutoUpdateSweep().catch(err => console.error('[TOOL-AUTO] sweep failed:', errMsg(err)));
  }, opts.sweepMs ?? AUTO_UPDATE_SWEEP_MS);
  sweepTimer.unref?.();
}

export function stopToolAutoUpdateSweep(): void {
  // A pass still running belongs to the old generation and claims and sends nothing more.
  generation++;
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (unsubscribeHello) { unsubscribeHello(); unsubscribeHello = null; }
  for (const t of pendingHellos) clearTimeout(t);
  pendingHellos.clear();
  // And the automatic runs the pacer still holds are not sent from here (Devin on #1163).
  void dropQueuedAutoRuns().catch(err => console.error('[TOOL-AUTO] could not end the queued automatic runs:', errMsg(err)));
}

export const AUTO_TRIGGERS = ['floor', 'resume', 'nightly'] as const;

/**
 * For the admin MCP's software_summary: the automatic runs of the last day by
 * tool and trigger, the newest ten, and what this process's last full pass did.
 */
export async function autoUpdateSummary(now: number = Date.now()) {
  const since = new Date(now - 24 * 3600_000);
  const rows = await prisma.softwareUpdateRun.findMany({
    where: { trigger: { in: [...AUTO_TRIGGERS] }, requestedAt: { gte: since } },
    orderBy: { requestedAt: 'desc' },
    select: { id: true, hostKey: true, component: true, trigger: true, reason: true, restart: true, status: true, outcome: true, requestedAt: true },
  });
  const last24h: Record<string, Record<string, number>> = {};
  for (const r of rows) (last24h[r.component] ??= {})[r.trigger] = (last24h[r.component]?.[r.trigger] ?? 0) + 1;
  const counts: Record<string, number> = {};
  for (const e of lastPass?.entries ?? []) counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
  return {
    // Each tool's auto: its policy flag's mode.
    tools: AUTO_UPDATE.map(c => ({ component: c, policyFlag: TOOL_REGISTRY[c].policyFlag })),
    everyMinutes: AUTO_UPDATE_SWEEP_MS / 60_000,
    lastPass: lastPass ? { at: lastPass.at, outcomes: counts } : null,
    last24h,
    recent: rows.slice(0, 10).map(r => ({ ...r, requestedAt: r.requestedAt.toISOString() })),
    note: 'automatic runs are the floor, resume and nightly triggers; a floor run with no reason is the cloud-session runner backstop from before reasons were kept',
  };
}

/** Tests: forget the last pass. */
export function resetAutoUpdateForTests(): void {
  helloAt.clear();
  loggedSchedules.clear();
  lastPass = null;
  chain = Promise.resolve();
  pending.clear();
}
