/**
 * A long-lived connection only the lease holder may keep open — Slack Socket
 * Mode and the Discord gateway. Slack
 * hands each event to one of the open sockets and Discord to all of them, so
 * with two processes connected events land on the draining one or are
 * answered twice.
 *
 * `set(true|false)` follows the lease; starts and stops run one at a time and
 * converge on the latest wish, so a drain that arrives mid-start stops the
 * connection once the start has finished.
 */

export interface LeaderOnlyService {
  name: string;
  /** Resolves true when the connection is up, false when it is disabled or failed. */
  start(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface LeaderOnly {
  set(wanted: boolean): void;
  /** Resolves once the connection matches the latest `set`. */
  settled(): Promise<void>;
  isRunning(): boolean;
}

export function leaderOnly(svc: LeaderOnlyService, log: (msg: string) => void = msg => console.log(msg)): LeaderOnly {
  let wanted = false;
  let running = false;
  let loop: Promise<void> | null = null;
  // Bumped by every set(); a start that failed is not retried until the next.
  let generation = 0;
  let failedGeneration = -1;

  const converge = async (): Promise<void> => {
    while (running !== wanted) {
      if (wanted) {
        const gen = generation;
        running = await svc.start().catch((err: Error) => {
          log(`[${svc.name}] start failed: ${err.message}`);
          return false;
        });
        // Disabled or failed: no retry loop; the next set(true) tries again.
        if (!running) { failedGeneration = gen; return; }
      } else {
        await svc.stop().catch((err: Error) => log(`[${svc.name}] stop failed: ${err.message}`));
        running = false;
        log(`[${svc.name}] stopped (not the lease holder)`);
      }
    }
  };

  const kick = () => {
    if (loop) return;
    loop = converge().finally(() => {
      loop = null;
      // A set() that landed between the last check and here.
      if (running !== wanted && failedGeneration !== generation) kick();
    });
  };

  return {
    set(next) {
      wanted = next;
      generation++;
      kick();
    },
    async settled() {
      while (loop) await loop;
    },
    isRunning: () => running,
  };
}
