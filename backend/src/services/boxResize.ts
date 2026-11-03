/**
 * Resize a box to another size (docs/box-provisioning.md, "Resizing a box").
 * The rules are boxResizePolicy.ts; this module checks them against the row
 * and the box's busy checks, takes the box's resize lock, and runs the job:
 *
 *   resuming  a hibernated box only: EC2 can't modify a hibernated instance,
 *             so it is resumed and then stopped plainly (its RAM is not kept)
 *   stopping  StopInstances, until the power sweep settles the row `stopped`
 *   resizing  ModifyInstanceAttribute to the size's type, skipping any type
 *             the box's zone doesn't offer
 *   starting  StartInstances; a capacity refusal retypes to the size's next
 *             type and starts again, and when every type is refused the box
 *             goes back to the type it had
 *   ready     its agent reconnected (the connect that settles `starting`)
 *
 * A box that was stopped or hibernated is retyped and left `stopped`. The
 * stops and starts go through requestPower (boxPower.ts) with `forResize`,
 * which every other power request is refused against while the lock holds,
 * so the sweep, an ask or the owner can't start a box being retyped.
 *
 * The job runs in the process that took the request. Its phases are written
 * to the row (any process's list reads them) and pushed to the owner's and the
 * actor's status sockets here (`box-resize` frames, plus the usual `workspace`
 * boxes change). A process that dies mid-resize leaves a lock that goes stale
 * after RESIZE_STALE_MS, and the view says the resize was cut off.
 */
