// Waking a parked box from a preview link's landing page (row 6b; PRD U4,
// SR20; services/previewLinkWake.ts). Pinned here: a viewer the link doesn't
// admit never wakes a box, whatever they post; only a box the idle sweep
// stopped is woken, never one stopped by hand; never by its own owner (theirs
// to start); never with the flag off or a stale form; within the owner's
// budget; and a start that fails gives the wake back.
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Instance } from '@prisma/client';
import { previewLandingRouter, type PreviewLandingDeps } from './previewLanding';
import { memoryHostStore } from '../services/previewHostTestStore';
import { autoStopNote } from '../services/boxLifecyclePolicy';
import { linkTokenHash } from '../services/previewLinkRules';
import type { LinkWakeDeps } from '../services/previewLinkWake';

const servers: http.Server[] = [];
afterAll(() => servers.forEach(s => { s.closeAllConnections(); s.close(); }));

const TOKEN = 'abcdefghijklmnopqrstuv';
const sweptBox = (over: Partial<Instance> = {}) => ({
  id: 'box-1', name: 'olivebox', userId: 'owner', status: 'stopped', parkedAt: new Date(Date.now() - 3600_000), lifecycleNote: autoStopNote(2),
  autoTerminatedAt: null, ec2InstanceId: 'i-1', region: 'us-east-1', kind: 'ec2', ...over,
} as unknown as Instance);

async function landing(over: Partial<PreviewLandingDeps> = {}) {
  const mem = memoryHostStore();
  mem.addUser('owner', 'owner@example.com');
  mem.addUser('viewer', 'viewer@example.com');
  mem.addUser('stranger', 'stranger@example.com');
  // A link audience: the viewer opens it with its token.
  mem.addLink({ name: 'my-app', audience: 'link', linkTokenHash: linkTokenHash(TOKEN) });
  const state = { user: 'viewer' as string | null, boxStatus: 'stopped' as string | null, box: sweptBox(), wakeOn: true, claim: { ok: true, wakeId: 'w1' } as Awaited<ReturnType<LinkWakeDeps['claim']>> };
  const calls = { claim: [] as unknown[], start: 0, refund: [] as string[], notified: [] as string[], startFails: false };
  const wake: LinkWakeDeps = {
    enabled: async () => state.wakeOn,
    box: async () => state.box,
    claim: async (input) => { calls.claim.push(input); return state.claim; },
    refund: async (id) => { calls.refund.push(id); },
    start: async () => { calls.start++; if (calls.startFails) throw new Error('ec2 said no'); state.boxStatus = 'starting'; },
    provisioningConfigured: () => true,
    notifyOwner: async (_o, text) => { calls.notified.push(text); },
    boxesChanged: () => {},
    now: () => Date.now(),
  };
  const app = express();
  app.use('/termag/previews', previewLandingRouter({
    store: mem.store,
    domain: () => 'previews.test',
    cookieSecret: () => Buffer.alloc(32, 1),
    flags: async () => ({ enabled: true, killSwitch: false }),
    allowed: () => true,
    user: () => (state.user ? { id: state.user, googleEmail: `${state.user}@example.com` } : null),
    boxStatus: async () => state.boxStatus,
    wake,
    ...over,
  }));
  const server = http.createServer(app);
  servers.push(server);
  const port = await new Promise<number>(r => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  const req = (path: string, method = 'GET', body?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {} }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    r.end(body);
  });
  return { mem, state, calls, req };
}

const csrfIn = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? null;
const URL_ = `/termag/previews/my-app/${TOKEN}`;

