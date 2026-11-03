import type { Instance } from '../types';
import { TRANSITIONAL_BOX_STATUSES } from './boxPower';
import type { BoxStatusBus } from './boxStatusBus';

/**
 * The signed-in user's box list, polled while any box is in transition and
 * published to the box status bus. App owns its lifetime rather than the box
 * list, because the list unmounts with the sidebar while terminal panes parked
 * on a stopping or stopped box still wait on the bus for the next status.
 */
/**
 * A box whose list entry is still changing on its own: going up or down, or
 * applying claim-time dotfiles (the "personalizing" badge clears when the run
 * reports). A box launched for its owner has an on-claim status only under
 * onboarding-refresh-enabled (backend services/newBoxDotfiles.ts).
 */
/**
 * How long after `claimUpdateStartedAt` an `updating` box is still updating
 * (backend services/boxUpdatePolicy.ts CLAIM_UPDATE_POLICY_MS: the claim's
 * 150 s bound and some). Past it the orchestrator that ran it has stopped, and
 * its sweep marks the row timed-out; nothing waits on it meanwhile.
 */
export const CLAIM_UPDATE_LIVE_MS = 210_000;

/** A box just claimed from the pool is updating before its first launch (backend services/claimUpdate.ts). */
export function claimUpdateLive(b: Pick<Instance, 'claimUpdateStatus' | 'claimUpdateStartedAt'> | null | undefined, now: number = Date.now()): boolean {
  if (b?.claimUpdateStatus !== 'updating' || !b.claimUpdateStartedAt) return false;
  return now - new Date(b.claimUpdateStartedAt).getTime() < CLAIM_UPDATE_LIVE_MS;
}

export function boxIsSettling(b: Instance): boolean {
  return TRANSITIONAL_BOX_STATUSES.includes(b.status)
    || b.onClaimStatus === 'pending'
    || b.onClaimStatus === 'running'
    || claimUpdateLive(b);
}

export class BoxFeed {
  private boxes: Instance[] = [];
  private loaded = false;
  private failing = false;
  private settledAt = 0;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private started = 0;
  private settledGen = 0;
  /** The last fetch begun before the last start(): a list from it or earlier is kept, but it is not current. */
  private stoppedAtGen = 0;
  private askedAt = new Map<string, number>();

  constructor(
    private readonly fetchBoxes: () => Promise<Instance[]>,
    private readonly bus: BoxStatusBus,
    private readonly pollMs = 5000,
  ) {}

  getSnapshot = (): Instance[] => this.boxes;
  /** False until the first successful load: an empty list before that means "not yet", not "no boxes". */
  hasLoaded = (): boolean => this.loaded;

  /**
   * True while the latest fetch failed: the list is the last good one and may
   * be out of date (a box started since is missing or shows its old status).
   * Cleared by the next fetch that answers.
   */
  isFailing = (): boolean => this.failing;
  /**
   * True once a list fetched since the last start() has come back. stop() keeps
   * the old list for panes still reading it, but a box can park while the
   * feed is stopped (the workspace unmounted for the dashboard or settings),
   * so a decision about the box's state now must wait for this.
   */
  isFresh = (): boolean => this.running && this.settledGen > this.stoppedAtGen;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    // Set here, not in stop(): a reload begun while the feed was stopped (a
    // clone retry, a start's follow-up reload) fetched a list from before the
    // return, and must not count as current either.
    this.stoppedAtGen = this.started;
    // A failure from before the stop (another user, a lapsed session) says
    // nothing about the list this start fetches.
    this.failing = false;
    void this.reload();
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /**
   * Put one box into the list now, ahead of the next reload: a box claimed
   * from the warm pool comes back `ready` in the create response, and waiting
   * for a reload would hide exactly the speed the claim is for.
   */
  upsert = (instance: Instance): void => {
    this.boxes = [instance, ...this.boxes.filter(b => b.id !== instance.id)];
    this.bus.publish(this.boxes);
    for (const fn of this.listeners) fn();
    this.schedule();
  };

  /**
   * A box id the list lacks, say one a project was just moved onto: reload,
   * and let only a list fetched from now on say the box is gone.
   */
  lookFor = (id: string): void => {
    if (this.askedAt.has(id) || this.boxes.some(b => b.id === id)) return;
    this.askedAt.set(id, this.started + 1);
    void this.reload();
  };

  /** True once a list fetched after lookFor(id) still lacks the box. */
  isGone = (id: string): boolean => {
    const asked = this.askedAt.get(id);
    return asked !== undefined && this.settledGen >= asked && !this.boxes.some(b => b.id === id);
  };

  /** A lookFor no list has answered yet, because its fetch failed or is still out. */
  private awaitsLookup(): boolean {
    for (const asked of this.askedAt.values()) if (asked > this.settledGen) return true;
    return false;
  }

  /**
   * Reload unless a list landed within maxAgeMs: for a tab coming back into
   * view, where a quick switch away and back needs no fetch. A failing feed
   * always reloads.
   */
  reloadIfOlderThan = (maxAgeMs: number): Promise<void> => {
    if (!this.failing && this.loaded && Date.now() - this.settledAt < maxAgeMs) return Promise.resolve();
    return this.reload();
  };

  reload = async (): Promise<void> => {
    const gen = ++this.started;
    try {
      const boxes = await this.fetchBoxes();
      // A slower, older fetch must not replace a newer list.
      if (gen < this.settledGen) return;
      this.boxes = boxes;
      this.settledGen = gen;
      this.settledAt = Date.now();
      this.loaded = true;
      this.failing = false;
      this.bus.publish(this.boxes);
      for (const fn of this.listeners) fn();
    } catch {
      // Keep the last list; the next poll or action retries. Say so, or a
      // form reading it offers boxes as they were.
      if (gen >= this.settledGen && !this.failing) {
        this.failing = true;
        for (const fn of this.listeners) fn();
      }
    }
    this.schedule();
  };

  private schedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // A feed with no fresh list yet (the fetch after start() failed) keeps
    // trying, or a settled list would never become current again.
    if (!this.running || !(this.boxes.some(boxIsSettling) || this.awaitsLookup() || !this.isFresh())) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, this.pollMs);
  }
}
