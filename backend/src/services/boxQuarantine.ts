/**
 * Box quarantine: an admin cuts a possibly compromised box off and
 * keeps it for a forensic look, in one action instead of by hand in the EC2
 * console. The rules are in boxQuarantinePolicy.ts.
 *
 * The row moves to `quarantined` and the box's tokens are revoked in one
 * transaction, so from that write on nothing in termag talks to the box or
 * starts it. The AWS steps follow, each on its own: tag the instance, deny
 * every action to its role, remove every rule from its security group (and
 * the host's :3040 rule for it), stop it, and once it has stopped snapshot
 * each EBS volume. Removing the rules stops new connections only; the ones
 * already open last until the stop, which is why the stop comes before the
 * snapshot rather than after (boxQuarantinePolicy QUARANTINE_STEPS). A step
 * the IAM grant refuses is recorded as failed and the rest still run; a
 * second request re-runs only the steps that are not done.
 */
import {
  CreateSnapshotCommand,
  CreateTagsCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  StopInstancesCommand,
  type Instance as Ec2Instance,
} from '@aws-sdk/client-ec2';
import { IAMClient, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { Prisma, type Instance } from '@prisma/client';
import { prisma } from '../db';
import { dropInstanceAgent } from './agentRegistry';
import {
  awsClientConfig,
  findSecurityGroupsReferencing,
  getBoxConfig,
  revokeTargets,
  terminateBox,
  type BoxConfig,
} from './boxProvisioner';
import { isHibernateRefusal } from './boxPowerPolicy';
import {
  EC2_GROUP_NOT_FOUND,
  EC2_PERMISSION_NOT_FOUND,
  IAM_NOT_FOUND,
  awsErrorCode,
  isAwsNotFound,
} from './boxTeardownPolicy';
import {
  NO_INSTANCE_YET,
  QUARANTINED,
  QUARANTINE_DENY_POLICY,
  SNAPSHOT_IN_PROGRESS,
  SWEEP_RETRY_MS,
  deniesEverythingPolicy,
  mergeStepResults,
  needsContainmentRun,
  needsStop,
  parseStepResults,
  quarantineInstanceTags,
  quarantineRefusal,
  quarantineSnapshotTags,
  quarantineTerminateRefusal,
  snapshotDescription,
  snapshotTargets,
  stepsToRun,
  stopUnsettled,
  type QuarantineOutcome,
  type QuarantineStep,
  type QuarantineStepResult,
  type QuarantineTagFacts,
} from './boxQuarantinePolicy';
import type { RouteResult } from '../routes/routeResult';
import { notifyOnSuccess, notifyWorkspaceChange } from './workspaceEvents';

export interface QuarantineActor {
  id: string;
  googleEmail: string;
}

export interface QuarantineClients {
  ec2: EC2Client;
  iam: IAMClient;
}

type Recorder = (step: QuarantineStep, outcome: QuarantineOutcome, detail: string, extra?: Partial<QuarantineStepResult>) => Promise<void>;

/** Boxes with a quarantine run in flight in this process, so two clicks don't snapshot the disks twice. */
const running = new Set<string>();

/** How long the snapshot waits for the stop to settle, and how often it looks. Tests shorten them. */
export const quarantineTiming = { stopWaitMs: 5 * 60_000, pollMs: 5000 };

/** When the sweep last ran each box, so a box whose run keeps failing to record is tried every SWEEP_RETRY_MS, not every tick. */
const sweptAt = new Map<string, number>();

/** Whether a quarantine run is in flight for this box here, so the admin card doesn't offer a retry it would refuse. */
export function quarantineRunning(instanceId: string): boolean {
  return running.has(instanceId);
}

function clientsFor(cfg: BoxConfig, box: Instance): QuarantineClients {
  const region = box.region ?? cfg.region;
  return { ec2: new EC2Client(awsClientConfig(cfg, region)), iam: new IAMClient(awsClientConfig(cfg, region)) };
}

export async function quarantineBox(
  instanceId: string,
  actor: QuarantineActor,
  reason: string,
  clients?: QuarantineClients,
): Promise<RouteResult> {
  const box = await prisma.instance.findUnique({ where: { id: instanceId } });
  const refused = quarantineRefusal(box);
  if (refused) return { status: refused.status, body: { error: refused.error } };
  if (running.has(instanceId)) return { status: 409, body: { error: 'A quarantine of this box is already running' } };
  running.add(instanceId);
  try {
    let run = await runQuarantine(box!, actor, reason, clients);
    // A launch may record its instance after this run read the row and found
    // none. Its own follow-up (resumeQuarantineAfterLaunch) can't start while
    // this run holds the box, so contain that instance here before letting go.
    const after = await prisma.instance.findUnique({ where: { id: instanceId } });
    if (run.result.status === 200 && !run.actedOn && after?.status === QUARANTINED && after.ec2InstanceId) {
      console.warn(`[QUARANTINE] ${after.name}: ${after.ec2InstanceId} was recorded during the run; containing it`);
      run = await runQuarantine(after, actor, reason, clients);
    }
    return run.result;
  } finally {
    running.delete(instanceId);
  }
}

/** The run's answer, and the EC2 instance its AWS steps acted on (null when they were skipped). */
interface QuarantineRun {
  result: RouteResult;
  actedOn: string | null;
}

async function runQuarantine(read: Instance, actor: QuarantineActor, reason: string, clients?: QuarantineClients): Promise<QuarantineRun> {
  let box = read;
  const now = new Date();
  const previous = box.status === QUARANTINED ? parseStepResults(box.quarantineSteps) : null;
  const todo = new Set(stepsToRun(previous));
  const results: QuarantineStepResult[] = [];
  // Each result is written as it lands, not once at the end: a backend
  // restart mid-run (a deploy during an incident) must not lose the snapshot
  // ids, or the retry would snapshot the same volumes again.
  const record: Recorder = async (step, outcome, detail, extra = {}) => {
    results.push({ step, outcome, detail: detail.slice(0, 500), at: new Date().toISOString(), ...extra });
    // A failed write is not the step failing; the next one carries every result so far.
    await prisma.instance.update({
      where: { id: box.id },
      data: { quarantineSteps: mergeStepResults(previous, results) as unknown as Prisma.InputJsonValue },
    }).catch(err => console.error(`[QUARANTINE] ${box.name}: recording ${step}=${outcome} failed:`, err.message));
  };

  if (box.status !== QUARANTINED) {
    const moved = await prisma.$transaction(async tx => {
      const claim = await tx.instance.updateMany({
        where: { id: box.id, status: box.status },
        data: {
          status: QUARANTINED,
          quarantinedAt: now,
          quarantinedById: actor.id,
          quarantineReason: reason,
          quarantineFromStatus: box.status,
          quarantineSteps: Prisma.DbNull,
          rehibernatePending: false,
        },
      });
      if (claim.count === 0) return null;
      return tx.agentToken.updateMany({ where: { instanceId: box.id, revokedAt: null }, data: { revokedAt: now } });
    });
    if (!moved) return { result: { status: 409, body: { error: 'The box changed state; reload and try again' } }, actedOn: null };
    // The owner's list changes here, at the claim, not when the AWS steps end:
    // the snapshot waits out the stop, and the owner never sees the steps.
    if (box.userId) for (const what of ['boxes', 'projects'] as const) notifyWorkspaceChange(box.userId, what);
    console.warn(`[QUARANTINE] ${box.name} (${box.id}, ${box.ec2InstanceId ?? 'no EC2'}) quarantined by ${actor.googleEmail} from ${box.status}: ${reason}`);
    await record('tokens', 'done', `${moved.count} token(s) revoked`);
  } else if (todo.has('tokens')) {
    const revoked = await prisma.agentToken.updateMany({ where: { instanceId: box.id, revokedAt: null }, data: { revokedAt: now } });
    await record('tokens', 'done', `${revoked.count} token(s) revoked`);
  }
  dropInstanceAgent(box.id, 'quarantined');

  // Read after the claim, not before it: a launch still in flight may have
  // recorded its instance meanwhile, and the AWS steps must act on that one.
  // A launch that records it after this read re-runs them itself
  // (boxProvisioner.launchBox, resumeQuarantineAfterLaunch).
  const fresh = await prisma.instance.findUnique({ where: { id: box.id } });
  if (fresh) box = fresh;

  const cfg = getBoxConfig();
  const awsSkip = box.kind !== 'ec2' ? 'self-managed box: isolate the machine itself'
    : !box.ec2InstanceId ? NO_INSTANCE_YET
      : !cfg ? 'box provisioning is not configured on this orchestrator'
        : null;
  if (awsSkip) {
    for (const step of ['tag', 'iam', 'network', 'stop', 'snapshot'] as const) if (todo.has(step)) await record(step, 'skipped', awsSkip);
  } else {
    // A retry, or a launch follow-up, still names the admin who quarantined
    // the box: the tags are the forensic record of who put the hold on.
    const facts: QuarantineTagFacts = read.status === QUARANTINED
      ? { at: box.quarantinedAt ?? now, by: await quarantinerEmail(box, actor), reason: box.quarantineReason ?? reason }
      : { at: now, by: actor.googleEmail, reason };
    await runAwsSteps(box, cfg!, clients ?? clientsFor(cfg!, box), todo, previous, facts, record);
  }

  const steps = mergeStepResults(previous, results);
  const failed = steps.filter(s => s.outcome === 'failed').map(s => s.step);
  console.warn(`[QUARANTINE] ${box.name}: ${steps.map(s => `${s.step}=${s.outcome}`).join(' ')}`);
  return { result: { status: 200, body: { id: box.id, status: QUARANTINED, steps, failed } }, actedOn: awsSkip ? null : box.ec2InstanceId };
}

async function quarantinerEmail(box: Instance, actor: QuarantineActor): Promise<string> {
  if (!box.quarantinedById || box.quarantinedById === actor.id) return actor.googleEmail;
  const admin = await prisma.user.findUnique({ where: { id: box.quarantinedById }, select: { googleEmail: true } });
  return admin?.googleEmail ?? actor.googleEmail;
}

async function runAwsSteps(
  box: Instance,
  cfg: BoxConfig,
  { ec2, iam }: QuarantineClients,
  todo: Set<QuarantineStep>,
  previous: QuarantineStepResult[] | null,
  facts: QuarantineTagFacts,
  record: Recorder,
): Promise<void> {
  const ec2InstanceId = box.ec2InstanceId!;
  let described: Ec2Instance | undefined;
  let describeError: string | null = null;
  try {
    const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [ec2InstanceId] }));
    described = res.Reservations?.[0]?.Instances?.[0];
  } catch (err) {
    describeError = failure(err);
  }

  if (todo.has('tag')) {
    try {
      await ec2.send(new CreateTagsCommand({ Resources: [ec2InstanceId], Tags: quarantineInstanceTags(facts) }));
      await record('tag', 'done', `tagged ${ec2InstanceId} Quarantined`);
    } catch (err) {
      await record('tag', 'failed', failure(err));
    }
  }

  if (todo.has('iam')) {
    if (!box.iamRoleName) {
      await record('iam', 'skipped', 'no box role recorded');
    } else {
      try {
        await iam.send(new PutRolePolicyCommand({ RoleName: box.iamRoleName, PolicyName: QUARANTINE_DENY_POLICY, PolicyDocument: deniesEverythingPolicy() }));
        await record('iam', 'done', `${QUARANTINE_DENY_POLICY} on ${box.iamRoleName}`);
      } catch (err) {
        if (isAwsNotFound(err, IAM_NOT_FOUND)) await record('iam', 'skipped', `role ${box.iamRoleName} is already gone`);
        else await record('iam', 'failed', failure(err));
      }
    }
  }

  if (todo.has('network')) {
    if (!box.securityGroupId) await record('network', 'skipped', 'no box security group recorded');
    else await isolateNetwork(ec2, cfg, box.securityGroupId, record);
  }

  // Whether a stop is on its way (this run's or an earlier one's), which is
  // what the snapshot waits for. A refused stop never settles the instance.
  let stopLanded = previous?.some(r => r.step === 'stop' && r.outcome !== 'failed') ?? false;
  if (todo.has('stop')) {
    const state = described?.State?.Name;
    if (described && !needsStop(state)) {
      await record('stop', 'skipped', `EC2 already reports it ${state}`);
      stopLanded = true;
    } else {
      stopLanded = await stopInstance(ec2, box, state, record);
    }
  }

  if (todo.has('snapshot')) {
    // Snapshot a quiet disk: wait for the stop (or the hibernate, whose memory
    // image lands on the root volume) to finish. With no stop on its way the
    // box keeps running whatever the wait, so it is snapshotted at once, as it
    // is; the detail says so either way.
    const settled = await describeOnceSettled(ec2, ec2InstanceId, described, stopLanded ? quarantineTiming.stopWaitMs : 0);
    if (!settled.instance) {
      await record('snapshot', 'failed', `could not describe ${ec2InstanceId}: ${settled.error ?? describeError ?? 'not found'}`);
    } else {
      await snapshotVolumes(ec2, cfg, box, settled.instance, previous, facts, record);
    }
  }
}

