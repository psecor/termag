/**
 * The resize lock against a real Postgres: a resize is a row in box_events,
 * taken with the box row locked FOR UPDATE, so two requests at once for one
 * box get one 202 and one 409, and each resize keeps its own row.
 *
 * The first resize's job is held at its first EC2 call until the test lets
 * it fail, and the second request's pre-check waits until that job is under
 * way. So the second request always reads the box while the first resize
 * runs, as two clicks a second apart do. Unheld, the job's immediate failure
 * could close the first row before the second request read it, which a
 * loaded CI runner did: a correct 202 for a box with no resize running.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_boxevents_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_boxevents_${process.pid}$1`); });

const job = vi.hoisted(() => {
  let started!: () => void;
  let release!: () => void;
  return {
    dryRuns: 0,
    underway: new Promise<void>(resolve => { started = resolve; }),
    released: new Promise<void>(resolve => { release = resolve; }),
    start: () => started(),
    release: () => release(),
  };
});
vi.mock('@aws-sdk/client-ec2', () => {
  const command = (name: string) => class { constructor(public input: any) {} name = name; };
  return {
    DescribeInstancesCommand: command('DescribeInstances'),
    DescribeInstanceTypeOfferingsCommand: command('DescribeInstanceTypeOfferings'),
    DescribeInstanceTypesCommand: command('DescribeInstanceTypes'),
    ModifyInstanceAttributeCommand: command('ModifyInstanceAttribute'),
    EC2Client: class {
      async send(cmd: { name: string; input: any }) {
        if (cmd.name === 'ModifyInstanceAttribute' && cmd.input.DryRun) {
          if (++job.dryRuns === 2) await job.underway;
          throw Object.assign(new Error('dry run'), { name: 'DryRunOperation' });
        }
        // Once released, the job ends failed, before it touches power.
        if (cmd.name === 'DescribeInstances') {
          job.start();
          await job.released;
          throw new Error('describe failed');
        }
        return {};
      }
    },
  };
});
vi.mock('./boxProvisioner', () => ({
  isCapacityRefusal: () => false, getBoxConfig: () => ({ region: 'us-east-2' }),
  awsClientConfig: () => ({ region: 'us-east-2' }), isBoxProvisioningConfigured: () => true,
}));
vi.mock('./boxPower', () => ({ requestPower: vi.fn() }));
vi.mock('./boxLifecycle', () => ({ busyBoxes: async () => new Map(), workingBoxes: () => new Set() }));
vi.mock('./productEvents', () => ({ recordProductEvent: vi.fn() }));
vi.mock('./workspaceEvents', () => ({ notifyWorkspaceChange: () => {} }));

describe.skipIf(!adminUrl)('resize rows in box_events, against Postgres', () => {
  let prisma: typeof import('../db').prisma;
  let startResize: typeof import('./boxResize').startResize;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = spawnSync(join(__dirname, '../../node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: join(__dirname, '../..'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);
    ({ prisma } = await import('../db'));
    ({ startResize } = await import('./boxResize'));
    await prisma.user.create({ data: { id: 'u1', googleId: 'g-u1', googleEmail: 'u1@example.com', unixUsername: 'u1', displayName: 'u1' } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const owner = { userId: 'u1', role: 'owner' as const, via: 'ui' as const };
  const until = async (ok: () => Promise<boolean>) => { for (let i = 0; i < 100 && !(await ok()); i++) await new Promise(r => setTimeout(r, 20)); };

  it('two requests at once: one resize, one 409; then a second resize keeps its own row', async () => {
    const box = await prisma.instance.create({ data: { userId: 'u1', name: 'olive', kind: 'ec2', status: 'ready', ec2InstanceId: 'i-1', size: 'small', instanceType: 'm8g.large' } });
    const [a, b] = await Promise.all([startResize(box, 'large', owner), startResize({ ...box }, 'medium', owner)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect(((a.ok ? b : a) as { body: { code: string } }).body.code).toBe('resize_running');
    job.release();

    await until(async () => (await prisma.boxEvent.count({ where: { boxId: box.id, finishedAt: { not: null } } })) === 1);
    const first = await prisma.boxEvent.findFirstOrThrow({ where: { boxId: box.id } });
    expect(first).toMatchObject({ kind: 'resize', boxName: 'olive', actorId: 'u1', actorRole: 'owner', phase: 'failed', error: expect.stringContaining('describe failed') });

    expect(await startResize(box, 'medium', owner)).toMatchObject({ ok: true });
    await until(async () => (await prisma.boxEvent.count({ where: { boxId: box.id, finishedAt: { not: null } } })) === 2);
    expect(await prisma.boxEvent.count({ where: { boxId: box.id, kind: 'resize' } })).toBe(2);
  });
});
