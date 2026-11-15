import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAMClient } from '@aws-sdk/client-iam';

const denyTable = vi.hoisted(() => ({ current: null as null | { rows: Array<Record<string, any>>; delegate: any } }));
// The default lock: its transactions run one at a time, like the advisory lock, and the table is in memory.
vi.mock('../db', () => {
  const tx = {
    $executeRaw: async () => 0,
    get sharedRoleDeny() { return denyTable.current!.delegate; },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const $transaction = (fn: (t: unknown) => Promise<unknown>) => {
    const run = tail.then(() => fn(tx));
    tail = run.catch(() => {});
    return run;
  };
  return { prisma: { $transaction, get sharedRoleDeny() { return denyTable.current!.delegate; } } };
});

/** An in-memory `shared_role_denies` table, with the Prisma calls boxSharedRole makes. */
function sharedRoleDenyTable() {
  const rows: Array<Record<string, any>> = [];
  const hit = (r: Record<string, any>, where: Record<string, any>) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(r[k]);
      if ('lte' in v) return r[k] != null && r[k] <= v.lte;
    }
    return (r[k] ?? null) === v;
  });
  const delegate = {
    findMany: async ({ where }: any) => rows.filter(r => hit(r, where)).map(r => ({ ...r })),
    upsert: async ({ where: { roleName_ec2InstanceId: key }, create, update }: any) => {
      const row = rows.find(r => r.roleName === key.roleName && r.ec2InstanceId === key.ec2InstanceId);
      if (row) Object.assign(row, update); else rows.push({ releaseAfter: null, ...create });
      return {};
    },
    updateMany: async ({ where, data }: any) => {
      const hits = rows.filter(r => hit(r, where));
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    },
    deleteMany: async ({ where }: any) => {
      const gone = rows.filter(r => hit(r, where));
      for (const r of gone) rows.splice(rows.indexOf(r), 1);
      return { count: gone.length };
    },
  };
  return { rows, delegate };
}

const {
  ROLE_INLINE_POLICY_LIMIT,
  SHARED_QUARANTINE_POLICY,
  denySharedRoleInstance,
  parseSharedBoxRole,
  quarantineDenyDocument,
  quarantinedInstanceIds,
  scheduleSharedRoleDenyRelease,
  sweepSharedRoleDenies,
  SHARED_DENY_RETENTION_MS,
  usesSharedRole,
} = await import('./boxSharedRole');

const SHARED = { roleName: 'termag-termag-box-instance', instanceProfileName: 'termag-termag-box-instance-profile' };

/** An IAM fake holding one role's inline policies. */
function fakeIam() {
  const policies = new Map<string, string>();
  const sent: string[] = [];
  const send = async (cmd: { constructor: { name: string }; input: any }) => {
    const name = cmd.constructor.name.replace(/Command$/, '');
    sent.push(name);
    const key = cmd.input.PolicyName;
    switch (name) {
      case 'GetRolePolicy':
        if (!policies.has(key)) throw Object.assign(new Error('none'), { name: 'NoSuchEntityException' });
        return { PolicyDocument: encodeURIComponent(policies.get(key)!) };
      case 'PutRolePolicy': policies.set(key, cmd.input.PolicyDocument); return {};
      case 'DeleteRolePolicy': policies.delete(key); return {};
      default: return {};
    }
  };
  return { iam: { send } as unknown as IAMClient, policies, sent };
}

const ids = (n: number) => Array.from({ length: n }, (_, k) => `i-${k.toString(16).padStart(17, '0')}`);

describe('parseSharedBoxRole', () => {
  it('needs both names', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseSharedBoxRole({})).toBeUndefined();
    expect(parseSharedBoxRole({ BOX_SHARED_ROLE_NAME: SHARED.roleName })).toBeUndefined();
    expect(err).toHaveBeenCalledOnce();
    expect(parseSharedBoxRole({ BOX_SHARED_ROLE_NAME: ` ${SHARED.roleName} `, BOX_INSTANCE_PROFILE_NAME: SHARED.instanceProfileName })).toEqual(SHARED);
  });
});

describe('usesSharedRole', () => {
  it('goes by the row, and by the shared names when the row lost its mark', () => {
    expect(usesSharedRole({ iamRoleShared: true }, undefined)).toBe(true);
    expect(usesSharedRole({ iamRoleShared: false, iamRoleName: 'termag-boxes-c1' }, SHARED)).toBe(false);
    expect(usesSharedRole({ iamRoleShared: false, iamRoleName: SHARED.roleName }, SHARED)).toBe(true);
    expect(usesSharedRole({ iamInstanceProfileName: SHARED.instanceProfileName }, SHARED)).toBe(true);
    expect(usesSharedRole({ iamRoleName: null, iamInstanceProfileName: null }, SHARED)).toBe(false);
  });
});

