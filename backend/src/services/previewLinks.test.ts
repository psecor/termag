import { describe, expect, it, vi } from 'vitest';
import type { Instance, User } from '@prisma/client';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({ isProjectAgentConnected: vi.fn(), projectAgentCapabilities: vi.fn(), sendForProject: vi.fn() }));
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => false), numberVariation: vi.fn(async () => 24) }));

const svc = await import('./previewLinks');
const { memoryStore } = await import('./previewLinksTestStore');
const core = await import('./previewAudience');
const { holdUntil, linkTokenHash, LINK_TOKEN_RE, NAME_HOLD_MS } = await import('./previewLinkRules');
type PreviewLinkDeps = import('./previewLinks').PreviewLinkDeps;
type PreviewLinkProject = import('./previewLinks').PreviewLinkProject;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-31T12:00:00Z');

const user = (id: string): User => ({ id, googleEmail: `${id}@x.test`, displayName: id[0].toUpperCase() + id.slice(1), unixUsername: id } as User);
const alice = user('alice');
const bob = user('bob');
const carol = user('carol');
const dave = user('dave');
const box = { id: 'box1', hostHome: '/home/alice', status: 'ready' } as Instance;
const caller = (u: User) => ({ id: u.id, googleEmail: u.googleEmail });

function setup(over: Partial<PreviewLinkDeps> = {}) {
  let now = T0;
  const mem = memoryStore(() => new Date(now));
  for (const u of [alice, bob, carol, dave]) mem.users.set(u.id, { id: u.id, email: u.googleEmail, displayName: u.displayName });
  for (const [p, o] of [['proj0001', 'alice'], ['proj0002', 'alice'], ['proj0003', 'bob']]) mem.projectOwners.set(p, o);
  const projects = new Map<string, PreviewLinkProject>([
    ['proj0001', { id: 'proj0001', name: 'webapp', userId: alice.id, archived: false, instanceId: box.id, instance: box, owner: alice }],
    ['proj0002', { id: 'proj0002', name: 'other', userId: alice.id, archived: false, instanceId: box.id, instance: box, owner: alice }],
    ['proj0003', { id: 'proj0003', name: 'bobs', userId: bob.id, archived: false, instanceId: 'box2', instance: { ...box, id: 'box2' } as Instance, owner: bob }],
  ]);
  const collaborators = new Set(['proj0001:bob']);
  const workstreams: Record<string, string | null> = { main: null, 'feature-x': 'ws-feature-x', 'feature-y': 'ws-feature-y' };
  const flags = { enabled: true, audiences: true };
  const listeners: Array<Record<string, unknown>> = [
    { port: 5173, pid: 101, command: 'node /home/alice/termag/projects/webapp/node_modules/.bin/vite --port 5173', verdict: { ok: true }, inCheckout: true },
    { port: 9229, pid: 102, command: 'node --inspect=9229 server.js', verdict: { ok: false, code: 'port_refused', reason: 'debugger or shell' } },
  ];
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const agent = { connected: true, capabilities: ['port-forward-v1', 'preview-link-v1'] };
  const revoked: Array<{ linkId: string; idHashes: string[] }> = [];
  let random = 0;
  const deps: PreviewLinkDeps = {
    store: mem.store,
    findProject: async (id) => projects.get(id) ?? null,
    isCollaborator: async (projectId, userId) => collaborators.has(`${projectId}:${userId}`),
    findWorkstream: async (_p, name) => (name in workstreams ? { id: workstreams[name] } : undefined),
    findUserByEmail: async (email) => [alice, bob, carol, dave].find(u => u.googleEmail === email) ?? null,
    enabled: async () => flags.enabled,
    audiencesOn: async () => flags.audiences,
    ttlDefault: async () => 24,
    agent: {
      connected: () => agent.connected,
      capabilities: () => agent.capabilities,
      send: async (_host, type, payload) => { sent.push({ type, payload }); return { listeners }; },
    },
    siteBase: () => 'https://termag.example/termag',
    previewDomain: () => 'previews.example',
    now: () => new Date(now),
    random: (n) => Buffer.alloc(n, ++random),
    onSessionsRevoked: (linkId, idHashes) => revoked.push({ linkId, idHashes }),
    ...over,
  };
  return {
    deps, mem, flags, listeners, sent, agent, revoked, projects, collaborators,
    advance: (ms: number) => { now += ms; },
    publish: (who: User, body: Record<string, unknown>, projectId = 'proj0001') => svc.publishPreviewLinkFor(deps, caller(who), projectId, body),
    session: (linkId: string, userId: string, basis: string, tokenHash: string | null = null) => {
      const s = { idHash: `sess-${mem.sessions.length}`, linkId, userId, basis, tokenHash, revokedAt: null };
      mem.sessions.push(s);
      return s;
    },
  };
}