import {
  DescribeInstancesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  EC2Client,
  ModifyInstanceAttributeCommand,
} from '@aws-sdk/client-ec2';
import type { Instance, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { awsClientConfig, getBoxConfig, isBoxProvisioningConfigured, isCapacityRefusal } from './boxProvisioner';
import { requestPower } from './boxPower';
import { busyBoxes, workingBoxes } from './boxLifecycle';
import { powerTimeoutsFromEnv } from './boxPowerPolicy';
import { boxEventDimensions } from './boxPowerEvents';
import { boxInUseFields } from './boxActivity';
import { boxSizeSpec, BOX_SIZES, type BoxSize } from './boxSize';
import {
  blockedRefusal,
  boxRefusal,
  hibernationAfterResize,
  isPermissionRefusal,
  RESIZE_MAX_MEMORY_GIB,
  RESIZE_MAX_VCPUS,
  RESIZE_NOT_PERMITTED_ERROR,
  RESIZE_STALE_MS,
  resizeTypeAllowed,
  resizeBlockers,
  resizePlan,
  resizeRefusal,
  resizeView,
  type Blocker,
  type ResizePhase,
  type ResizePlan,
  type ResizeRefusal,
  type ResizeView,
} from './boxResizePolicy';
import { advanceBoxEvent, createBoxEvent, finishBoxEvent, latestBoxEvent, type BoxEvent } from './boxEvents';
import { recordProductEvent } from './productEvents';
import { notifyWorkspaceChange } from './workspaceEvents';

export interface ResizeActor {
  userId: string;
  /** owner: the box's owner (the UIs, the CLI); admin: the Fleet tab, with a reason. */
  role: 'owner' | 'admin';
  reason?: string | null;
  /** Where it was asked, for the product event. */
  via: 'ui' | 'cli' | 'admin';
}

// ── The job, over injected effects ──────────────────────────────────────────

/** What the job does to the world. The Prisma/EC2 implementation is below; tests pass fakes. */
export interface ResizeEffects {
  /** Write the phase to the row and tell the browsers. */
  phase(phase: ResizePhase): Promise<void>;
  /** The instance's type and zone as EC2 has them now. */
  describe(): Promise<{ type: string; zone: string | null }>;
  /** Of `types`, the ones offered in `zone`, in order; all of them when that can't be asked. */
  offered(types: string[], zone: string | null): Promise<string[]>;
  /** A hibernated box: start it and wait until its agent is back (row `ready`). */
  resume(): Promise<void>;
  /** A running box: stop it and wait until the row is `stopped`. */
  stop(): Promise<void>;
  modify(type: string): Promise<void>;
  /** StartInstances; throws EC2's refusal (capacity, among others). */
  start(): Promise<void>;
  /** After start: wait until the agent reconnects (row `ready`). */
  waitReady(): Promise<void>;
  /**
   * A failed resize of a box that was down: stop it if it is up or coming up
   * (ready, starting), and wait for that; false when it was already down.
   */
  stopIfUp(): Promise<boolean>;
}

export interface ResizeOutcome {
  outcome: 'ready' | 'stopped' | 'failed';
  /** The type the instance has at the end, as far as the job knows; null when it never found out. */
  type: string | null;
  fromType: string | null;
  /** Whether the box is now of the size asked for (its type is one of the size's). */
  resized: boolean;
  /** A fallback type was used: the size's first type had no capacity or isn't offered there. */
  fallback: boolean;
  /** Every type of the size was refused, and the box went back to its old type. */
  reverted: boolean;
  error: string | null;
}

/**
 * The steps, in order, for one plan. Never throws: a failure is an outcome,
 * after a best-effort start of a box that was running, so a failed resize
 * doesn't leave a running box down.
 */
export async function runResize(plan: ResizePlan, fx: ResizeEffects): Promise<ResizeOutcome> {
  let fromType: string | null = null;
  let current: string | null = null;
  let stopped = false;
  // A hibernated box is resumed to be stopped plainly: once that has begun, a
  // failure before the stop takes must put it down again (Bugbot on #877).
  let woken = false;
  const tried: string[] = [];
  const done = (o: Partial<ResizeOutcome> & Pick<ResizeOutcome, 'outcome'>): ResizeOutcome => ({
    type: current, fromType, resized: false, fallback: false, reverted: false, error: null, ...o,
  });
  try {
    const described = await fx.describe();
    fromType = current = described.type;
    const candidates = await fx.offered(plan.types, described.zone);
    if (candidates.length === 0) {
      return done({ outcome: 'failed', error: `None of ${plan.to}'s types (${plan.types.join(', ')}) is both within the resize cap and offered in ${described.zone ?? 'the box\'s zone'}` });
    }
    if (plan.fromStatus === 'hibernated') {
      await fx.phase('resuming');
      woken = true;
      await fx.resume();
    }
    if (plan.fromStatus !== 'stopped') {
      await fx.phase('stopping');
      await fx.stop();
    }
    stopped = true;

    if (!plan.startAfter) {
      await fx.phase('resizing');
      if (candidates[0] !== current) { await fx.modify(candidates[0]); current = candidates[0]; }
      await fx.phase('stopped');
      return done({ outcome: 'stopped', resized: true, fallback: candidates[0] !== plan.types[0] });
    }

    for (const type of candidates) {
      await fx.phase('resizing');
      if (type !== current) { await fx.modify(type); current = type; }
      await fx.phase('starting');
      try {
        await fx.start();
      } catch (err) {
        if (!isCapacityRefusal(err)) throw err;
        tried.push(type);
        console.warn(`[RESIZE] no capacity for ${type}: ${errMsg(err)}; trying the next type`);
        continue;
      }
      stopped = false;
      await fx.waitReady();
      await fx.phase('ready');
      return done({ outcome: 'ready', resized: true, fallback: type !== plan.types[0] });
    }

    // No type of the size could start: put the box back as it was.
    await fx.phase('resizing');
    if (fromType && current !== fromType) { await fx.modify(fromType); current = fromType; }
    await fx.phase('starting');
    await fx.start();
    stopped = false;
    await fx.waitReady();
    await fx.phase('failed');
    return done({
      outcome: 'failed', reverted: true,
      error: `EC2 had no capacity for ${tried.join(', ')}; the box is back on ${fromType} and running. Try again later.`,
    });
  } catch (err) {
    const message = isPermissionRefusal(err) ? RESIZE_NOT_PERMITTED_ERROR : errMsg(err);
    let back = '';
    if (stopped && plan.startAfter) {
      // The box was up when asked; leave it up on whatever type it has.
      try {
        await fx.start();
        back = ' It was started again';
        try { await fx.waitReady(); back += ' and is running'; } catch { back += ', but its agent has not reconnected yet'; }
        back += `, on ${current ?? 'its old type'}.`;
      } catch (startErr) {
        back = ` It is stopped (starting it again failed: ${errMsg(startErr)}).`;
      }
    } else if (woken && !stopped) {
      // It was down when asked, and the resume may have brought it up: stop it.
      try {
        back = await fx.stopIfUp() ? ' It was resumed for the resize, and stopped again.' : '';
      } catch (stopErr) {
        back = ` It may still be running (stopping it again failed: ${errMsg(stopErr)}).`;
      }
    }
    await fx.phase('failed').catch(() => {});
    // A modify that went through retyped the box whatever failed after it
    // (the start, the agent's reconnect), so the row must say its new size.
    const resized = !!current && current !== fromType && plan.types.includes(current);
    return done({ outcome: 'failed', resized, fallback: resized && current !== plan.types[0], error: `${message}${back}` });
  }
}

// ── The Prisma + EC2 effects ────────────────────────────────────────────────

const POLL_MS = 3_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function ec2For(box: Pick<Instance, 'region'>): EC2Client {
  const cfg = getBoxConfig();
  if (!cfg) throw new Error('Box provisioning is not configured');
  return new EC2Client(awsClientConfig(cfg, box.region ?? cfg.region));
}

async function row(id: string): Promise<Instance> {
  return prisma.instance.findUniqueOrThrow({ where: { id } });
}

/** Poll the row until `ok` says so; `fail` names a status that ends the wait as a failure. */
async function waitFor(id: string, what: string, ok: (s: string) => boolean, fail: (s: string) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const box = await row(id);
    if (ok(box.status)) return;
    if (fail(box.status)) throw new Error(`${what} did not take: the box is ${box.status}${box.provisioningError ? ` (${box.provisioningError})` : ''}`);
    if (Date.now() >= deadline) throw new Error(`${what} did not finish within ${Math.round(timeoutMs / 60_000)} minutes (the box is ${box.status})`);
    await sleep(POLL_MS);
  }
}