describe('the deny list', () => {
  beforeEach(() => { denyTable.current = sharedRoleDenyTable(); });

  it('denies every action to the listed instances’ sessions, and round-trips', () => {
    const doc = quarantineDenyDocument(['i-0bbbbbbbbbbbbbbb2', 'i-0aaaaaaaaaaaaaaa1', 'i-0aaaaaaaaaaaaaaa1'])!;
    expect(JSON.parse(doc).Statement).toEqual([{
      Sid: 'QuarantinedBoxes', Effect: 'Deny', Action: '*', Resource: '*',
      Condition: { StringLike: { 'aws:userid': ['*:i-0aaaaaaaaaaaaaaa1', '*:i-0bbbbbbbbbbbbbbb2'] } },
    }]);
    expect(quarantinedInstanceIds(encodeURIComponent(doc))).toEqual(['i-0aaaaaaaaaaaaaaa1', 'i-0bbbbbbbbbbbbbbb2']);
    expect(quarantineDenyDocument([])).toBeNull();
  });

  it('holds about 400 instances within the role’s inline policy limit', () => {
    expect(quarantineDenyDocument(ids(400))!.length).toBeLessThan(ROLE_INLINE_POLICY_LIMIT);
  });

  it('adds an instance once, keeps the others, and deletes the policy with the last one', async () => {
    const { iam, policies } = fakeIam();
    const t0 = new Date('2026-11-10T12:00:00Z');
    expect(await denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1', 'box-a')).toBe(1);
    expect(await denySharedRoleInstance(iam, SHARED.roleName, 'i-0bbbbbbbbbbbbbbb2', 'box-b')).toBe(2);
    expect(await denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1', 'box-a')).toBe(2);
    await scheduleSharedRoleDenyRelease(SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1', t0);
    await scheduleSharedRoleDenyRelease(SHARED.roleName, 'i-0bbbbbbbbbbbbbbb2', t0);
    expect(quarantinedInstanceIds(encodeURIComponent(policies.get(SHARED_QUARANTINE_POLICY)!))).toHaveLength(2);
    expect(await sweepSharedRoleDenies(iam, SHARED.roleName, new Date(t0.getTime() + SHARED_DENY_RETENTION_MS))).toBe(2);
    expect(policies.has(SHARED_QUARANTINE_POLICY)).toBe(false);
    expect(denyTable.current!.rows).toEqual([]);
  });

  it('holds an instance again when it is quarantined after its release was scheduled', async () => {
    const { iam, policies } = fakeIam();
    const t0 = new Date('2026-11-10T12:00:00Z');
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1');
    await scheduleSharedRoleDenyRelease(SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1', t0);
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1');
    expect(await sweepSharedRoleDenies(iam, SHARED.roleName, new Date(t0.getTime() + 2 * SHARED_DENY_RETENTION_MS))).toBe(0);
    expect(quarantinedInstanceIds(encodeURIComponent(policies.get(SHARED_QUARANTINE_POLICY)!))).toEqual(['i-0aaaaaaaaaaaaaaa1']);
  });

  it('keeps every entry when quarantines run at once', async () => {
    const { iam, policies } = fakeIam();
    await Promise.all(ids(20).map(id => denySharedRoleInstance(iam, SHARED.roleName, id)));
    expect(quarantinedInstanceIds(encodeURIComponent(policies.get(SHARED_QUARANTINE_POLICY)!))).toHaveLength(20);
  });

  it('refuses past the limit, writing nothing, and keeps the entry for the next write', async () => {
    const { iam, policies, sent } = fakeIam();
    await Promise.all(ids(440).map(id => denyTable.current!.delegate.upsert({
      where: { roleName_ec2InstanceId: { roleName: SHARED.roleName, ec2InstanceId: id } },
      create: { roleName: SHARED.roleName, ec2InstanceId: id, boxId: '' }, update: {},
    })));
    await expect(denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1')).rejects.toThrow(/over IAM's 10240/);
    expect(sent).not.toContain('PutRolePolicy');
    expect(policies.size).toBe(0);
    expect(denyTable.current!.rows.some(r => r.ec2InstanceId === 'i-0aaaaaaaaaaaaaaa1')).toBe(true);
  });

  it('refuses something that is not an instance id', async () => {
    const { iam } = fakeIam();
    await expect(denySharedRoleInstance(iam, SHARED.roleName, '*')).rejects.toThrow(/not an EC2 instance id/);
    expect(denyTable.current!.rows).toEqual([]);
  });
});

describe('the deny list is ours, not what IAM reads back', () => {
  beforeEach(() => { denyTable.current = sharedRoleDenyTable(); });

  /** IAM that keeps what is written but answers GetRolePolicy as if nothing were (IAM reads are eventually consistent). */
  function staleIam() {
    const fake = fakeIam();
    const send = (fake.iam as any).send;
    (fake.iam as any).send = async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetRolePolicyCommand') throw Object.assign(new Error('none yet (stale)'), { name: 'NoSuchEntityException' });
      return send(cmd);
    };
    return fake;
  }
  const deniedIn = (policies: Map<string, string>) =>
    policies.has(SHARED_QUARANTINE_POLICY) ? quarantinedInstanceIds(encodeURIComponent(policies.get(SHARED_QUARANTINE_POLICY)!)) : [];

  it('keeps the first box denied when the second quarantine reads a stale policy', async () => {
    const { iam, policies } = staleIam();
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1');
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0bbbbbbbbbbbbbbb2');
    expect(deniedIn(policies)).toEqual(['i-0aaaaaaaaaaaaaaa1', 'i-0bbbbbbbbbbbbbbb2']);
  });

  it('keeps a terminated box denied for the retention, and the sweep drops it after', async () => {
    const { iam, policies } = staleIam();
    const t0 = new Date('2026-11-10T12:00:00Z');
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1');
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0bbbbbbbbbbbbbbb2');
    await scheduleSharedRoleDenyRelease(SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1', t0);
    expect(deniedIn(policies)).toEqual(['i-0aaaaaaaaaaaaaaa1', 'i-0bbbbbbbbbbbbbbb2']);

    expect(await sweepSharedRoleDenies(iam, SHARED.roleName, new Date(t0.getTime() + SHARED_DENY_RETENTION_MS - 60_000))).toBe(0);
    expect(deniedIn(policies)).toEqual(['i-0aaaaaaaaaaaaaaa1', 'i-0bbbbbbbbbbbbbbb2']);

    expect(await sweepSharedRoleDenies(iam, SHARED.roleName, new Date(t0.getTime() + SHARED_DENY_RETENTION_MS))).toBe(1);
    expect(deniedIn(policies)).toEqual(['i-0bbbbbbbbbbbbbbb2']);
    expect(denyTable.current!.rows.map(r => r.ec2InstanceId)).toEqual(['i-0bbbbbbbbbbbbbbb2']);
  });

  it('keeps an expired entry when the policy write fails, so the next sweep tries again', async () => {
    const { iam, policies } = staleIam();
    const t0 = new Date('2026-11-10T12:00:00Z');
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1');
    await scheduleSharedRoleDenyRelease(SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1', t0);
    const send = (iam as any).send;
    (iam as any).send = async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'DeleteRolePolicyCommand') throw Object.assign(new Error('throttled'), { name: 'Throttling' });
      return send(cmd);
    };
    const later = new Date(t0.getTime() + SHARED_DENY_RETENTION_MS + 1);
    await expect(sweepSharedRoleDenies(iam, SHARED.roleName, later)).rejects.toThrow(/throttled/);
    expect(denyTable.current!.rows).toHaveLength(1);
    expect(deniedIn(policies)).toEqual(['i-0aaaaaaaaaaaaaaa1']);
    (iam as any).send = send;
    expect(await sweepSharedRoleDenies(iam, SHARED.roleName, later)).toBe(1);
    expect(policies.has(SHARED_QUARANTINE_POLICY)).toBe(false);
  });

  /** Runs `during` once, the first time the sweep writes the role's policy (after its snapshot, before its delete). */
  function onSweepWrite(iam: IAMClient, during: () => unknown) {
    const send = (iam as any).send;
    let fired = false;
    (iam as any).send = async (cmd: { constructor: { name: string } }) => {
      const out = await send(cmd);
      if (!fired && /^(Put|Delete)RolePolicyCommand$/.test(cmd.constructor.name)) { fired = true; await during(); }
      return out;
    };
  }

  it('keeps the deny of an instance quarantined again while the sweep is between its snapshot and its delete', async () => {
    const { iam, policies } = staleIam();
    const t0 = new Date('2026-11-10T12:00:00Z');
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1');
    await scheduleSharedRoleDenyRelease(SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1', t0);
    let rehold: Promise<number> | undefined;
    onSweepWrite(iam, () => { rehold = denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1'); });

    await sweepSharedRoleDenies(iam, SHARED.roleName, new Date(t0.getTime() + SHARED_DENY_RETENTION_MS));
    await rehold;

    expect(deniedIn(policies)).toEqual(['i-0aaaaaaaaaaaaaaa1']);
    expect(denyTable.current!.rows).toEqual([expect.objectContaining({ ec2InstanceId: 'i-0aaaaaaaaaaaaaaa1', releaseAfter: null })]);
  });

  it('never deletes, or leaves off the policy, a row whose release changed after the sweep read it', async () => {
    const { iam, policies } = staleIam();
    const t0 = new Date('2026-11-10T12:00:00Z');
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1');
    await denySharedRoleInstance(iam, SHARED.roleName, 'i-0bbbbbbbbbbbbbbb2');
    await scheduleSharedRoleDenyRelease(SHARED.roleName, 'i-0aaaaaaaaaaaaaaa1', t0);
    await scheduleSharedRoleDenyRelease(SHARED.roleName, 'i-0bbbbbbbbbbbbbbb2', t0);
    // A writer that does not take the lock puts b back on hold mid-sweep.
    onSweepWrite(iam, () => { denyTable.current!.rows.find(r => r.ec2InstanceId === 'i-0bbbbbbbbbbbbbbb2')!.releaseAfter = null; });

    expect(await sweepSharedRoleDenies(iam, SHARED.roleName, new Date(t0.getTime() + SHARED_DENY_RETENTION_MS))).toBe(1);

    expect(denyTable.current!.rows.map(r => r.ec2InstanceId)).toEqual(['i-0bbbbbbbbbbbbbbb2']);
    expect(deniedIn(policies)).toEqual(['i-0bbbbbbbbbbbbbbb2']);
  });
});
