// Module-level evidence collector for backend reachability. Lives outside
// React so the axios interceptor (services/api.ts) and the status socket
// (contexts/ProjectContext.tsx) can report without a hook; ConnectionProvider
// subscribes and derives the user-facing state from it (utils/connection.ts).

export interface TrackerSnapshot {
  /** Epoch ms of the last proof the server was reachable; null before first contact. */
  lastContactAt: number | null;
  /** Whether the status WebSocket currently reports itself open. */
  socketOpen: boolean;
  /** Network-level failures since the last successful contact. */
  consecutiveFailures: number;
}

type Listener = () => void;

export class ConnectionTracker {
  private snap: TrackerSnapshot = { lastContactAt: null, socketOpen: false, consecutiveFailures: 0 };
  private listeners = new Set<Listener>();
  /** Set by the status-socket owner so a stale socket can be force-closed. */
  closeSocket: (() => void) | null = null;

  get snapshot(): TrackerSnapshot { return this.snap; }

  /** Any proof the server is reachable: WS message, HTTP response of any status, successful probe. */
  contact(at: number = Date.now()): void {
    this.snap = { ...this.snap, lastContactAt: at, consecutiveFailures: 0 };
    this.emit();
  }

  /** A network-level failure (no HTTP response at all). */
  failure(): void {
    this.snap = { ...this.snap, consecutiveFailures: this.snap.consecutiveFailures + 1 };
    this.emit();
  }

  setSocketOpen(open: boolean): void {
    if (this.snap.socketOpen === open) return;
    this.snap = { ...this.snap, socketOpen: open };
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const connectionTracker = new ConnectionTracker();
