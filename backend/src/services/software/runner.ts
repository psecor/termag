/**
 * One pass at a time, without losing a request: run() while a pass is in
 * flight queues exactly one follow-up pass after it (several requests during
 * one pass coalesce into that one). Used by the software collector so a
 * "refresh inventories" during a sweep is not silently dropped.
 */
export function singleFlight(pass: () => Promise<void>, onError: (err: unknown) => void = () => {}) {
  let running: Promise<void> | null = null;
  let again = false;
  const start = (): Promise<void> => {
    running = pass().catch(onError).finally(() => {
      running = null;
      if (again) { again = false; void start(); }
    });
    return running;
  };
  return {
    run(): void { if (running) again = true; else void start(); },
    /** Resolves when nothing is running or queued. */
    async idle(): Promise<void> { while (running) await running; },
  };
}
