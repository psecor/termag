/**
 * Devin CLI updates: the devin-update-policy flag as a
 * parsed value, in the shape of Claude Code's (claudeUpdatePolicy.ts), whose
 * parser it uses with the Devin CLI's defaults. Pure: Devin's entry in
 * services/toolUpdate/components.ts reads the flag for the owner and the box.
 *
 * The defaults are the safe side:
 *
 *   * floor 3000.11.92: no security advisory has been published for the
 *     Devin CLI (Devin for Terminal). Searched on 2026-10-30: GitHub's advisory
 *     database (reviewed and unreviewed, "Devin" and "Cognition"), and NVD's
 *     CVE search. The one Devin CVE, CVE-2024-56083 (the "Use Devin's
 *     Machine" VS Code live-share URL, fixed server-side 2024-12-12), is
 *     about the cloud product, not the CLI. So the floor is the oldest
 *     version in the fleet on 2026-10-30, which installs nothing on a box on
 *     its own; raise it when an advisory names a fixed version.
 *   * target latest: the version static.devin.ai/cli/current/manifest.json
 *     names; there are no other channels to choose.
 *   * restart none, as Codex's and Cursor's.
 */
import { parseClaudeUpdatePolicy, type ClaudeUpdatePolicy } from './claudeUpdatePolicy';

export const DEVIN_UPDATE_POLICY_FLAG = 'devin-update-policy';

export const DEVIN_TARGET_TAGS: readonly string[] = ['latest'];

export const DEFAULT_DEVIN_UPDATE_POLICY: ClaudeUpdatePolicy = {
  mode: 'off',
  floor: '3000.11.92',
  target: 'latest',
  restart: 'none',
  drainSec: 600,
  forceAfterHours: 24,
};

/** The flag's value, key by key over the Devin CLI's defaults; a bad key keeps its default. */
export function parseDevinUpdatePolicy(value: unknown): ClaudeUpdatePolicy {
  return parseClaudeUpdatePolicy(value, DEFAULT_DEVIN_UPDATE_POLICY, DEVIN_TARGET_TAGS, undefined, DEVIN_UPDATE_POLICY_FLAG);
}
