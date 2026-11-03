/**
 * Box quarantine: the pure decisions. `boxQuarantine.ts` owns every AWS call
 * and Prisma write; this module decides what a request may do and shapes what
 * is sent, so the rules are unit-testable.
 *
 * Quarantine is for a box that may be compromised: cut it off from
 * everything it could reach and keep its disks exactly as they were, for a
 * forensic look. It is one-way. The only exit is an admin's terminate, which
 * destroys the instance and keeps the snapshots.
 */

export const QUARANTINED = 'quarantined';

/** The inline policy that denies every action to the box's role, including sessions already issued. */
export const QUARANTINE_DENY_POLICY = 'termag-quarantine-deny-all';

export const QUARANTINE_REASON_MAX = 500;

/**
 * In the order they run. `tokens` is the database half and always runs first.
 * `stop` comes before `snapshot`: a security group's revoked rules leave the
 * connections already open (tracked) flowing, so only the stop ends them, and
 * a disk copied while the suspect processes still run is one they can still
 * change. The snapshot waits for the stop to settle (stop, then
 * snapshot).
 */
export const QUARANTINE_STEPS = ['tokens', 'tag', 'iam', 'network', 'stop', 'snapshot'] as const;
export type QuarantineStep = typeof QUARANTINE_STEPS[number];

export type QuarantineOutcome = 'done' | 'skipped' | 'failed';

export interface QuarantineStepResult {
  step: QuarantineStep;
  outcome: QuarantineOutcome;
  detail: string;
  at: string;
  /** `snapshot` only: one per EBS volume that was attached. */
  snapshots?: Array<{ volumeId: string; device: string; snapshotId: string }>;
}

export const STEP_LABELS: Readonly<Record<QuarantineStep, string>> = {
  tokens: 'revoke box tokens and drop its agent',
  tag: 'tag the EC2 instance',
  iam: 'deny every action to the box role',
  network: 'remove every security group rule',
  stop: 'stop the instance, ending connections already open',
  snapshot: 'snapshot every EBS volume once it is stopped',
};

export interface QuarantineBox {
  kind: string;
  status: string;
  ec2InstanceId: string | null;
}

export interface QuarantineRequest {
  reason: string;
}

/**
 * The admin's request body, or the error to answer. `confirm: true` is
 * required so a single stray call can't quarantine a box.
 */
export function parseQuarantineBody(body: unknown): QuarantineRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
  const { reason, confirm } = body as { reason?: unknown; confirm?: unknown };
  if (confirm !== true) return { error: 'confirm: true is required' };
  if (typeof reason !== 'string' || !reason.trim()) return { error: 'reason is required' };
  if (reason.trim().length > QUARANTINE_REASON_MAX) return { error: `reason must be at most ${QUARANTINE_REASON_MAX} characters` };
  return { reason: reason.trim() };
}

/**
 * Why this box can't be quarantined, or null. A box already quarantined is
 * accepted: the request re-runs whatever step did not finish.
 */
export function quarantineRefusal(box: QuarantineBox | null): { status: number; error: string } | null {
  if (!box) return { status: 404, error: 'Box not found' };
  if (box.status === 'terminated') return { status: 409, error: 'This box is already terminated' };
  return null;
}

/** Why an admin may not terminate this box from the quarantine path, or null. */
export function quarantineTerminateRefusal(box: QuarantineBox | null): { status: number; error: string } | null {
  if (!box) return { status: 404, error: 'Box not found' };
  if (box.status === 'terminated') return { status: 409, error: 'This box is already terminated' };
  if (box.status !== QUARANTINED) return { status: 409, error: 'Only a quarantined box is terminated here; its owner terminates any other' };
  return null;
}

/** The owner-facing refusal for every power and terminate request on a quarantined box. */
export const QUARANTINED_OWNER_ERROR =
  'This box was quarantined by a termag admin and is kept for investigation. Create a new box to keep working.';

/**
 * Which steps a run performs, given what the previous runs recorded. A step
 * that is done stays done (a second snapshot of the same disks would only
 * blur the timeline); everything else is tried again, so a grant added after
 * a refusal can be picked up with a retry.
 */
export function stepsToRun(previous: readonly QuarantineStepResult[] | null): QuarantineStep[] {
  const done = new Set((previous ?? []).filter(r => r.outcome === 'done').map(r => r.step));
  return QUARANTINE_STEPS.filter(s => !done.has(s));
}

/** Merge a run's results over the previous ones, one entry per step, in step order. */
export function mergeStepResults(
  previous: readonly QuarantineStepResult[] | null,
  current: readonly QuarantineStepResult[],
): QuarantineStepResult[] {
  const byStep = new Map<QuarantineStep, QuarantineStepResult>();
  for (const r of previous ?? []) byStep.set(r.step, r);
  for (const r of current) byStep.set(r.step, r);
  return QUARANTINE_STEPS.flatMap(s => byStep.get(s) ?? []);
}

/** Read the column back; anything malformed counts as no record. */
export function parseStepResults(raw: unknown): QuarantineStepResult[] | null {
  if (!Array.isArray(raw)) return null;
  const steps = new Set<string>(QUARANTINE_STEPS);
  const out = raw.filter((r): r is QuarantineStepResult =>
    !!r && typeof r === 'object'
    && steps.has((r as QuarantineStepResult).step)
    && ['done', 'skipped', 'failed'].includes((r as QuarantineStepResult).outcome));
  return out;
}

export function deniesEverythingPolicy(): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Sid: 'TermagQuarantineDenyAll', Effect: 'Deny', Action: '*', Resource: '*' }],
  });
}

