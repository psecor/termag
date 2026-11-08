/**
 * Resizing a box: the pure decisions. `boxResize.ts` owns the EC2 calls, the
 * row writes and the job; this module only decides, so every rule is a unit
 * test (docs/box-provisioning.md, "Resizing a box").
 *
 * A resize takes a box to another size (small, medium, large; never a raw
 * type): stop it, ModifyInstanceAttribute to the size's type, start it, wait
 * for its agent. A hibernated box is resumed and stopped plainly first,
 * because EC2 can't modify a hibernated instance. A box that was down
 * (stopped or hibernated) is retyped and left stopped. Who may: the box's
 * owner, and an admin for any box with a reason (the admin audit log keeps
 * it). One resize per box at a time.
 */
import { BOX_SIZES, isBoxSize, type BoxSize } from './boxSize';
import { RESIZE_STALE_MS } from './boxResizeLock';

export { RESIZE_STALE_MS };

/** A `resize` row of box_events (services/boxEvents.ts), as far as these rules read it. */
export interface ResizeEventRow {
  startedAt: Date;
  finishedAt: Date | null;
  from?: string | null;
  to?: string | null;
  phase: string;
  error?: string | null;
  actorRole?: string;
  reason?: string | null;
  detail?: unknown;
}

/** Whether the row is a resize still running: not finished, not stale. */
export function resizeInFlight(row: Pick<ResizeEventRow, 'startedAt' | 'finishedAt'> | null | undefined, nowMs = Date.now()): boolean {
  if (!row || row.finishedAt) return false;
  return nowMs - row.startedAt.getTime() < RESIZE_STALE_MS;
}

/**
 * Where a resize is. `disk` only while the box's disk grows (the owner asked
 * for both, services/boxDisk.ts): the resize waits for it before it stops the
 * box. `resuming` only for a hibernated box; `ready` (back up
 * on the new size), `stopped` (it was down, and stays down) and `failed` are
 * where one ends, and the row keeps the last one until the next resize.
 */
export type ResizePhase = 'disk' | 'resuming' | 'stopping' | 'resizing' | 'starting' | 'ready' | 'stopped' | 'failed';
export const RESIZE_RUNNING_PHASES: readonly ResizePhase[] = ['disk', 'resuming', 'stopping', 'resizing', 'starting'];

/** A warm-pool claim's on-claim run (dotfiles, keys) still counts as in flight for this long. */
export const CLAIM_IN_FLIGHT_MS = 30 * 60 * 1000;

export const RESIZE_SIZE_ERROR = `size must be one of ${BOX_SIZES.join(', ')}`;

export interface ResizeRefusal {
  status: number;
  code: string;
  error: string;
}

export interface ResizeAccessBox {
  userId: string | null;
}

/**
 * Who may ask. `owner`: the cookie and CLI routes, for the caller's own box;
 * anyone else's box answers 404 like a missing one. `admin`: the Fleet tab,
 * any box, with a reason, which the admin audit log records.
 */
export function resizeAccess(
  box: ResizeAccessBox | null,
  caller: { id: string; isAdmin: boolean },
  surface: 'owner' | 'admin',
  reason?: unknown,
): ResizeRefusal | null {
  const notFound = { status: 404, code: 'not_found', error: 'Box not found' };
  if (surface === 'owner') return !box || box.userId !== caller.id ? notFound : null;
  if (!caller.isAdmin || !box) return notFound;
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    return { status: 400, code: 'reason_required', error: 'Say why you are resizing someone\'s box (reason); the audit log keeps it' };
  }
  return null;
}

export interface ResizeBox {
  userId: string | null;
  kind: string;
  status: string;
  ec2InstanceId: string | null;
  size: string | null;
  autoTerminatedAt?: Date | null;
}

/** The statuses a resize starts from: up, or down in either way. */
export const RESIZE_FROM_STATUSES = ['ready', 'stopped', 'hibernated'] as const;