type Push = (frame: BoxResizeFrame, userIds: string[]) => void;
let push: Push | null = null;

/** A `box-resize` frame on the status socket: where a resize is, for the owner's and the actor's browsers. */
export interface BoxResizeFrame {
  type: 'box-resize';
  instanceId: string;
  resize: ResizeView | null;
}

/** index.ts wires this to the status sockets. */
export function setBoxResizePush(cb: Push | null): void {
  push = cb;
}

function tell(box: Pick<Instance, 'id' | 'userId'>, actorId: string, view: ResizeView | null): void {
  const to = [...new Set([box.userId, actorId].filter((x): x is string => !!x))];
  try { push?.({ type: 'box-resize', instanceId: box.id, resize: view }, to); } catch (err) {
    console.error('[RESIZE] push failed:', errMsg(err));
  }
  if (box.userId) notifyWorkspaceChange(box.userId, 'boxes');
}

export function prismaResizeEffects(box: Instance, actorId: string, eventId: string): ResizeEffects {
  const timeouts = powerTimeoutsFromEnv();
  const ec2 = ec2For(box);
  const id = box.id;
  const InstanceId = box.ec2InstanceId!;
  return {
    async phase(phase) {
      // The end (ready, stopped, failed) is finishResize's to write, with the outcome.
      if (phase === 'ready' || phase === 'stopped' || phase === 'failed') return;
      tell(box, actorId, resizeView(await advanceBoxEvent(eventId, phase)));
    },
    async describe() {
      const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [InstanceId] }));
      const inst = out.Reservations?.[0]?.Instances?.[0];
      if (!inst?.InstanceType) throw new Error(`EC2 does not describe ${InstanceId}`);
      return { type: inst.InstanceType, zone: inst.Placement?.AvailabilityZone ?? null };
    },
    async offered(sizeTypes, zone) {
      // The cap first (resizeTypeAllowed): a type past it is never asked of EC2.
      const info = await typeInfo(box, sizeTypes);
      const types = sizeTypes.filter(t => resizeTypeAllowed(t, info.get(t)));
      if (types.length < sizeTypes.length) {
        console.log(`[RESIZE] ${box.name}: skipping ${sizeTypes.filter(t => !types.includes(t)).join(', ')} (past the resize cap of ${RESIZE_MAX_VCPUS} vCPU / ${RESIZE_MAX_MEMORY_GIB} GiB, or not m/r Graviton)`);
      }
      if (!zone || types.length === 0) return types;
      try {
        const out = await ec2.send(new DescribeInstanceTypeOfferingsCommand({
          LocationType: 'availability-zone',
          Filters: [{ Name: 'location', Values: [zone] }, { Name: 'instance-type', Values: types }],
        }));
        const here = new Set((out.InstanceTypeOfferings ?? []).map(o => o.InstanceType as string));
        return types.filter(t => here.has(t));
      } catch (err) {
        // Not being able to ask is not "none offered": the start's own refusal walks on.
        console.warn(`[RESIZE] ${box.name}: DescribeInstanceTypeOfferings failed (${errMsg(err)}); trying every type`);
        return types;
      }
    },
    async resume() {
      await requestPower(await row(id), 'start', { forResize: true, startedBy: 'resize' });
      await waitFor(id, 'The resume', s => s === 'ready', s => s === 'hibernated' || s === 'stopped' || s === 'failed', timeouts.startMs);
    },
    async stop() {
      await requestPower(await row(id), 'stop', { forResize: true, sleepBy: 'resize' });
      // The power sweep settles the row from EC2's state; a stop that times out goes back to ready.
      await waitFor(id, 'The stop', s => s === 'stopped', s => s === 'ready' || s === 'failed', timeouts.stopMs + 2 * 60_000);
    },
    async modify(type) {
      await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId, InstanceType: { Value: type } }));
      console.log(`[RESIZE] ${box.name}: instance type set to ${type}`);
      await prisma.instance.update({ where: { id }, data: { instanceType: type } });
    },
    async start() {
      await requestPower(await row(id), 'start', { forResize: true, startedBy: 'resize' });
    },
    async waitReady() {
      await waitFor(id, 'The start', s => s === 'ready', s => s === 'stopped' || s === 'failed', timeouts.startMs);
    },
    async stopIfUp() {
      const now = await row(id);
      if (now.status !== 'ready' && now.status !== 'starting' && now.status !== 'stopping') return false;
      if (now.status !== 'stopping') await requestPower(now, 'stop', { forResize: true, sleepBy: 'resize' });
      await waitFor(id, 'The stop', s => s === 'stopped', s => s === 'ready' || s === 'failed', timeouts.stopMs + 2 * 60_000);
      return true;
    },
  };
}

