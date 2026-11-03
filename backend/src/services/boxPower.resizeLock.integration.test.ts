/**
 * requestPower's resize guard against a real Postgres: a NOT EXISTS on the
 * box's open `resize` row in box_events. It must match a box that was never
 * resized (an earlier NOT over nullable columns was NULL there and matched no
 * row, Bugbot on #877), refuse one a resize holds, and let a finished or stale
 * resize go. The in-memory fakes in boxPower.test.ts can't show SQL's NULLs.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_resizelock_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_resizelock_${process.pid}$1`); });

vi.mock('@aws-sdk/client-ec2', () => {
  const command = (name: string) => class { constructor(public input: unknown) {} name = name; };
  return {
    StopInstancesCommand: command('StopInstances'),
    StartInstancesCommand: command('StartInstances'),
    DescribeInstancesCommand: command('DescribeInstances'),
    EC2Client: class { async send() { return {}; } },
  };
});
vi.mock('./agentRegistry', () => ({ dropInstanceAgent: vi.fn() }));
vi.mock('./boxProvisioner', () => ({ getBoxConfig: () => ({ region: 'us-east-2' }), awsClientConfig: () => ({ region: 'us-east-2' }) }));
vi.mock('./productEvents', () => ({ recordProductEvent: vi.fn() }));

describe.skipIf(!adminUrl)('requestPower and the resize lock, against Postgres', () => {
  let prisma: typeof import('../db').prisma;
  let power: typeof import('./boxPower');
  let lock: typeof import('./boxResizeLock');

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
    power = await import('./boxPower');
    lock = await import('./boxResizeLock');
    await prisma.user.create({ data: { id: 'u1', googleId: 'g-u1', googleEmail: 'u1@example.com', unixUsername: 'u1', displayName: 'u1' } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  beforeEach(async () => { await prisma.boxEvent.deleteMany({}); await prisma.instance.deleteMany({}); });

  /** A stopped box, with a resize row when `resize` says when it started and finished. */
  const box = async (resize?: { startedAt: Date; finishedAt: Date | null }, kind = 'resize') => {
    const b = await prisma.instance.create({
      data: { userId: 'u1', name: `b${Math.random().toString(36).slice(2, 8)}`, kind: 'ec2', status: 'stopped', ec2InstanceId: `i-${Math.random().toString(16).slice(2, 10)}` },
    });
    if (resize) await prisma.boxEvent.create({ data: { boxId: b.id, boxName: b.name, kind, actorRole: 'owner', phase: 'stopping', ...resize } });
    return b;
  };

  it('starts a box that was never resized (resizeStartedAt NULL)', async () => {
    const b = await box();
    await expect(power.requestPower(b, 'start')).resolves.toBe('starting');
  });

  it('starts a box whose last resize finished, or whose lock went stale', async () => {
    const finished = await box({ startedAt: new Date(Date.now() - 60_000), finishedAt: new Date() });
    await expect(power.requestPower(finished, 'start')).resolves.toBe('starting');
    const stale = await box({ startedAt: new Date(Date.now() - lock.RESIZE_STALE_MS - 60_000), finishedAt: null });
    await expect(power.requestPower(stale, 'start')).resolves.toBe('starting');
    const growing = await box({ startedAt: new Date(), finishedAt: null }, 'disk-grow');
    await expect(power.requestPower(growing, 'start')).resolves.toBe('starting');
  });

  it('refuses, in the write, a box a resize locked after the caller read it', async () => {
    const before = await box();
    await prisma.boxEvent.create({ data: { boxId: before.id, boxName: before.name, kind: 'resize', actorRole: 'owner', phase: 'requested' } });
    await expect(power.requestPower(before, 'start')).rejects.toThrow('This box is being resized; try again once that is done');
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: before.id } })).status).toBe('stopped');
    // The resize's own start goes through.
    const locked = await prisma.instance.findUniqueOrThrow({ where: { id: before.id } });
    await expect(power.requestPower(locked, 'start', { forResize: true })).resolves.toBe('starting');
  });

  it('keeps a box_events row, with the box name, when the box row is deleted', async () => {
    const b = await prisma.instance.create({ data: { userId: 'u1', name: 'gone', kind: 'ec2', status: 'stopped' } });
    const e = await prisma.boxEvent.create({ data: { boxId: b.id, boxName: b.name, kind: 'resize', actorRole: 'owner', phase: 'done', finishedAt: new Date() } });
    await prisma.instance.delete({ where: { id: b.id } });
    expect(await prisma.boxEvent.findUnique({ where: { id: e.id } })).toMatchObject({ boxId: null, boxName: 'gone' });
  });
});