/**
 * EC2 tag values and snapshot descriptions: printable ASCII only, so a reason
 * typed with an em dash or an emoji is never what makes a call fail
 * (the ASCII gotcha on EC2 descriptions), capped at EC2's 255.
 */
export function ec2Text(text: string, max = 255): string {
  return text.replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/gu, '?').trim().slice(0, max);
}

export interface QuarantineTagFacts {
  at: Date;
  by: string;
  reason: string;
}

export function quarantineInstanceTags(f: QuarantineTagFacts): Array<{ Key: string; Value: string }> {
  return [
    { Key: 'Quarantined', Value: f.at.toISOString() },
    { Key: 'QuarantinedBy', Value: ec2Text(f.by) },
    { Key: 'QuarantineReason', Value: ec2Text(f.reason) || '-' },
  ];
}

/**
 * Tags on each forensic snapshot. `Retain=true` is what keeps the nightly
 * prune-snapshots.sh from deleting it: an `App=termag` snapshot that no AMI
 * references is otherwise collected after 24 hours.
 */
export function quarantineSnapshotTags(
  f: QuarantineTagFacts & { managedTag: string; ec2InstanceId: string; boxName: string; device: string },
): Array<{ Key: string; Value: string }> {
  return [
    { Key: 'App', Value: 'termag' },
    { Key: 'Component', Value: 'box-quarantine' },
    { Key: 'ManagedBy', Value: f.managedTag },
    { Key: 'Retain', Value: 'true' },
    { Key: 'Name', Value: ec2Text(`quarantine-${f.boxName}-${f.device.replace(/^\/dev\//, '')}`) },
    { Key: 'QuarantinedInstance', Value: f.ec2InstanceId },
    { Key: 'Quarantined', Value: f.at.toISOString() },
    { Key: 'QuarantinedBy', Value: ec2Text(f.by) },
  ];
}

export function snapshotDescription(boxName: string, ec2InstanceId: string, device: string, by: string): string {
  return ec2Text(`termag quarantine of ${boxName} (${ec2InstanceId}) ${device} by ${by}`);
}

export interface BlockDeviceMapping {
  DeviceName?: string;
  Ebs?: { VolumeId?: string };
}

/** Every attached EBS volume, root first as EC2 lists it. */
export function snapshotTargets(mappings: readonly BlockDeviceMapping[] | undefined): Array<{ volumeId: string; device: string }> {
  return (mappings ?? []).flatMap(m => (m.Ebs?.VolumeId ? [{ volumeId: m.Ebs.VolumeId, device: m.DeviceName ?? '?' }] : []));
}

/** The detail of every AWS step a run skipped because the box had no instance yet. */
export const NO_INSTANCE_YET = 'no EC2 instance yet: a launch in flight never boots one, or contains the one it booted';

/** The detail of a snapshot checkpoint: some volumes are taken, and the run is still going (or was cut short). */
export const SNAPSHOT_IN_PROGRESS = 'in progress, taken so far:';

/** Long enough that a run that just claimed the box, on any process, has finished (its snapshot wait included). */
export const LAUNCH_FOLLOW_UP_SETTLE_MS = 10 * 60 * 1000;

/** How long the sweep leaves a box it already tried, so a run that keeps failing to record isn't repeated every tick. */
export const SWEEP_RETRY_MS = 15 * 60 * 1000;

/**
 * A quarantined box with an instance its quarantine never finished acting on:
 * the run found none and the launch recorded one afterwards, but its
 * follow-up was lost (a restart in between), or a run was cut short, before
 * recording anything or part way through its steps. The provisioning sweep
 * contains it. A step that ran and failed is not this: that is the admin's
 * Retry, after the grant is fixed.
 */
export function needsContainmentRun(
  box: { status: string; kind: string; ec2InstanceId: string | null; quarantinedAt: Date | null; quarantineSteps: unknown },
  nowMs: number,
): boolean {
  if (box.status !== QUARANTINED || box.kind !== 'ec2' || !box.ec2InstanceId || !box.quarantinedAt) return false;
  if (nowMs - box.quarantinedAt.getTime() < LAUNCH_FOLLOW_UP_SETTLE_MS) return false;
  const steps = parseStepResults(box.quarantineSteps);
  if (!steps || steps.length < QUARANTINE_STEPS.length) return true;
  return steps.some(s => (s.outcome === 'skipped' && s.detail === NO_INSTANCE_YET)
    || (s.step === 'snapshot' && s.outcome === 'failed' && s.detail.startsWith(SNAPSHOT_IN_PROGRESS)));
}

/** EC2 states in which there is nothing left to stop. */
export function needsStop(ec2State: string | undefined): boolean {
  return ec2State === 'running' || ec2State === 'pending';
}

/** EC2 states the snapshot waits out: the instance is still running, or still writing its disks on the way down. */
export function stopUnsettled(ec2State: string | undefined): boolean {
  return ec2State === 'running' || ec2State === 'pending' || ec2State === 'stopping';
}

const ADMIN_ONLY_FIELDS = ['quarantinedById', 'quarantineReason', 'quarantineFromStatus', 'quarantineSteps'] as const;
type AdminOnlyField = typeof ADMIN_ONLY_FIELDS[number];

/**
 * A box row as its owner's routes return it. The owner sees that and when the
 * box was quarantined, never why, by whom or what was collected: the reason
 * can name what the investigation suspects.
 */
export function ownerBoxView<T extends object>(row: T): Omit<T, AdminOnlyField> {
  const out = { ...row } as Record<string, unknown>;
  for (const k of ADMIN_ONLY_FIELDS) delete out[k];
  return out as Omit<T, AdminOnlyField>;
}