describe('publishing', () => {
  it('publishes an owner link: 201, the bare landing URL, its name held 30 days past its expiry', async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app' });
    expect(r.status).toBe(201);
    const body = r.body as any;
    expect(body).toMatchObject({
      renewed: false,
      shareUrl: 'https://termag.example/termag/previews/my-app',
      link: { name: 'my-app', port: 5173, audience: 'owner', hostMode: 'localhost', live: true, host: expect.stringMatching(/^my-app--[a-z2-7]{6}\.previews\.example$/), url: 'https://termag.example/termag/previews/my-app' },
    });
    expect(body.link.expiresAt).toBe(new Date(T0 + 24 * HOUR).toISOString());
    const [link] = t.mem.links;
    expect(link).toMatchObject({ projectId: 'proj0001', workstreamId: null, ownerId: 'alice', linkTokenHash: null });
    expect(t.mem.names.get('my-app')).toEqual({ name: 'my-app', ownerId: 'alice', reservedUntil: holdUntil(link.expiresAt), linkId: link.id });
    expect(t.mem.events).toEqual([expect.objectContaining({ audienceId: link.audienceId, kind: 'created', actorId: 'alice', delivery: { kind: 'link', id: link.id } })]);
  });

  it("asks the box about the workstream's checkout, and takes the lifetime asked for", async () => {
    const t = setup();
    const r = await t.publish(alice, { workstream: 'feature-x', port: 5173, name: 'my-app', ttlHours: 168, hostMode: 'public' });
    expect(r.status).toBe(201);
    expect(t.sent).toEqual([{ type: 'preview-listeners', payload: { cwd: '/home/alice/termag/projects/webapp/.worktrees/feature-x', port: 5173 } }]);
    expect(t.mem.links[0]).toMatchObject({ workstreamId: 'ws-feature-x', hostMode: 'public', expiresAt: new Date(T0 + 168 * HOUR) });
  });

  it('lets a collaborator publish, as the link\'s owner', async () => {
    const t = setup();
    expect((await t.publish(bob, { port: 5173, name: 'bobs-view' })).status).toBe(201);
    expect(t.mem.links[0].ownerId).toBe('bob');
  });

  it('answers 404 to someone with no standing on the project, and for an archived project', async () => {
    const t = setup();
    expect(await t.publish(carol, { port: 5173, name: 'my-app' })).toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } });
    t.projects.get('proj0001')!.archived = true;
    expect((await t.publish(alice, { port: 5173, name: 'my-app' })).status).toBe(404);
  });

  it('a project archived after the standing check gets no link: the name transaction checks again', async () => {
    const t = setup();
    const live = await t.publish(alice, { port: 5173, name: 'live-app' });
    // The archive lands between standing and the name's transaction.
    t.mem.archivedProjects.add('proj0001');
    expect(await t.publish(alice, { port: 5174, name: 'late-app' })).toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } });
    expect(t.mem.links.map(l => l.name)).toEqual(['live-app']);
    expect(t.mem.audiences).toHaveLength(1);
    // Nor does an extend move an archived project's link on.
    expect(await svc.extendPreviewLinkFor(t.deps, caller(alice), (live.body as any).link.id, { ttlHours: 48 })).toMatchObject({ status: 409, body: { code: 'link_ended' } });
  });

  it("an archived project's link left live (its end failed) can still be revoked, and a viewer removed, by its owner; nothing wider", async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test', 'carol@x.test'] });
    const id = (r.body as any).link.id;
    t.projects.get('proj0001')!.archived = true;
    expect((await svc.extendPreviewLinkFor(t.deps, caller(alice), id, { ttlHours: 2 })).status).toBe(404);
    expect((await svc.removePreviewLinkViewerFor(t.deps, caller(alice), id, 'bob')).status).toBe(200);
    expect(await svc.revokePreviewLinkFor(t.deps, caller(carol), id)).toMatchObject({ status: 404 });
    expect((await svc.revokePreviewLinkFor(t.deps, caller(alice), id)).status).toBe(200);
    expect(t.mem.audiences[0]).toMatchObject({ endReason: 'revoked' });
  });

  it('answers 404 on every route with preview-links-enabled off, as if they were not there', async () => {
    const t = setup();
    const created = await t.publish(alice, { port: 5173, name: 'my-app' });
    const id = (created.body as any).link.id;
    t.flags.enabled = false;
    const NOT_FOUND = { status: 404, body: { error: 'Not found', code: 'not_found' } };
    const a = caller(alice);
    expect(await t.publish(alice, { port: 5173, name: 'other-app' })).toEqual(NOT_FOUND);
    expect(await svc.listPreviewLinksFor(t.deps, a, 'proj0001')).toEqual(NOT_FOUND);
    expect(await svc.previewListenersFor(t.deps, a, 'proj0001', {})).toEqual(NOT_FOUND);
    expect(await svc.extendPreviewLinkFor(t.deps, a, id, { ttlHours: 2 })).toEqual(NOT_FOUND);
    expect(await svc.revokePreviewLinkFor(t.deps, a, id)).toEqual(NOT_FOUND);
    expect(await svc.removePreviewLinkViewerFor(t.deps, a, id, 'bob')).toEqual(NOT_FOUND);
    expect(await svc.listOwnPreviewLinksFor(t.deps, a)).toEqual({ status: 200, body: { links: [] } });
    expect(t.mem.links[0].endedAt).toBeNull();
  });

  it('refuses a bad body with 400 and the reason', async () => {
    const t = setup();
    expect(await t.publish(alice, { port: 5173, name: 'admin' })).toMatchObject({ status: 400, body: { code: 'name_reserved' } });
    expect(await t.publish(alice, { port: 0, name: 'my-app' })).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    expect(await t.publish(alice, { port: 5173, name: 'my-app', workstream: 'nope' })).toMatchObject({ status: 404, body: { code: 'workstream_not_found' } });
  });

  it('refuses the people and link audiences while their flag is off', async () => {
    const t = setup();
    t.flags.audiences = false;
    expect(await t.publish(alice, { port: 5173, name: 'my-app', audience: 'link' })).toMatchObject({ status: 403, body: { code: 'audience_disabled' } });
    expect(await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test'] })).toMatchObject({ status: 403, body: { code: 'audience_disabled' } });
    expect(t.mem.links).toHaveLength(0);
  });

  it('names every email that is not a termag user', async () => {
    const t = setup();
    expect(await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test', 'eve@evil.test', 'zed@x.test'] }))
      .toEqual({ status: 400, body: { error: 'Not termag users: eve@evil.test, zed@x.test', code: 'not_a_termag_user', emails: ['eve@evil.test', 'zed@x.test'] } });
  });

  it('needs the box connected and new enough to answer for its ports', async () => {
    const t = setup();
    t.agent.capabilities = ['port-forward-v1'];
    expect(await t.publish(alice, { port: 5173, name: 'my-app' })).toMatchObject({ status: 501, body: { code: 'box_outdated', error: 'Update this box to publish ports' } });
    t.agent.connected = false;
    expect(await t.publish(alice, { port: 5173, name: 'my-app' })).toMatchObject({ status: 503, body: { code: 'box_not_ready' } });
  });

  // SR6: a debugger, shell or notebook can't be published, from the dialog or the CLI.
  it("refuses a port the box's guard refuses, with its reason; publishes one nothing listens on yet", async () => {
    const t = setup();
    expect(await t.publish(alice, { port: 9229, name: 'my-app' })).toEqual({ status: 403, body: { error: 'debugger or shell', code: 'port_refused' } });
    expect(t.mem.links).toHaveLength(0);
    expect((await t.publish(alice, { port: 8080, name: 'my-app' })).status).toBe(201);
  });

  it("makes a link audience's 128-bit token once, in the share URL, and keeps only its hash", async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app', audience: 'link' });
    const shareUrl = (r.body as any).shareUrl as string;
    const token = shareUrl.split('/').pop()!;
    expect(shareUrl).toBe(`https://termag.example/termag/previews/my-app/${token}`);
    expect(token).toMatch(LINK_TOKEN_RE);
    expect(t.mem.links[0].linkTokenHash).toBe(linkTokenHash(token));
    expect(JSON.stringify(t.mem.links) + JSON.stringify(t.mem.events)).not.toContain(token);
    expect((r.body as any).link.url).toBe('https://termag.example/termag/previews/my-app');
  });

  it('grants a people link to the people it names, deduplicated', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test', 'CAROL@x.test', 'carol@x.test'] });
    expect(t.mem.grantees.map(g => g.userId).sort()).toEqual(['bob', 'carol']);
  });
});

