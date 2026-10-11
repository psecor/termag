import type { CloudSession } from '../types';

/**
 * The signed-in user's active Claude Code cloud sessions, as one external
 * store for the sidebar, the box list and the mobile inbox. Polled every
 * 30 s while running (the backend does one tmux-list per box behind it), and
 * reloaded at once when the status WebSocket says a session changed
 * ({type: 'claude-session'}, pushed on every event the backend records).
 */
export class CloudSessionFeed {
  private sessions: CloudSession[] = [];
  private loaded = false;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly fetchSessions: () => Promise<CloudSession[]>,
    private readonly pollMs = 30_000,
  ) {}

  getSnapshot = (): CloudSession[] => this.sessions;
  /** False until the first successful load, so the UI can tell "none" from "not yet". */
  hasLoaded = (): boolean => this.loaded;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.reload();
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Fetch now; concurrent calls share one request. The poll timer restarts after it. */
  reload = (): Promise<void> => {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const next = await this.fetchSessions();
        this.sessions = next;
        this.loaded = true;
        for (const fn of this.listeners) fn();
      } catch { /* keep the last list; the next poll or push retries */ }
      finally {
        this.inflight = null;
        this.schedule();
      }
    })();
    return this.inflight;
  };

  private schedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.running) return;
    this.timer = setTimeout(() => { this.timer = null; void this.reload(); }, this.pollMs);
  }
}
