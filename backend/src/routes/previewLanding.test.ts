// The landing page on the main host (routes/previewLanding.ts): who may open
// a link (previewLinkAccess.decide, here through the route), the one-time
// code, the hand-off page, the same 404 for every refusal (A4), and the
// reverify route a preview host sends a navigation through (A2, SR10, SR11,
// SR16, SR22).
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { previewLandingRouter, type PreviewLandingDeps } from './previewLanding';
import { memoryHostStore } from '../services/previewHostTestStore';
import { codeHash, newSecret } from '../services/previewHostRules';
import { linkTokenHash } from '../services/previewLinkRules';

const servers: http.Server[] = [];
afterAll(() => servers.forEach(s => { s.closeAllConnections(); s.close(); }));

const DOMAIN = 'previews.test';
const TOKEN = 'abcdefghijklmnopqrstuv';

async function landing(over: Partial<PreviewLandingDeps> = {}) {
  const mem = memoryHostStore();
  mem.addUser('owner', 'owner@example.com');
  mem.addUser('viewer', 'viewer@example.com');
  mem.addLink({ name: 'my-app' });
  const state = { user: 'owner' as string | null, flags: { enabled: true, killSwitch: false }, boxStatus: 'ready' as string | null, allowed: new Set(['owner@example.com', 'viewer@example.com']) };
  const app = express();
  app.use('/termag/previews', previewLandingRouter({
    store: mem.store,
    domain: () => DOMAIN,
    cookieSecret: () => Buffer.alloc(32, 1),
    flags: async () => ({ ...state.flags }),
    allowed: (e) => state.allowed.has(e),
    user: () => (state.user ? { id: state.user, googleEmail: `${state.user}@example.com` } : null),
    boxStatus: async () => state.boxStatus,
    ...over,
  }));
  const server = http.createServer(app);
  servers.push(server);
  const port = await new Promise<number>(r => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  const get = (path: string, method = 'GET') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject).end();
  });
  return { mem, state, get };
}

const codeIn = (url: string) => new URL(url.replace(/&amp;/g, '&')).searchParams.get('code')!;

