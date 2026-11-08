/**
 * Review starts held while their project's box wakes ("A review target on a box that's
 * asleep"). Behind box-wake-on-action-enabled, POST /projects/:id/review on a project whose box is parked, from the
 * box's owner, wakes the box (the owner-only start path POST /instances/:id/start takes) and holds the start here.
 * The route answers 202 at once. A sweep reads each held start's box from the database, so it doesn't matter which
 * orchestrator process the box's agent connects to. Once the box is ready, the start runs as if just asked (its
 * `replay`), and its answer is the review's pane or, failed, why not and what to do, kept for the Review tab to read
 * (GET …/review/held) until it's replaced or expires.
 *
 * In memory, per process: a restart forgets a held start (the read then says nothing is held), and Review again
 * holds it anew. One start is held per workstream: a second Review there replaces the first.
 */

export type HeldState = 'waking' | 'starting' | 'failed';

/** The start route's answer, captured from a replay. */
export interface StartAnswer { status: number; body: unknown }

export interface HeldReview {
  projectId: string;
  workstream: string;
  instanceId: string;
  /** The box's name, for what the Review tab says while it waits ("Waking <box>…"). */
  box: string;
  pr: number;
  reviewer: string;
  since: number;
  state: HeldState;
  /** Failed: why, and what to do. */
  error?: string;
  /** Whether the box has been asked to start: one on its way down when held is asked once it's down. */
  woken: boolean;
  /**
   * Held after another start beat this one to the box. That start failing puts the box straight back to sleep, and
   * then this one wakes it. A box seen `stopping` meanwhile was stopped on purpose, which is left alone.
   */
  beaten?: boolean;
  /** Seen stopping or hibernating since it was held, not as the hibernation refresh's own stop. */
  stopSeen?: boolean;
  /**
   * Seen `refreshing`: the hibernation refresh woke the box, and its stop follows. The refresh clears
   * rehibernatePending as it asks for that stop, so the stop itself reads as a plain `stopping`, which isn't then
   * someone stopping the box.
   */
  refreshSeen?: boolean;
}

export interface HoldRequest extends Omit<HeldReview, 'since' | 'state' | 'error'> {
  /** Runs the start again, as it was asked. */
  replay: () => Promise<StartAnswer>;
  /** Asks the box to start (the owner-only start path); a status of 300 or more is its refusal. */
  wake: () => Promise<StartAnswer>;
}

export interface HeldDeps {
  /**
   * The box's status now, from the database; null when it's gone. `refreshing`: the hibernation refresh woke it and
   * is putting it back down (routes/review.ts boxStatusOf), which a held start waits out, then wakes it.
   */
  boxStatus: (instanceId: string) => Promise<string | null>;
  now: () => number;
}

/**
 * The start route's refusal before anything has run on the box (routes/review.ts): a ready box whose agent hasn't
 * reconnected yet. The only answer a replay tries again. Any other failure may come after the pane was made and
 * the reviewer launched, and running the start again would replace that live review.
 */
export const AGENT_OFFLINE = "Owner's agent is offline";

/** How long a held start waits for its box to be ready, its agent included. */
export const WAKE_WAIT_MS = 15 * 60_000;
/** How long a failed start's reason stays readable. */
export const FAILED_KEEP_MS = 30 * 60_000;
const ASLEEP = new Set(['stopped', 'hibernated']);
/** On its way up: a wake refused by it was beaten to it (another start), not refused. */
const COMING_UP = new Set(['starting', 'provisioning', 'awaiting-agent', 'ready', 'refreshing']);
const GONE = new Set(['failed', 'terminated', 'quarantined']);

function errorOf(body: unknown, fallback: string): string {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' && e ? e : fallback;
}

const what = (box: string) => `Start ${box} from your boxes, then Review again.`;
const STOPPING = new Set(['stopping', 'hibernating']);

