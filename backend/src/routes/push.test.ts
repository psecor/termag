import { describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  addSubscription, listSubscriptions, pushConfig, pushRouter, removeSubscription, sendTest,
  type PushRouteDeps, type PushRouteStore,
} from './push';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../services/pushFlag', () => ({ webPushEnabledFor: vi.fn(async () => true) }));

const VAPID = { publicKey: 'BPub', privateKey: 'priv', subject: 'mailto:ops@example.com' };
const P256DH = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 3).toString('base64url');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

function makeDeps(over: Partial<PushRouteDeps> = {}) {
  const store = {
    list: vi.fn<PushRouteStore['list']>(async () => []),
    upsert: vi.fn<PushRouteStore['upsert']>(async () => ({ id: 'sub1' })),
    remove: vi.fn<PushRouteStore['remove']>(async () => 1),
  };
  const send = vi.fn<PushRouteDeps['send']>(async () => ({ sent: 2, failed: 1, removed: 1 }));
  const enabledFor = vi.fn<PushRouteDeps['enabledFor']>(async () => true);
  return { store, send, vapid: () => VAPID, baseUrl: () => 'https://example.com/termag', enabledFor, ...over };
}

describe('GET /config', () => {
  it('hands out the public key only', async () => {
    expect(await pushConfig('u1', makeDeps())).toEqual({ status: 200, body: { enabled: true, publicKey: 'BPub' } });
  });
  it('says off with any VAPID var unset', async () => {
    expect(await pushConfig('u1', makeDeps({ vapid: () => null }))).toEqual({ status: 200, body: { enabled: false, publicKey: null } });
  });
  it('says off, without the key, while mobile-web-push-enabled is off for the user', async () => {
    const d = makeDeps({ enabledFor: async () => false });
    expect(await pushConfig('u1', d)).toEqual({ status: 200, body: { enabled: false, publicKey: null } });
  });
  it('refuses to subscribe or test while the flag is off, without writing', async () => {
    const d = makeDeps({ enabledFor: async () => false });
    const body = { subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } } };
    expect((await addSubscription('u1', body, d)).status).toBe(403);
    expect((await sendTest('u1', d)).status).toBe(403);
    expect(d.store.upsert).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });
});

describe('GET /subscriptions', () => {
  it("lists the caller's devices without endpoints or keys", async () => {
    const d = makeDeps();
    const at = new Date('2026-10-14T00:00:00Z');
    d.store.list.mockResolvedValue([
      { id: 's1', userAgent: 'iPhone', createdAt: at, lastUsedAt: null, failedAt: null, endpoint: ENDPOINT, p256dh: P256DH } as never,
    ]);
    const r = await listSubscriptions('u1', d);
    expect(d.store.list).toHaveBeenCalledWith('u1');
    expect(r).toEqual({ status: 200, body: { subscriptions: [{ id: 's1', userAgent: 'iPhone', createdAt: at, lastUsedAt: null, failedAt: null }] } });
  });
});

describe('POST /subscriptions', () => {
  const body = { subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } }, userAgent: 'Pixel' };

  it('upserts by endpoint for the caller and returns the id', async () => {
    const d = makeDeps();
    expect(await addSubscription('u1', body, d)).toEqual({ status: 200, body: { id: 'sub1' } });
    expect(d.store.upsert).toHaveBeenCalledWith('u1', { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH, userAgent: 'Pixel' });
  });

  it('refuses an endpoint that is not a known push service (SSRF) without writing', async () => {
    const d = makeDeps();
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com.evil.com/x', 'https://user@fcm.googleapis.com/x']) {
      const r = await addSubscription('u1', { ...body, subscription: { ...body.subscription, endpoint } }, d);
      expect(r.status).toBe(400);
    }
    expect(d.store.upsert).not.toHaveBeenCalled();
  });

  it('refuses bad keys and shapes', async () => {
    const d = makeDeps();
    expect((await addSubscription('u1', { subscription: { endpoint: ENDPOINT, keys: { p256dh: 'x', auth: AUTH } } }, d)).status).toBe(400);
    expect((await addSubscription('u1', { subscription: { endpoint: ENDPOINT } }, d)).status).toBe(400);
    expect((await addSubscription('u1', { endpoint: ENDPOINT }, d)).status).toBe(400);
    expect((await addSubscription('u1', undefined, d)).status).toBe(400);
    expect(d.store.upsert).not.toHaveBeenCalled();
  });

  it('is a 409 with push off', async () => {
    const d = makeDeps({ vapid: () => null });
    expect((await addSubscription('u1', body, d)).status).toBe(409);
    expect(d.store.upsert).not.toHaveBeenCalled();
  });
});