/** Why this box can't go to `size` at all, whatever is running on it; null when it can. */
export function resizeRefusal(
  box: ResizeBox, open: ResizeEventRow | null, size: unknown, provisioningConfigured: boolean, nowMs = Date.now(),
): ResizeRefusal | null {
  if (!isBoxSize(size)) return { status: 400, code: 'invalid_size', error: RESIZE_SIZE_ERROR };
  const fixed = boxRefusal(box, open, provisioningConfigured, nowMs);
  if (fixed) return fixed;
  if (box.size === size) return { status: 409, code: 'same_size', error: `${box.size} is already this box's size` };
  return null;
}

/**
 * resizeRefusal without the size: what the pickers show before one is chosen.
 * `open` is the box's latest resize row: one still running refuses (409).
 */
export function boxRefusal(box: ResizeBox, open: ResizeEventRow | null, provisioningConfigured: boolean, nowMs = Date.now()): ResizeRefusal | null {
  if (box.kind !== 'ec2') return { status: 400, code: 'not_ec2', error: 'Only an EC2 box termag runs can be resized from termag' };
  // A pool box is sized by the pool (box-warm-pool-sizes); resizing one would
  // hand a claimer a box whose spec hash says another size.
  if (!box.userId) return { status: 409, code: 'pool_box', error: 'An unclaimed warm-pool box is not resized; the pool holds the sizes box-warm-pool-sizes asks for' };
  if (!provisioningConfigured) return { status: 503, code: 'not_configured', error: 'Box provisioning is not configured on this orchestrator' };
  if (!box.ec2InstanceId) return { status: 409, code: 'no_instance', error: 'This box has no EC2 instance yet' };
  if (box.autoTerminatedAt) return { status: 409, code: 'terminating', error: 'This box is being terminated automatically' };
  if (resizeInFlight(open, nowMs)) {
    return { status: 409, code: 'resize_running', error: `This box is already being resized${open?.to ? ` to ${open.to}` : ''}; one resize at a time` };
  }
  if (!(RESIZE_FROM_STATUSES as readonly string[]).includes(box.status)) {
    return { status: 409, code: 'box_changing', error: `This box is ${box.status}; resize it once it is running, stopped or hibernated` };
  }
  return null;
}

export interface Blocker {
  /** The busy check's name (boxLifecycle.ts registerBoxBusyCheck), or `working` / `claim`. */
  check: string;
  reason: string;
  /** A running turn and the like may be stopped on purpose (force); a claim or a box update may not. */
  forceable: boolean;
}

const BLOCKER_TEXT: Record<string, { reason: string; forceable: boolean }> = {
  working: { reason: 'an agent is working on it, and its turn stops', forceable: true },
  'ask-run': { reason: 'an ask is running on it, and its turn stops', forceable: true },
  'claude-runner': { reason: 'a cloud session is running on it, and stops', forceable: true },
  ssh: { reason: 'an SSH or SSM session is open to it', forceable: true },
  tunnels: { reason: 'a port forward to it is open', forceable: true },
  'host-load': { reason: 'it has been busy (high load) for the last half hour', forceable: true },
  'box-update': { reason: 'a box update is running on it; powering it off now could leave its agent unable to start', forceable: false },
};

export interface BlockerBox {
  status: string;
  onClaimStatus?: string | null;
  claimedAt?: Date | null;
}

/**
 * What stands in the way on a running box: `busy` is every busy check that
 * reports it (boxLifecycle.busyBoxes), `working` an agent status of working
 * on it. A box that is down has nothing running, so nothing blocks it.
 */
export function resizeBlockers(box: BlockerBox, facts: { busy: readonly string[]; working: boolean }, nowMs = Date.now()): Blocker[] {
  if (box.status !== 'ready') return [];
  const out: Blocker[] = [];
  const claiming = (box.onClaimStatus === 'pending' || box.onClaimStatus === 'running')
    && !!box.claimedAt && nowMs - box.claimedAt.getTime() < CLAIM_IN_FLIGHT_MS;
  if (claiming) out.push({ check: 'claim', reason: 'it is still being set up for its owner after a warm-pool claim', forceable: false });
  if (facts.working) out.push({ check: 'working', ...BLOCKER_TEXT.working });
  for (const check of new Set(facts.busy)) {
    // A growing disk doesn't block a resize: the resize waits for the grow before it stops the box (boxResize.runResize).
    if (check === 'disk-grow') continue;
    const known = BLOCKER_TEXT[check];
    if (known) out.push({ check, ...known });
    // A check that failed counts as busy (boxLifecycle.busyBoxes), but only a person can say it isn't.
    else if (check.endsWith('-failed')) out.push({ check, reason: `termag could not check ${check.slice(0, -'-failed'.length)} on it`, forceable: true });
    else out.push({ check, reason: `it is busy (${check})`, forceable: true });
  }
  return out;
}

