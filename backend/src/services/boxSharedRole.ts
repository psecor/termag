/**
 * One IAM role and instance profile for every box, instead of a role and a
 * profile per box (docs/box-provisioning.md, "Box IAM identity").
 *
 *   BOX_INSTANCE_PROFILE_NAME  the shared instance profile new boxes launch with
 *   BOX_SHARED_ROLE_NAME       the role in it
 *
 * Both are set by the box-provisioning terraform module, which owns the role,
 * its permissions boundary, its policies and the profile. With both set, a
 * launch creates no IAM resource and records `iamRoleShared` on the row; with
 * either unset, every launch makes its own role as before. A box keeps the
 * kind of role it launched with for life, so teardown decides from the row,
 * never from the config: a box with its own role still has it deleted, and
 * the shared role and profile are never deleted.
 *
 * Quarantine can't deny everything to a role every box uses. It writes one
 * inline policy on the shared role, `termag-quarantine-deny-instances`, which
 * denies every action to the sessions of the quarantined instances. EC2 names
 * an instance-profile session after the instance, so `aws:userid` of a call
 * made with a box's credentials is `<role id>:<instance id>`; the policy
 * matches `*:<instance id>`, and because it is attached to the shared role
 * only that role's sessions are evaluated against it. The deny is evaluated
 * on every request, so it also stops credentials the box already took from
 * IMDS. The quarantine also takes the instance profile off the instance,
 * so the box gets no new credentials either.
 *
 * The list is the `shared_role_denies` table, and every write puts the whole
 * of it on the role, under a database lock: an IAM read can lag a write, so
 * the policy is never read back to be edited. Once EC2 reports a quarantined
 * instance terminated, teardown schedules its entry to go after
 * SHARED_DENY_RETENTION_MS, longer than any credential the instance was issued
 * stays valid; the provisioning sweep removes it after that. Until then a
 * credential copied off the box is still refused.
 */
import { DeleteRolePolicyCommand, PutRolePolicyCommand, type IAMClient } from '@aws-sdk/client-iam';
import { prisma } from '../db';

export interface SharedBoxRole {
  roleName: string;
  instanceProfileName: string;
}

export const SHARED_QUARANTINE_POLICY = 'termag-quarantine-deny-instances';

/**
 * IAM's limit on the inline policies of one role, together, in characters
 * without whitespace. The shared role's own grants are managed policies
 * (terraform), so the whole budget is this policy's: about 440 instances.
 */
export const ROLE_INLINE_POLICY_LIMIT = 10_240;

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

/** The shared role from the environment; undefined (per-box roles) unless both names are set. */
export function parseSharedBoxRole(env: NodeJS.ProcessEnv): SharedBoxRole | undefined {
  const roleName = env.BOX_SHARED_ROLE_NAME?.trim();
  const instanceProfileName = env.BOX_INSTANCE_PROFILE_NAME?.trim();
  if (!roleName && !instanceProfileName) return undefined;
  if (!roleName || !instanceProfileName) {
    console.error('[BOX] only one of BOX_SHARED_ROLE_NAME and BOX_INSTANCE_PROFILE_NAME is set; new boxes keep getting a role of their own');
    return undefined;
  }
  return { roleName, instanceProfileName };
}

/** What decides whether a box's role is the shared one. */
export interface BoxRoleFacts {
  iamRoleShared?: boolean | null;
  iamRoleName?: string | null;
  iamInstanceProfileName?: string | null;
}

/**
 * Whether the box's role is the shared one. The row says so; a role or
 * profile recorded under the configured shared names counts too, so no path
 * can delete the shared role on the strength of a row that lost its mark.
 */
export function usesSharedRole(box: BoxRoleFacts, shared: SharedBoxRole | undefined): boolean {
  if (box.iamRoleShared) return true;
  if (!shared) return false;
  return box.iamRoleName === shared.roleName || box.iamInstanceProfileName === shared.instanceProfileName;
}

/** The deny policy for these instances, or null when there are none (the policy is deleted). */
export function quarantineDenyDocument(instanceIds: readonly string[]): string | null {
  const ids = [...new Set(instanceIds)].sort();
  if (ids.length === 0) return null;
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'QuarantinedBoxes',
      Effect: 'Deny',
      Action: '*',
      Resource: '*',
      Condition: { StringLike: { 'aws:userid': ids.map(id => `*:${id}`) } },
    }],
  });
}

/**
 * The instances a policy document (as GetRolePolicy returns it, URL-encoded)
 * denies, for checking what is on the role. Never the source of a write: the
 * table is (writeDenied).
 */
