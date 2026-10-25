/**
 * Web Push to the phone client.
 *
 * Pure parts first (VAPID config, the endpoint allow-list, payload builders,
 * the live-subscription rule), then the sender: `sendToSubscriptions` takes
 * its store and transport as arguments so tests never touch the network or
 * the database, and `sendToUser` wires in Prisma and the `web-push` library.
 *
 * Payloads use the Declarative Web Push shape (`web_push: 8030`) so iOS 18.4+
 * can show them without running the service worker; everywhere else
 * `frontend/public/sw.js` reads the same JSON.
 */
import { parse as legacyUrlParse } from 'url';
import webpush from 'web-push';
import { prisma } from '../db';

// ── VAPID ──────────────────────────────────────────────────────

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** Private-use and reserved TLDs: a contact on one of these is not a contact. */
const NON_PUBLIC_TLDS = new Set(['local', 'localhost', 'internal', 'invalid', 'test', 'lan', 'home', 'corp', 'localdomain']);

/**
 * Why the VAPID `sub` claim would be refused, or null when it looks usable.
 * Apple's push service answers 403 BadJwtToken for a contact on a non-public
 * domain (`mailto:e2e@termag.local`, seen 2026-10-14) while FCM accepts it, so
 * a bad subject only fails for iPhone and Mac users. Checked at config time so
 * the failure is one log line, not a mystery per send.
 */
export function vapidSubjectProblem(subject: string): string | null {
  let host: string;
  if (subject.startsWith('mailto:')) {
    const m = /^mailto:[^@\s]+@([^@\s]+)$/.exec(subject);
    if (!m) return 'a mailto: subject needs an address (mailto:someone@example.com)';
    host = m[1];
  } else if (subject.startsWith('https://')) {
    try { host = new URL(subject).hostname; } catch { return 'the https: subject is not a URL'; }
  } else {
    return 'the subject must be a mailto: address or an https: URL';
  }
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2 || labels.some(l => !l)) return `"${host}" is not a public domain`;
  if (NON_PUBLIC_TLDS.has(labels[labels.length - 1])) return `"${host}" is on a private-use domain; Apple's push service rejects it`;
  return null;
}

let warnedSubject: string | null = null;

/**
 * All three of VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT, or null
 * (push off). A subject Apple would refuse also turns push off, with one error
 * line, so a misconfiguration is not half-working (Android only).
 */
export function vapidConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  const problem = vapidSubjectProblem(subject);
  if (problem) {
    if (warnedSubject !== subject) {
      warnedSubject = subject;
      console.error(`[PUSH] web push is off: VAPID_SUBJECT ${problem}`);
    }
    return null;
  }
  return { publicKey, privateKey, subject };
}

// ── Endpoint allow-list (SSRF guard) ──────────────────────────

/**
 * Push services a browser hands out endpoints on. Exact hosts, and suffixes
 * that need at least one label in front (`web.push.apple.com`,
 * `wns2-par02p.notify.windows.com`).
 */
const EXACT_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com']);
const HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

export const MAX_ENDPOINT_LENGTH = 2048;

// The whole URL, strictly: `https://`, a lowercase DNS name, an optional
// explicit `:443`, then a path (and query, which WNS uses) from a small set of
// characters. No `@` anywhere (so no userinfo), no `\`, `#`, brackets or
// whitespace. Browsers' endpoints all fit; anything cleverer is refused
// before a URL parser gets a chance to read it differently from another.
const ENDPOINT_SHAPE = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::443)?(\/[A-Za-z0-9\-._~%:/?&=+,]*)$/;
const IPV4_LIKE = /^[0-9.]+$/;

function hostAllowed(host: string): boolean {
  if (EXACT_HOSTS.has(host)) return true;
  return HOST_SUFFIXES.some(suffix => host.endsWith(suffix) && host.length > suffix.length);
}

/**
 * May the server POST to this push endpoint? It is a URL the browser gave
 * us, so it is also a URL an attacker can give us: https on 443 to a known
 * push service only. `web-push` sends with the legacy `url.parse`, so the
 * WHATWG parser and the legacy one must both agree on the host as well.
 */