/** The instance once EC2 no longer reports it running or stopping, or as it is when the wait runs out. */
async function describeOnceSettled(
  ec2: EC2Client,
  ec2InstanceId: string,
  first: Ec2Instance | undefined,
  waitMs: number,
): Promise<{ instance: Ec2Instance | undefined; error: string | null }> {
  let instance = first;
  let error: string | null = null;
  for (const deadline = Date.now() + waitMs; ;) {
    try {
      const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [ec2InstanceId] }));
      instance = res.Reservations?.[0]?.Instances?.[0] ?? instance;
      error = null;
    } catch (err) {
      error = failure(err);
    }
    if ((instance && !stopUnsettled(instance.State?.Name)) || Date.now() >= deadline) return { instance, error };
    await new Promise(r => setTimeout(r, quarantineTiming.pollMs));
  }
}

async function isolateNetwork(
  ec2: EC2Client,
  cfg: BoxConfig,
  sgId: string,
  record: Recorder,
): Promise<void> {
  const notes: string[] = [];
  let ok = true;
  try {
    const res = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }));
    const sg = res.SecurityGroups?.[0];
    const ingress = sg?.IpPermissions ?? [];
    const egress = sg?.IpPermissionsEgress ?? [];
    if (ingress.length) await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: sgId, IpPermissions: ingress }));
    if (egress.length) await ec2.send(new RevokeSecurityGroupEgressCommand({ GroupId: sgId, IpPermissions: egress }));
    notes.push(`${sgId}: ${ingress.length} ingress and ${egress.length} egress rule(s) removed; connections already open last until the stop`);
  } catch (err) {
    if (isAwsNotFound(err, EC2_GROUP_NOT_FOUND)) {
      notes.push(`${sgId} is already gone`);
    } else {
      ok = false;
      notes.push(`${sgId}: ${failure(err)}`);
    }
  }

  let referencing: string[] = [];
  try {
    referencing = await findSecurityGroupsReferencing(ec2, sgId);
  } catch (err) {
    // Failed, not done: another group may still admit the box, and only a
    // step left failed is run again by the retry.
    ok = false;
    notes.push(`finding rules that admit ${sgId} failed (${failure(err)}); tried the host security group only`);
  }
  for (const groupId of revokeTargets(cfg.hostSecurityGroupId, referencing, sgId)) {
    try {
      await ec2.send(new RevokeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [{ IpProtocol: 'tcp', FromPort: 3040, ToPort: 3040, UserIdGroupPairs: [{ GroupId: sgId }] }],
      }));
      notes.push(`:3040 from ${sgId} revoked on ${groupId}`);
    } catch (err) {
      if (isAwsNotFound(err, EC2_PERMISSION_NOT_FOUND) || isAwsNotFound(err, EC2_GROUP_NOT_FOUND)) continue;
      ok = false;
      notes.push(`revoking :3040 on ${groupId} failed: ${failure(err)}`);
    }
  }
  await record('network', ok ? 'done' : 'failed', notes.join('; '));
}