describe('names', () => {
  it('refuses a live name for another workstream or project, even to its owner: 409 name_in_use', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app' });
    expect(await t.publish(alice, { workstream: 'feature-x', port: 5173, name: 'my-app' })).toMatchObject({ status: 409, body: { code: 'name_in_use' } });
    expect(await t.publish(alice, { port: 5173, name: 'my-app' }, 'proj0002')).toMatchObject({ status: 409, body: { code: 'name_in_use' } });
    expect(t.mem.links).toHaveLength(1);
  });

  it("refuses someone else's name for 30 days after its link last worked, then lets them reclaim it", async () => {
    const t = setup();
    const first = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 1 });
    await svc.revokePreviewLinkFor(t.deps, caller(alice), (first.body as any).link.id);
    // Revoked within its hour, it is held 30 days past the expiry it had: holds never move earlier.
    t.advance(30 * DAY + HOUR - 1);
    expect(await t.publish(bob, { port: 3000, name: 'my-app' }, 'proj0003')).toMatchObject({ status: 409, body: { code: 'name_taken' } });
    t.advance(1);
    const r = await t.publish(bob, { port: 3000, name: 'my-app' }, 'proj0003');
    expect(r.status).toBe(201);
    expect(t.mem.names.get('my-app')).toMatchObject({ ownerId: 'bob', linkId: (r.body as any).link.id });
    // The old ended link stays, as history.
    expect(t.mem.links[0]).toMatchObject({ ownerId: 'alice', endReason: 'revoked' });
  });

  it('lets its owner take a name back at any time once no link is live, from any project', async () => {
    const t = setup();
    const first = await t.publish(alice, { port: 5173, name: 'my-app' });
    await svc.revokePreviewLinkFor(t.deps, caller(alice), (first.body as any).link.id);
    const r = await t.publish(alice, { port: 5173, name: 'my-app' }, 'proj0002');
    expect(r.status).toBe(201);
    expect(t.mem.links).toHaveLength(2);
    expect(t.mem.names.get('my-app')!.linkId).toBe((r.body as any).link.id);
  });

  // SR19 (decided 2026-11-06): each new link its own origin, so an earlier app's Service Worker never sees the new one.
  it('gives a new link under a reused name a new host suffix; a renew and an extend keep it', async () => {
    const t = setup();
    const first = (await t.publish(alice, { port: 5173, name: 'my-app' })).body as any;
    expect(first.link.host).toMatch(/^my-app--[a-z2-7]{6}\.previews\.example$/);
    const renewed = (await t.publish(alice, { port: 5174, name: 'my-app' })).body as any;
    expect(renewed.renewed).toBe(true);
    expect(renewed.link.host).toBe(first.link.host);
    const extended = (await svc.extendPreviewLinkFor(t.deps, caller(alice), first.link.id, { ttlHours: 48 })).body as any;
    expect(extended.link.host).toBe(first.link.host);
    await svc.revokePreviewLinkFor(t.deps, caller(alice), first.link.id);
    const next = (await t.publish(alice, { port: 5173, name: 'my-app' }, 'proj0002')).body as any;
    expect(next.link.id).not.toBe(first.link.id);
    expect(next.link.host).toMatch(/^my-app--[a-z2-7]{6}\.previews\.example$/);
    expect(next.link.host).not.toBe(first.link.host);
  });

  // SR19's pinning test: a project deleted with a live link keeps its name refused to another owner for 30 days.
  it('keeps a name refused for 30 days after its project, and so its link, is deleted', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 24 });
    // The cascade: the audience, the link and everything under them go; the reservation's linkId is set null.
    t.mem.cascadeAudience(t.mem.audiences[0].id);
    expect(t.mem.names.get('my-app')!.linkId).toBeNull();
    t.advance(2 * DAY);
    expect(await t.publish(bob, { port: 3000, name: 'my-app' }, 'proj0003')).toMatchObject({ status: 409, body: { code: 'name_taken' } });
    t.advance(29 * DAY - 1); // the link could last have worked at T0 + 24 h: held until 30 days after
    expect(await t.publish(bob, { port: 3000, name: 'my-app' }, 'proj0003')).toMatchObject({ status: 409, body: { code: 'name_taken' } });
    t.advance(1);
    expect((await t.publish(bob, { port: 3000, name: 'my-app' }, 'proj0003')).status).toBe(201);
  });

  it('frees a name that expired naturally to another owner 30 days after it expired', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 1 });
    t.advance(HOUR + 30 * DAY - 1);
    expect(await t.publish(bob, { port: 3000, name: 'my-app' }, 'proj0003')).toMatchObject({ status: 409, body: { code: 'name_taken' } });
    t.advance(1);
    expect((await t.publish(bob, { port: 3000, name: 'my-app' }, 'proj0003')).status).toBe(201);
  });

  it('lets only one of two publishes of a new name at once have it', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.publish(alice, { port: 5173, name: 'race' }), t.publish(bob, { port: 3000, name: 'race' }, 'proj0003')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(t.mem.links).toHaveLength(1);
  });
});

