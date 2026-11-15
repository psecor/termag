/**
 * The person's pinned sessions, from the server: the
 * chat sidebar's Pinned section, the same on every browser, the phone and the
 * desktop app. Behind user-projects-enabled. No UI here: the sidebar reads
 * `useSessionPins()`.
 *
 * One store per page, shared by every component that reads it, so a pin made
 * from a card's hover, its ⋯ menu or the `p` key shows everywhere at once. It
 * reads GET /api/session-pins when the first reader mounts, again on each
 * `pins` push (a pin or unpin in another tab) and each `projects` push (an
 * archive, reopen, rename or share change moves what is listed), and drops
 * what it read when the last reader unmounts.
 *
 * pin() and unpin() change the list at once, then write. Writes to one session
 * go out one after another, so the server ends where the last click left it,
 * and a read that lands (or fails) while any write is out is dropped and read
 * again once they're done, so it can't undo a click. A write that fails undoes
 * its click and reads the list again, which puts the session where the server
 * has it.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { FLAGS, useFlag } from '../flags';
import { sessionPinsApi, type SessionPin } from '../services/api';
import { PINS_PUSH_EVENT, PROJECTS_PUSH_EVENT } from '../utils/workspacePush';

export type { SessionPin };

/** What pin() needs of a sidebar row (ChatSessionRow / InboxRow carry all three). */
export interface PinnableSession {
  workstreamId: string;
  projectId: string;
  workstream: string;
}

export interface SessionPinsApi {
  list(): Promise<SessionPin[]>;
  pin(workstreamId: string): Promise<SessionPin>;
  unpin(workstreamId: string): Promise<void>;
}

export interface SessionPinsSnapshot {
  /** Pins on live sessions the person can see, oldest first; null until the first read answers, and while pins are off. */
  pins: readonly SessionPin[] | null;
  /** The first read has answered or failed, or the server said pins are off. */
  settled: boolean;
  /** The latest read failed: `pins` is the last good list (or null). */
  failed: boolean;
  /** The server answered session_pins_disabled: user-projects-enabled is off for this person there. */
  offOnServer: boolean;
}

export const SESSION_PINS_DISABLED = 'session_pins_disabled';

const INITIAL: SessionPinsSnapshot = { pins: null, settled: false, failed: false, offOnServer: false };

