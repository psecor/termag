/**
 * The review group store against a real Postgres: one open group per PR,
 * reopening a group takes its members back, closed groups expire, the open
 * group cap, and another user's group is out of reach.
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_groups_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_groups_${process.pid}$1`); });

const NOW = new Date('2026-10-24T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const m = (repo: string, number: number, note: string | null = null) => ({ repo, number, note, title: `${repo}#${number}` });
const keys = (g: { members: { repo: string; number: number }[] }) => g.members.map(x => `${x.repo}#${x.number}`);

describe.skipIf(!adminUrl)('review groups against Postgres', () => {
  let store: typeof import('./prReviewGroups').prismaReviewGroups;
  let prisma: typeof import('../db').prisma;

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
    ({ prismaReviewGroups: store } = await import('./prReviewGroups'));
    for (const id of ['u1', 'u2']) {
      await prisma.user.create({ data: { id, googleId: `g-${id}`, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id } });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('stores a group in review order, and moves a PR out of the other open group', async () => {
    const a = await store.create('u1', 'Desktop bridge', [m('example-org/termag', 646, 'the contract'), m('example-org/terraform', 28576)]);
    expect(keys(a)).toEqual(['example-org/termag#646', 'example-org/terraform#28576']);
    expect(a.members[0]).toMatchObject({ position: 0, note: 'the contract', title: 'example-org/termag#646' });

    const b = await store.create('u1', 'Infra', [m('example-org/terraform', 28576), m('example-org/terraform', 28577)]);
    const [ga, gb] = (await store.list('u1', NOW)).filter(g => [a.id, b.id].includes(g.id)).sort((x, y) => (x.id === a.id ? -1 : 1));
    expect(keys(ga)).toEqual(['example-org/termag#646']);
    expect(keys(gb)).toEqual(['example-org/terraform#28576', 'example-org/terraform#28577']);

    // Reordering is a whole new list: positions follow it.
    expect(await store.setMembers('u1', b.id, [m('example-org/terraform', 28577), m('example-org/terraform', 28576, 'after 646 deploys')])).toBe(true);
    const again = (await store.list('u1', NOW)).find(g => g.id === b.id)!;
    expect(keys(again)).toEqual(['example-org/terraform#28577', 'example-org/terraform#28576']);
    expect(again.members[1].note).toBe('after 646 deploys');
  });

  it('leaves a closed group its members, and takes them back on reopen', async () => {
    const closed = await store.create('u1', 'Old', [m('o/r', 1)]);
    await store.update('u1', closed.id, { closed: true }, NOW);
    const open = await store.create('u1', 'New', [m('o/r', 1)]);
    let groups = await store.list('u1', NOW);
    expect(keys(groups.find(g => g.id === closed.id)!)).toEqual(['o/r#1']);
    expect(keys(groups.find(g => g.id === open.id)!)).toEqual(['o/r#1']);
    // Open groups first, then closed ones.
    expect(groups.findIndex(g => g.id === closed.id)).toBeGreaterThan(groups.findIndex(g => g.id === open.id));

    await store.update('u1', closed.id, { closed: false }, NOW);
    groups = await store.list('u1', NOW);
    expect(groups.find(g => g.id === closed.id)).toMatchObject({ closedAt: null });
    expect(keys(groups.find(g => g.id === open.id)!)).toEqual([]);
    await store.remove('u1', closed.id);
    await store.remove('u1', open.id);
  });

  it('keeps a closed group 30 days, then deletes it with its members', async () => {
    const g = await store.create('u1', 'Expiring', [m('o/r', 2)]);
    await store.update('u1', g.id, { closed: true }, new Date(NOW.getTime() - 31 * DAY));
    const kept = await store.create('u1', 'Recent', [m('o/r', 3)]);
    await store.update('u1', kept.id, { closed: true }, new Date(NOW.getTime() - 29 * DAY));
    const ids = (await store.list('u1', NOW)).map(x => x.id);
    expect(ids).not.toContain(g.id);
    expect(ids).toContain(kept.id);
    expect(await prisma.prReviewGroupMember.count({ where: { groupId: g.id } })).toBe(0);
    await store.remove('u1', kept.id);
  });

  it('caps open groups at 10', async () => {
    const before = (await store.list('u1', NOW)).filter(g => !g.closedAt).length;
    const made: string[] = [];
    for (let i = before; i < 10; i++) made.push((await store.create('u1', `g${i}`, [])).id);
    await expect(store.create('u1', 'one too many', [])).rejects.toThrow(/at most 10 open groups/);
    for (const id of made) await store.remove('u1', id);
  });

  it('holds the cap and the one-open-group rule under concurrent writes (Devin)', async () => {
    const before = (await store.list('u1', NOW)).filter(g => !g.closedAt).length;
    const room = 10 - before;
    // Twelve creates at once, each claiming the same PR: exactly `room` land, and the PR ends in one group.
    const results = await Promise.allSettled(Array.from({ length: room + 2 }, (_, i) => store.create('u1', `race${i}`, [m('race/r', 1)])));
    const made = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof store.create>>> => r.status === 'fulfilled').map(r => r.value.id);
    expect(made).toHaveLength(room);
    expect(results.filter(r => r.status === 'rejected').every(r => /at most 10 open groups/.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
    const holding = (await store.list('u1', NOW)).filter(g => !g.closedAt && keys(g).includes('race/r#1'));
    expect(holding).toHaveLength(1);
    for (const id of made) await store.remove('u1', id);
  });

  it('never reaches another user\'s group', async () => {
    const g = await store.create('u2', 'Theirs', [m('example-org/termag', 646)]);
    expect(await store.update('u1', g.id, { name: 'Mine now' }, NOW)).toBe(false);
    expect(await store.setMembers('u1', g.id, [])).toBe(false);
    await store.remove('u1', g.id);
    expect((await store.list('u2', NOW)).map(x => x.name)).toEqual(['Theirs']);
    // u1 claiming the same PR leaves u2's group alone.
    await store.create('u1', 'Also 646', [m('example-org/termag', 646)]);
    expect(keys((await store.list('u2', NOW))[0])).toEqual(['example-org/termag#646']);
  });
});
