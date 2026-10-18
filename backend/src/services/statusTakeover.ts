/**
 * Status timers around a lease takeover.
 *
 * Until the displaced process has closed its agents and browsers it keeps
 * taking status writes, which land in session_statuses but not in this
 * process's map. So the serving process re-reads the table once they are
 * closed, and runs no auto-idle or milestone timer before that: a timer fired
 * from the map it hydrated at boot would write a fresh row over a newer one
 * the displaced process wrote, and the re-read would then keep the timer's.
 * Once the re-read is done (or failed) the timers are armed from the map.
 */
export interface StatusTakeoverDeps {
  /** How long after taking the lease to re-read: the drain's grace, browser delay and a margin. */
  delayMs: number;
  /** Re-read session_statuses; resolves to how many entries a newer row replaced. */
  rehydrate: () => Promise<number>;
  setTimersSuspended: (suspended: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string) => void;
}

export interface StatusTakeover {
  /** This process took the lease (or took it back): suspend, re-read later, then arm. */
  serve(): void;
  /** This process lost the lease: suspend, and forget a pending or running re-read. */
  drain(): void;
}

export function createStatusTakeover(deps: StatusTakeoverDeps): StatusTakeover {
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? (h => clearTimeout(h as NodeJS.Timeout));
  const log = deps.log ?? (msg => console.log(`[STATUS] ${msg}`));
  let pending: unknown = null;
  // Bumped on every serve and drain, so a re-read still running from an
  // earlier term never arms timers in a later one.
  let term = 0;

  const cancel = () => {
    if (pending !== null) { clearTimer(pending); pending = null; }
  };

  return {
    serve() {
      cancel();
      const mine = ++term;
      deps.setTimersSuspended(true);
      pending = setTimer(() => {
        pending = null;
        deps.rehydrate()
          .then(n => log(`re-read session_statuses after taking the lease: ${n} newer status(es)`))
          .catch(err => log(`re-read after taking the lease failed: ${(err as Error).message}`))
          .finally(() => {
            if (mine === term) deps.setTimersSuspended(false);
          });
      }, deps.delayMs);
    },
    drain() {
      cancel();
      term++;
      deps.setTimersSuspended(true);
    },
  };
}