const errorCode = (err: unknown): string | undefined =>
  (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code as string | undefined;

/** Framework-free so it can be tested in node; `events` is window in the page. */
export class SessionPinsStore {
  private snapshot: SessionPinsSnapshot = INITIAL;
  private ids: ReadonlySet<string> = new Set();
  private listeners = new Set<() => void>();
  private readers = 0;
  private readGen = 0;
  /** Writes sent and not yet answered, and whether a read was dropped (or a write failed) meanwhile. */
  private writing = 0;
  private stale = false;
  /** Reads sent and not yet answered. */
  private readsOut = 0;
  private opSeq = 0;
  /** Per session, the newest write's seq: an older write's answer doesn't touch the list. */
  private latest = new Map<string, number>();
  /** Per session, the tail of its chain of writes. */
  private chains = new Map<string, Promise<unknown>>();
  /** Per session, writes not yet answered. */
  private pendingFor = new Map<string, number>();
  /**
   * Per session with writes out, its pin as the server last had it (null:
   * none): as listed before the first of them, then each one's answer. What a
   * failed click goes back to, never a row an unanswered click put there.
   */
  private confirmed = new Map<string, SessionPin | null>();

  constructor(private readonly api: SessionPinsApi, private readonly events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>) {}

  getSnapshot = (): SessionPinsSnapshot => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  isPinned = (workstreamId: string | null | undefined): boolean => Boolean(workstreamId) && this.ids.has(workstreamId!);

  /** A reader mounted: the first one reads the list and listens for pushes. Returns its release. */
  acquire = (): (() => void) => {
    if (this.readers++ === 0) {
      this.events.addEventListener(PINS_PUSH_EVENT, this.onPush);
      this.events.addEventListener(PROJECTS_PUSH_EVENT, this.onPush);
      void this.reload();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.readers > 0) return;
      this.events.removeEventListener(PINS_PUSH_EVENT, this.onPush);
      this.events.removeEventListener(PROJECTS_PUSH_EVENT, this.onPush);
      // Nobody reads it now: the next reader starts from a fresh read, and answers still out are dropped.
      this.readGen += 1;
      this.set(INITIAL);
    };
  };

  private onPush = (): void => { void this.reload(); };

  reload = async (): Promise<void> => {
    if (this.readers === 0) return;
    if (this.writing > 0) { this.stale = true; return; }
    const gen = ++this.readGen;
    this.readsOut += 1;
    try {
      const pins = await this.api.list();
      if (gen !== this.readGen) return;
      // A click since this read went out: its answer may not have it.
      if (this.writing > 0) { this.stale = true; return; }
      this.set({ pins: Array.isArray(pins) ? pins : [], settled: true, failed: false, offOnServer: false });
    } catch (err) {
      if (gen !== this.readGen) return;
      if (errorCode(err) === SESSION_PINS_DISABLED) { this.set({ pins: null, settled: true, failed: false, offOnServer: true }); return; }
      // Like an answer, a failure during a write is read again once the writes are done.
      if (this.writing > 0) { this.stale = true; return; }
      this.set({ ...this.snapshot, settled: true, failed: true });
    } finally {
      this.readsOut -= 1;
    }
  };

  /** Pins it now and writes it; false when the write failed (the click is undone and the list read again). */
  pin = (session: PinnableSession): Promise<boolean> => {
    if (this.readers === 0 || this.snapshot.offOnServer) return Promise.resolve(false);
    const { workstreamId } = session;
    this.noteConfirmed(workstreamId);
    if (!this.isPinned(workstreamId)) this.put(workstreamId, { ...session, pinnedAt: new Date().toISOString() });
    return this.write(workstreamId, () => this.api.pin(workstreamId));
  };

  /** Unpins it now and writes it; false when the write failed (the click is undone and the list read again). */
  unpin = (workstreamId: string): Promise<boolean> => {
    if (this.readers === 0 || this.snapshot.offOnServer) return Promise.resolve(false);
    this.noteConfirmed(workstreamId);
    this.put(workstreamId, null);
    return this.write(workstreamId, async () => { await this.api.unpin(workstreamId); return null; });
  };

  /** Before a session's first write that's out: its pin as listed now, which no write has touched yet. */
  private noteConfirmed(workstreamId: string): void {
    if (!this.confirmed.has(workstreamId)) this.confirmed.set(workstreamId, this.snapshot.pins?.find(p => p.workstreamId === workstreamId) ?? null);
  }

  /** Shows the session pinned as `pin`, in its place by when it was pinned (as the server orders them), or not pinned for null. */
  private put(workstreamId: string, pin: SessionPin | null): void {
    const now = this.snapshot.pins ?? [];
    const rest = now.filter(p => p.workstreamId !== workstreamId);
    if (!pin) {
      if (rest.length !== now.length) this.set({ ...this.snapshot, pins: rest });
      return;
    }
    const next = [...rest, pin].sort((a, b) => a.pinnedAt.localeCompare(b.pinnedAt) || (a.workstreamId < b.workstreamId ? -1 : a.workstreamId > b.workstreamId ? 1 : 0));
    this.set({ ...this.snapshot, pins: next });
  }

  /**
   * Sends one write after the session's earlier ones; `send` answers the pin
   * the server now has (null: none). Each answer becomes the session's
   * confirmed pin. Only the newest write's outcome touches the list: its
   * answer, or on a failure the confirmed pin (what the server had before
   * the first of these writes, or an earlier one's answer), so a failed click
   * is undone at once in case the re-read fails too.
   */
  private write(workstreamId: string, send: () => Promise<SessionPin | null>): Promise<boolean> {
    const seq = ++this.opSeq;
    this.latest.set(workstreamId, seq);
    this.pendingFor.set(workstreamId, (this.pendingFor.get(workstreamId) ?? 0) + 1);
    this.writing += 1;
    // A read already out may answer after this write finishes, without it: drop it, and read once the writes are done.
    if (this.readsOut > 0) { this.readGen += 1; this.stale = true; }
    const newest = () => this.latest.get(workstreamId) === seq && this.readers > 0;
    const run = async (): Promise<boolean> => {
      try {
        const answer = await send();
        this.confirmed.set(workstreamId, answer);
        if (newest()) this.put(workstreamId, answer);
        return true;
      } catch {
        if (newest()) this.put(workstreamId, this.confirmed.get(workstreamId) ?? null);
        this.stale = true;
        return false;
      } finally {
        if (this.latest.get(workstreamId) === seq) this.latest.delete(workstreamId);
        const left = (this.pendingFor.get(workstreamId) ?? 1) - 1;
        if (left > 0) this.pendingFor.set(workstreamId, left);
        else { this.pendingFor.delete(workstreamId); this.confirmed.delete(workstreamId); }
        this.writing -= 1;
        if (this.writing === 0 && this.stale) { this.stale = false; void this.reload(); }
      }
    };
    const done = (this.chains.get(workstreamId) ?? Promise.resolve()).then(run);
    this.chains.set(workstreamId, done);
    void done.then(() => { if (this.chains.get(workstreamId) === done) this.chains.delete(workstreamId); });
    return done;
  }

  private set(next: SessionPinsSnapshot): void {
    this.snapshot = next;
    this.ids = new Set((next.pins ?? []).map(p => p.workstreamId));
    for (const fn of this.listeners) fn();
  }
}

const NO_EVENTS = { addEventListener: () => {}, removeEventListener: () => {} };

/** The page's one store. */
export const sessionPinsStore = new SessionPinsStore(sessionPinsApi, typeof window === 'undefined' ? NO_EVENTS : window);

export interface SessionPins extends SessionPinsSnapshot {
  /** Pins are on: user-projects-enabled in the browser, signed in, and the server didn't say it's off. */
  enabled: boolean;
  isPinned(workstreamId: string | null | undefined): boolean;
  pin(session: PinnableSession): Promise<boolean>;
  unpin(workstreamId: string): Promise<boolean>;
  reload(): Promise<void>;
}

const OFF: SessionPins = {
  ...INITIAL, settled: true, enabled: false,
  isPinned: () => false, pin: async () => false, unpin: async () => false, reload: async () => {},
};

/**
 * The person's pinned sessions, live. While pins are off (the flag, or signed
 * out) it reads nothing: `enabled` false, `pins` null, and pin/unpin do
 * nothing and answer false.
 */
export function useSessionPins(store: SessionPinsStore = sessionPinsStore): SessionPins {
  const { user } = useAuth();
  const on = useFlag(FLAGS.userProjects, false) && Boolean(user);
  useEffect(() => (on ? store.acquire() : undefined), [on, store]);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return useMemo(() => (on
    ? { ...snap, enabled: !snap.offOnServer, isPinned: store.isPinned, pin: store.pin, unpin: store.unpin, reload: store.reload }
    : OFF), [on, snap, store]);
}