describe('DELETE /subscriptions', () => {
  it("removes only the caller's row and answers 204 either way", async () => {
    const d = makeDeps();
    expect(await removeSubscription('u1', { endpoint: ENDPOINT }, d)).toEqual({ status: 204, body: null });
    expect(d.store.remove).toHaveBeenCalledWith('u1', ENDPOINT);
    d.store.remove.mockResolvedValue(0);
    expect((await removeSubscription('u1', { endpoint: ENDPOINT }, d)).status).toBe(204);
  });
  it('needs an endpoint', async () => {
    const d = makeDeps();
    expect((await removeSubscription('u1', {}, d)).status).toBe(400);
    expect(d.store.remove).not.toHaveBeenCalled();
  });
});

describe('POST /test', () => {
  it("sends the test notification to the caller's devices and reports sent/failed", async () => {
    const d = makeDeps();
    expect(await sendTest('u1', d)).toEqual({ status: 200, body: { sent: 2, failed: 1 } });
    expect(d.send).toHaveBeenCalledWith('u1', {
      web_push: 8030,
      mutable: true,
      notification: {
        title: 'termag', body: 'Notifications are on for this device', navigate: 'https://example.com/termag/m', tag: 'termag-test',
        data: { key: 'termag-test' },
      },
    });
  });
  it('is a 409 with push off', async () => {
    const d = makeDeps({ vapid: () => null });
    expect((await sendTest('u1', d)).status).toBe(409);
    expect(d.send).not.toHaveBeenCalled();
  });
});

interface Layer { name?: string; handle: RequestHandler; route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] } }

describe('pushRouter', () => {
  it('puts every route behind requireAuth and mounts the contract paths', () => {
    const router = pushRouter(makeDeps()) as Router & { stack: Layer[] };
    expect(router.stack[0].handle).toBe(requireAuth);
    const routes = router.stack.filter(l => l.route).map(l => `${Object.keys(l.route!.methods)[0].toUpperCase()} ${l.route!.path}`);
    expect(routes).toEqual(['GET /config', 'GET /subscriptions', 'POST /subscriptions', 'DELETE /subscriptions', 'POST /test']);
  });

  it('answers DELETE with an empty 204 and a thrown store with a 500', async () => {
    const d = makeDeps();
    const router = pushRouter(d) as Router & { stack: Layer[] };
    const handler = (method: string, path: string) =>
      router.stack.find(l => l.route?.path === path && l.route.methods[method])!.route!.stack[0].handle;
    const res = () => {
      const r = { status: vi.fn(), json: vi.fn(), end: vi.fn() };
      r.status.mockReturnValue(r);
      return r;
    };
    const del = res();
    await handler('delete', '/subscriptions')({ user: { id: 'u1' }, body: { endpoint: ENDPOINT } } as unknown as Request, del as unknown as Response, () => {});
    expect(del.status).toHaveBeenCalledWith(204);
    expect(del.end).toHaveBeenCalled();

    d.store.list.mockRejectedValue(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = res();
    await handler('get', '/subscriptions')({ user: { id: 'u1' } } as unknown as Request, list as unknown as Response, () => {});
    expect(list.status).toHaveBeenCalledWith(500);
    err.mockRestore();
  });
});