/**
 * Before the box is touched: can this orchestrator set `type` at all? EC2
 * authorizes a dry run before it checks the instance's state, so a running
 * box answers DryRunOperation (allowed) or IncorrectInstanceState (allowed,
 * not now), and a missing grant UnauthorizedOperation.
 */
export async function canModifyType(box: Instance, type: string): Promise<boolean> {
  try {
    await ec2For(box).send(new ModifyInstanceAttributeCommand({ InstanceId: box.ec2InstanceId!, InstanceType: { Value: type }, DryRun: true }));
    return true;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'DryRunOperation' || name === 'IncorrectInstanceState') return true;
    if (isPermissionRefusal(err)) return false;
    throw err;
  }
}

interface TypeInfo { memoryMiB: number; vcpus: number; hibernationSupported: boolean }

async function typeInfo(box: Instance, types: string[]): Promise<Map<string, TypeInfo>> {
  const out = new Map<string, TypeInfo>();
  try {
    const res = await ec2For(box).send(new DescribeInstanceTypesCommand({ InstanceTypes: types as any }));
    for (const t of res.InstanceTypes ?? []) {
      if (t.InstanceType) {
        out.set(t.InstanceType, { memoryMiB: t.MemoryInfo?.SizeInMiB ?? 0, vcpus: t.VCpuInfo?.DefaultVCpus ?? 0, hibernationSupported: !!t.HibernationSupported });
      }
    }
  } catch (err) {
    console.warn(`[RESIZE] ${box.name}: DescribeInstanceTypes failed: ${errMsg(err)}`);
  }
  return out;
}

