// The page's half of tap detection. iOS and Safari's Mac
// web apps never run `notificationclick` for an installed app that is still
// alive: a tap only brings it to the front (iOS 27, macOS 26; 2026-10-14/15).
// So the worker (public/sw.js) records every notification it shows, and when
// the app comes to the front the page looks for a recorded one that vanished.
// A swiped-away notification vanishes the same way; that is the accepted cost.
// The decisions are pure and tested; the IndexedDB access is thin.

/** `<session key>#<id>`: unique per push (public/sw.js). Must match sw.js. */
export const TAG_SEPARATOR = '#';

/** The session a notification is about: its tag without the per-push id. */
export function notificationKey(tag: string | undefined): string {
  if (!tag) return '';
  const i = tag.lastIndexOf(TAG_SEPARATOR);
  return i < 0 ? tag : tag.slice(0, i);
}

export interface ShownRecord {
  tag: string;
  url: string;
  at: number;
}

/** A record whose notification is still listed is dropped after this, to bound the store. */
export const RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The recorded notifications that are gone, and the gone one if exactly one
 * is. Two or more gone at once is a Clear All or a run of swipes, not a tap,
 * so nothing opens.
 */
export function vanished(
  records: readonly ShownRecord[],
  shownTags: ReadonlySet<string>,
  now: number,
): { hit: ShownRecord | null; forget: string[] } {
  const gone = records.filter(r => !shownTags.has(r.tag));
  const expired = records.filter(r => shownTags.has(r.tag) && now - r.at > RECORD_MAX_AGE_MS);
  return { hit: gone.length === 1 ? gone[0] : null, forget: [...gone, ...expired].map(r => r.tag) };
}

/**
 * Where taps are inferred: an installed web app on Apple's WebKit. Elsewhere
 * `notificationclick` works, and a swipe must not open anything.
 */
export function infersTaps(env: { vendor: string; standalone: boolean }): boolean {
  return env.standalone && env.vendor.startsWith('Apple');
}

// ── Storage (public/sw.js writes the same store) ──

const DB_NAME = 'termag-push';
const STORE = 'shown';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'tag' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readAll(): Promise<ShownRecord[]> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as ShownRecord[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Drop records (the page closed those notifications itself, or handled them). */
export async function forgetShown(tags: readonly string[]): Promise<void> {
  if (!tags.length || typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      for (const t of tags) tx.objectStore(STORE).delete(t);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Forget whatever vanished since the last look and, with `open`, return the
 * one tapped notification's record. Called with `open: false` as the app goes
 * to the background, so a notification that went while it was in front
 * (tapped there, or closed by syncAttention) can't open anything later.
 */
export async function takeVanished(reg: ServiceWorkerRegistration, open: boolean): Promise<ShownRecord | null> {
  if (typeof indexedDB === 'undefined') return null;
  const [records, shown] = await Promise.all([readAll(), reg.getNotifications()]);
  const result = vanished(records, new Set(shown.map(n => n.tag)), Date.now());
  await forgetShown(result.forget);
  return open ? result.hit : null;
}