export function quarantinedInstanceIds(urlEncoded: string | undefined): string[] {
  if (urlEncoded === undefined) return [];
  const doc = JSON.parse(decodeURIComponent(urlEncoded));
  const ids: string[] = [];
  for (const st of [doc.Statement].flat()) {
    for (const v of [st?.Condition?.StringLike?.['aws:userid'] ?? []].flat()) {
      const id = typeof v === 'string' ? v.replace(/^\*:/, '') : '';
      if (INSTANCE_ID.test(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * How long an entry stays on the deny list after EC2 reports its instance
 * terminated. A terminated instance is issued no more credentials, and the ones
 * it was issued expire within hours (12 hours is IAM's ceiling on any role
 * session); twice that keeps every credential copied off the box refused for
 * as long as it could authorize.
 */
export const SHARED_DENY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The table calls the deny list makes (Prisma's `sharedRoleDeny`, or a test's). */
export interface DenyTable {
  findMany(args: { where: { roleName: string } }): Promise<Array<{ ec2InstanceId: string; releaseAfter: Date | null }>>;
  upsert(args: {
    where: { roleName_ec2InstanceId: { roleName: string; ec2InstanceId: string } };
    create: { roleName: string; ec2InstanceId: string; boxId: string };
    update: { releaseAfter: null };
  }): Promise<unknown>;
  updateMany(args: { where: { roleName: string; ec2InstanceId: string; releaseAfter: null }; data: { releaseAfter: Date } }): Promise<unknown>;
  deleteMany(args: { where: { roleName: string; ec2InstanceId: { in: string[] }; releaseAfter: { lte: Date } } }): Promise<{ count: number }>;
}

/**
 * Runs `fn` while holding a database lock on the shared role's deny list.
 * Every change to the list's rows and every write of the role's policy takes
 * it, so none of them lands between another's read of the table and its
 * write (two quarantines, a quarantine and the sweep, in this orchestrator or
 * one overlapping it in a deploy). `fn` gets the table inside the same
 * transaction, which commits when `fn` resolves.
 */
export async function withSharedRoleLock<T>(roleName: string, fn: (table: DenyTable) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`box-shared-role:${roleName}`}))`;
    return fn(tx.sharedRoleDeny as unknown as DenyTable);
  }, { timeout: 60_000, maxWait: 60_000 });
}

/**
 * Puts the deny list on the role: exactly these instances. The list always
 * comes from our table, never from GetRolePolicy, whose answer can lag a write
 * just made (IAM is eventually consistent) and would drop that entry.
 */
async function writeDenied(iam: IAMClient, roleName: string, ids: string[]): Promise<void> {
  const doc = quarantineDenyDocument(ids);
  if (doc === null) {
    try {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: SHARED_QUARANTINE_POLICY }));
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'NoSuchEntity' && name !== 'NoSuchEntityException') throw err;
    }
    return;
  }
  if (doc.length > ROLE_INLINE_POLICY_LIMIT) {
    throw new Error(`${SHARED_QUARANTINE_POLICY} would hold ${ids.length} instances (${doc.length} characters), over IAM's ${ROLE_INLINE_POLICY_LIMIT} per role; terminate quarantined boxes that are no longer needed`);
  }
  await iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: SHARED_QUARANTINE_POLICY, PolicyDocument: doc }));
}

/**
 * Adds the instance to the shared role's deny list and writes the whole list
 * to the role. The entry is committed first, in a transaction of its own
 * under the lock, so a write that fails leaves it in the list for the Retry
 * and every later write, and a sweep in progress finishes before it lands.
 * Resolves to how many instances the list holds.
 */
export async function denySharedRoleInstance(iam: IAMClient, roleName: string, instanceId: string, boxId = ''): Promise<number> {
  if (!INSTANCE_ID.test(instanceId)) throw new Error(`not an EC2 instance id: ${instanceId}`);
  await withSharedRoleLock(roleName, table => table.upsert({
    where: { roleName_ec2InstanceId: { roleName, ec2InstanceId: instanceId } },
    create: { roleName, ec2InstanceId: instanceId, boxId },
    // A quarantine of an instance whose release was scheduled holds it again.
    update: { releaseAfter: null },
  }));
  return withSharedRoleLock(roleName, async table => {
    const ids = (await table.findMany({ where: { roleName } })).map(r => r.ec2InstanceId);
    await writeDenied(iam, roleName, ids);
    return ids.length;
  });
}

/**
 * Schedules the instance's entry to leave the deny list SHARED_DENY_RETENTION_MS
 * after `terminatedAt`, which must be when EC2 reported the instance
 * terminated. The entry stays on the role until sweepSharedRoleDenies removes
 * it. An entry already scheduled keeps its earlier time.
 */
export async function scheduleSharedRoleDenyRelease(roleName: string, instanceId: string, terminatedAt: Date): Promise<void> {
  await withSharedRoleLock(roleName, table => table.updateMany({
    where: { roleName, ec2InstanceId: instanceId, releaseAfter: null },
    data: { releaseAfter: new Date(terminatedAt.getTime() + SHARED_DENY_RETENTION_MS) },
  }));
}

/**
 * Removes the entries whose release time has come: writes the list without
 * them, then deletes their rows. A failed write throws and deletes nothing, so
 * the next sweep tries again. Resolves to how many entries left the list.
 *
 * Under the lock nothing changes the rows between the read and the delete.
 * The delete still matches only rows that are past their release time when
 * it runs, and if any row it left out of the write is still there (held
 * again), the list is written once more from the rows that remain, so an
 * instance on hold is never left off the role.
 */
export async function sweepSharedRoleDenies(iam: IAMClient, roleName: string, now: Date): Promise<number> {
  return withSharedRoleLock(roleName, async table => {
    const rows = await table.findMany({ where: { roleName } });
    const expired = rows.filter(r => r.releaseAfter !== null && r.releaseAfter.getTime() <= now.getTime()).map(r => r.ec2InstanceId);
    if (expired.length === 0) return 0;
    await writeDenied(iam, roleName, rows.map(r => r.ec2InstanceId).filter(id => !expired.includes(id)));
    const { count } = await table.deleteMany({ where: { roleName, ec2InstanceId: { in: expired }, releaseAfter: { lte: now } } });
    const remaining = (await table.findMany({ where: { roleName } })).map(r => r.ec2InstanceId);
    if (remaining.some(id => expired.includes(id))) await writeDenied(iam, roleName, remaining);
    return count;
  });
}

/** The roles with an entry whose release time has come, for the provisioning sweep. */
export async function rolesWithExpiredDenies(now: Date): Promise<string[]> {
  const rows = await prisma.sharedRoleDeny.findMany({ where: { releaseAfter: { lte: now } }, select: { roleName: true } });
  return [...new Set(rows.map(r => r.roleName))];
}
