/**
 * Debug-level lines: printed only when asked for. The orchestrator's journal
 * may be shipped to a log backend, and
 * three per-request lines were about a million records every three days:
 * `[STATUS] Push ... to N clients` (every status fan-out), `[STATUS] POST
 * session=...` (every status hook) and `[GH-AUTHZ] ... allowed` (every
 * allowed GitHub call through the broker). They are useful when debugging
 * one host, so they stay, behind TERMAG_DEBUG.
 *
 *   TERMAG_DEBUG=STATUS,GH-AUTHZ   print those tags' debug lines
 *   TERMAG_DEBUG=all               print every tag's
 *   unset                          print none (production)
 *
 * The collector drops the same lines from an older backend's journal
 * (deploy/termag-otelcol.yaml filter/noise), so turning this on for a while
 * does not re-flood the project.
 */

let enabled: Set<string> | 'all' | null = null;

/** Parse TERMAG_DEBUG. Pure. */
export function debugTagsFromEnv(value: string | undefined): Set<string> | 'all' {
  const tags = (value ?? '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tags.includes('ALL') || tags.includes('1') || tags.includes('*')) return 'all';
  return new Set(tags);
}

/** Whether `[<tag>]` debug lines print, from TERMAG_DEBUG (read once). */
export function debugEnabled(tag: string, env: NodeJS.ProcessEnv = process.env): boolean {
  enabled ??= debugTagsFromEnv(env.TERMAG_DEBUG);
  return enabled === 'all' || enabled.has(tag.toUpperCase());
}

/** console.log(`[tag] message`) when the tag's debug lines are on. The message is built only then. */
export function debugLog(tag: string, message: () => string): void {
  if (debugEnabled(tag)) console.log(`[${tag}] ${message()}`);
}

/** Test hook: re-read TERMAG_DEBUG on the next call. */
export function resetDebugLogForTests(): void {
  enabled = null;
}