export function isAllowedPushEndpoint(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ENDPOINT_LENGTH) return false;
  const m = ENDPOINT_SHAPE.exec(raw);
  if (!m) return false;
  const host = m[1];
  if (IPV4_LIKE.test(host)) return false;
  if (host.split('.').some(label => label.length === 0 || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return false;
  if (!hostAllowed(host)) return false;

  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (parsed.port !== '' && parsed.port !== '443') return false;
  if (parsed.hostname !== host) return false;

  const legacy = legacyUrlParse(raw);
  if (legacy.protocol !== 'https:' || legacy.auth || legacy.hostname !== host) return false;
  if (legacy.port && legacy.port !== '443') return false;
  return true;
}

// ── Subscription body ─────────────────────────────────────────

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
export const MAX_USER_AGENT_LENGTH = 512;

function decodedLength(s: string): number {
  return Buffer.from(s.replace(/=+$/, ''), 'base64url').length;
}

/**
 * `POST /api/push/subscriptions` body: `{ subscription: { endpoint, keys:
 * { p256dh, auth } }, userAgent? }` — `PushSubscription.toJSON()` plus the
 * browser's UA. p256dh is an uncompressed P-256 point (65 bytes, 0x04
 * first), auth a 16-byte secret, both base64url.
 */
export function parseSubscriptionBody(body: unknown): PushSubscriptionInput | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be an object' };
  const { subscription, userAgent } = body as { subscription?: unknown; userAgent?: unknown };
  if (typeof subscription !== 'object' || subscription === null || Array.isArray(subscription)) {
    return { error: 'subscription must be an object' };
  }
  const { endpoint, keys } = subscription as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== 'string' || !endpoint) return { error: 'subscription.endpoint must be a string' };
  if (!isAllowedPushEndpoint(endpoint)) return { error: 'subscription.endpoint is not a known push service' };
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return { error: 'subscription.keys must be an object' };
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== 'string' || p256dh.length > 128 || !B64URL.test(p256dh)) {
    return { error: 'subscription.keys.p256dh must be base64url' };
  }
  const point = Buffer.from(p256dh.replace(/=+$/, ''), 'base64url');
  if (point.length !== 65 || point[0] !== 0x04) return { error: 'subscription.keys.p256dh must be a 65-byte P-256 key' };
  if (typeof auth !== 'string' || auth.length > 32 || !B64URL.test(auth)) {
    return { error: 'subscription.keys.auth must be base64url' };
  }
  if (decodedLength(auth) !== 16) return { error: 'subscription.keys.auth must be 16 bytes' };
  let ua: string | null = null;
  if (userAgent !== undefined && userAgent !== null) {
    if (typeof userAgent !== 'string') return { error: 'userAgent must be a string' };
    ua = userAgent.trim().slice(0, MAX_USER_AGENT_LENGTH) || null;
  }
  return { endpoint, p256dh, auth, userAgent: ua };
}

/** `DELETE /api/push/subscriptions` body: `{ endpoint }`. Not allow-listed: deleting is harmless. */
export function parseEndpointBody(body: unknown): { endpoint: string } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be an object' };
  const { endpoint } = body as { endpoint?: unknown };
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
    return { error: 'endpoint must be a string' };
  }
  return { endpoint };
}

// ── Payloads ──────────────────────────────────────────────────

export interface DeclarativePushPayload {
  web_push: 8030;
  /**
   * Run the worker's push handler even where the browser could show the
   * notification alone (Safari 18.4+), so the worker can record it: iOS never
   * tells a live Home Screen app about a tap, and the page infers one from the
   * record. Safari hands the worker `event.notification`
   * and leaves `event.data` empty, so what the worker needs is in `data`.
   */
  mutable: true;
  notification: {
    title: string;
    body: string;
    navigate: string;
    tag: string;
    /**
     * `key`: the notification's session (the status key), or a chat's
     * `chat-turn:` key. `kind: 'chat-turn'` tells the worker it may skip a
     * chat already on screen and must not record it for tap inference.
     */
    data: { key: string; kind?: 'chat-turn' };
  };
  /** The waiting count. Top level, where WebKit reads it (NotificationJSONParser); inside `notification` it is ignored. */
  app_badge?: string;
  termag?: { session: string; projectId: string; workstream: string; kind?: 'chat-turn' };
}

