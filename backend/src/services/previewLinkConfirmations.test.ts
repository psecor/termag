// A sign-in made on a box (SR5, option B of 2026-11-04): "only me" applies at
// once, anything wider waits for the person's confirm in their browser, and
// the confirm applies exactly what was asked, once.
import { describe, expect, it, vi } from 'vitest';
import type { Instance, User } from '@prisma/client';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: vi.fn(), projectAgentCapabilities: vi.fn(), sendForProject: vi.fn() }));
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => false), numberVariation: vi.fn(async () => 24) }));

const c = await import('./previewLinkConfirmations');
const svc = await import('./previewLinks');
const { memoryConfirmationStore, memoryStore } = await import('./previewLinksTestStore');
const { linkTokenHash } = await import('./previewLinkRules');
type PreviewLinkDeps = import('./previewLinks').PreviewLinkDeps;

const T0 = Date.parse('2026-11-04T12:00:00Z');
const user = (id: string): User => ({ id, googleEmail: `${id}@x.test`, displayName: id, unixUsername: id } as User);
const alice = user('alice');
const bob = user('bob');
const box = { id: 'box1', name: 'alicebox', hostHome: '/home/alice' } as Instance;
const PROJECT = 'cproject00000001';
const as = (u: User) => ({ id: u.id, googleEmail: u.googleEmail });

function setup() {
  let now = T0;
  const mem = memoryStore(() => new Date(now));
  const confirmations = memoryConfirmationStore(() => new Date(now));
  const rows = confirmations.rows;
  let seed = 0;
  const links: PreviewLinkDeps = {
    store: mem.store,
    findProject: async (id) => (id === PROJECT ? { id, name: 'webapp', userId: alice.id, archived: false, instanceId: box.id, instance: box, owner: alice } : null),
    isCollaborator: async (_p, uid) => uid === bob.id,
    findWorkstream: async (_p, name) => (name === 'main' ? { id: null } : undefined),
    findUserByEmail: async (email) => [alice, bob].find(u => u.googleEmail === email) ?? null,
    enabled: async () => true,
    audiencesOn: async () => true,
    ttlDefault: async () => 24,
    agent: { connected: () => true, capabilities: () => ['preview-link-v1'], send: async () => ({ listeners: [] }) },
    siteBase: () => 'https://termag.example/termag',
    previewDomain: () => null,
    now: () => new Date(now),
    random: (n) => Buffer.alloc(n, ++seed),
  };
  const logs: string[] = [];
  const deps: import('./previewLinkConfirmations').ConfirmationDeps = {
    links,
    store: confirmations.store,
    boxName: async (id) => (id === box.id ? box.name : null),
    secret: () => 'test-secret',
    random: (n) => Buffer.alloc(n, 0x40 + ++seed),
    log: (l) => logs.push(l),
    audienceOps: mem.audience,
    emailsOf: async (ids) => ids.map(i => `${i}@x.test`).sort(),
  };
  return { deps, mem, rows, logs, advance: (ms: number) => { now += ms; } };
}

/** The id from a 202's confirm URL. */
const idOf = (r: { body: unknown }) => ((r.body as any).confirm.url as string).split('/').pop()!;

