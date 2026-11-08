/**
 * The leader's budget for starting Slack streams. chat.startStream is Tier 2, about 20 a minute for the
 * whole workspace, so a reply streams only while there is budget; otherwise
 * AgentReplyStream (session/stream.ts) keeps "Working…" up and posts the
 * answer whole with chat.postMessage when it is done. A rate-limited start
 * pauses the budget for its Retry-After.
 *
 * Process-local, like agentRuns: only the process holding the Slack
 * connection (the lease holder) starts streams.
 */

const WINDOW_MS = 60_000;

/** `streamStartsPerMinute`'s default (tech spec §10); SLACK_STREAM_STARTS_PER_MINUTE overrides it. */
export const STREAM_STARTS_PER_MINUTE = Math.max(1, parseInt(process.env.SLACK_STREAM_STARTS_PER_MINUTE ?? '', 10) || 18);

/**
 * What a stream asks before each chat.startStream. `enforcing`: a refused
 * start makes the reply go out whole; otherwise the gate only counts.
 */
export interface StreamGate {
  readonly enforcing: boolean;
  take(): boolean;
  pause(seconds: number): void;
}

export class StreamBudget implements StreamGate {
  readonly enforcing = true;
  private starts: number[] = [];
  private pausedUntil = 0;

  constructor(readonly perMinute: number = STREAM_STARTS_PER_MINUTE, private now: () => number = Date.now) {}

  /** Takes one start if the last minute leaves room for it (and no Retry-After is pending). */
  take(): boolean {
    const t = this.now();
    if (t < this.pausedUntil) return false;
    this.starts = this.starts.filter(s => t - s < WINDOW_MS);
    if (this.starts.length >= this.perMinute) return false;
    this.starts.push(t);
    return true;
  }

  /** Counts a start that is not refused (an operator's): it still uses the workspace's budget. */
  record(): void {
    const t = this.now();
    this.starts = this.starts.filter(s => t - s < WINDOW_MS);
    this.starts.push(t);
  }

  /** No starts for `seconds` (Slack's Retry-After). */
  pause(seconds: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + seconds * 1000);
  }
}

/** The one budget every agent turn's stream shares (runTurn). */
export const streamBudget = new StreamBudget();

/**
 * A gate that never refuses: an operator's turn streams as it always has (#555),
 * while its starts and any Retry-After still count against `budget`, so space
 * and router turns, which enforce it, back off.
 */
export function countingGate(budget: StreamBudget): StreamGate {
  return { enforcing: false, take: () => { budget.record(); return true; }, pause: (s) => budget.pause(s) };
}

/**
 * How long Slack asked us to wait, when `err` is a rate limit: the web API's
 * rate-limited error (its `retryAfter`) or a `ratelimited` method error. Null
 * for any other error.
 */
export function retryAfterSeconds(err: unknown): number | null {
  const e = err as { code?: string; retryAfter?: number; data?: { error?: string } } | null;
  if (e?.code === 'slack_webapi_rate_limited_error') return typeof e.retryAfter === 'number' ? e.retryAfter : 60;
  if (e?.data?.error === 'ratelimited') return 60;
  return null;
}