/** Null to go ahead; else the 409 the caller answers, with what blocks it and whether `force` would help. */
export function blockedRefusal(blockers: readonly Blocker[], force: boolean): (ResizeRefusal & { blockers: Blocker[]; forceable: boolean }) | null {
  if (blockers.length === 0) return null;
  const hard = blockers.filter(b => !b.forceable);
  if (hard.length === 0 && force) return null;
  const forceable = hard.length === 0;
  const list = (hard.length ? hard : blockers).map(b => b.reason).join('; ');
  return {
    status: 409, code: 'box_busy', blockers: [...blockers], forceable,
    error: forceable
      ? `Resizing stops this box for two to three minutes, and ${list}. Confirm (force) to resize anyway.`
      : `Can't resize this box right now: ${list}. Try again once that is done.`,
  };
}

export interface ResizePlan {
  to: BoxSize;
  from: BoxSize | null;
  /** The box's status when asked: what it is resumed or stopped from, and whether it comes back up. */
  fromStatus: 'ready' | 'stopped' | 'hibernated';
  /** The size's types, the first preferred (boxSize.boxSizeSpec). */
  types: string[];
  /** Only a box that was running comes back up; a stopped or hibernated one is left stopped. */
  startAfter: boolean;
}

export function resizePlan(box: { status: string; size: string | null }, to: BoxSize, types: string[]): ResizePlan {
  const fromStatus = box.status as ResizePlan['fromStatus'];
  return { to, from: isBoxSize(box.size) ? box.size : null, fromStatus, types: [...types], startAfter: fromStatus === 'ready' };
}

/** A type's RAM in MiB by its name, for the resize families only (4 GiB per vCPU in m, 8 in r; xlarge is 4 vCPU); null for any other. */
export function typeMemoryByName(type: string): number | null {
  const m = /^([mr])[78]g\.(medium|large|xlarge|(\d+)xlarge)$/.exec(type);
  if (!m) return null;
  const vcpus = m[2] === 'medium' ? 1 : m[2] === 'large' ? 2 : m[2] === 'xlarge' ? 4 : 4 * Number(m[3]);
  return vcpus * (m[1] === 'm' ? 4 : 8) * 1024;
}

/**
 * Whether a box that hibernates still can after its type changed from
 * `fromType` to `toType`. A hibernation-capable box launched with its root
 * grown by its RAM for hibinit-agent's swap file
 * (boxProvisioner.planHibernation), so a type with more RAM than it launched
 * with, or one that can't hibernate, would make every hibernate fall back to
 * a stop: it loses hibernation instead, and the UI offers Stop only. Memory
 * is DescribeInstanceTypes' answer, else the type's name; with neither it is
 * null, can't tell, and the caller leaves the flag as it was rather than drop
 * hibernation because a lookup failed (Bugbot on #877).
 */
export function hibernationAfterResize(
  fromType: string,
  toType: string,
  info: Map<string, { memoryMiB: number; hibernationSupported: boolean }>,
): boolean | null {
  const to = info.get(toType);
  if (to && !to.hibernationSupported) return false;
  const memory = (type: string) => (info.get(type)?.memoryMiB || null) ?? typeMemoryByName(type);
  const from = memory(fromType);
  const next = memory(toType);
  if (!from || !next) return null;
  return next <= from;
}