describe('the landing page', () => {
  it('hands the owner a one-time code on first open with the hand-off page, then redirects straight', async () => {
    const { mem, get } = await landing();
    const first = await get('/termag/previews/my-app?next=%2Fdash');
    expect(first.status).toBe(200);
    expect(first.body).toContain("You're opening an app running on Olive Owner's box");
    expect(first.body).not.toMatch(/<script/i);
    expect(first.headers['referrer-policy']).toBe('no-referrer');
    expect(first.headers['x-frame-options']).toBe('DENY');
    expect(first.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const url = first.body.match(/url=([^"]+)"/)![1];
    expect(url.startsWith(`https://my-app--abcdef.${DOMAIN}/__termag/auth?code=`)).toBe(true);
    const row = mem.codes.get(codeHash('code', codeIn(url))!);
    expect(row).toMatchObject({ linkId: 'link-my-app', userId: 'owner', basis: 'owner', tokenHash: null, sessionIdHash: null, next: '/dash' });
    expect(row!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    expect(mem.events.map(e => e.kind)).toEqual(['opened']);

    const again = await get('/termag/previews/my-app');
    expect(again.status).toBe(302);
    expect(again.headers.location!.startsWith(`https://my-app--abcdef.${DOMAIN}/__termag/auth?code=`)).toBe(true);
    expect(again.headers['referrer-policy']).toBe('no-referrer');
  });

  it('a code that failed to be written records no open, so the retry still gets the first-open page', async () => {
    const { mem, get } = await landing();
    const createCode = mem.store.createCode;
    let fail = true;
    mem.store.createCode = async (row) => { if (fail) { fail = false; throw new Error('db down'); } return createCode(row); };
    expect((await get('/termag/previews/my-app')).status).toBe(500);
    expect(mem.viewers.size).toBe(0);
    const retry = await get('/termag/previews/my-app');
    expect(retry.status).toBe(200);
    expect(retry.body).toContain("You're opening an app running on");
  });

  it('stores only an origin-form next (SR16)', async () => {
    const { mem, get } = await landing();
    await get(`/termag/previews/my-app?next=${encodeURIComponent('//evil.example/x')}`);
    expect([...mem.codes.values()][0].next).toBe('/');
  });

  it('shows the hand-off page every time for a link audience, and lets a token in (SR11, SR15)', async () => {
    const { mem, state, get } = await landing();
    Object.assign(mem.links.get('link-my-app')!.link, { audience: 'link', linkTokenHash: linkTokenHash(TOKEN) });
    state.user = 'viewer';
    for (let i = 0; i < 2; i++) {
      const a = await get(`/termag/previews/my-app/${TOKEN}`);
      expect(a.status).toBe(200);
      expect(a.headers['referrer-policy']).toBe('no-referrer');
    }
    expect([...mem.codes.values()].every(c => c.basis === 'token' && c.tokenHash === linkTokenHash(TOKEN))).toBe(true);
    // A wrong token, or none, is the same 404 as no link at all (A4).
    const wrong = await get('/termag/previews/my-app/zzzzzzzzzzzzzzzzzzzzzz');
    const none = await get('/termag/previews/my-app');
    const missing = await get('/termag/previews/nope-app');
    expect([wrong.status, none.status, missing.status]).toEqual([404, 404, 404]);
    expect(wrong.body).toBe(none.body);
    expect(none.body).toBe(missing.body);
  });

  it('gives the same 404 to an outsider, a removed viewer, an ended link, and a link with previews off or killed (A4)', async () => {
    const { mem, state, get } = await landing();
    state.user = 'viewer';
    const outsider = await get('/termag/previews/my-app');
    mem.share('proj-1', 'viewer');
    expect((await get('/termag/previews/my-app')).status).toBe(200);
    mem.remove('link-my-app', 'viewer');
    const removed = await get('/termag/previews/my-app');
    state.user = 'owner';
    state.flags.enabled = false;
    const off = await get('/termag/previews/my-app');
    state.flags = { enabled: true, killSwitch: true };
    const killed = await get('/termag/previews/my-app');
    state.flags.killSwitch = false;
    mem.links.get('link-my-app')!.link.endedAt = new Date();
    const ended = await get('/termag/previews/my-app');
    for (const a of [outsider, removed, off, killed, ended]) {
      expect(a.status).toBe(404);
      expect(a.body).toBe(outsider.body);
    }
    expect(mem.codes.size).toBe(1);
    expect(mem.events.filter(e => e.kind === 'refused').map(e => e.reason)).toEqual(['no_access', 'removed', 'disabled', 'kill_switch', 'ended']);
  });

  it('refuses an archived project\'s link whatever its audience says, a live link-audience token included (fails closed)', async () => {
    const { mem, state, get } = await landing();
    // The audience is still live: an archive whose end of the audiences failed.
    Object.assign(mem.links.get('link-my-app')!.link, { audience: 'link', linkTokenHash: linkTokenHash(TOKEN), endedAt: null });
    mem.links.get('link-my-app')!.project.archived = true;
    for (const user of ['owner', 'viewer']) {
      state.user = user;
      expect((await get(`/termag/previews/my-app/${TOKEN}`)).status, user).toBe(404);
    }
    expect(mem.codes.size).toBe(0);
  });

  it('refuses a link whose project is archived like an ended one, and hands out no code', async () => {
    const { mem, get } = await landing();
    const plain = await get('/termag/previews/nope-app');
    mem.links.get('link-my-app')!.project.archived = true;
    const a = await get('/termag/previews/my-app');
    expect(a.status).toBe(404);
    expect(a.body).toBe(plain.body);
    expect(mem.codes.size).toBe(0);
    expect(mem.events.filter(e => e.kind === 'refused').map(e => e.reason)).toEqual(['ended']);
  });

  it('says a parked box\'s preview is asleep, and hands out no code (wake is phase 3)', async () => {
    const { mem, state, get } = await landing();
    state.boxStatus = 'stopped';
    const a = await get('/termag/previews/my-app');
    expect(a.status).toBe(503);
    expect(a.body).toContain('asleep');
    expect(mem.codes.size).toBe(0);
  });

  it('sends someone not signed in to sign-in, or a 401 page, and says previews are off without a domain', async () => {
    const { state, get } = await landing();
    state.user = null;
    expect((await get('/termag/previews/my-app')).status).toBe(401);
    const signIn = await landing({ signIn: async () => '/termag/auth/login' });
    signIn.state.user = null;
    const a = await signIn.get('/termag/previews/my-app');
    expect(a.status).toBe(302);
    expect(a.headers.location).toBe('/termag/auth/login');
    const off = await landing({ domain: () => null });
    expect((await off.get('/termag/previews/my-app')).body).toContain('Previews are off');
  });
});

describe('a HEAD request', () => {
  it('mints no code on the landing page and uses no ticket up on reverify', async () => {
    const { mem, get } = await landing();
    const now = new Date();
    await mem.store.createSession({ idHash: 's1', linkId: 'link-my-app', userId: 'owner', basis: 'owner', tokenHash: null, verifiedAt: now, expiresAt: new Date(now.getTime() + 3600_000) });
    const ticket = newSecret();
    await mem.store.createCode({ codeHash: codeHash('ticket', ticket)!, linkId: 'link-my-app', userId: 'owner', basis: 'owner', tokenHash: null, sessionIdHash: 's1', next: '/', expiresAt: new Date(now.getTime() + 60_000) });
    for (const path of ['/termag/previews/my-app', '/termag/previews/my-app/abcdefghijklmnopqrstuv', `/termag/previews/my-app/reverify?ticket=${ticket}`]) {
      expect((await get(path, 'HEAD')).status, path).toBe(204);
    }
    expect(mem.codes.size).toBe(1);
    expect(mem.events).toHaveLength(0);
    // The ticket is still good for the viewer's own GET.
    expect((await get(`/termag/previews/my-app/reverify?ticket=${ticket}`)).status).toBe(302);
  });
});

describe('a recent termag sign-in, in google and oidc mode (SR18)', () => {
  it('sends a viewer whose sign-in is stale back through sign-in, and hands out no code', async () => {
    let fresh = false;
    const l = await landing({ signInFresh: () => fresh, signIn: async () => '/termag/auth/login' });
    const stale = await l.get('/termag/previews/my-app');
    expect(stale.status).toBe(302);
    expect(stale.headers.location).toBe('/termag/auth/login');
    expect(l.mem.codes.size).toBe(0);
    fresh = true;
    expect((await l.get('/termag/previews/my-app')).status).toBe(200);
    expect(l.mem.codes.size).toBe(1);
  });

  it('the hourly reverify needs it too', async () => {
    const l = await landing({ signInFresh: () => false, signIn: async () => '/termag/auth/login' });
    const a = await l.get('/termag/previews/my-app/reverify?ticket=whatever');
    expect(a.status).toBe(302);
    expect(a.headers.location).toBe('/termag/auth/login');
  });

  it('okta mode sets no rule: the ALB\'s Okta action re-checks on its own', async () => {
    const l = await landing();
    expect((await l.get('/termag/previews/my-app')).status).toBe(200);
  });
});

describe('reverify', () => {
  async function withSession() {
    const l = await landing();
    const now = new Date();
    await l.mem.store.createSession({ idHash: 'sess-1', linkId: 'link-my-app', userId: 'owner', basis: 'owner', tokenHash: null, verifiedAt: new Date(now.getTime() - 3700_000), expiresAt: new Date(now.getTime() + 3600_000) });
    const ticket = newSecret();
    await l.mem.store.createCode({ codeHash: codeHash('ticket', ticket)!, linkId: 'link-my-app', userId: 'owner', basis: 'owner', tokenHash: null, sessionIdHash: 'sess-1', next: '/where', expiresAt: new Date(now.getTime() + 60_000) });
    return { ...l, ticket };
  }

  it('answers the session\'s own user with a code bound to that session', async () => {
    const { mem, get, ticket } = await withSession();
    const a = await get(`/termag/previews/my-app/reverify?ticket=${ticket}`);
    expect(a.status).toBe(302);
    const code = codeIn(a.headers.location!);
    expect(mem.codes.get(codeHash('code', code)!)).toMatchObject({ sessionIdHash: 'sess-1', userId: 'owner', next: '/where' });
    // Single use.
    expect((await get(`/termag/previews/my-app/reverify?ticket=${ticket}`)).status).toBe(404);
  });

  it('refreshes nobody else\'s session with a leaked ticket (SR10)', async () => {
    const { state, get, ticket } = await withSession();
    state.user = 'viewer';
    expect((await get(`/termag/previews/my-app/reverify?ticket=${ticket}`)).status).toBe(404);
  });

  it('checks the session\'s basis again: a rotated token shuts a token session out without asking for the token', async () => {
    const { mem, state, get } = await landing();
    Object.assign(mem.links.get('link-my-app')!.link, { audience: 'link', linkTokenHash: linkTokenHash(TOKEN) });
    state.user = 'viewer';
    const mk = async (tokenHash: string) => {
      const id = newSecret();
      await mem.store.createSession({ idHash: id, linkId: 'link-my-app', userId: 'viewer', basis: 'token', tokenHash, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) });
      const t = newSecret();
      await mem.store.createCode({ codeHash: codeHash('ticket', t)!, linkId: 'link-my-app', userId: 'viewer', basis: 'token', tokenHash, sessionIdHash: id, next: '/', expiresAt: new Date(Date.now() + 60_000) });
      return t;
    };
    expect((await get(`/termag/previews/my-app/reverify?ticket=${await mk(linkTokenHash(TOKEN))}`)).status).toBe(302);
    expect((await get(`/termag/previews/my-app/reverify?ticket=${await mk(linkTokenHash('x'.repeat(22)))}`)).status).toBe(404);
  });

  it('never takes a code as a ticket', async () => {
    const { mem, get } = await withSession();
    const code = newSecret();
    await mem.store.createCode({ codeHash: codeHash('code', code)!, linkId: 'link-my-app', userId: 'owner', basis: 'owner', tokenHash: null, sessionIdHash: 'sess-1', next: '/', expiresAt: new Date(Date.now() + 60_000) });
    expect((await get(`/termag/previews/my-app/reverify?ticket=${code}`)).status).toBe(404);
  });
});
