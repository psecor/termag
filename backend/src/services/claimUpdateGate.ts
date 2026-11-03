/**
 * The launch gate of a claim's update (claimUpdate.ts): which boxes have one
 * running in this process, so a launch can wait for it. Apart from
 * claimUpdate.ts so the launch paths that read it (agentRuntime.ts,
 * projectClone.ts, routes/chat.ts, routes/claudeRunner.ts) take on nothing
 * else with it.
 *
 * Per process, like the agent socket the update needs: a launch is sent
 * through the process holding that socket, which is the one that ran the
 * claim. The wait is bounded by the update's own (CLAIM_UPDATE_TIMEOUT_MS),
 * so a launch waits at most that long and then goes ahead on the commit the
 * box has.
 */

/** The most a claim waits for its update, from the RPC to the agent's next hello. */
export const CLAIM_UPDATE_TIMEOUT_MS = 150_000;

const inFlight = new Map<string, Promise<unknown>>();

/** Hold launches on this box until `run` settles. */
export function trackClaimUpdate(instanceId: string, run: Promise<unknown>): void {
  inFlight.set(instanceId, run);
  void run.catch(() => undefined).finally(() => { if (inFlight.get(instanceId) === run) inFlight.delete(instanceId); });
}

/** Whether a claim update is running for this box in this process. */
export function claimUpdateRunning(instanceId: string | null | undefined): boolean {
  return !!instanceId && inFlight.has(instanceId);
}

/** Whether any claim update is running in this process: lets a caller that has only a project skip the box lookup. */
export function anyClaimUpdateRunning(): boolean {
  return inFlight.size > 0;
}

/** Resolves once no claim update is running for this box (at once when none is). Never rejects. */
export async function claimUpdateSettled(instanceId: string | null | undefined): Promise<void> {
  const run = instanceId ? inFlight.get(instanceId) : undefined;
  if (run) await run.catch(() => undefined);
}

/** For tests: forget every run. */
export function resetClaimUpdateGate(): void {
  inFlight.clear();
}