/** `<FRONTEND_URL><BASE_PATH>`, no trailing slash. */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const frontend = (env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  const base = (env.BASE_PATH ?? '').replace(/\/+$/, '');
  return `${frontend}${base}`;
}

export interface WaitingPayloadInput {
  /** `appBaseUrl()`: FRONTEND_URL + BASE_PATH. */
  baseUrl: string;
  projectId: string;
  projectName: string;
  workstream: string;
  session: string;
  /** The status key (`statusKey(instanceId, session)`): a later wait on the same session replaces this one. */
  tag: string;
  message?: string | null;
  waitingReason?: 'approval' | 'user_input' | 'unknown' | null;
  /** The owner's sessions currently waiting, this one included. */
  waitingCount: number;
}

const MAX_BODY = 180;

export function waitingBody(message: string | null | undefined, reason: WaitingPayloadInput['waitingReason']): string {
  const text = (message ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
  if (reason === 'approval') return 'Needs approval';
  if (reason === 'user_input') return 'Asked you a question';
  return 'Waiting for you';
}

export function buildWaitingPayload(input: WaitingPayloadInput): DeclarativePushPayload {
  const path = `/m/p/${encodeURIComponent(input.projectId)}`;
  const query = input.workstream && input.workstream !== 'main' ? `?ws=${encodeURIComponent(input.workstream)}` : '';
  return {
    web_push: 8030,
    mutable: true,
    notification: {
      title: input.workstream === 'main' ? input.projectName : `${input.projectName} · ${input.workstream}`,
      body: waitingBody(input.message, input.waitingReason),
      navigate: `${input.baseUrl}${path}${query}`,
      tag: input.tag,
      data: { key: input.tag },
    },
    app_badge: String(Math.max(0, Math.floor(input.waitingCount))),
    termag: { session: input.session, projectId: input.projectId, workstream: input.workstream },
  };
}

export interface ChatTurnPayloadInput {
  baseUrl: string;
  projectId: string;
  projectName: string;
  workstream: string;
  session: string;
  /** The chat's last words (the status message), if any. */
  message?: string | null;
}

/** One notification per chat: a later answer replaces the earlier one. No `:` or `|` inside a project id or workstream. */
export function chatTurnTag(projectId: string, workstream: string): string {
  return `chat-turn:${projectId}:${workstream}`;
}

/**
 * A simple-UI chat finished its turn. Opens the
 * chat at /chat/p/<id>. No `app_badge`: the badge counts sessions that wait,
 * and a chat that answered does not.
 */
/** A reply's line as a notification shows it: no markdown emphasis, code ticks or heading/list marker (frontend chat/turnNotify.ts). */
export function plainPreview(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim().replace(/^(#{1,6}|[-*+]|>)\s+/, '');
}

export function buildChatTurnPayload(input: ChatTurnPayloadInput): DeclarativePushPayload {
  const path = `/chat/p/${encodeURIComponent(input.projectId)}`;
  const query = input.workstream && input.workstream !== 'main' ? `?ws=${encodeURIComponent(input.workstream)}` : '';
  const tag = chatTurnTag(input.projectId, input.workstream);
  const text = plainPreview(input.message ?? '');
  return {
    web_push: 8030,
    mutable: true,
    notification: {
      title: input.workstream === 'main' ? input.projectName : `${input.projectName} · ${input.workstream}`,
      body: text ? `Your turn · ${text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text}` : 'Done · your turn',
      navigate: `${input.baseUrl}${path}${query}`,
      tag,
      data: { key: tag, kind: 'chat-turn' },
    },
    termag: { session: input.session, projectId: input.projectId, workstream: input.workstream, kind: 'chat-turn' },
  };
}

export function buildTestPayload(baseUrl: string): DeclarativePushPayload {
  return {
    web_push: 8030,
    mutable: true,
    notification: {
      title: 'termag',
      body: 'Notifications are on for this device',
      navigate: `${baseUrl}/m`,
      tag: 'termag-test',
      data: { key: 'termag-test' },
    },
  };
}

// ── Sending ───────────────────────────────────────────────────

export interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  lastUsedAt?: Date | null;
  failedAt?: Date | null;
}

/**
 * A subscription that is not known to be failing: never failed, or delivered
 * since it last did. Rows that 404/410 are deleted outright, so this only
 * filters out transient-or-unknown failures.
 */
export function isLiveSubscription(sub: Pick<StoredSubscription, 'lastUsedAt' | 'failedAt'>): boolean {
  if (!sub.failedAt) return true;
  return !!sub.lastUsedAt && sub.lastUsedAt.getTime() > sub.failedAt.getTime();
}

export interface PushStore {
  listForUser(userId: string): Promise<StoredSubscription[]>;
  remove(id: string): Promise<void>;
  markUsed(id: string, at: Date): Promise<void>;
  markFailed(id: string, at: Date): Promise<void>;
}

export type PushTransport = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: webpush.RequestOptions,
) => Promise<{ statusCode: number }>;

export interface SendDeps {
  store: PushStore;
  transport: PushTransport;
  vapid: VapidConfig | null;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface SendSummary {
  sent: number;
  failed: number;
  removed: number;
}

/** Short-lived: a "waiting" an hour old is stale, and the page shows the truth anyway. */
export const PUSH_TTL_SECONDS = 3600;
const PUSH_TIMEOUT_MS = 10_000;

function statusCodeOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' ? code : null;
}

/**
 * Send `payload` to each subscription. 404/410 (the browser unsubscribed or
 * the subscription expired) deletes the row; any other failure stamps
 * `failedAt`; success stamps `lastUsedAt`. Never throws.
 */
export async function sendToSubscriptions(
  subs: StoredSubscription[],
  payload: DeclarativePushPayload,
  deps: SendDeps,
): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, failed: 0, removed: 0 };
  const { vapid, store, transport } = deps;
  if (!vapid || subs.length === 0) return summary;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.warn(m));
  const body = JSON.stringify(payload);
  const options: webpush.RequestOptions = {
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: PUSH_TTL_SECONDS,
    urgency: 'high',
    contentEncoding: 'aes128gcm',
    timeout: PUSH_TIMEOUT_MS,
  };

  await Promise.all(subs.map(async (sub) => {
    // Rows are allow-listed on the way in; re-check before every POST anyway.
    if (!isAllowedPushEndpoint(sub.endpoint)) {
      summary.failed++;
      summary.removed++;
      await store.remove(sub.id).catch(() => {});
      return;
    }
    try {
      await transport({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, options);
      summary.sent++;
      await store.markUsed(sub.id, now()).catch(() => {});
    } catch (err) {
      summary.failed++;
      const code = statusCodeOf(err);
      if (code === 404 || code === 410) {
        summary.removed++;
        await store.remove(sub.id).catch(() => {});
      } else {
        log(`[PUSH] send to ${new URL(sub.endpoint).hostname} failed${code ? ` (${code})` : ''}: ${err instanceof Error ? err.message : String(err)}`);
        await store.markFailed(sub.id, now()).catch(() => {});
      }
    }
  }));
  return summary;
}

