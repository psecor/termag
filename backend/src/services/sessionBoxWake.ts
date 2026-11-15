/**
 * Waking the box a New session was started on ("Send
 * never waits on a box"). Behind box-placement-enabled, POST /api/projects
 * takes the caller's own parked box: the project waits `pending`, as it does on
 * a booting box, and the box is woken through the owner-only start POST
 * /instances/:id/start takes. An asleep box is started at once by the create
 * (routes/projects.ts). A box on its way down (stopping, hibernating) can't be
 * started yet, so it is held here and started once it is down, as
 * services/reviewHeld.ts does for a review. A box already starting is left as
 * it is. Once the box's agent says hello, the pending checkout runs
 * (services/projectClone.ts redispatchClones).
 *
 * A wake that fails is kept for WAKE_ERROR_KEEP_MS, by box, so the session can
 * say so ("Couldn't wake box-a: …"); GET /api/instances carries it as the box's
 * `wakeError`. In memory, per process: a restart forgets a held wake, and the
 * session's Retry asks again.
 */

export interface WakeAnswer { status: number; body: unknown }

export interface SessionWakeDeps {
  /** The box's status now, from the database; null when it's gone. */
  boxStatus: (instanceId: string) => Promise<string | null>;
  /** The owner-only start; a status of 300 or more is its refusal. */
  wake: (userId: string, instanceId: string) => Promise<WakeAnswer>;
  /**
   * Run the box's held checkouts, as its agent's hello would: for a box whose stop timed out back to ready, which
   * keeps its agent, so no hello comes.
   */
  redispatch?: (userId: string, instanceId: string) => Promise<void>;
  now: () => number;
}

/** How long a held wake waits for its box to finish going down. */
export const WAKE_WAIT_MS = 15 * 60_000;
/** How long a failed wake's reason stays readable. */
export const WAKE_ERROR_KEEP_MS = 30 * 60_000;

const ASLEEP = new Set(['stopped', 'hibernated']);
const GOING_DOWN = new Set(['stopping', 'hibernating']);
/** Coming up or up: a refused start found the box like this was beaten to it by another, not refused. */
const COMING_UP = new Set(['starting', 'provisioning', 'awaiting-agent', 'ready']);

function errorOf(body: unknown, fallback: string): string {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' && e ? e.replace(/\.$/, '') : fallback;
}

interface Held { userId: string; instanceId: string; name: string; since: number }

export class SessionBoxWakes {
  private readonly held = new Map<string, Held>();
  private readonly errors = new Map<string, { error: string; at: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private readonly deps: SessionWakeDeps, private readonly pollMs = 3_000) {}

  /**
   * Wake the box for a session, by its status now: asleep, started at once;
   * on its way down, held and started once it's down; anything else (starting,
   * ready, launching) needs nothing. Answers whether a wake was asked for or
   * is held, and the reason when the start was refused.
   */
  async wakeFor(userId: string, instanceId: string, name: string, status: string): Promise<{ state: 'waking' | 'held' | 'none' | 'failed'; error?: string }> {
    if (GOING_DOWN.has(status)) {
      this.errors.delete(instanceId);
      this.hold({ userId, instanceId, name, since: this.deps.now() });
      return { state: 'held' };
    }
    // Coming up or up: no wake to ask for, and an earlier failure no longer says anything.
    if (!ASLEEP.has(status)) { this.errors.delete(instanceId); return { state: 'none' }; }
    const answer = await this.deps.wake(userId, instanceId).catch(err => ({ status: 500, body: { error: (err as Error).message } }));
    if (answer.status < 300) { this.errors.delete(instanceId); return { state: 'waking' }; }
    // Another start beat this one to it: the box is coming up anyway.
    const after = await this.deps.boxStatus(instanceId).catch(() => null);
    if (after && COMING_UP.has(after)) { this.errors.delete(instanceId); return { state: 'waking' }; }
    const error = `Couldn't wake ${name}: ${errorOf(answer.body, 'the start was refused')}`;
    this.errors.set(instanceId, { error, at: this.deps.now() });
    return { state: 'failed', error };
  }

  /** The last failed wake of this box, while it is recent. */
  errorFor(instanceId: string): string | null {
    const e = this.errors.get(instanceId);
    if (!e) return null;
    if (this.deps.now() - e.at > WAKE_ERROR_KEEP_MS) { this.errors.delete(instanceId); return null; }
    return e.error;
  }

  /** Whether a wake is held for this box (it is on its way down). */
  isHeld(instanceId: string): boolean {
    return this.held.has(instanceId);
  }

  private hold(h: Held) {
    // One wake per box: a second session on the same box shares it.
    if (!this.held.has(h.instanceId)) this.held.set(h.instanceId, h);
    if (!this.timer && this.pollMs > 0) {
      this.timer = setInterval(() => { void this.sweep(); }, this.pollMs);
      this.timer.unref?.();
    }
  }

  /** One pass over the held wakes: a box that's down is started; one that's gone or took too long is let go, saying why. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const [id, h] of [...this.held]) {
        const status = await this.deps.boxStatus(id).catch(() => 'unknown');
        if (status === null || status === 'failed' || status === 'terminated' || status === 'quarantined') {
          this.held.delete(id);
          this.errors.set(id, { error: `Couldn't wake ${h.name}: it is ${status ?? 'gone'}`, at: this.deps.now() });
          continue;
        }
        if (ASLEEP.has(status)) {
          this.held.delete(id);
          await this.wakeFor(h.userId, id, h.name, status);
          continue;
        }
        // Back up without sleeping (the stop timed out): its agent never left, so no hello runs the checkouts.
        if (status === 'ready') {
          this.held.delete(id);
          await this.deps.redispatch?.(h.userId, id).catch(() => {});
          continue;
        }
        if (!GOING_DOWN.has(status) && status !== 'unknown') { this.held.delete(id); continue; }
        if (this.deps.now() - h.since > WAKE_WAIT_MS) {
          this.held.delete(id);
          this.errors.set(id, { error: `Couldn't wake ${h.name}: it took too long to go to sleep`, at: this.deps.now() });
        }
      }
    } finally {
      this.sweeping = false;
      if (this.timer && this.held.size === 0) { clearInterval(this.timer); this.timer = null; }
    }
  }

  /** Tests: forget everything and stop the sweep. */
  reset(): void {
    this.held.clear();
    this.errors.clear();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

/** The process's wakes, read from the database and started through the owner-only start route. */
export const sessionWakes = new SessionBoxWakes({
  boxStatus: async id => {
    const { prisma } = await import('../db');
    return (await prisma.instance.findUnique({ where: { id }, select: { status: true } }))?.status ?? null;
  },
  wake: async (userId, id) => {
    const { prisma } = await import('../db');
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { status: 404, body: { error: 'Box owner not found' } };
    // The box routes pull in the provisioner and the warm pool: loaded here, as routes/projects.ts does.
    const { powerOwnedBox } = await import('../routes/instances');
    return powerOwnedBox(user as Express.User, id, 'start');
  },
  redispatch: async (userId, id) => {
    const ev = { instance: { id }, user: { id: userId }, settled: Promise.resolve() } as unknown as import('./agentRegistry').BoxAgentHelloEvent;
    const [{ redispatchClones }, { onHello }] = await Promise.all([import('./projectClone'), import('./workspaceSetup')]);
    await Promise.all([redispatchClones(ev), onHello(ev)]);
  },
  now: () => Date.now(),
});