async function snapshotVolumes(
  ec2: EC2Client,
  cfg: BoxConfig,
  box: Instance,
  described: Ec2Instance,
  previous: QuarantineStepResult[] | null,
  facts: QuarantineTagFacts,
  record: Recorder,
): Promise<void> {
  const ec2InstanceId = box.ec2InstanceId!;
  const state = described.State?.Name;
  const already = [...(previous?.find(r => r.step === 'snapshot')?.snapshots ?? [])];
  const errors: string[] = [];
  const targets = snapshotTargets(described.BlockDeviceMappings);
  // EC2 is the record too: a snapshot whose id never reached the row (the
  // write failed, or the run was cut short right after CreateSnapshot) is
  // found by its tags rather than taken again.
  for (const found of await taggedSnapshots(ec2, ec2InstanceId, facts, errors)) {
    if (already.some(s => s.volumeId === found.volumeId)) continue;
    const device = targets.find(t => t.volumeId === found.volumeId)?.device ?? '?';
    already.push({ volumeId: found.volumeId, device, snapshotId: found.snapshotId });
  }
  const taken = new Set(already.map(s => s.volumeId));
  const snapshots = [...already];
  for (const { volumeId, device } of targets) {
    if (taken.has(volumeId)) continue;
    try {
      const res = await ec2.send(new CreateSnapshotCommand({
        VolumeId: volumeId,
        Description: snapshotDescription(box.name, ec2InstanceId, device, facts.by),
        TagSpecifications: [{
          ResourceType: 'snapshot',
          Tags: quarantineSnapshotTags({ ...facts, managedTag: cfg.managedTag, ec2InstanceId, boxName: box.name, device }),
        }],
      }));
      if (!res.SnapshotId) throw new Error('CreateSnapshot answered no SnapshotId');
      snapshots.push({ volumeId, device, snapshotId: res.SnapshotId });
      // Checkpoint each id as it is taken (left as failed until the last one):
      // a run cut short here retries the rest without a second snapshot of this one.
      await record('snapshot', 'failed', `${SNAPSHOT_IN_PROGRESS} ${snapshots.map(s => s.snapshotId).join(', ')}`, { snapshots: [...snapshots] });
    } catch (err) {
      errors.push(`${volumeId} (${device}): ${failure(err)}`);
    }
  }
  if (targets.length === 0) {
    await record('snapshot', 'failed', `EC2 lists no EBS volume on ${ec2InstanceId}`);
    return;
  }
  const listed = snapshots.map(s => `${s.snapshotId} of ${s.device}`).join(', ');
  const asTaken = stopUnsettled(state) ? `; taken while EC2 still reported it ${state}` : '';
  const missing = targets.some(t => !snapshots.some(s => s.volumeId === t.volumeId));
  if (missing) await record('snapshot', 'failed', `${listed ? `${listed}; ` : ''}failed: ${errors.join('; ')}${asTaken}`, { snapshots });
  else await record('snapshot', 'done', `${listed}${asTaken}${errors.length ? ` (${errors.join('; ')})` : ''}`, { snapshots });
}