describe('waking a parked box from a preview link', () => {
  it('offers "Wake it" to a viewer the link admits, wakes the box once, then shows the waking page until it is up', async () => {
    const { calls, state, req } = await landing();
    const page = await req(`${URL_}?next=%2Fcart`);
    expect(page.status).toBe(503);
    expect(page.body).toContain("Olive Owner's box went to sleep after it was idle");
    expect(page.headers['content-security-policy']).toContain("form-action 'self'");
    expect(page.body).not.toMatch(/<script/i);
    const csrf = csrfIn(page.body)!;
    expect(page.body).toContain(`action="${URL_}?next=%2Fcart"`);
    const woke = await req(`${URL_}?next=%2Fcart`, 'POST', `csrf=${csrf}`);
    expect(woke.status).toBe(303);
    expect(woke.headers.location).toBe(`${URL_}?next=%2Fcart`);
    expect(calls.start).toBe(1);
    expect(calls.claim).toEqual([expect.objectContaining({ ownerId: 'owner', audienceId: 'aud-my-app', linkId: 'link-my-app', viewerId: 'viewer' })]);
    expect(calls.notified[0]).toMatch(/^viewer@example\.com woke your box olivebox to open your preview link my-app/);
    const waking = await req(woke.headers.location!);
    expect(waking.body).toContain("Waking Olive Owner's box");
    expect(waking.body).toMatch(/<meta http-equiv="refresh" content="5;url=\/termag\/previews\/my-app\//);
    // Up: the landing carries on as ever.
    state.boxStatus = 'ready';
    expect((await req(URL_)).body).toContain("You're opening an app running on Olive Owner's box");
  });

  it('a box still going down says so and looks again, then offers the wake once it has stopped (Bugbot, #1570)', async () => {
    const { state, req } = await landing();
    state.boxStatus = 'stopping';
    const going = await req(URL_);
    expect(going.body).toContain("Olive Owner's box is going to sleep");
    expect(going.body).toMatch(/<meta http-equiv="refresh" content="5;url=\/termag\/previews\/my-app\//);
    expect(csrfIn(going.body)).toBeNull();
    state.boxStatus = 'stopped';
    expect(csrfIn((await req(URL_)).body)).not.toBeNull();
  });

  it('a box going down promises no wake to a viewer who could never wake it: its owner, or the flag off (Bugbot, #1570)', async () => {
    const { state, req } = await landing();
    for (const status of ['stopping', 'hibernating']) {
      state.boxStatus = status;
      state.box = sweptBox({ status });
      state.wakeOn = false;
      const off = await req(URL_);
      expect(off.body).not.toContain('is going to sleep');
      expect(off.body).not.toMatch(/http-equiv="refresh"/);
      expect(csrfIn(off.body)).toBeNull();
      state.wakeOn = true;
      state.user = 'owner';
      const own = await req(URL_);
      expect(own.body).not.toContain('is going to sleep');
      expect(csrfIn(own.body)).toBeNull();
      state.user = 'viewer';
      // The settling copy itself never says the stop was idle or that a wake will be offered.
      const going = await req(URL_);
      expect(going.body).toContain('is going to sleep');
      expect(going.body).not.toMatch(/It was idle|stopped, you can wake it/);
    }
  });

  it('Wake it pressed while the box is still going down goes back to the landing, which looks again (Bugbot, #1570)', async () => {
    const { calls, state, req } = await landing();
    const csrf = csrfIn((await req(URL_)).body)!;
    for (const status of ['stopping', 'hibernating']) {
      state.box = sweptBox({ status });
      state.boxStatus = status;
      const r = await req(URL_, 'POST', `csrf=${csrf}`);
      expect(r.status).toBe(303);
      expect((await req(r.headers.location!)).body).toContain("Olive Owner's box is going to sleep");
    }
    expect(calls.claim).toEqual([]);
    expect(calls.start).toBe(0);
  });

  // Pinning (row 6b): a viewer without access never triggers a wake.
  it('a viewer the link doesn\'t admit gets the same not-found page, whether opening or posting, and never wakes the box', async () => {
    const { calls, state, req } = await landing();
    const csrf = csrfIn((await req(URL_)).body)!;
    state.user = 'stranger';
    for (const path of ['/termag/previews/my-app', `/termag/previews/my-app/${'z'.repeat(22)}`]) {
      expect((await req(path)).status).toBe(404);
      expect((await req(path, 'POST', `csrf=${csrf}`)).status).toBe(404);
    }
    expect(calls.claim).toEqual([]);
    expect(calls.start).toBe(0);
  });

  it('never wakes a box its owner stopped by hand, nor one that isn\'t asleep: it says so', async () => {
    const { calls, state, req } = await landing();
    const csrf = csrfIn((await req(URL_)).body)!;
    state.box = sweptBox({ lifecycleNote: null });
    const page = await req(URL_);
    expect(csrfIn(page.body)).toBeNull();
    expect(page.body).toContain('Its owner put this box to sleep themselves, so only they can start it');
    expect((await req(URL_, 'POST', `csrf=${csrf}`)).body).toContain('only they can start it');
    expect(calls.start).toBe(0);
  });

  it('never for its own owner (theirs to start), nor with preview-links-wake-enabled off', async () => {
    const { calls, state, req } = await landing();
    state.user = 'owner';
    const own = await req('/termag/previews/my-app');
    expect(csrfIn(own.body)).toBeNull();
    expect(own.body).toContain('This is your box: start it from termag');
    state.user = 'viewer';
    const csrf = csrfIn((await req(URL_)).body)!;
    state.wakeOn = false;
    const off = await req(URL_);
    expect(csrfIn(off.body)).toBeNull();
    // A form from before the flag went off is refused by the flag itself.
    expect((await req(URL_, 'POST', `csrf=${csrf}`)).body).toContain('This preview is asleep. Ask its owner to start the box.');
    expect(calls.claim).toEqual([]);
    expect(calls.start).toBe(0);
  });

  it('a stale Wake it with the flag off, once the box is coming up or up, goes back to the landing rather than refusing (Bugbot, #1570)', async () => {
    const { calls, state, req } = await landing();
    const csrf = csrfIn((await req(URL_)).body)!;
    state.wakeOn = false;
    for (const status of ['starting', 'ready']) {
      state.box = sweptBox({ status });
      state.boxStatus = status;
      const r = await req(URL_, 'POST', `csrf=${csrf}`);
      expect(r.status).toBe(303);
      expect(r.body).not.toContain('Ask its owner to start the box');
    }
    expect((await req(URL_)).body).toContain("You're opening an app running on Olive Owner's box");
    expect(calls.claim).toEqual([]);
    expect(calls.start).toBe(0);
  });

  it('refuses a stale or forged form, and stays within the owner\'s budget', async () => {
    const { calls, state, req } = await landing();
    expect((await req(URL_, 'POST', 'csrf=forged')).status).toBe(403);
    expect(calls.claim).toEqual([]);
    const csrf = csrfIn((await req(URL_)).body)!;
    state.claim = { ok: false, reason: 'too-soon', retryAt: Date.now() + 600_000 };
    const r = await req(URL_, 'POST', `csrf=${csrf}`);
    expect(r.body).toContain('woken for a viewer a few minutes ago');
    expect(calls.start).toBe(0);
  });

  it('a second viewer whose claim loses to another\'s wake joins it: back to the landing, which shows the wait (Bugbot, #1570)', async () => {
    const { calls, state, req } = await landing();
    const csrf = csrfIn((await req(URL_)).body)!;
    // Between this viewer's look and their claim, someone else woke it.
    state.claim = { ok: false, reason: 'too-soon', retryAt: Date.now() + 1800_000 };
    // The box reads as stopped until this viewer's claim has lost, then as starting: the other viewer's start. Keyed
    // on the claim, not on a count of looks, so the wake's own looks before it can't skip it (Devin, #1570).
    const asleep = state.box;
    Object.defineProperty(state, 'box', { get: () => (calls.claim.length ? { ...asleep, status: 'starting' } : asleep), configurable: true });
    const r = await req(URL_, 'POST', `csrf=${csrf}`);
    expect(calls.claim).toHaveLength(1);
    expect(r.status).toBe(303);
    expect(calls.start).toBe(0);
    // The 303 is the join: back to the landing, which shows the other viewer's wake.
    state.boxStatus = 'starting';
    expect((await req(r.headers.location!)).body).toContain("Waking Olive Owner's box");
  });

  it('a claim that loses with no other wake under way is refused, not sent back to the landing (Devin, #1570)', async () => {
    const { calls, state, req } = await landing();
    const csrf = csrfIn((await req(URL_)).body)!;
    state.claim = { ok: false, reason: 'too-soon', retryAt: Date.now() + 1800_000 };
    const r = await req(URL_, 'POST', `csrf=${csrf}`);
    expect(calls.claim).toHaveLength(1);
    expect(r.status).not.toBe(303);
    expect(calls.start).toBe(0);
  });

  it('Wake it pressed once the box is already up goes back to the landing, which hands off (Bugbot, #1570)', async () => {
    const { calls, state, req } = await landing();
    const csrf = csrfIn((await req(URL_)).body)!;
    state.box = sweptBox({ status: 'ready' });
    state.boxStatus = 'ready';
    const r = await req(URL_, 'POST', `csrf=${csrf}`);
    expect(r.status).toBe(303);
    expect(calls.claim).toEqual([]);
    expect((await req(r.headers.location!)).body).toContain("You're opening an app running on Olive Owner's box");
  });

  // Pinning (Bugbot, #1570): the wake decides on the box it starts. Going down at the first look and stopped by its
  // owner at the second, it's refused, never started.
  it('a box going down at the first look and stopped by its owner at the second is never woken (Bugbot, #1570)', async () => {
    const { calls, state, req } = await landing();
    const csrf = csrfIn((await req(URL_)).body)!;
    const going = sweptBox({ status: 'stopping' });
    const byHand = sweptBox({ lifecycleNote: null });
    let looks = 0;
    const swept = sweptBox();
    // The wake's first look (stopped by the sweep), the refusal's (going down again), the start's (stopped by hand).
    Object.defineProperty(state, 'box', { get: () => [swept, going][++looks - 1] ?? byHand, configurable: true });
    const r = await req(URL_, 'POST', `csrf=${csrf}`);
    expect(r.body).toContain('only they can start it');
    expect(calls.claim).toEqual([]);
    expect(calls.start).toBe(0);
  });

  it('a start that fails gives the wake back', async () => {
    const { calls, req } = await landing();
    calls.startFails = true;
    const csrf = csrfIn((await req(URL_)).body)!;
    const r = await req(URL_, 'POST', `csrf=${csrf}`);
    expect(r.body).toContain('The owner&#39;s box didn&#39;t start');
    expect(calls.refund).toEqual(['w1']);
  });
});
