// termag's service worker: web push for the phone client.
//
// Deliberately no `fetch` handler. It never serves a page or a chunk, so a
// hot-patched orchestrator is picked up on the next load exactly as before,
// and an outage looks like an outage rather than a stale app.
//
// The payload is a mutable Declarative Web Push (`web_push: 8030`,
// `mutable: true`). Safari 18.4+ parses it and hands this worker the proposed
// notification as `event.notification` (with `event.data` empty); everywhere
// else this worker parses the JSON. On Safari's path the worker shows the
// notification under a tag unique to the push and records it: iOS never tells
// a live Home Screen app about a tap, and the page infers one from a recorded
// notification that vanished (mobile/shownNotifications.ts). Elsewhere a tap
// arrives as `notificationclick`, so the tag stays the session's and the
// browser replaces that session's earlier notification itself. Every push
// shows a notification: iOS revokes a subscription whose pushes show nothing,
// and if this worker fails Safari shows the proposed one instead.
//
// A simple-UI chat's "your turn" push (`data.kind: 'chat-turn'`)
// is one notification per chat and is never
// recorded: only the phone's waiting sessions infer taps. Outside Safari it
// is skipped when a focused window already shows that chat (Chromium does not
// demand a notification while a tab of the site is visible); on Safari it
// always shows, for the reason above.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

const FALLBACK = { title: 'termag', body: 'An agent needs you', navigate: '/termag/m' };

function readPayload(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data === 'object') return data;
  } catch { /* not JSON */ }
  return { notification: FALLBACK };
}

/** What to show, from Safari's parsed notification or from the JSON. */
function readMessage(event) {
  const proposed = event.notification;
  if (proposed && proposed.title) {
    const data = proposed.data && typeof proposed.data === 'object' ? proposed.data : {};
    // Safari sets the badge from the payload's app_badge itself (event.appBadge).
    return { title: proposed.title, body: proposed.body, navigate: proposed.navigate, key: data.key, kind: data.kind, badge: undefined, termag: null, safari: true };
  }
  const payload = readPayload(event);
  const n = { ...FALLBACK, ...(payload.notification || {}) };
  const data = n.data && typeof n.data === 'object' ? n.data : {};
  return { title: n.title, body: n.body, navigate: n.navigate, key: data.key || n.tag, kind: data.kind, badge: payload.app_badge, termag: payload.termag || null, safari: false };
}

// Must match notificationKey() in mobile/shownNotifications.ts.
const TAG_SEPARATOR = '#';
function notificationKey(tag) {
  const i = tag ? tag.lastIndexOf(TAG_SEPARATOR) : -1;
  return i < 0 ? (tag || '') : tag.slice(0, i);
}

self.addEventListener('push', (event) => {
  const m = readMessage(event);
  const url = sameOriginUrl(m.navigate);
  if (m.kind === 'chat-turn') {
    event.waitUntil(showChatTurn(m, url));
    return;
  }
  // Safari: a unique tag per push, so a tapped notification can be told apart
  // from an earlier one for the same session still on screen. Elsewhere the
  // session's own tag (Android groups, and taps the group, when a session's
  // notifications pile up; closing them from here is not reliable there).
  const tag = !m.key ? undefined : m.safari ? `${m.key}${TAG_SEPARATOR}${Date.now().toString(36)}` : m.key;
  event.waitUntil((async () => {
    const earlier = m.safari && m.key ? await shownFor(m.key) : [];
    await self.registration.showNotification(m.title, {
      body: m.body,
      tag,
      // A second wait on the same session replaces the first; renotify so it
      // still buzzes instead of updating silently.
      renotify: !m.safari && !!tag,
      icon: '/termag/icons/icon-192.png',
      badge: '/termag/icons/icon-monochrome-96.png',
      data: { url, termag: m.termag },
      navigate: url,
    });
    // Replace the session's earlier notification. iOS may keep a closed one
    // on screen; forgetClosed() then leaves its record.
    for (const n of earlier) n.close();
    if (m.safari && tag) {
      await safely(async () => {
        await remember({ tag, url, at: Date.now() });
        if (earlier.length) await forgetClosed(earlier.map(n => n.tag));
      });
    }
    const badge = Number(m.badge);
    // Not on Safari's path: there the payload's app_badge is applied for us,
    // and setAppBadge in iOS's worker never settles, so the push event would
    // outlast its 20 s budget and iOS would drop the notification (iOS 27
    // simulator, 2026-10-15).
    if (!m.safari && m.badge !== undefined && Number.isFinite(badge) && 'setAppBadge' in self.navigator) {
      await (badge > 0 ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()).catch(() => {});
    }
  })());
});