/**
 * This quarantine's snapshots already in EC2, by the tags every one carries.
 * A refused lookup (the grant may lack ec2:DescribeSnapshots) is noted and
 * counts as none, so the snapshots are still taken.
 */
async function taggedSnapshots(
  ec2: EC2Client,
  ec2InstanceId: string,
  facts: QuarantineTagFacts,
  notes: string[],
): Promise<Array<{ volumeId: string; snapshotId: string }>> {
  try {
    const res = await ec2.send(new DescribeSnapshotsCommand({
      OwnerIds: ['self'],
      Filters: [
        { Name: 'tag:QuarantinedInstance', Values: [ec2InstanceId] },
        { Name: 'tag:Quarantined', Values: [facts.at.toISOString()] },
      ],
    }));
    return (res.Snapshots ?? []).flatMap(s => (s.SnapshotId && s.VolumeId && s.State !== 'error'
      ? [{ volumeId: s.VolumeId, snapshotId: s.SnapshotId }] : []));
  } catch (err) {
    notes.push(`looking up snapshots already taken failed: ${failure(err)}`);
    return [];
  }
}

/**
 * A box launched hibernation-capable is hibernated rather than stopped, so its
 * memory lands on the root volume for whoever looks next; a refused hibernate
 * still stops it. Returns whether EC2 took a stop.
 */
