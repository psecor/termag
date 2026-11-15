/**
 * Waiting for a box's agent before an action that needs it. The PR overlay's
 * "New workstream for #N" checks a branch out on the box, so a stopped or
 * hibernated box used to answer "This box is stopped. Start it from the Boxes
 * list first." Instead the picker starts (or resumes) the box and waits for
 * the agent's connect, which is what writes `ready`.
 *
 * The decisions are here and the loop takes its side effects injected, so both
 * are unit-testable; the picker passes `instancesApi.start` / `.get`.
 */
import type { Instance, InstanceStatus } from '../types';

/** How long the picker waits for a box: a cold EC2 start plus the agent's connect. */
export const WAKE_BOX_DEADLINE_MS = 6 * 60 * 1000;
export const WAKE_BOX_POLL_MS = 3000;
/**
 * Each read and the start are given a timeout, so a request that never answers
 * cannot hold the wake past its deadline: the read is a single row, and EC2's
 * start answers within seconds.
 */
export const WAKE_READ_TIMEOUT_MS = 15_000;
export const WAKE_START_TIMEOUT_MS = 30_000;

export type WakeStep = 'ready' | 'start' | 'wait' | 'unavailable';

/**
 * What a box in this status needs before its agent can run something:
 * `ready` go ahead; `start` ask EC2 to start (stopped, hibernated); `wait` it
 * is already on its way (a `stopping` or `hibernating` box is waited out and
 * then started); `unavailable` no start will help (failed, terminated, or no
 * box at all).
 */
export function wakeStep(status: InstanceStatus | null | undefined): WakeStep {
  switch (status) {
    case 'ready': return 'ready';
    case 'stopped':
    case 'hibernated': return 'start';
    case 'provisioning':
    case 'awaiting-agent':
    case 'warming':
    case 'warm':
    case 'stopping':
    case 'hibernating':
    case 'starting': return 'wait';
    default: return 'unavailable';
  }
}

/** The line the picker shows while it waits for the box's agent. */
export function wakeNote(name: string, status: InstanceStatus): string {
  switch (status) {
    case 'stopped': return `Starting ${name}… the workstream is created once its agent connects.`;
    case 'hibernated': return `Resuming ${name} from hibernation… the workstream is created once its agent connects.`;
    case 'starting': return `${name} is starting… the workstream is created once its agent connects.`;
    case 'stopping': return `${name} is stopping; it starts again once it has stopped…`;
    case 'hibernating': return `${name} is hibernating; it starts again once it has hibernated…`;
    default: return `Waiting for ${name} to be ready…`;
  }
}

export type WakeResult =
  | { ok: true; box: Instance }
  /** `error` is for the picker to show; the box is still in `status`. */
  | { ok: false; error: string };

export interface WakeBoxOptions {
  /** Read the box's current row. */
  get: (id: string) => Promise<Instance>;
  /** Start it (POST /api/instances/:id/start): stopped, or hibernated after a resume. Errors propagate. */
  start: (id: string) => Promise<unknown>;
  /** Called before each poll with the box as last read, so the UI can say what it is waiting for. */
  onWait?: (box: Instance) => void;
  deadlineMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Drive one box to `ready`: start it when it is down, wait while it is on its
 * way, and give up after the deadline.
 *
 * A single failed read is a blip, not the end of the wake: the last known
 * status is kept and the next poll tries again, so a six-minute wait survives
 * a dropped request. A start the backend refuses is retried only if a read
 * straight after it shows the box on its way up (someone else started it
 * between our read and our POST, which the start answers 409 for); a box that
 * is still down refused the start for real, and that error is rethrown, since
 * it says what the user needs to read (no AWS on this orchestrator, a box
 * being terminated, EC2 refusing the start).
 */
export async function wakeBox(box: Instance, opts: WakeBoxOptions): Promise<WakeResult> {
  const deadlineMs = opts.deadlineMs ?? WAKE_BOX_DEADLINE_MS;
  const pollMs = opts.pollMs ?? WAKE_BOX_POLL_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + deadlineMs;
  let current = box;
  // The down state a start was last requested from, so one start is asked for
  // per descent. Cleared once the box is on its way; a box stopped again after
  // starting is then started again, and the deadline bounds the loop.
  let startedFrom: InstanceStatus | null = null;

  /**
   * A failed read is a blip and means "no news": keep the last status and let
   * the next poll try again. A 404 is not a blip — the box is gone (deleted,
   * or never the caller's) — so it ends the wake with that answer instead of
   * polling a missing row until the deadline.
   */
  const read = async (): Promise<Instance | null> => {
    try {
      return await opts.get(box.id);
    } catch (err) {
      if (isMissingBox(err)) throw err;
      return null;
    }
  };

  for (;;) {
    const step = wakeStep(current.status);
    if (step === 'ready') return { ok: true, box: current };
    if (step === 'unavailable') {
      return { ok: false, error: `${current.name} is ${current.status}; a workstream cannot be made on it.` };
    }
    opts.onWait?.(current);
    if (step === 'wait') {
      startedFrom = null;
    } else if (startedFrom !== current.status) {
      startedFrom = current.status;
      try {
        await opts.start(current.id);
      } catch (err) {
        // Another tab, or the project's own open, may have started the box
        // between our read and the start. Read it: on its way up or up, wait
        // for it; still down, the refusal is the box's own and is rethrown.
        // A box that is gone answers with the read's own 404.
        const after = await read();
        const afterStep = after ? wakeStep(after.status) : 'unavailable';
        if (!after || afterStep === 'start' || afterStep === 'unavailable') throw err;
        current = after;
        continue;
      }
    }
    if (now() >= deadline) {
      return {
        ok: false,
        error: `${current.name} did not come up in time (still ${current.status}). Try again once it is ready.`,
      };
    }
    await sleep(pollMs);
    const next = await read();
    if (next) current = next;
  }
}

/** A box read that answered 404: the row is gone, so no amount of waiting finds it. */
function isMissingBox(err: unknown): boolean {
  return (err as { response?: { status?: number } } | null)?.response?.status === 404;
}
