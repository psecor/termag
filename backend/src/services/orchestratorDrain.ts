/**
 * What an orchestrator process does when it gains or loses the lease
 * (services/orchestratorLease.ts).
 *
 * Serving: runs the singleton work and accepts new WebSockets.
 * Draining (a newer process holds the lease): stops the singleton work at
 * once, refuses new WebSockets and fails its health check, so the load
 * balancer sends everything new to the serving process. After `graceMs`,
 * long enough for the load balancer to notice, it closes the box agents'
 * sockets with DRAIN_CLOSE_CODE, which agents redial promptly, and
 * `browserDelayMs` later the browsers' terminal and status sockets: by then
 * the agents are on the serving process, so a pane that reconnects finds its
 * box there. HTTP keeps being answered throughout from the shared database.
 */
export const DRAIN_CLOSE_CODE = 4503;
export const DRAIN_CLOSE_REASON = 'orchestrator draining; reconnect';

export interface DrainDeps {
  graceMs: number;
  browserDelayMs: number;
  startLeaderWork: () => void;
  stopLeaderWork: () => void;
  /** Close the box agents' sockets; returns how many. */
  closeAgents: () => number;
  /** Close every other socket (terminals, status); returns how many. */
  closeBrowsers: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string) => void;
}

export interface Drain {
  serve(): void;
  drain(): void;
  isServing(): boolean;
}

export function createDrain(deps: DrainDeps): Drain {
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? (h => clearTimeout(h as NodeJS.Timeout));
  const log = deps.log ?? (msg => console.log(`[DRAIN] ${msg}`));
  let serving = false;
  let pending: unknown = null;

  const cancelPending = () => {
    if (pending !== null) { clearTimer(pending); pending = null; }
  };

  return {
    serve() {
      // Serving again (the newer process died) before the closes ran: what
      // this process still holds stays.
      cancelPending();
      if (serving) return;
      serving = true;
      deps.startLeaderWork();
    },
    drain() {
      if (!serving) return;
      serving = false;
      deps.stopLeaderWork();
      log(`refusing new connections; closing agents in ${Math.round(deps.graceMs / 1000)}s`);
      pending = setTimer(() => {
        const agents = deps.closeAgents();
        log(`closed ${agents} agent connection(s)`);
        pending = setTimer(() => {
          pending = null;
          const browsers = deps.closeBrowsers();
          log(`closed ${browsers} browser connection(s)`);
        }, deps.browserDelayMs);
      }, deps.graceMs);
    },
    isServing: () => serving,
  };
}