describe('renewing (P5)', () => {
  it("renews this workstream's live link in place: same row, new port and host mode, expiry only later", async () => {
    const t = setup();
    const first = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 48 });
    t.advance(HOUR);
    // Bob, a collaborator, can't renew Alice's link: a renew changes its audience, people, port and token.
    expect(await t.publish(bob, { port: 9999, name: 'my-app', audience: 'link', ttlHours: 1 })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(t.mem.links[0]).toMatchObject({ port: 5173, audience: 'owner' });
    const r = await t.publish(alice, { port: 8080, name: 'my-app', ttlHours: 1, hostMode: 'public' });
    expect(r.status).toBe(200);
    expect((r.body as any).renewed).toBe(true);
    expect(t.mem.links).toHaveLength(1);
    expect(t.mem.links[0]).toMatchObject({ id: (first.body as any).link.id, port: 8080, hostMode: 'public', ownerId: 'alice', expiresAt: new Date(T0 + 48 * HOUR) });
    t.advance(HOUR);
    await t.publish(alice, { port: 8080, name: 'my-app', ttlHours: 168 });
    expect(t.mem.links[0].expiresAt).toEqual(new Date(T0 + 2 * HOUR + 168 * HOUR));
    expect(t.mem.names.get('my-app')!.reservedUntil).toEqual(holdUntil(t.mem.links[0].expiresAt));
  });

  it('keeps a link audience\'s token across a renew, and says the URL is the one given before', async () => {
    const t = setup();
    const first = await t.publish(alice, { port: 5173, name: 'my-app', audience: 'link' });
    const hash = t.mem.links[0].linkTokenHash;
    const r = await t.publish(alice, { port: 5173, name: 'my-app', audience: 'link' });
    expect(r.body).toMatchObject({ renewed: true, shareUrl: null, note: expect.stringContaining('keeps its token') });
    expect(t.mem.links[0].linkTokenHash).toBe(hash);
    expect((first.body as any).shareUrl).toContain('/previews/my-app/');
  });

  it('mints a token, shown once, for a link that becomes link', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app' });
    const r = await t.publish(alice, { port: 5173, name: 'my-app', audience: 'link' });
    const token = ((r.body as any).shareUrl as string).split('/').pop()!;
    expect(token).toMatch(LINK_TOKEN_RE);
    expect(t.mem.links[0].linkTokenHash).toBe(linkTokenHash(token));
  });

  it("revokes a removed grant's sessions at once, and keeps the others'", async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test', 'carol@x.test'] });
    const id = t.mem.links[0].id;
    const bobs = t.session(id, 'bob', 'grant');
    const carols = t.session(id, 'carol', 'grant');
    const owners = t.session(id, 'alice', 'owner');
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['carol@x.test'] });
    expect(bobs.revokedAt).not.toBeNull();
    expect(carols.revokedAt).toBeNull();
    expect(owners.revokedAt).toBeNull();
    expect(t.mem.grantees.map(g => g.userId)).toEqual(['carol']);
    expect(t.revoked).toEqual([{ linkId: id, idHashes: [bobs.idHash] }]);
  });

  it('revokes every grant and token session when the audience narrows to owner', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'link', emails: ['bob@x.test'] });
    const id = t.mem.links[0].id;
    const hash = t.mem.links[0].linkTokenHash;
    const grant = t.session(id, 'bob', 'grant');
    const token = t.session(id, 'dave', 'token', hash);
    const owner = t.session(id, 'alice', 'owner');
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'owner' });
    expect(grant.revokedAt).not.toBeNull();
    expect(token.revokedAt).not.toBeNull();
    expect(owner.revokedAt).toBeNull();
    expect(t.mem.links[0].linkTokenHash).toBeNull();
    expect(t.mem.grantees).toEqual([]);
  });

  it('revokes token sessions when a link stops being link, and keeps them while its token stays', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'link' });
    const id = t.mem.links[0].id;
    const token = t.session(id, 'dave', 'token', t.mem.links[0].linkTokenHash);
    await t.publish(alice, { port: 5174, name: 'my-app', audience: 'link' });
    expect(token.revokedAt).toBeNull();
    await t.publish(alice, { port: 5174, name: 'my-app', audience: 'people', emails: ['bob@x.test'] });
    expect(token.revokedAt).not.toBeNull();
  });

  it('lets a removed viewer back in when a renew names them again', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test'] });
    const id = t.mem.links[0].id;
    await svc.removePreviewLinkViewerFor(t.deps, caller(alice), id, 'bob');
    expect(t.mem.viewers[0].revokedAt).not.toBeNull();
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test'] });
    expect(t.mem.viewers[0].revokedAt).toBeNull();
  });
});