async function stopInstance(
  ec2: EC2Client,
  box: Instance,
  state: string | undefined,
  record: Recorder,
): Promise<boolean> {
  const InstanceIds = [box.ec2InstanceId!];
  if (box.hibernationConfigured && state === 'running') {
    try {
      await ec2.send(new StopInstancesCommand({ InstanceIds, Hibernate: true }));
      await record('stop', 'done', 'hibernate requested: its memory is written to the root volume, which the snapshot takes once it settles');
      return true;
    } catch (err) {
      if (!isHibernateRefusal(err)) { await record('stop', 'failed', failure(err)); return false; }
    }
  }
  try {
    await ec2.send(new StopInstancesCommand({ InstanceIds }));
    await record('stop', 'done', `stop requested (EC2 reported ${state ?? 'an unknown state'})`);
    return true;
  } catch (err) {
    await record('stop', 'failed', failure(err));
    return false;
  }
}

/** How long the admin's request waits for the run before it answers that the run goes on (the snapshot waits out the stop). */
export const QUARANTINE_ANSWER_WITHIN_MS = 20_000;

/**
 * The route's answer: the run's own when it finishes within answerWithinMs,
 * else 202 with `running: true` while it carries on, so a long stop wait never
 * outlasts the load balancer's idle timeout. The Fleet card polls the steps.
 */
