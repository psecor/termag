import type { Instance, InstanceStatus } from '../types';
import type { BoxStatusBus } from './boxStatusBus';
import { canStartBox } from './boxPower';

// Opening a project or workstream whose box is stopped or hibernated starts
// the box, in the workspace, the simple UI and
// the phone client alike. It is the box menu's Start, fired by the open:
// the same POST /api/instances/:id/start, so the route's owner check and its
// power rules stand. A box the caller does not own is not in their box list
// and is never asked; a start the route refuses is not retried until the
// box's status changes, and the project shows the parked state it always did.

type StartableBox = Pick<Instance, 'id' | 'kind' | 'status' | 'ec2InstanceId'>;

export type SelectStartDecision =
  /** Send the start. */
  | 'start'
  /** No box in the caller's list: a local project, or someone else's box. */
  | 'no-box'
  /** Not stopped or hibernated (ready, starting, stopping, hibernating, …), or not an EC2 box. */
  | 'not-parked'
  /** A start for this box is already out, from another open of one of its projects. */
  | 'in-flight'
  /** The route refused a start for this box in this status; wait for the status to change. */
  | 'refused'
  /** The start did not reach a decision (network, 502, a proxy's 503, no answer in time); a later open may try again. */
  | 'failed';

/**
 * Whether a failed start is the route's answer, held until the box's status
 * changes, or something a later open may retry. A 4xx is the route deciding:
 * 403/404 not this caller's to power, 400/409 not startable from here. The
 * route's one 503, "provisioning is not configured" (powerRequestError in
 * backend/src/services/boxPowerPolicy.ts), does not change by itself. Anything
 * else, a request that never got an answer included, is not a refusal.
 */
const NOT_CONFIGURED = /provisioning is not configured/i;

export function startErrorKind(err: unknown): 'refused' | 'failed' {
  const res = (err as { response?: { status?: number; data?: { error?: unknown } } } | null)?.response;
  const status = res?.status;
  if (status === undefined) return 'failed';
  if (status >= 400 && status < 500) return 'refused';
  if (status === 503 && typeof res?.data?.error === 'string' && NOT_CONFIGURED.test(res.data.error)) return 'refused';
  return 'failed';
}

export interface SelectStartState {
  inFlight: ReadonlySet<string>;
  refused: ReadonlyMap<string, InstanceStatus>;
}

export function selectStartDecision(box: StartableBox | undefined, state: SelectStartState): SelectStartDecision {
  if (!box) return 'no-box';
  if (state.inFlight.has(box.id)) return 'in-flight';
  if (!canStartBox(box)) return 'not-parked';
  if (state.refused.get(box.id) === box.status) return 'refused';
  return 'start';
}

/**
 * One per tab, shared by every open: two projects on one parked box opened
 * back to back send one start. A box stays in flight until the box list has
 * reloaded after the 202, so the next open sees it `starting`. The API client
 * has no timeout, so each wait is bounded: a request that never answers must
 * not hold the box in flight for the life of the tab.
 */
export class SelectBoxStarter {
  private readonly inFlight = new Set<string>();
  private readonly refused = new Map<string, InstanceStatus>();

  constructor(
    private readonly startBox: (id: string) => Promise<unknown>,
    private readonly reloadBoxes: () => Promise<void>,
    bus: BoxStatusBus,
    private readonly waitMs = 30_000,
  ) {
    // The bus only reports changes: any new status for a refused box lifts
    // the refusal, so the next time it is parked an open may start it again.
    bus.subscribe(id => { this.refused.delete(id); });
  }

  async open(box: StartableBox | undefined): Promise<SelectStartDecision> {
    const decision = selectStartDecision(box, { inFlight: this.inFlight, refused: this.refused });
    if (decision !== 'start' || !box) return decision;
    this.inFlight.add(box.id);
    try {
      try {
        await this.bounded(this.startBox(box.id));
      } catch (err) {
        const kind = startErrorKind(err);
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        console.warn(`[termag] did not start box ${box.id} on open: ${msg ?? String(err)}`);
        if (kind === 'failed') return kind;
        this.refused.set(box.id, box.status);
        // A 409 usually means the list is behind (the box is already on its
        // way); the reload shows the real state, and its status change lifts
        // the hold.
        await this.reload();
        return kind;
      }
      await this.reload();
      return 'start';
    } finally {
      this.inFlight.delete(box.id);
    }
  }

  /** The list reload after a start; never throws, never waits past waitMs. */
  private async reload(): Promise<void> {
    try { await this.bounded(this.reloadBoxes()); } catch { /* the next poll or open catches up */ }
  }

  private bounded<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${this.waitMs / 1000}s`)), this.waitMs);
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  }
}