describe('revoking, extending, removing viewers', () => {
  it('revokes: ends the link, holds its name 30 days from now, revokes its sessions and drops its codes', async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 1 });
    const id = (r.body as any).link.id;
    const s = t.session(id, 'alice', 'owner');
    t.mem.codes.push({ linkId: id });
    // Past its expiry, so 30 days from the revoke is later than 30 days from the expiry.
    t.advance(2 * HOUR);
    const out = await svc.revokePreviewLinkFor(t.deps, caller(alice), id);
    expect(out).toMatchObject({ status: 200, body: { link: { live: false, endReason: 'revoked' } } });
    expect(t.mem.links[0].endedAt).toEqual(new Date(T0 + 2 * HOUR));
    expect(t.mem.names.get('my-app')!.reservedUntil).toEqual(new Date(T0 + 2 * HOUR + NAME_HOLD_MS));
    expect(s.revokedAt).not.toBeNull();
    expect(t.mem.codes).toEqual([]);
    expect(t.revoked).toEqual([{ linkId: id, idHashes: [s.idHash] }]);
    expect(t.mem.events.map(e => e.kind)).toEqual(['created', 'revoked']);
    // Again: as it is, nothing moved.
    t.advance(DAY);
    expect((await svc.revokePreviewLinkFor(t.deps, caller(alice), id)).status).toBe(200);
    expect(t.mem.links[0].endedAt).toEqual(new Date(T0 + 2 * HOUR));
  });

  it("never moves a name's hold earlier on revoke", async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 168 });
    const held = t.mem.names.get('my-app')!.reservedUntil;
    await svc.revokePreviewLinkFor(t.deps, caller(alice), (r.body as any).link.id);
    expect(t.mem.names.get('my-app')!.reservedUntil).toEqual(held);
  });

  it("lets the project's owner and the link's creator change a link, and nobody else", async () => {
    const t = setup();
    t.collaborators.add('proj0001:carol');
    const bobs = await t.publish(bob, { port: 5173, name: 'bobs-view' });
    const id = (bobs.body as any).link.id;
    expect(await svc.extendPreviewLinkFor(t.deps, caller(carol), id, { ttlHours: 2 })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(await svc.revokePreviewLinkFor(t.deps, caller(carol), id)).toMatchObject({ status: 403 });
    expect(await svc.revokePreviewLinkFor(t.deps, caller(dave), id)).toMatchObject({ status: 404 });
    expect((await svc.extendPreviewLinkFor(t.deps, caller(alice), id, { ttlHours: 2 })).status).toBe(200);
    expect((await svc.revokePreviewLinkFor(t.deps, caller(bob), id)).status).toBe(200);
  });

  it('extends from now, never earlier, and moves the name\'s hold with it', async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 2 });
    const id = (r.body as any).link.id;
    t.advance(HOUR);
    expect(await svc.extendPreviewLinkFor(t.deps, caller(alice), id, { ttlHours: 48 })).toMatchObject({ status: 200, body: { link: { expiresAt: new Date(T0 + 49 * HOUR).toISOString() } } });
    expect(t.mem.names.get('my-app')!.reservedUntil).toEqual(holdUntil(new Date(T0 + 49 * HOUR)));
    await svc.extendPreviewLinkFor(t.deps, caller(alice), id, { ttlHours: 1 });
    expect(t.mem.links[0].expiresAt).toEqual(new Date(T0 + 49 * HOUR));
    expect(await svc.extendPreviewLinkFor(t.deps, caller(alice), id, { ttlHours: 500 })).toMatchObject({ status: 400 });
    await svc.revokePreviewLinkFor(t.deps, caller(alice), id);
    expect(await svc.extendPreviewLinkFor(t.deps, caller(alice), id, { ttlHours: 2 })).toMatchObject({ status: 409, body: { code: 'link_ended' } });
  });

  it("removes a viewer: their row is marked, every session of theirs revoked; the owner and creator can't be", async () => {
    const t = setup();
    await t.publish(bob, { port: 5173, name: 'my-app', audience: 'people', emails: ['carol@x.test'] });
    const id = t.mem.links[0].id;
    const s = t.session(id, 'carol', 'grant');
    expect(await svc.removePreviewLinkViewerFor(t.deps, caller(bob), id, 'carol')).toEqual({ status: 200, body: { removed: true } });
    expect(t.mem.viewers).toEqual([expect.objectContaining({ audienceId: t.mem.links[0].audienceId, userId: 'carol', revokedAt: new Date(T0) })]);
    expect(s.revokedAt).not.toBeNull();
    expect(t.mem.events.at(-1)).toMatchObject({ kind: 'viewer-removed', detail: { userId: 'carol' } });
    expect(await svc.removePreviewLinkViewerFor(t.deps, caller(bob), id, 'alice')).toMatchObject({ status: 400 });
    expect(await svc.removePreviewLinkViewerFor(t.deps, caller(alice), id, 'bob')).toMatchObject({ status: 400 });
  });
});

