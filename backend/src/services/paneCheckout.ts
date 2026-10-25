export function shouldWaitForPaneCheckout(input: {
  hasRepo: boolean;
  managed: boolean;
  hasGithubCredential: boolean;
}): boolean {
  return input.hasRepo && input.managed && input.hasGithubCredential;
}

/**
 * Whether the pane checkout may be typed: no claim still running, and GitHub
 * delivered. `expectGithub: false` says this orchestrator delivers no GitHub
 * at all (no broker or no credential store, credentialDelivery.ts), so
 * nothing will ever stamp `githubDeliveredAt` and waiting for it would only
 * run the clock out.
 */
export function paneCheckoutReady(row: {
  githubDeliveredAt: Date | null;
  onClaimStatus: string | null;
} | null, opts: { expectGithub?: boolean } = {}): boolean {
  if (row == null) return true;
  if (row.onClaimStatus === 'pending' || row.onClaimStatus === 'running') return false;
  return opts.expectGithub === false || row.githubDeliveredAt != null;
}

export async function waitForPaneCheckout(
  read: () => Promise<{
    githubDeliveredAt: Date | null;
    onClaimStatus: string | null;
    lastConnectedAt?: Date | null;
  } | null>,
  opts?: {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    expectGithub?: boolean;
  },
): Promise<'ready' | 'timeout'> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const intervalMs = opts?.intervalMs ?? 250;
  const now = opts?.now ?? (() => Date.now());
  const sleep = opts?.sleep ?? (ms => new Promise(resolve => { setTimeout(resolve, ms); }));
  const deadline = now() + timeoutMs;
  for (;;) {
    if (paneCheckoutReady(await read(), { expectGithub: opts?.expectGithub })) return 'ready';
    const t = now();
    if (t >= deadline) return 'timeout';
    await sleep(Math.min(intervalMs, deadline - t));
  }
}
