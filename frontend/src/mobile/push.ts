// The phone client's half of web push: register the
// service worker, subscribe this device with the server's VAPID key, and keep
// the home-screen badge and the shown notifications in step with what is
// actually waiting. Pure helpers are exported for tests; the rest touches
// browser APIs and is exercised on the emulator / Safari web app (§8).
import { pushApi, type PushSubscriptionBody } from '../services/api';
import { isAppleMobile, isStandalone } from './redirect';
import { forgetShown, notificationKey, takeVanished, type ShownRecord } from './shownNotifications';

export const SW_URL = '/termag/sw.js';
export const SW_SCOPE = '/termag/';
/** Window event main.tsx raises for a notification click; its detail is the target URL. */
export const NAVIGATE_EVENT = 'termag:navigate';

/** The router path for a /termag URL (BrowserRouter's basename is /termag). */
export function routerPathFor(target: { pathname: string; search: string }): string | null {
  if (!target.pathname.startsWith('/termag/')) return null;
  return `${target.pathname.slice('/termag'.length)}${target.search}`;
}

export type PushSupport =
  /** No service worker / Push API / Notification in this browser. */
  | 'unsupported'
  /** iOS/iPadOS Safari outside the installed app: push needs Add to Home Screen first. */
  | 'needs-install'
  | 'supported';

interface SupportEnv {
  userAgent: string;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** iPadOS reports a Mac user agent; touch points tell them apart. */
  maxTouchPoints: number;
}

export function pushSupport(env: SupportEnv): PushSupport {
  // iOS hides PushManager entirely outside the installed app, so check that first.
  if (isAppleMobile(env.userAgent, env.maxTouchPoints) && !env.standalone) return 'needs-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  return 'supported';
}

export function currentPushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  return pushSupport({
    userAgent: navigator.userAgent,
    standalone: isStandalone(window),
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
}

/** The VAPID key as the Push API wants it (URL-safe base64 → bytes). */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** What the server stores: endpoint + keys, nothing else from the browser object. */
export function subscriptionBody(sub: { toJSON(): PushSubscriptionJSON }): PushSubscriptionBody | null {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return null;
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } };
}

/**
 * Tags of shown notifications to close: a session notification (tag = the
 * status key, `instance|session`, plus `#<id>` per push) whose session's
 * status has arrived and is not waiting. A session not heard from yet keeps
 * its notification: statuses stream in one by one after the page opens, with
 * no end-of-snapshot, and opening the app must not clear what still needs an
 * answer. Other tags (the test notification) are left for the user.
 */
export function staleNotificationTags(shownTags: Array<string | undefined>, resolvedKeys: ReadonlySet<string>): string[] {
  return shownTags.filter((t): t is string => !!t && t.includes('|') && resolvedKeys.has(notificationKey(t)));
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
    // register() resolves with the existing registration and need not check
    // for a new worker; WebKit's installed app kept an old one across visits.
    void reg.update().catch(() => {});
    return reg;
  } catch {
    return null;
  }
}

/**
 * `p`, or `fallback()` if it has not settled after `ms`. WebKit's push calls can
 * stay pending for good (pushManager.getSubscription() in the iOS 27 simulator's
 * installed app, 2026-10-14), and a sheet waiting on one never leaves "Checking".
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { resolve(fallback()); } catch (err) { reject(err); }
    }, ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, err => { clearTimeout(timer); reject(err); });
  });
}

/** Long enough for Safari's first worker activation (seconds), short enough to not look hung. */
export const PUSH_CHECK_MS = 8000;
/** subscribe() talks to Apple / FCM / Mozilla before it settles. */
export const PUSH_SUBSCRIBE_MS = 20000;

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  const reg = await registerServiceWorker();
  if (!reg) return null;
  return navigator.serviceWorker.ready.catch(() => reg);
}

const TIMED_OUT = Symbol('timed out');

function lookupSubscription(): Promise<PushSubscription | null | typeof TIMED_OUT> {
  return withTimeout<PushSubscription | null | typeof TIMED_OUT>((async () => {
    const reg = await readyRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  })(), PUSH_CHECK_MS, () => TIMED_OUT);
}

/** This device's subscription; null when there is none or the browser never answers. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const sub = await lookupSubscription();
  return sub === TIMED_OUT ? null : sub;
}

// The endpoint this device last registered with the server, so turning off
// still reaches the server when the browser cannot say which it is: WebKit's
// getSubscription() can stay pending for good, and Chrome drops its own
// subscription when notifications are blocked, leaving the server's row.
const ENDPOINT_KEY = 'termag.push.endpoint';

function rememberedEndpoint(): string | null {
  try { return window.localStorage.getItem(ENDPOINT_KEY); } catch { return null; }
}

/** Whether this device registered a push subscription with the server (it may since have lapsed). */
export function pushEndpointRemembered(): boolean {
  return !!rememberedEndpoint();
}

