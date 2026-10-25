/**
 * Web Push subscriptions for the phone client, mounted at
 * `${BASE_PATH}/api/push` behind requireAuth:
 *
 *   GET    /config         → { enabled, publicKey }
 *   GET    /subscriptions  → { subscriptions: [{ id, userAgent, createdAt, lastUsedAt, failedAt }] }
 *   POST   /subscriptions  { subscription: { endpoint, keys: { p256dh, auth } }, userAgent? } → { id }
 *   DELETE /subscriptions  { endpoint } → 204
 *   POST   /test           → { sent, failed }
 *
 * The handlers are plain functions over a small store so the tests drive them
 * without Express or a database; `pushRouter()` wires in Prisma.
 */
import { Router, type RequestHandler } from 'express';
import { prisma } from '../db';
import { webPushEnabledFor } from '../services/pushFlag';
import { requireAuth } from '../middleware/auth';
import { sendResult, type RouteResult } from './routeResult';
import {
  appBaseUrl, buildTestPayload, defaultSendDeps, parseEndpointBody, parseSubscriptionBody, sendToUser,
  type DeclarativePushPayload, type PushSubscriptionInput, type SendSummary, type VapidConfig,
} from '../services/webPush';

export interface SubscriptionView {
  id: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  failedAt: Date | null;
}

export interface PushRouteStore {
  list(userId: string): Promise<SubscriptionView[]>;
  /** Upsert by endpoint; a row another user registered is re-owned by `userId`. */
  upsert(userId: string, input: PushSubscriptionInput): Promise<{ id: string }>;
  /** Only `userId`'s row; returns how many were removed. */
  remove(userId: string, endpoint: string): Promise<number>;
}

export interface PushRouteDeps {
  store: PushRouteStore;
  vapid: () => VapidConfig | null;
  send: (userId: string, payload: DeclarativePushPayload) => Promise<SendSummary>;
  baseUrl: () => string;
  /** mobile-web-push-enabled for this user (services/pushFlag.ts). */
  enabledFor: (userId: string) => Promise<boolean>;
}

const NOT_ENABLED: RouteResult = { status: 403, body: { error: 'push is not enabled for this account' } };

/** Push is available to this user: the server has VAPID keys and the flag is on for them. */
export async function pushConfig(userId: string, deps: Pick<PushRouteDeps, 'vapid' | 'enabledFor'>): Promise<RouteResult> {
  const vapid = deps.vapid();
  const enabled = !!vapid && await deps.enabledFor(userId);
  return { status: 200, body: { enabled, publicKey: enabled ? vapid!.publicKey : null } };
}

export async function listSubscriptions(userId: string, deps: Pick<PushRouteDeps, 'store'>): Promise<RouteResult> {
  const rows = await deps.store.list(userId);
  return {
    status: 200,
    body: {
      subscriptions: rows.map(r => ({
        id: r.id, userAgent: r.userAgent, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, failedAt: r.failedAt,
      })),
    },
  };
}

export async function addSubscription(userId: string, body: unknown, deps: Pick<PushRouteDeps, 'store' | 'vapid' | 'enabledFor'>): Promise<RouteResult> {
  if (!deps.vapid()) return { status: 409, body: { error: 'push is not configured on this server' } };
  if (!await deps.enabledFor(userId)) return NOT_ENABLED;
  const parsed = parseSubscriptionBody(body);
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } };
  const { id } = await deps.store.upsert(userId, parsed);
  return { status: 200, body: { id } };
}

export async function removeSubscription(userId: string, body: unknown, deps: Pick<PushRouteDeps, 'store'>): Promise<RouteResult> {
  const parsed = parseEndpointBody(body);
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } };
  // 204 whether or not a row matched: the device is not subscribed for this user either way.
  await deps.store.remove(userId, parsed.endpoint);
  return { status: 204, body: null };
}

export async function sendTest(userId: string, deps: Pick<PushRouteDeps, 'vapid' | 'send' | 'baseUrl' | 'enabledFor'>): Promise<RouteResult> {
  if (!deps.vapid()) return { status: 409, body: { error: 'push is not configured on this server' } };
  if (!await deps.enabledFor(userId)) return NOT_ENABLED;
  const { sent, failed } = await deps.send(userId, buildTestPayload(deps.baseUrl()));
  return { status: 200, body: { sent, failed } };
}

export const prismaPushRouteStore: PushRouteStore = {
  list: (userId) => prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userAgent: true, createdAt: true, lastUsedAt: true, failedAt: true },
  }),
  upsert: (userId, input) => prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    // A re-subscribe (new keys) or a browser now signed in as someone else:
    // the row follows the browser, and a fresh start clears the failure mark.
    update: { userId, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent, failedAt: null },
    create: { userId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent },
    select: { id: true },
  }),
  remove: async (userId, endpoint) => (await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } })).count,
};

export function defaultPushRouteDeps(): PushRouteDeps {
  return {
    store: prismaPushRouteStore,
    vapid: () => defaultSendDeps().vapid,
    send: (userId, payload) => sendToUser(userId, payload, defaultSendDeps()),
    baseUrl: () => appBaseUrl(),
    enabledFor: webPushEnabledFor,
  };
}

function reply(res: Parameters<RequestHandler>[1], result: RouteResult): void {
  if (result.status === 204) { res.status(204).end(); return; }
  sendResult(res, result);
}

export function pushRouter(deps: PushRouteDeps = defaultPushRouteDeps()): Router {
  const router = Router();
  router.use(requireAuth);

  const wrap = (fn: (userId: string, body: unknown) => Promise<RouteResult> | RouteResult): RequestHandler =>
    async (req, res) => {
      try {
        reply(res, await fn(req.user!.id, req.body));
      } catch (err) {
        console.error('[PUSH] route failed:', err instanceof Error ? err.message : String(err));
        res.status(500).json({ error: 'push request failed' });
      }
    };

  router.get('/config', wrap(userId => pushConfig(userId, deps)));
  router.get('/subscriptions', wrap(userId => listSubscriptions(userId, deps)));
  router.post('/subscriptions', wrap((userId, body) => addSubscription(userId, body, deps)));
  router.delete('/subscriptions', wrap((userId, body) => removeSubscription(userId, body, deps)));
  router.post('/test', wrap(userId => sendTest(userId, deps)));
  return router;
}