export async function quarantineBoxAnswer(
  instanceId: string,
  actor: QuarantineActor,
  reason: string,
  answerWithinMs = QUARANTINE_ANSWER_WITHIN_MS,
  clients?: QuarantineClients,
): Promise<RouteResult> {
  const run = quarantineBox(instanceId, actor, reason, clients);
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<null>(r => { timer = setTimeout(() => r(null), answerWithinMs); });
  try {
    const answer = await Promise.race([run, waited]);
    if (answer) return answer;
  } finally {
    clearTimeout(timer);
  }
  run.catch(err => console.error(`[QUARANTINE] ${instanceId}: run failed after the request was answered:`, err));
  return { status: 202, body: { id: instanceId, status: QUARANTINED, running: true } };
}

/**
 * A launch recorded its instance after the quarantine's own run had already
 * found none: run the steps still not done, as the admin who quarantined it.
 * Waits out a run still in flight, which would otherwise answer 409.
 */
export async function resumeQuarantineAfterLaunch(instanceId: string, waitMs = 60_000): Promise<void> {
  for (const deadline = Date.now() + waitMs; running.has(instanceId);) {
    if (Date.now() >= deadline) {
      // Safe to leave: the run in flight re-reads the row before it lets go of
      // the box and contains an instance recorded meanwhile (quarantineBox).
      console.warn(`[QUARANTINE] ${instanceId}: a run is still in flight after ${waitMs}ms; it contains the launched instance`);
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const box = await prisma.instance.findUnique({ where: { id: instanceId } });
  if (!box || box.status !== QUARANTINED) return;
  const admin = box.quarantinedById
    ? await prisma.user.findUnique({ where: { id: box.quarantinedById }, select: { id: true, googleEmail: true } })
    : null;
  const actor = admin ?? { id: box.quarantinedById ?? 'termag', googleEmail: 'termag (launch follow-up)' };
  const result = await quarantineBox(instanceId, actor, box.quarantineReason ?? 'quarantined during its launch');
  if (result.status !== 200) console.error(`[QUARANTINE] ${box.name}: follow-up after its launch answered ${result.status}`, result.body);
}

/**
 * Contain the quarantined boxes whose launch follow-up never ran, or whose
 * run was cut short (needsContainmentRun), a few per tick, and each at most
 * once per SWEEP_RETRY_MS. Leader work, from the provisioning sweep. Returns
 * how many were started.
 */
export async function sweepUncontainedQuarantines(now = Date.now(), limit = 3): Promise<number> {
  const rows = await prisma.instance.findMany({
    where: { status: QUARANTINED, kind: 'ec2', ec2InstanceId: { not: null } },
    select: { id: true, name: true, status: true, kind: true, ec2InstanceId: true, quarantinedAt: true, quarantineSteps: true },
  });
  const due = rows.filter(r => !running.has(r.id) && now - (sweptAt.get(r.id) ?? 0) >= SWEEP_RETRY_MS
    && needsContainmentRun(r, now)).slice(0, limit);
  for (const r of due) {
    sweptAt.set(r.id, now);
    console.warn(`[QUARANTINE] ${r.name}: ${r.ec2InstanceId} was never fully contained; running its unfinished AWS steps now`);
    await resumeQuarantineAfterLaunch(r.id, 0).catch(err => console.error(`[QUARANTINE] ${r.name}: sweep run failed:`, err));
  }
  return due.length;
}

/**
 * The only way out of quarantine: archive its projects and terminate it as an
 * owner's terminate would (boxProvisioner.terminateBox, which also deletes the
 * role and with it the deny policy). The snapshots are not touched.
 */
export async function terminateQuarantinedBox(instanceId: string, actor: QuarantineActor): Promise<RouteResult> {
  const box = await prisma.instance.findUnique({ where: { id: instanceId } });
  const refused = quarantineTerminateRefusal(box);
  if (refused) return { status: refused.status, body: { error: refused.error } };
  if (running.has(instanceId)) return { status: 409, body: { error: 'A quarantine of this box is still running' } };
  const now = new Date();
  // Projects are archived without revokeChats, unlike the owner's terminate of
  // a self-managed box (routes/instances.ts): its tokens are already revoked,
  // so there is no agent to reach, and a session still live on a suspect
  // machine is the admin's to deal with there, not termag's.
  const [archived, , moved] = await prisma.$transaction([
    prisma.project.updateMany({ where: { instanceId, archived: false }, data: { archived: true } }),
    prisma.agentToken.updateMany({ where: { instanceId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.instance.updateMany({ where: { id: instanceId, status: QUARANTINED }, data: { status: 'terminated', terminatedAt: now } }),
  ]);
  if (moved.count === 0) return { status: 409, body: { error: 'The box changed state; reload and try again' } };
  console.warn(`[QUARANTINE] ${box!.name} (${box!.id}) terminated by ${actor.googleEmail}; ${archived.count} project(s) archived`);
  if (box!.kind === 'ec2' && getBoxConfig()) {
    const row = await prisma.instance.findUnique({ where: { id: instanceId } });
    if (row) void terminateBox(row);
  }
  const result = { status: 200, body: { ok: true, archivedProjects: archived.count } };
  return box!.userId ? notifyOnSuccess(result, box!.userId, ['boxes', 'projects']) : result;
}

function failure(err: unknown): string {
  const code = awsErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  return code && !message.startsWith(code) ? `${code}: ${message}` : message;
}