describe('listing', () => {
  it('lists live and recently ended links, newest first, with grants, viewers and pending requests', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'old-app', ttlHours: 1 });
    await t.publish(alice, { workstream: 'feature-x', port: 5174, name: 'new-app', audience: 'people', emails: ['bob@x.test'] });
    t.mem.requests.push({ id: 'creq00000001', projectId: 'proj0001', workstreamId: null, boxId: 'box1', port: 6006, note: 'storybook', state: 'pending', createdAt: new Date(T0), decidedAt: null });
    t.advance(2 * HOUR);
    const r = await svc.listPreviewLinksFor(t.deps, caller(bob), 'proj0001');
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.links.map((l: any) => [l.name, l.live, l.endReason])).toEqual([['new-app', true, null], ['old-app', false, 'expired']]);
    expect(body.links[0].grantees).toEqual([{ id: 'bob', email: 'bob@x.test', displayName: 'Bob', expiresAt: null }]);
    expect(body.requests).toEqual([expect.objectContaining({ id: 'creq00000001', port: 6006, note: 'storybook' })]);
    expect(body.ttlHoursDefault).toBe(24);
    t.advance(8 * DAY);
    expect(((await svc.listPreviewLinksFor(t.deps, caller(bob), 'proj0001')).body as any).links.map((l: any) => l.name)).toEqual([]);
  });

  it("lists a person's own live links across projects for the CLI", async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'one-app' });
    await t.publish(alice, { port: 5173, name: 'two-app' }, 'proj0002');
    await t.publish(bob, { port: 5173, name: 'bobs-app' }, 'proj0003');
    const r = await svc.listOwnPreviewLinksFor(t.deps, caller(alice));
    expect((r.body as any).links.map((l: any) => l.name)).toEqual(['two-app', 'one-app']);
  });

  it("shows the box's listeners, bounded, and asks about the workstream's checkout", async () => {
    const t = setup();
    t.listeners.push({ port: 70000, verdict: { ok: true } }, { port: 3000, command: 'x'.repeat(500), verdict: { ok: false } });
    const r = await svc.previewListenersFor(t.deps, caller(alice), 'proj0001', { workstream: 'feature-y' });
    expect(r.status).toBe(200);
    const listeners = (r.body as any).listeners;
    expect(listeners.map((l: any) => l.port)).toEqual([5173, 9229, 3000]);
    expect(listeners[1]).toEqual({ port: 9229, pid: 102, command: 'node --inspect=9229 server.js', verdict: { ok: false, code: 'port_refused', reason: 'debugger or shell' }, inCheckout: false });
    expect(listeners[2].command).toHaveLength(80);
    expect(listeners[2].verdict).toEqual({ ok: false, code: 'port_refused', reason: 'the box refused this port' });
    expect(t.sent[0].payload).toEqual({ cwd: '/home/alice/termag/projects/webapp/.worktrees/feature-y' });
    expect(await svc.previewListenersFor(t.deps, caller(alice), 'proj0001', { workstream: 'nope' })).toMatchObject({ status: 404 });
  });
});

describe('agent requests', () => {
  const pending = (over = {}) => ({ id: 'creq00000001', projectId: 'proj0001', workstreamId: null, boxId: 'box1', port: 5173, note: null, state: 'pending', createdAt: new Date(T0), decidedAt: null, ...over });

  it('marks a request approved when a publish names it, once', async () => {
    const t = setup();
    t.mem.requests.push(pending());
    expect((await t.publish(alice, { port: 5173, name: 'my-app', requestId: 'creq00000001' })).status).toBe(201);
    expect(t.mem.requests[0].state).toBe('approved');
    expect(t.mem.links[0].requestId).toBe('creq00000001');
    expect(await t.publish(alice, { port: 5173, name: 'my-other', requestId: 'creq00000001' })).toMatchObject({ status: 409, body: { code: 'request_not_pending' } });
  });

  it('declines a pending request, for the project\'s people only', async () => {
    const t = setup();
    t.mem.requests.push(pending());
    expect(await svc.declinePreviewLinkRequestFor(t.deps, caller(carol), 'creq00000001')).toMatchObject({ status: 404 });
    expect(await svc.declinePreviewLinkRequestFor(t.deps, caller(bob), 'creq00000001')).toMatchObject({ status: 200, body: { request: { state: 'declined' } } });
    expect(await svc.declinePreviewLinkRequestFor(t.deps, caller(alice), 'creq00000001')).toMatchObject({ status: 409 });
  });
});