function rememberEndpoint(endpoint: string | null): void {
  try {
    if (endpoint) window.localStorage.setItem(ENDPOINT_KEY, endpoint);
    else window.localStorage.removeItem(ENDPOINT_KEY);
  } catch { /* storage blocked: the browser's own answer is all there is */ }
}

export type EnableResult = { ok: true } | { ok: false; reason: 'denied' | 'unsupported' | 'disabled' | 'failed'; detail?: string };

/** Must run inside a tap: iOS refuses a permission prompt without the gesture. */
export async function enablePush(): Promise<EnableResult> {
  if (currentPushSupport() !== 'supported') return { ok: false, reason: 'unsupported' };
  // Ask first, before any await that could lose the user activation.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };
  try {
    const config = await pushApi.config();
    if (!config.enabled || !config.publicKey) return { ok: false, reason: 'disabled' };
    const reg = await withTimeout(readyRegistration(), PUSH_CHECK_MS, () => null);
    if (!reg) return { ok: false, reason: 'unsupported' };
    const key = urlBase64ToUint8Array(config.publicKey);
    // An unanswered lookup means none we can use: subscribing again is harmless.
    let sub = await withTimeout(reg.pushManager.getSubscription(), PUSH_CHECK_MS, () => null);
    // A subscription made with another server key cannot receive this server's pushes.
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      sub = await withTimeout(
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }),
        PUSH_SUBSCRIBE_MS,
        () => { throw new Error('the browser did not answer the subscribe request'); },
      );
    }
    const body = subscriptionBody(sub);
    if (!body) return { ok: false, reason: 'failed', detail: 'the browser returned an incomplete subscription' };
    await pushApi.subscribe(body, navigator.userAgent);
    // A previous subscription on this device (another server key) can no longer receive anything.
    const previous = rememberedEndpoint();
    if (previous && previous !== body.endpoint) await pushApi.unsubscribe(previous).catch(() => {});
    rememberEndpoint(body.endpoint);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'failed', detail: (err as Error)?.message };
  }
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/**
 * Unsubscribe this device on the server, then in the browser. False when that
 * could not be done: the server call failed (the browser's subscription is
 * kept, so trying again still works), or the browser never answered and no
 * endpoint was remembered.
 */
export async function disablePush(): Promise<boolean> {
  const found = await lookupSubscription();
  const sub = found === TIMED_OUT ? null : found;
  const endpoints = new Set([sub?.endpoint, rememberedEndpoint()].filter((e): e is string => !!e));
  if (found === TIMED_OUT && endpoints.size === 0) return false;
  try {
    for (const endpoint of endpoints) await pushApi.unsubscribe(endpoint);
  } catch {
    return false;
  }
  rememberEndpoint(null);
  await sub?.unsubscribe().catch(() => {});
  return true;
}

/**
 * Notifications were blocked in the system settings while this device was
 * subscribed: drop the subscription, here and on the server (§6). The device
 * can show nothing, and while its row looks live the account's pushMutesChat
 * keeps skipping the Slack and Discord posts. Turning on again re-subscribes.
 */
export async function dropBlockedSubscription(): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission === 'granted') return;
  if (currentPushSupport() !== 'supported') return;
  await disablePush().catch(() => {});
}

/**
 * The page's side of clearing (§6): set the badge and close the notifications
 * of sessions known to be no longer waiting (`resolvedKeys`, status keys).
 */
export async function syncAttention(resolvedKeys: ReadonlySet<string>, attention: number): Promise<void> {
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (attention > 0) await nav.setAppBadge?.(attention);
    else await nav.clearAppBadge?.();
  } catch { /* no permission, or not installed */ }
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if (!reg) return;
    const shown = await reg.getNotifications();
    const stale = new Set(staleNotificationTags(shown.map(n => n.tag), resolvedKeys));
    for (const n of shown) if (stale.has(n.tag)) n.close();
    // Closed on purpose, so not a tap (shownNotifications.ts).
    await forgetShown([...stale]).catch(() => {});
  } catch { /* getNotifications unsupported */ }
}

/**
 * A notification tapped while the app was alive, inferred from the worker's
 * record (shownNotifications.ts); null when none or not exactly one.
 * `open: false` only forgets what vanished.
 */
export async function checkTappedNotification(open: boolean): Promise<ShownRecord | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    return reg ? await takeVanished(reg, open) : null;
  } catch {
    return null;
  }
}
