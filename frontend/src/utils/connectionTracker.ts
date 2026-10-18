// Module-level evidence collector for backend reachability. Lives outside
// React so the axios interceptor (services/api.ts) and the status socket
// (contexts/ProjectContext.tsx) can report without a hook; ConnectionProvider
// subscribes and derives the user-facing state from it (utils/connection.ts).

export interface TrackerSnapshot {
  /** Epoch ms of the last proof the server was reachable; null before first contact. */
  lastContactAt: number | null;
  /**
   * Epoch ms of the last frame on the status socket; null before the first one.
   * Separate from `lastContactAt` so HTTP evidence can never vouch for a socket.
   */
  lastSocketContactAt: number | null;
  /** Whether the status WebSocket currently reports itself open. */
  socketOpen: boolean;
  /** Network-level failures since the last successful contact. */
  consecutiveFailures: number;
}

/** Where a piece of reachability evidence came from. */
export type ContactSource = 'socket' | 'http';

type Listener = () => void;

export class ConnectionTracker {
  private snap: TrackerSnapshot = {
    lastContactAt: null,
    lastSocketContactAt: null,
    socketOpen: false,
    consecutiveFailures: 0,
  };
  private listeners = new Set<Listener>();
  private terminalReconnects = new Set<Listener>();
  /** Set by the status-socket owner so a stale socket can be force-closed. */
  closeSocket: (() => void) | null = null;
  /** Set by the status-socket owner: drop the current socket and open a new one now. */
  reconnectSocket: (() => void) | null = null;

  get snapshot(): TrackerSnapshot { return this.snap; }

  /** Any proof the server is reachable: WS message, HTTP response of any status, successful probe. */
  contact(source: ContactSource = 'http', at: number = Date.now()): void {
    this.snap = {
      ...this.snap,
      lastContactAt: at,
      lastSocketContactAt: source === 'socket' ? at : this.snap.lastSocketContactAt,
      consecutiveFailures: 0,
    };
    this.emit();
  }

  /** Reopen the status socket immediately, bypassing its reconnect delay. */
  reconnectNow(): void {
    this.reconnectSocket?.();
    // Terminal panes keep their own sockets and already skip a retry when they
    // still look `connected`. A frozen tab leaves those half-open too, so the
    // same kick has to reach them — otherwise the overlay clears and keystrokes
    // vanish into a dead PTY. Short alt-tabs never get here: the foreground
    // handler only calls reconnectNow when the status socket was already quiet.
    for (const fn of this.terminalReconnects) fn();
  }

  /** Each Terminal pane registers its retry so reconnectNow can reach it. */
  registerTerminalReconnect(fn: Listener): () => void {
    this.terminalReconnects.add(fn);
    return () => { this.terminalReconnects.delete(fn); };
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
