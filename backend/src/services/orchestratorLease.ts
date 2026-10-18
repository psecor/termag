/**
 * Which orchestrator process runs the singleton work, so a blue/green deploy
 * can run two processes side by side.
 *
 * One row in `orchestrator_leases`. A process started with
 * ORCHESTRATOR_LEASE=true claims it on start, and the newest process wins: a
 * deploy's green process displaces blue without being told about it, and a
 * claim that lands late never takes it from a process that started later. The
 * holder heartbeats; a heartbeat that finds another holder means this process
 * was displaced and drains. A draining process takes the lease back once the
 * holder has been silent for `staleMs`, so blue resumes if green dies.
 *
 * Opt-in because a second backend on the same database (the orchestrator's
 * read-only mirror) must never displace the real one.
 */
import { hostname } from 'os';
import { randomUUID } from 'crypto';

export const LEASE_ID = 'orchestrator';

export type LeaseRole = 'serving' | 'draining';

/**
 * `claimedAt` on the row is the holder process's start time, whenever it
 * actually wrote the row, so "newest wins" compares process ages even when a
 * claim landed late. `now` is the heartbeat time.
 */
export interface LeaseStore {
  /** Take the lease unconditionally. */
  claim(holderId: string, label: string, now: Date, startedAt: Date): Promise<void>;
  /** Extend it; false when another process holds it now. */
  heartbeat(holderId: string, now: Date): Promise<boolean>;
  /** Take it only if its holder last beat before `staleBefore` (or nobody holds it). */
  reclaimIfStale(holderId: string, label: string, now: Date, staleBefore: Date, startedAt: Date): Promise<boolean>;
  /**
   * Take it only if its holder claimed it before `startedAt` (or nobody holds
   * it): the claim a process makes on start, retried after a failed one, so a
   * process that started later keeps it.
   */
  claimIfOlder(holderId: string, label: string, now: Date, startedAt: Date): Promise<boolean>;
}

export interface LeaseConfig {
  heartbeatMs: number;
  staleMs: number;
  /** How long a displaced process keeps its connections before closing its agents' (the load balancer's unhealthy window). */
  drainGraceMs: number;
  /** How long after the agents it closes the browsers', so they reconnect to a process that has their boxes. */
  drainBrowserDelayMs: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Null unless ORCHESTRATOR_LEASE=true: then the process always serves, as before. */
export function leaseConfigFromEnv(env: NodeJS.ProcessEnv): LeaseConfig | null {
  if (env.ORCHESTRATOR_LEASE !== 'true') return null;
  const heartbeatMs = positiveInt(env.ORCHESTRATOR_LEASE_HEARTBEAT_MS, 5_000);
  return {
    heartbeatMs,
    staleMs: Math.max(positiveInt(env.ORCHESTRATOR_LEASE_STALE_MS, 30_000), heartbeatMs * 3),
    // The ALB marks a target unhealthy after unhealthy_threshold x interval;
    // until then it still sends this process new requests.
    drainGraceMs: positiveInt(env.ORCHESTRATOR_DRAIN_GRACE_MS, 45_000),
    // Agents redial within about a second of a drain close (agent-dial.js).
    drainBrowserDelayMs: positiveInt(env.ORCHESTRATOR_DRAIN_BROWSER_DELAY_MS, 1_500),
  };
}

export function newHolder(): { holderId: string; label: string } {
  return { holderId: randomUUID(), label: `${hostname()} pid ${process.pid}` };
}

export interface LeaseOptions {
  store: LeaseStore;
  holderId: string;
  label: string;
  config: LeaseConfig;
  onServe: () => void;
  onDrain: () => void;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class OrchestratorLease {
  private role: LeaseRole = 'draining';
  /** False after a failed claim on start, until a retry lands. */
  private claimed = false;
  private startedAt = new Date(0);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: LeaseOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (msg => console.log(`[LEASE] ${msg}`));
  }

  get currentRole(): LeaseRole {
    return this.role;
  }

  /**
   * Claims the lease and starts serving. A database that can't be reached
   * still serves: refusing to start would turn a database blip into an outage
   * on the only orchestrator there is, and the heartbeat sorts it out later.
   */
  async start(): Promise<void> {
    this.startedAt = this.now();
    let held = true;
    try {
      // Not an unconditional write: a claim that lands late must not take
      // the lease from a process that started after this one and already
      // holds it.
      held = await this.opts.store.claimIfOlder(this.opts.holderId, this.opts.label, this.startedAt, this.startedAt);
      this.claimed = held;
      this.log(held ? `claimed by ${this.opts.label}` : 'a newer orchestrator already holds the lease; draining');
    } catch (err) {
      this.log(`claim failed, serving anyway: ${(err as Error).message}`);
    }
    // Starts in `draining`, so a refused claim never serves and never runs
    // the sweeps; the tick takes the lease back if that holder goes silent.
    if (held) this.become('serving');
    this.timer = setInterval(() => { void this.tick(); }, this.opts.config.heartbeatMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (this.role === 'serving') {
        // A failed heartbeat (the database is down) is not a lost lease. Nor is
        // a row this process never managed to write: it retries the claim it
        // makes on start, which only a process that started later can refuse.
        const held = await (this.claimed
          ? this.opts.store.heartbeat(this.opts.holderId, now)
          : this.opts.store.claimIfOlder(this.opts.holderId, this.opts.label, now, this.startedAt)
        ).catch((err: Error) => {
          this.log(`${this.claimed ? 'heartbeat' : 'claim'} failed: ${err.message}`);
          return null;
        });
        if (held === null) return;
        if (held && !this.claimed) {
          this.claimed = true;
          this.log(`claimed by ${this.opts.label} after a failed first try`);
        }
        if (!held) {
          this.log('displaced by a newer orchestrator; draining');
          this.become('draining');
        }
      } else {
        // Draining, either displaced by a newer process or refused on start.
        // Newest wins here too: take the lease from a holder that started
        // before this process (an older process that won a claim race), or
        // from one that has gone silent.
        const staleBefore = new Date(now.getTime() - this.opts.config.staleMs);
        const taken = await this.opts.store.claimIfOlder(this.opts.holderId, this.opts.label, now, this.startedAt)
          .then(ok => ok || this.opts.store.reclaimIfStale(this.opts.holderId, this.opts.label, now, staleBefore, this.startedAt))
          .catch(() => false);
        if (taken) {
          this.claimed = true;
          this.log(`the holder went silent for ${this.opts.config.staleMs / 1000}s; ${this.opts.label} serves again`);
          this.become('serving');
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private become(role: LeaseRole): void {
    if (this.role === role) return;
    this.role = role;
    if (role === 'serving') this.opts.onServe();
    else this.opts.onDrain();
  }
}