async function showChatTurn(m, url) {
  if (!m.safari && await chatOnScreen(url)) return;
  await self.registration.showNotification(m.title, {
    body: m.body,
    tag: m.key,
    renotify: !!m.key,
    icon: '/termag/icons/icon-192.png',
    badge: '/termag/icons/icon-monochrome-96.png',
    data: { url, termag: m.termag },
    // Only where notificationclick may never run (Safari). A Chrome that
    // honours `navigate` handles the click itself and never routes the open
    // simple UI window to the chat.
    ...(m.safari ? { navigate: url } : {}),
  });
}

// Must match chatHref() in chat/simpleChat.ts: /termag/chat/p/<id>[?ws=<workstream>].
function sameChat(a, b) {
  return a.pathname === b.pathname && (a.searchParams.get('ws') || 'main') === (b.searchParams.get('ws') || 'main');
}

/** A focused, visible window shows this chat: the person is looking at it. */
async function chatOnScreen(url) {
  try {
    const target = new URL(url);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return wins.some(w => w.focused && w.visibilityState === 'visible' && sameChat(new URL(w.url), target));
  } catch {
    return false;
  }
}

async function shownFor(key) {
  try {
    return (await self.registration.getNotifications()).filter(n => n.tag && notificationKey(n.tag) === key);
  } catch {
    return [];
  }
}

/** Only ever open this origin's /termag pages, whatever the payload says. */
function sameOriginUrl(raw) {
  try {
    const u = new URL(raw || '/termag/m', self.location.origin);
    if (u.origin === self.location.origin && u.pathname.startsWith('/termag/')) return u.href;
  } catch { /* bad URL */ }
  return new URL('/termag/m', self.location.origin).href;
}

// The open window routes itself (main.tsx + MobileApp): a message keeps the
// SPA's state instead of reloading it. Only with no window open does the
// worker open one. iOS and Safari's Mac web apps never call this handler for a
// live app (macOS 26, iOS 27; 2026-10-14/15): the page infers the tap instead.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = sameOriginUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    // Handled here, so the page must not infer it again.
    await safely(() => forget([event.notification.tag]));
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // A window of the same client (the simple UI for a chat, else the phone's).
    const area = new URL(url).pathname.startsWith('/termag/chat') ? '/termag/chat' : '/termag/m';
    const win = wins.find(w => new URL(w.url).pathname.startsWith(area)) || wins[0];
    if (win) {
      win.postMessage({ type: 'termag:navigate', url });
      return win.focus();
    }
    return self.clients.openWindow(url);
  })());
});

// ── The record of shown notifications (mobile/shownNotifications.ts reads it) ──

const DB_NAME = 'termag-push';
const STORE = 'shown';

async function safely(fn) {
  try { await fn(); } catch { /* storage unavailable: the page just can't infer taps */ }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'tag' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function write(change) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      change(tx.objectStore(STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function remember(record) {
  return write(store => store.put(record));
}

function forget(tags) {
  const list = tags.filter(Boolean);
  return list.length ? write(store => { for (const t of list) store.delete(t); }) : Promise.resolve();
}

/** Forget closed notifications that are really gone (iOS keeps them on screen). */
async function forgetClosed(tags) {
  const still = new Set((await self.registration.getNotifications()).map(n => n.tag));
  await forget(tags.filter(t => !still.has(t)));
}