// ── Entry points ────────────────────────────────────────────────────────────

/** The sizes a resize offers: every one, whatever box-default-size says (the flag only gates new boxes' pickers). */
export function resizeSizes(env: NodeJS.ProcessEnv = process.env) {
  return BOX_SIZES.map(size => {
    const spec = boxSizeSpec(size, env);
    return { size, vcpus: spec.vcpus, memoryGiB: spec.memoryGiB, instanceType: spec.types[0] };
  });
}

/** What the pickers show (GET …/resize): the sizes, the current one, the resize, and what would block one now. */
export interface ResizeInfo {
  box: { id: string; name: string; status: string; size: string | null; instanceType: string | null; hibernationConfigured: boolean };
  sizes: ReturnType<typeof resizeSizes>;
  resize: ResizeView | null;
  /** Why no resize is possible now (any size); null when one is. */
  refusal: ResizeRefusal | null;
  blockers: Blocker[];
}

async function blockersFor(box: Instance): Promise<Blocker[]> {
  if (box.status !== 'ready') return [];
  const busy = (await busyBoxes([box.id])).get(box.id) ?? [];
  return resizeBlockers(box, { busy, working: workingBoxes().has(box.id) });
}

export async function resizeInfo(box: Instance): Promise<ResizeInfo> {
  const last = await latestBoxEvent(box.id, 'resize');
  return {
    box: { id: box.id, name: box.name, status: box.status, size: box.size, instanceType: box.instanceType, hibernationConfigured: box.hibernationConfigured },
    sizes: resizeSizes(),
    resize: resizeView(last),
    refusal: boxRefusal(box, last, isBoxProvisioningConfigured()),
    blockers: await blockersFor(box),
  };
}

export type StartResizeResult =
  | { ok: true; status: 202; resize: ResizeView }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Check, lock and start a resize of `box` to `size`. Answers at once: 202
 * with the resize as it starts, or the refusal. The job carries on after.
 */