describe('parseListeners', () => {
  it('reads nothing from an answer that is not a list', () => {
    expect(svc.parseListeners(null)).toBeNull();
    expect(svc.parseListeners({ listeners: 'x' })).toBeNull();
    expect(svc.parseListeners({ listeners: [null, 'x', { port: 'x' }] })).toEqual([]);
  });
});

describe('the link as a delivery on its audience', () => {

  function withDelivery() {
    const t = setup();
    t.mem.deliveries.push(svc.previewLinkDelivery(t.mem.store, (linkId, idHashes) => t.revoked.push({ linkId, idHashes })));
    return t;
  }

  it('keeps its own name, port, host mode and token; who, when and the end are its audience\'s', async () => {
    const t = setup();
    await t.publish(alice, { workstream: 'feature-x', port: 5173, name: 'my-app', audience: 'link', ttlHours: 2 });
    const [raw] = t.mem.rawLinks;
    expect(Object.keys(raw).sort()).toEqual(['audienceId', 'createdAt', 'hostMode', 'hostSuffix', 'id', 'linkTokenHash', 'name', 'port', 'requestId']);
    expect(t.mem.audiences).toEqual([expect.objectContaining({ id: raw.audienceId, projectId: 'proj0001', workstreamId: 'ws-feature-x', ownerId: 'alice', kind: 'link', expiresAt: new Date(T0 + 2 * HOUR), endedAt: null })]);
  });

  it('a revoke ends the audience, with the actor as a user id', async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app' });
    await svc.revokePreviewLinkFor(t.deps, caller(alice), (r.body as any).link.id);
    expect(t.mem.audiences[0]).toMatchObject({ endedAt: new Date(T0), revokedAt: new Date(T0), endReason: 'revoked' });
    expect(t.mem.events.at(-1)).toEqual({ audienceId: t.mem.audiences[0].id, kind: 'revoked', actorId: 'alice', reason: 'revoked' });
  });

  it("archiving the project ends its links: project-gone, sessions revoked and closed, codes dropped, the name held", async () => {
    const t = withDelivery();
    const r = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 1 });
    const id = (r.body as any).link.id;
    const other = await t.publish(alice, { port: 5173, name: 'other-app' }, 'proj0002');
    const s = t.session(id, 'bob', 'collaborator');
    t.mem.codes.push({ linkId: id });
    t.advance(2 * HOUR);
    expect(await core.endPreviewAudiences({ projectId: 'proj0001' }, 'project-gone', null, new Date(T0 + 2 * HOUR), t.mem.endDeps)).toBe(1);
    expect(t.mem.links.find(l => l.id === id)).toMatchObject({ endReason: 'project-gone', endedAt: new Date(T0 + 2 * HOUR) });
    expect(s.revokedAt).not.toBeNull();
    expect(t.revoked).toEqual([{ linkId: id, idHashes: [s.idHash] }]);
    expect(t.mem.codes).toEqual([]);
    expect(t.mem.names.get('my-app')!.reservedUntil).toEqual(new Date(T0 + 2 * HOUR + NAME_HOLD_MS));
    // Another project's link is untouched.
    expect(t.mem.links.find(l => l.id === (other.body as any).link.id)!.endedAt).toBeNull();
  });

  it('removing a workstream ends its links: workstream-gone; then the cascade leaves the name held (SR19)', async () => {
    const t = withDelivery();
    await t.publish(alice, { workstream: 'feature-x', port: 5173, name: 'feature-app' });
    await t.publish(alice, { port: 5173, name: 'main-app' });
    expect(await core.endPreviewAudiences({ workstreamId: 'ws-feature-x' }, 'workstream-gone', null, new Date(T0), t.mem.endDeps)).toBe(1);
    expect(t.mem.links.map(l => [l.name, l.endReason])).toEqual([['feature-app', 'workstream-gone'], ['main-app', null]]);
    t.mem.cascadeAudience(t.mem.audiences[0].id);
    expect(t.mem.names.get('feature-app')).toMatchObject({ linkId: null, reservedUntil: holdUntil(new Date(T0 + 24 * HOUR)) });
    expect(await t.publish(bob, { port: 3000, name: 'feature-app' }, 'proj0003')).toMatchObject({ status: 409, body: { code: 'name_taken' } });
  });

  it('ending an audience ends every link on it: the second link loses its sessions and codes too, though the first stamped it', async () => {
    const t = withDelivery();
    const r = await t.publish(alice, { port: 5173, name: 'first-app' });
    const first = t.mem.rawLinks[0];
    // A second link on the same audience (one per audience today; the hook is written for several).
    t.mem.rawLinks.push({ ...first, id: 'link-second', name: 'second-app', port: 5174 });
    t.mem.names.set('second-app', { name: 'second-app', ownerId: 'alice', reservedUntil: new Date(T0), linkId: 'link-second' });
    const a = t.session((r.body as any).link.id, 'bob', 'collaborator');
    const b = t.session('link-second', 'bob', 'collaborator');
    t.mem.codes.push({ linkId: 'link-second' });
    await core.endPreviewAudience(first.audienceId, 'project-gone', null, new Date(T0), t.mem.endDeps);
    expect([a.revokedAt, b.revokedAt]).toEqual([new Date(T0), new Date(T0)]);
    expect(t.mem.codes).toEqual([]);
    expect(t.mem.names.get('second-app')!.reservedUntil).toEqual(new Date(T0 + NAME_HOLD_MS));
    expect(t.revoked.map(x => x.linkId)).toEqual([(r.body as any).link.id, 'link-second']);
  });

  it('a workstream removed after the standing check gets no link: the name transaction checks it again', async () => {
    const t = setup();
    t.mem.goneWorkstreams.add('ws-feature-x');
    expect(await t.publish(alice, { workstream: 'feature-x', port: 5173, name: 'late-app' })).toEqual({ status: 404, body: { error: 'Not found', code: 'not_found' } });
    expect(t.mem.links).toEqual([]);
    // Main, with no workstream row, is the project's alone.
    expect((await t.publish(alice, { port: 5173, name: 'main-app' })).status).toBe(201);
  });
});