// ── Prisma + web-push wiring ──────────────────────────────────

export const prismaPushStore: PushStore = {
  listForUser: (userId) => prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true, lastUsedAt: true, failedAt: true },
  }),
  remove: async (id) => { await prisma.pushSubscription.deleteMany({ where: { id } }); },
  markUsed: async (id, at) => { await prisma.pushSubscription.updateMany({ where: { id }, data: { lastUsedAt: at } }); },
  markFailed: async (id, at) => { await prisma.pushSubscription.updateMany({ where: { id }, data: { failedAt: at } }); },
};

export const webPushTransport: PushTransport = (subscription, payload, options) =>
  webpush.sendNotification(subscription, payload, options);

export function defaultSendDeps(): SendDeps {
  return { store: prismaPushStore, transport: webPushTransport, vapid: vapidConfigFromEnv() };
}

/** Every subscription of `userId`. Never throws; push off → nothing sent. */
export async function sendToUser(
  userId: string,
  payload: DeclarativePushPayload,
  deps: SendDeps = defaultSendDeps(),
): Promise<SendSummary> {
  if (!deps.vapid) return { sent: 0, failed: 0, removed: 0 };
  let subs: StoredSubscription[];
  try {
    subs = await deps.store.listForUser(userId);
  } catch (err) {
    console.warn('[PUSH] could not read subscriptions:', err instanceof Error ? err.message : String(err));
    return { sent: 0, failed: 0, removed: 0 };
  }
  return sendToSubscriptions(subs, payload, deps);
}