describe('from a sign-in made on a box', () => {
  it('publishes an "only me" link at once, as from a laptop', async () => {
    const t = setup();
    const r = await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'my-app' }, box.id);
    expect(r.status).toBe(201);
    expect(t.mem.links).toHaveLength(1);
    expect(t.rows.size).toBe(0);
  });

  it('holds a wider audience for a confirm: 202 with a one-time URL on the main host, and nothing live', async () => {
    const t = setup();
    const r = await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test'] }, box.id);
    expect(r.status).toBe(202);
    const body = r.body as any;
    expect(body).toMatchObject({ code: 'confirm_in_browser', audience: 'people', emails: ['bob@x.test'] });
    expect(body.confirm.url).toMatch(/^https:\/\/termag\.example\/termag\/previews\/confirm\/[A-Za-z0-9_-]{43}$/);
    expect(body.confirm.expiresAt).toBe(new Date(T0 + 10 * 60_000).toISOString());
    expect(t.mem.links).toEqual([]);
    expect(t.mem.audiences).toEqual([]);
    // Only the id's hash is kept.
    const [row] = [...t.rows.values()];
    expect(row.idHash).toBe(c.hashConfirmId(idOf(r)));
    expect(JSON.stringify(row)).not.toContain(idOf(r));
    expect(row).toMatchObject({ userId: 'alice', projectId: PROJECT, fromBoxId: 'box1', kind: 'publish', state: 'pending' });
    expect(t.logs[0]).toMatch(/^\[PREVIEW-LINK\] confirmation requested: publish user=alice/);
  });

  it('refuses at once what could never apply, without asking for a confirm', async () => {
    const t = setup();
    expect(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'my-app', audience: 'people', emails: ['eve@x.test'] }, box.id)).toMatchObject({ status: 400, body: { code: 'not_a_termag_user' } });
    expect(await c.publishFromBoxFor(t.deps, as(user('mallory')), PROJECT, { port: 5173, name: 'my-app', audience: 'link' }, box.id)).toMatchObject({ status: 404 });
    expect(t.rows.size).toBe(0);
  });

  it('confirming applies exactly the request, once, and hands a minted token to the CLI once', async () => {
    const t = setup();
    const r = await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'my-app', audience: 'link', ttlHours: 6 }, box.id);
    const id = idOf(r);
    const page = await c.confirmPageFor(t.deps, 'alice', id);
    expect(page).toMatchObject({ state: 'pending', projectName: 'webapp', boxName: 'alicebox', fromBoxName: 'alicebox', workstream: 'main', port: 5173, name: 'my-app', audience: 'link', ttlHours: 6 });
    expect(await c.decideConfirmationFor(t.deps, as(alice), id, 'publish', page!.csrf)).toEqual({ ok: true, state: 'confirmed' });
    expect(t.mem.links).toHaveLength(1);
    expect(t.mem.links[0]).toMatchObject({ name: 'my-app', port: 5173, audience: 'link', hostMode: 'localhost', expiresAt: new Date(T0 + 6 * 3600_000) });
    expect(t.mem.grantees).toEqual([]);
    // Used: a second Publish changes nothing.
    expect(await c.decideConfirmationFor(t.deps, as(alice), id, 'publish', page!.csrf)).toEqual({ ok: false, status: 409, reason: 'confirmed' });
    expect(t.mem.links).toHaveLength(1);
    // The CLI's poll gets the token once.
    const first = (await c.confirmationStatusFor(t.deps, as(alice), id)).body as any;
    expect(first).toMatchObject({ state: 'confirmed', link: { name: 'my-app', audience: 'link' } });
    const token = (first.shareUrl as string).split('/').pop()!;
    expect(t.mem.links[0].linkTokenHash).toBe(linkTokenHash(token));
    expect(((await c.confirmationStatusFor(t.deps, as(alice), id)).body as any).shareUrl).toBeNull();
    expect(t.mem.events.at(-1)).toMatchObject({ kind: 'confirmed', actorId: 'alice', detail: { confirm: 'publish', fromBoxId: 'box1' } });
  });

  it('declining, or letting it expire, publishes nothing', async () => {
    const t = setup();
    const a = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'one-app', audience: 'link' }, box.id));
    const b = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'two-app', audience: 'link' }, box.id));
    const pa = await c.confirmPageFor(t.deps, 'alice', a);
    expect(await c.decideConfirmationFor(t.deps, as(alice), a, 'decline', pa!.csrf)).toEqual({ ok: true, state: 'declined' });
    expect(((await c.confirmationStatusFor(t.deps, as(alice), a)).body as any).state).toBe('declined');
    t.advance(10 * 60_000);
    expect(((await c.confirmationStatusFor(t.deps, as(alice), b)).body as any).state).toBe('expired');
    const pb = await c.confirmPageFor(t.deps, 'alice', b);
    expect(pb!.state).toBe('expired');
    expect(await c.decideConfirmationFor(t.deps, as(alice), b, 'publish', pb!.csrf)).toEqual({ ok: false, status: 409, reason: 'expired' });
    expect(t.mem.links).toEqual([]);
    expect(t.logs.map(l => l.split(':')[0])).toEqual([
      '[PREVIEW-LINK] confirmation requested', '[PREVIEW-LINK] confirmation requested', '[PREVIEW-LINK] confirmation declined', '[PREVIEW-LINK] confirmation expired',
    ]);
  });

  it('only the person who asked may see or confirm it', async () => {
    const t = setup();
    const id = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'my-app', audience: 'link' }, box.id));
    expect(await c.confirmPageFor(t.deps, 'bob', id)).toBeNull();
    // Even with a CSRF token made for Bob, or one lifted from Alice's page.
    const alicePage = await c.confirmPageFor(t.deps, 'alice', id);
    expect(await c.decideConfirmationFor(t.deps, as(bob), id, 'publish', alicePage!.csrf)).toEqual({ ok: false, status: 404, reason: 'not_found' });
    expect(await c.confirmationStatusFor(t.deps, as(bob), id)).toMatchObject({ status: 404 });
    expect(t.mem.links).toEqual([]);
  });

  it('needs the CSRF token the page made for this request and person', async () => {
    const t = setup();
    const id = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'my-app', audience: 'link' }, box.id));
    const other = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5174, name: 'my-other', audience: 'link' }, box.id));
    const otherPage = await c.confirmPageFor(t.deps, 'alice', other);
    for (const csrf of [undefined, '', 'x', otherPage!.csrf]) {
      expect(await c.decideConfirmationFor(t.deps, as(alice), id, 'publish', csrf)).toEqual({ ok: false, status: 403, reason: 'csrf' });
    }
    expect(t.mem.links).toEqual([]);
  });

  it('an extend of a people or link link waits for a confirm; of an "only me" one it applies at once', async () => {
    const t = setup();
    const owner = await svc.publishPreviewLinkFor(t.deps.links, as(alice), PROJECT, { port: 5173, name: 'only-me', ttlHours: 2 });
    expect((await c.extendFromBoxFor(t.deps, as(alice), (owner.body as any).link.id, { ttlHours: 24 }, box.id)).status).toBe(200);
    const wide = await svc.publishPreviewLinkFor(t.deps.links, as(alice), PROJECT, { port: 5174, name: 'wide-app', audience: 'link', ttlHours: 2 });
    const wideId = (wide.body as any).link.id;
    const r = await c.extendFromBoxFor(t.deps, as(alice), wideId, { ttlHours: 48 }, box.id);
    expect(r.status).toBe(202);
    expect(t.mem.links.find(l => l.id === wideId)!.expiresAt).toEqual(new Date(T0 + 2 * 3600_000));
    const page = await c.confirmPageFor(t.deps, 'alice', idOf(r));
    expect(page).toMatchObject({ kind: 'extend', name: 'wide-app', port: 5174, audience: 'link', ttlHours: 48 });
    expect(await c.decideConfirmationFor(t.deps, as(alice), idOf(r), 'publish', page!.csrf)).toEqual({ ok: true, state: 'confirmed' });
    expect(t.mem.links.find(l => l.id === wideId)!.expiresAt).toEqual(new Date(T0 + 48 * 3600_000));
  });

  it("an extend's confirm names the people the link keeps in, as a publish's does", async () => {
    const t = setup();
    const ppl = await svc.publishPreviewLinkFor(t.deps.links, as(alice), PROJECT, { port: 5175, name: 'ppl-app', audience: 'people', emails: ['bob@x.test'], ttlHours: 2 });
    const r = await c.extendFromBoxFor(t.deps, as(alice), (ppl.body as any).link.id, { ttlHours: 48 }, box.id);
    expect(r).toMatchObject({ status: 202, body: { audience: 'people', emails: ['bob@x.test'] } });
    expect(await c.confirmPageFor(t.deps, 'alice', idOf(r))).toMatchObject({ kind: 'extend', audience: 'people', emails: ['bob@x.test'] });
  });

  it('a confirm whose publish is refused by then ends failed, with the reason for the CLI', async () => {
    const t = setup();
    const id = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'taken-app', audience: 'link' }, box.id));
    // Someone else's link takes the name first.
    t.deps.links.findProject = async (pid) => ({ id: pid, name: 'webapp', userId: alice.id, archived: false, instanceId: box.id, instance: box, owner: alice });
    await svc.publishPreviewLinkFor(t.deps.links, as(alice), 'cproject00000002', { port: 3000, name: 'taken-app' });
    const page = await c.confirmPageFor(t.deps, 'alice', id);
    expect(await c.decideConfirmationFor(t.deps, as(alice), id, 'publish', page!.csrf)).toEqual({ ok: true, state: 'failed' });
    expect(((await c.confirmationStatusFor(t.deps, as(alice), id)).body as any)).toMatchObject({ state: 'failed', failure: expect.stringContaining('another workstream or project') });
  });

  it('a publish that throws mid-apply ends failed, never stuck applying; so does an apply the server lost', async () => {
    const t = setup();
    const id = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'my-app', audience: 'link' }, box.id));
    const page = await c.confirmPageFor(t.deps, 'alice', id);
    const withName = t.deps.links.store.withName;
    t.deps.links.store.withName = async () => { throw new Error('connection reset'); };
    expect(await c.decideConfirmationFor(t.deps, as(alice), id, 'publish', page!.csrf)).toEqual({ ok: true, state: 'failed' });
    expect(((await c.confirmationStatusFor(t.deps, as(alice), id)).body as any)).toMatchObject({ state: 'failed', failure: expect.stringContaining('ask again') });
    t.deps.links.store.withName = withName;
    // A process that died between `applying` and its outcome:
    const lost = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5174, name: 'lost-app', audience: 'link' }, box.id));
    const row = t.rows.get(c.hashConfirmId(lost))!;
    Object.assign(row, { state: 'applying', decidedAt: new Date(T0) });
    expect(((await c.confirmationStatusFor(t.deps, as(alice), lost)).body as any).state).toBe('pending');
    t.advance(c.APPLY_STALE_MS + 1);
    expect(((await c.confirmationStatusFor(t.deps, as(alice), lost)).body as any)).toMatchObject({ state: 'failed', failure: expect.stringContaining('interrupted') });
    expect(t.mem.links).toEqual([]);
  });

  it("keeps a minted link token sealed at rest: the row alone can't open it, the poll with the id gets it once", async () => {
    const t = setup();
    const id = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'my-app', audience: 'link' }, box.id));
    const page = await c.confirmPageFor(t.deps, 'alice', id);
    await c.decideConfirmationFor(t.deps, as(alice), id, 'publish', page!.csrf);
    const row = t.rows.get(c.hashConfirmId(id))!;
    // A backup-shaped read: every column of the row, and nothing else.
    const backup = JSON.stringify(row);
    expect(row.shareUrlSealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(backup).not.toContain('/previews/my-app/');
    const linkHash = t.mem.links[0].linkTokenHash!;
    // No 22-character token in the backup hashes to the link's.
    for (const m of backup.matchAll(/[A-Za-z0-9_-]{22}/g)) expect(linkTokenHash(m[0])).not.toBe(linkHash);
    // The idHash (all the row has of the id) is no key; another confirm's id is none either.
    expect(c.openShareUrl(row.idHash, row.shareUrlSealed)).toBeNull();
    expect(c.openShareUrl('B'.repeat(43), row.shareUrlSealed)).toBeNull();
    // The person's page, whose request carries the id, can show it while it's held.
    const shown = (await c.confirmPageFor(t.deps, 'alice', id))!.shareUrl!;
    expect(linkTokenHash(shown.split('/').pop()!)).toBe(linkHash);
    // The CLI's poll with the right id gets it once.
    const first = (await c.confirmationStatusFor(t.deps, as(alice), id)).body as any;
    expect(first.shareUrl).toBe(shown);
    expect(t.rows.get(c.hashConfirmId(id))!.shareUrlSealed).toBeNull();
    expect(((await c.confirmationStatusFor(t.deps, as(alice), id)).body as any).shareUrl).toBeNull();
  });

  it('stores nothing to seal for "only me" and people links', async () => {
    const t = setup();
    for (const [name, body] of [['wide-one', { audience: 'people', emails: ['bob@x.test'] }], ['wide-two', { audience: 'people', emails: ['bob@x.test'] }]] as const) {
      const id = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name, ...body }, box.id));
      const page = await c.confirmPageFor(t.deps, 'alice', id);
      expect(await c.decideConfirmationFor(t.deps, as(alice), id, 'publish', page!.csrf)).toEqual({ ok: true, state: 'confirmed' });
      expect(t.rows.get(c.hashConfirmId(id))!.shareUrlSealed).toBeNull();
    }
    // An "only me" extend of nothing wider never makes a confirm at all.
    expect([...t.rows.values()].every(r => r.request.audience === 'people')).toBe(true);
  });

  it('a seal opens only under its own id and refuses any tampering', () => {
    const id = 'A'.repeat(43);
    const sealed = c.sealShareUrl(id, 'https://termag.example/termag/previews/x/TOKENTOKENTOKENTOKEN12');
    expect(c.openShareUrl(id, sealed)).toBe('https://termag.example/termag/previews/x/TOKENTOKENTOKENTOKEN12');
    const [v, iv, ct, tag] = sealed.split('.');
    const flip = (b64: string) => { const b = Buffer.from(b64, 'base64url'); b[0] ^= 1; return b.toString('base64url'); };
    for (const bad of [`${v}.${iv}.${flip(ct)}.${tag}`, `${v}.${iv}.${ct}.${flip(tag)}`, `${v}.${flip(iv)}.${ct}.${tag}`, `v2.${iv}.${ct}.${tag}`, 'garbage', '']) {
      expect(c.openShareUrl(id, bad), bad).toBeNull();
    }
    expect(c.openShareUrl(id, null)).toBeNull();
  });

  it('an apply reported lost that then succeeds is confirmed after all, with its token; the stale check reports what is stored', async () => {
    const t = setup();
    const id = idOf(await c.publishFromBoxFor(t.deps, as(alice), PROJECT, { port: 5173, name: 'slow-app', audience: 'link' }, box.id));
    const page = await c.confirmPageFor(t.deps, 'alice', id);
    // The publish stalls past APPLY_STALE_MS; meanwhile the CLI polls.
    const withName = t.deps.links.store.withName.bind(t.deps.links.store);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    t.deps.links.store.withName = (async (name: string, fn: never) => { await gate; return withName(name, fn); }) as never;
    const deciding = c.decideConfirmationFor(t.deps, as(alice), id, 'publish', page!.csrf);
    await new Promise(r => setTimeout(r, 0));
    t.advance(c.APPLY_STALE_MS + 1);
    expect(((await c.confirmationStatusFor(t.deps, as(alice), id)).body as any)).toMatchObject({ state: 'failed', failure: expect.stringContaining('interrupted') });
    release();
    expect(await deciding).toEqual({ ok: true, state: 'confirmed' });
    const after = (await c.confirmationStatusFor(t.deps, as(alice), id)).body as any;
    expect(after).toMatchObject({ state: 'confirmed', link: { name: 'slow-app' } });
    expect(after.shareUrl).toMatch(/\/previews\/slow-app\/[A-Za-z0-9_-]{22}$/);
    expect(t.mem.links).toHaveLength(1);
  });
});