describe('a link lives at most 30 days from its first publish (SR23)', () => {
  /** Keep a 168 h link alive by extending it every 6 days, to day 24. */
  async function keptToDay24(t: ReturnType<typeof setup>, id: string) {
    for (let d = 6; d <= 24; d += 6) {
      t.advance(6 * DAY);
      expect((await svc.extendPreviewLinkFor(t.deps, caller(alice), id, { ttlHours: 168 })).status, `day ${d}`).toBe(200);
    }
  }

  it('extends up to the cap, then answers 409 lifetime_cap', async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 168 });
    const id = (r.body as any).link.id;
    expect((r.body as any).link.maxExpiresAt).toBe(new Date(T0 + 30 * DAY).toISOString());
    await keptToDay24(t, id);
    // The extend on day 24 asked for day 31: cut to day 30.
    expect(t.mem.links[0].expiresAt).toEqual(new Date(T0 + 30 * DAY));
    t.advance(DAY);
    expect(await svc.extendPreviewLinkFor(t.deps, caller(alice), id, { ttlHours: 168 })).toEqual({
      status: 409, body: { error: 'This link has reached its 30-day limit; publish it again.', code: 'lifetime_cap' },
    });
    expect(t.mem.links[0].expiresAt).toEqual(new Date(T0 + 30 * DAY));
  });

  it('renews up to the cap, then refuses, and changes nothing', async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 168 });
    await keptToDay24(t, (r.body as any).link.id);
    t.advance(DAY);
    expect(await t.publish(alice, { port: 5175, name: 'my-app', ttlHours: 168 })).toMatchObject({ status: 409, body: { code: 'lifetime_cap' } });
    expect(t.mem.links[0]).toMatchObject({ port: 5173, expiresAt: new Date(T0 + 30 * DAY) });
  });

  it('a renew that can still move the expiry moves it only as far as the cap', async () => {
    const t = setup();
    const r = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 168 });
    const id = (r.body as any).link.id;
    for (let d = 6; d <= 18; d += 6) { t.advance(6 * DAY); await svc.extendPreviewLinkFor(t.deps, caller(alice), id, { ttlHours: 168 }); }
    t.advance(6 * DAY); // day 24, live until day 25
    expect((await t.publish(alice, { port: 5174, name: 'my-app', ttlHours: 168 })).status).toBe(200);
    expect(t.mem.links[0]).toMatchObject({ port: 5174, expiresAt: new Date(T0 + 30 * DAY) });
  });

  it('a publish once it has ended starts a new link, with a new 30 days', async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 24 });
    t.advance(2 * DAY);
    const again = await t.publish(alice, { port: 5173, name: 'my-app', ttlHours: 168 });
    expect(again.status).toBe(201);
    expect((again.body as any).link.maxExpiresAt).toBe(new Date(T0 + 32 * DAY).toISOString());
  });
});

describe('review fixes (Devin on 39a686c3)', () => {
  it("the project's owner may renew a collaborator's link; the collaborator their own", async () => {
    const t = setup();
    await t.publish(bob, { port: 5173, name: 'bobs-app' });
    expect((await t.publish(bob, { port: 5174, name: 'bobs-app' })).status).toBe(200);
    expect((await t.publish(alice, { port: 5175, name: 'bobs-app' })).status).toBe(200);
    expect(t.mem.links[0]).toMatchObject({ port: 5175, ownerId: 'bob' });
  });

  it("lists a collaborator's live links on the caller's own projects too, so the CLI can revoke them by name", async () => {
    const t = setup();
    await t.publish(bob, { port: 5173, name: 'demo-app' });
    await t.publish(bob, { port: 5173, name: 'elsewhere' }, 'proj0003');
    const mine = (await svc.listOwnPreviewLinksFor(t.deps, caller(alice))).body as any;
    expect(mine.links.map((l: any) => l.name)).toEqual(['demo-app']);
  });

  it("removing a viewer drops their grant too, so a renew that doesn't name them keeps them out", async () => {
    const t = setup();
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['bob@x.test', 'carol@x.test'] });
    const id = t.mem.links[0].id;
    await svc.removePreviewLinkViewerFor(t.deps, caller(alice), id, 'bob');
    expect(t.mem.grantees.map(g => g.userId)).toEqual(['carol']);
    await t.publish(alice, { port: 5173, name: 'my-app', audience: 'people', emails: ['carol@x.test'] });
    expect(t.mem.viewers.find(v => v.userId === 'bob')!.revokedAt).not.toBeNull();
  });
});