/**
 * The types a resize may set: Graviton m and r families (m8g, m7g, r8g, r7g)
 * up to 8 vCPU and 32 GiB, the product's cap and the provisioner role's
 * `Ec2ResizeTaggedInstances` list in terraform. A size's fallbacks
 * (boxSize.ts) go past it (r8g.2xlarge is 64 GiB, m8g.4xlarge 16 vCPU), so a
 * resize skips those rather than have EC2 refuse the call.
 */
export const RESIZE_MAX_VCPUS = 8;
export const RESIZE_MAX_MEMORY_GIB = 32;
const RESIZE_FAMILY_RE = /^[mr][78]g\.[a-z0-9]+$/;

/** Whether a resize may set `type`; `info` is DescribeInstanceTypes' answer for it, when there is one. */
export function resizeTypeAllowed(type: string, info?: { vcpus?: number; memoryMiB?: number } | null): boolean {
  if (!RESIZE_FAMILY_RE.test(type)) return false;
  if (info?.vcpus && info.vcpus > RESIZE_MAX_VCPUS) return false;
  if (info?.memoryMiB && info.memoryMiB > RESIZE_MAX_MEMORY_GIB * 1024) return false;
  if (info?.vcpus && info.memoryMiB) return true;
  // Without an answer, the name: 4 GiB per vCPU in m, 8 in r, and 2xlarge is
  // 8 vCPU. So m stops at 2xlarge (32 GiB) and r at xlarge (4 vCPU, 32 GiB).
  const multiple = /\.(\d+)xlarge$/.exec(type);
  const xl = multiple ? Number(multiple[1]) : type.endsWith('.xlarge') ? 1 : 0;
  return type.startsWith('r') ? xl <= 1 : xl <= 2;
}

/** EC2's refusal of a call this orchestrator's role isn't allowed to make. */
export function isPermissionRefusal(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  return name === 'UnauthorizedOperation' || name === 'AccessDenied' || name === 'AccessDeniedException'
    || /not authorized to perform/i.test(message);
}

export const RESIZE_NOT_PERMITTED_ERROR = 'This orchestrator is not allowed to change instance types yet '
  + '(ec2:ModifyInstanceAttribute for this size\'s types; the terraform change in docs/box-provisioning.md, "Resizing a box", has to be applied first). '
  + 'Nothing was changed, and the box was not stopped.';

export interface ResizeView {
  to: string | null;
  from: string | null;
  /** The box's status when asked (ready, stopped, hibernated): which steps the resize takes. Null from a row written before it was kept. */
  fromStatus: string | null;
  phase: ResizePhase | null;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** An admin asked for it, not the owner; their reason, which the owner sees too. */
  byAdmin: boolean;
  reason: string | null;
}

/** The box's current or last resize, as the UIs and the CLI show it; null when it never had one. */
export function resizeView(row: ResizeEventRow | null | undefined, nowMs = Date.now()): ResizeView | null {
  if (!row) return null;
  const running = resizeInFlight(row, nowMs);
  const stale = !running && !row.finishedAt;
  const detail = (row.detail && typeof row.detail === 'object' ? row.detail : {}) as { fromStatus?: string; end?: string; withDisk?: boolean };
  const fromStatus = detail.fromStatus ?? null;
  // The row's phase in the views' words: requested reads as the first step, done as how it ended.
  const phase: ResizePhase | null = stale || row.phase === 'failed' ? 'failed'
    : row.phase === 'done' ? (detail.end === 'stopped' ? 'stopped' : 'ready')
      // Asked while the disk grew (detail.withDisk): its first step is waiting for that, not the stop (Cursor on #1214).
      : row.phase === 'requested' ? (detail.withDisk ? 'disk' : fromStatus === 'hibernated' ? 'resuming' : fromStatus === 'ready' ? 'stopping' : 'resizing')
        : row.phase as ResizePhase;
  return {
    to: row.to ?? null,
    from: row.from ?? null,
    fromStatus,
    phase,
    running,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: stale ? 'The resize was cut off (the orchestrator restarted); check the box and resize again' : row.error ?? null,
    byAdmin: row.actorRole === 'admin',
    reason: row.reason ?? null,
  };
}