export async function startResize(
  box: Instance, size: unknown, actor: ResizeActor, opts: { force?: boolean; nowMs?: number } = {},
): Promise<StartResizeResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const refused = resizeRefusal(box, await latestBoxEvent(box.id, 'resize'), size, isBoxProvisioningConfigured(), nowMs);
  if (refused) return { ok: false, status: refused.status, body: { error: refused.error, code: refused.code } };
  const to = size as BoxSize;
  const blocked = blockedRefusal(await blockersFor(box), opts.force === true);
  if (blocked) {
    return { ok: false, status: blocked.status, body: { error: blocked.error, code: blocked.code, blockers: blocked.blockers, forceable: blocked.forceable } };
  }

  const plan = resizePlan(box, to, boxSizeSpec(to).types);
  if (!await canModifyType(box, plan.types.find(t => resizeTypeAllowed(t)) ?? plan.types[0])) {
    return { ok: false, status: 503, body: { error: RESIZE_NOT_PERMITTED_ERROR, code: 'resize_not_permitted' } };
  }

  // The lock: a new `resize` row in box_events, taken with the box's row
  // locked (FOR UPDATE), so two requests for one box line up and the second
  // finds the first's open row. The box must still be in the status the
  // checks above read.
  const taken = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM instances WHERE id = ${box.id} FOR UPDATE`;
    const current = await tx.instance.findUnique({ where: { id: box.id } });
    const last = await tx.boxEvent.findFirst({ where: { boxId: box.id, kind: 'resize' }, orderBy: { startedAt: 'desc' } });
    const again = current && boxRefusal(current, last, true, nowMs);
    if (!current || again || current.status !== box.status) {
      return { refused: again ?? { status: 409, code: 'conflict', error: 'The box changed while the resize was being asked for; reload and try again' } };
    }
    const event = await createBoxEvent({
      box, kind: 'resize', actorId: actor.userId, actorRole: actor.role, reason: actor.reason, from: box.size, to,
      detail: { fromStatus: box.status, fromType: box.instanceType, via: actor.via, forced: opts.force === true },
      startedAt: new Date(nowMs),
    }, tx);
    // The owner resizing a running box is using it: the idle clock restarts
    // here, as their Start would, or the sweep could park the box minutes
    // after it comes back (Bugbot on #877). An admin's resize isn't the
    // owner's activity, and a box that stays down has no idle clock running.
    if (actor.role === 'owner' && box.status === 'ready') {
      await tx.instance.update({ where: { id: box.id }, data: boxInUseFields(box.id, nowMs) });
    }
    return { event };
  });
  if ('refused' in taken) {
    const r = taken.refused!;
    return { ok: false, status: r.status, body: { error: r.error, code: r.code } };
  }

  const event = taken.event;
  console.log(`[RESIZE] ${box.name} (${box.userId ?? 'pool'}): ${box.size ?? box.instanceType ?? '?'} -> ${to}, ${box.status}, `
    + `by ${actor.role} ${actor.userId}${actor.reason ? ` (reason: ${actor.reason.trim().slice(0, 200)})` : ''}${opts.force ? ', forced' : ''} (event ${event.id})`);
  tell(box, actor.userId, resizeView(event));
  void finishResize(box, event, plan, actor, opts.force === true);
  return { ok: true, status: 202, resize: resizeView(event)! };
}

async function finishResize(box: Instance, event: BoxEvent, plan: ResizePlan, actor: ResizeActor, forced: boolean): Promise<void> {
  const startedAt = Date.now();
  let result: ResizeOutcome;
  try {
    result = await runResize(plan, prismaResizeEffects(box, actor.userId, event.id));
  } catch (err) {
    result = { outcome: 'failed', type: null, fromType: null, resized: false, fallback: false, reverted: false, error: errMsg(err) };
  }

  const data: Prisma.InstanceUpdateInput = {};
  if (result.type) data.instanceType = result.type;
  if (result.resized) {
    data.size = plan.to;
    // Launched as a pool box, it now differs from what its pool spec hash says.
    data.poolSpecHash = null;
    if (box.hibernationConfigured && result.type && result.fromType && result.type !== result.fromType) {
      const info = await typeInfo(box, [result.fromType, result.type]);
      const keeps = hibernationAfterResize(result.fromType, result.type, info);
      if (keeps === false) {
        data.hibernationConfigured = false;
        console.log(`[RESIZE] ${box.name}: ${result.type} has more RAM than its root's swap file holds, or can't hibernate; it stops instead of hibernating from now on`);
      } else if (keeps === null) {
        console.warn(`[RESIZE] ${box.name}: no memory for ${result.fromType} or ${result.type}; hibernation left as it was`);
      }
    }
  }
  await prisma.instance.update({ where: { id: box.id }, data }).catch(err => console.error(`[RESIZE] ${box.name}: final write failed:`, errMsg(err)));
  const closed = await finishBoxEvent(event.id, {
    phase: result.outcome === 'failed' ? 'failed' : 'done',
    error: result.error,
    detail: {
      end: result.outcome, toType: result.type, ...(result.fromType ? { fromType: result.fromType } : {}), resized: result.resized,
      fallback: result.fallback, reverted: result.reverted, durationSec: Math.round((Date.now() - startedAt) / 1000),
      ...(data.hibernationConfigured === false ? { lostHibernation: true } : {}),
    },
  }).catch(err => { console.error(`[RESIZE] ${box.name}: closing event ${event.id} failed:`, errMsg(err)); return null; });
  tell(box, actor.userId, closed ? resizeView(closed) : null);

  recordProductEvent('box.resize', { user: actor.userId, box: box.id }, {
    ...boxEventDimensions(box),
    from: plan.from ?? 'configured', to: plan.to, fromType: result.fromType, toType: result.type,
    actor: actor.role, via: actor.via, startState: plan.fromStatus, forced,
    outcome: result.outcome, fallback: result.fallback, reverted: result.reverted,
    durationSec: Math.round((Date.now() - startedAt) / 1000),
  });
  console.log(`[RESIZE] ${box.name}: ${result.outcome}${result.type ? ` on ${result.type}` : ''} after ${Math.round((Date.now() - startedAt) / 1000)}s`
    + (result.error ? `: ${result.error}` : ''));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
