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
 * reports). A cold box never has an on-claim status, so it never polls for one.
 */
export function boxIsSettling(b: Instance): boolean {
  return TRANSITIONAL_BOX_STATUSES.includes(b.status)
    || b.onClaimStatus === 'pending'
    || b.onClaimStatus === 'running';
}

export class BoxFeed {
  private boxes: Instance[] = [];
  private loaded = false;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private started = 0;
  private settledGen = 0;
  private askedAt = new Map<string, number>();

  constructor(
    private readonly fetchBoxes: () => Promise<Instance[]>,
    private readonly bus: BoxStatusBus,
    private readonly pollMs = 5000,
  ) {}

  getSnapshot = (): Instance[] => this.boxes;
  /** False until the first successful load: an empty list before that means "not yet", not "no boxes". */
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

  reload = async (): Promise<void> => {
    const gen = ++this.started;
    try {
      const boxes = await this.fetchBoxes();
      // A slower, older fetch must not replace a newer list.
      if (gen < this.settledGen) return;
      this.boxes = boxes;
      this.settledGen = gen;
      this.loaded = true;
      this.bus.publish(this.boxes);
      for (const fn of this.listeners) fn();
    } catch { /* keep the last list; the next poll or action retries */ }
    this.schedule();
  };

  private schedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.running || !(this.boxes.some(boxIsSettling) || this.awaitsLookup())) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, this.pollMs);
  }
}
