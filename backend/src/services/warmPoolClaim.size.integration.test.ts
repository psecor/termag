/**
 * The claim statement against a real Postgres: a claim takes only a warm box
 * of the size it asks for (Instance.size, services/boxSize.ts), and a box
 * with no size only for a claim with none, even where two rows share a spec
 * hash.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_claimsize_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_claimsize_${process.pid}$1`); });

vi.mock('./agentRegistry', () => ({
  connectedInstanceIds: () => [], disownInstanceAgent: vi.fn(), notifyInstanceClaimed: vi.fn(),
  rebindInstanceOwner: vi.fn(), sendToInstanceAgent: vi.fn(), settleClaimedOwner: vi.fn(),
}));
vi.mock('./sshKeySync', () => ({ syncBoxAuthorizedKeys: vi.fn() }));
vi.mock('./credentialDelivery', () => ({ deliverToInstance: vi.fn() }));

describe.skipIf(!adminUrl)('claiming a warm box of a size, against Postgres', () => {
  let prisma: typeof import('../db').prisma;
  let effects: typeof import('./warmPoolClaim').prismaClaimEffects;
  let owner: import('@prisma/client').User;
  const ids: Record<string, string> = {};

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
    ({ prismaClaimEffects: effects } = await import('./warmPoolClaim'));
    owner = await prisma.user.create({ data: { id: 'u1', googleId: 'g-u1', googleEmail: 'u1@example.com', unixUsername: 'u1', displayName: 'u1' } });
    const now = new Date();
    for (const [name, size] of [['warm-small', 'small'], ['warm-none', null]] as const) {
      const row = await prisma.instance.create({
        data: { userId: null, name, kind: 'ec2', status: 'warm', poolSpecHash: 'h1', size, warmedAt: now, lastConnectedAt: now },
      });
      ids[name] = row.id;
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const take = (size: 'small' | 'medium' | 'large' | null, boxName: string) =>
    effects.takeWarmBox({ owner, boxName, currentHash: 'h1', size, parentInstanceId: null }, Object.values(ids));

  it('never hands out a box of another size', async () => {
    expect(await take('medium', 'b1')).toBeNull();
    expect(await take('large', 'b2')).toBeNull();
  });

  it('takes the box of the size asked for, and the size-less one only for a claim with none', async () => {
    expect(await take('small', 'b3')).toMatchObject({ id: ids['warm-small'], size: 'small', userId: 'u1', status: 'ready' });
    expect(await take('small', 'b4')).toBeNull();
    expect(await take(null, 'b5')).toMatchObject({ id: ids['warm-none'], size: null, userId: 'u1' });
  });
});