export class HeldReviewStarts {
  private readonly held = new Map<string, HeldReview & { replay: HoldRequest['replay']; wake: HoldRequest['wake'] }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private readonly deps: HeldDeps, private readonly pollMs = 3_000) {}

  private static key(projectId: string, workstream: string) { return `${projectId}|${workstream}`; }

  /** Holds a start (replacing one already held for the workstream) and keeps the sweep running while any is held. */
  hold(req: HoldRequest): HeldReview {
    const entry = { ...req, since: this.deps.now(), state: 'waking' as HeldState };
    this.held.set(HeldReviewStarts.key(req.projectId, req.workstream), entry);
    if (!this.timer && this.pollMs > 0) {
      this.timer = setInterval(() => { void this.sweep(); }, this.pollMs);
      this.timer.unref?.();
    }
    return this.view(entry);
  }

  /** The start held for a workstream, or null. */
  get(projectId: string, workstream: string): HeldReview | null {
    const h = this.held.get(HeldReviewStarts.key(projectId, workstream));
    return h ? this.view(h) : null;
  }

  private view(h: HeldReview): HeldReview {
    const { projectId, workstream, instanceId, box, pr, reviewer, since, state, error, woken, beaten } = h;
    return { projectId, workstream, instanceId, box, pr, reviewer, since, state, ...(error ? { error } : {}), woken, ...(beaten ? { beaten } : {}) };
  }

  /** Kept, failed, for FAILED_KEEP_MS from now: its reason is what the Review tab shows. */
  private fail(h: HeldReview, error: string) {
    h.state = 'failed';
    h.error = error;
    h.since = this.deps.now();
  }

  /** One pass over the held starts: each whose box is ready runs; one whose box won't come up fails, saying what to do. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const [key, h] of [...this.held]) {
        const now = this.deps.now();
        if (h.state === 'failed') {
          if (now - h.since > FAILED_KEEP_MS) this.held.delete(key);
          continue;
        }
        const status = await this.deps.boxStatus(h.instanceId).catch(() => 'unknown');
        // Replaced while the status was read.
        if (this.held.get(key) !== h) continue;
        if (status === null || GONE.has(status)) {
          this.fail(h, `${h.box} ${status === null ? 'is gone' : `is ${status}`}: start a New session on the PR's repository, then Review again.`);
          continue;
        }
        if (status === 'refreshing') h.refreshSeen = true;
        else if (STOPPING.has(status) && !h.refreshSeen) h.stopSeen = true;
        // A box another start was waking, stopped since (not that start failing): someone stopped it; left asleep.
        if (ASLEEP.has(status) && !h.woken && h.beaten && h.stopSeen) {
          this.fail(h, `${h.box} was stopped while it was starting, so the review didn't start. ${what(h.box)}`);
          continue;
        }
        if (ASLEEP.has(status) && !h.woken) {
          const asked = await h.wake().catch(err => ({ status: 500, body: { error: (err as Error).message } }));
          // Woken by this start; or beaten to it by another, which leaves `woken` unset, so a box that goes back to
          // sleep (that start failed) is woken again on a later pass, until WAKE_WAIT_MS.
          h.woken = asked.status < 300;
          const after = h.woken ? null : await this.deps.boxStatus(h.instanceId).catch(() => null);
          const beaten = !h.woken && COMING_UP.has(after ?? '');
          if (beaten) { h.beaten = true; h.stopSeen = false; h.refreshSeen = after === 'refreshing'; }
          if (!h.woken && !beaten) this.fail(h, `Couldn't wake ${h.box}: ${errorOf(asked.body, 'the start was refused').replace(/\.$/, '')}. ${what(h.box)}`);
          continue;
        }
        if (status === 'ready') {
          h.state = 'starting';
          const answer = await h.replay().catch(err => ({ status: 500, body: { error: (err as Error).message } }));
          // Replaced meanwhile (another Review, or the replay found the box parked again and held it anew).
          if (this.held.get(key) !== h) continue;
          if (answer.status < 300) { this.held.delete(key); continue; }
          // Ready, but its agent hasn't reconnected yet (refused before anything ran): tried again on the next pass.
          if (answer.status === 503 && errorOf(answer.body, '') === AGENT_OFFLINE && now - h.since < WAKE_WAIT_MS) { h.state = 'waking'; continue; }
          this.fail(h, errorOf(answer.body, 'The review could not start'));
          continue;
        }
        if (now - h.since > WAKE_WAIT_MS) this.fail(h, `${h.box} took too long to wake. ${what(h.box)}`);
      }
    } finally {
      this.sweeping = false;
      if (this.timer && this.held.size === 0) { clearInterval(this.timer); this.timer = null; }
    }
  }

  /** Tests: forget everything and stop the sweep. */
  reset(): void {
    this.held.clear();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
