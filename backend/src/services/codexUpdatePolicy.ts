/**
 * Codex updates: the codex-update-policy flag as a
 * parsed value, in the shape of Claude Code's (claudeUpdatePolicy.ts), whose
 * parser it uses with Codex's own defaults. Pure: Codex's entry in
 * services/toolUpdate/components.ts reads the flag for the owner and the box.
 *
 * The defaults are what a deployment without the flag runs, so they are the
 * safe side:
 *
 *   * floor 0.131.0, from Codex's published advisories (GitHub's advisory
 *     database, the @openai/codex npm package and openai/codex):
 *       - CVE-2025-61260 (GHSA-xrxf-jgv3-qmrm, critical): code execution
 *         through a malicious MCP configuration in a repository; <= 0.23.0.
 *       - CVE-2025-59532 (GHSA-w5fx-fh39-j5rw, high): sandbox bypass in the
 *         path configuration logic; 0.2.0 to 0.38.0, fixed in 0.39.0.
 *       - CVE-2026-19592 (GHSA-26wp-42v3-96xp, high): git metadata reads ran
 *         a repository's core.fsmonitor helper outside the sandbox; fixed by
 *         openai/codex#22652, first released in 0.131.0. The advisory names
 *         no version range; the release notes of rust-v0.131.0 list the fix.
 *     The fleet ran 0.162 to 0.165 on 2026-10-30, so this floor installs
 *     nothing on a box on its own.
 *   * target latest: Codex publishes no `stable` tag (its other dist-tags are
 *     alpha and per-platform builds), so latest or an exact x.y.z.
 *   * restart none: the restart a manual run uses is the admin's, from the
 *     run; this one is the later automatic sweep's, which must not restart
 *     sessions until the flag says so.
 */
import { parseClaudeUpdatePolicy, type ClaudeUpdatePolicy } from './claudeUpdatePolicy';

export const CODEX_UPDATE_POLICY_FLAG = 'codex-update-policy';
/** The release flag: off, the admin routes answer 404 claude_update_off for Codex and a box's policy says restart nothing. */
export const CODEX_UPDATE_ENABLED_FLAG = 'codex-update-enabled';

export const CODEX_TARGET_TAGS: readonly string[] = ['latest'];

export const DEFAULT_CODEX_UPDATE_POLICY: ClaudeUpdatePolicy = {
  floor: '0.131.0',
  target: 'latest',
  restart: 'none',
  drainSec: 600,
  forceAfterHours: 24,
};

/** The flag's value, key by key over Codex's defaults; a bad key keeps its default. */
export function parseCodexUpdatePolicy(value: unknown): ClaudeUpdatePolicy {
  return parseClaudeUpdatePolicy(value, DEFAULT_CODEX_UPDATE_POLICY, CODEX_TARGET_TAGS);
}
