/**
 * pi updates: the pi-update-policy flag as a parsed
 * value, in the shape of Claude Code's (claudeUpdatePolicy.ts), whose parser it
 * uses with pi's defaults. pi is @earendil-works/pi-coding-agent, the
 * pi provider's agent. Pure: pi's entry in
 * services/toolUpdate/components.ts reads the flag for the owner and the box.
 *
 * The defaults are the safe side:
 *
 *   * floor 0.79.0, from pi's published advisories (GitHub's advisory database
 *     and earendil-works/pi's security advisories):
 *       - CVE-2026-54325 (GHSA-mqxh-6gq7-558m, medium): pi loaded
 *         project-local extensions without approval; fixed in 0.79.0.
 *       - CVE-2026-54328 (GHSA-jfgx-wxx8-mp94, high): predictable temporary
 *         extension install paths allowed local privilege escalation on
 *         shared Linux hosts; fixed in 0.78.1.
 *       - CVE-2026-54327 (GHSA-r95r-rj6r-c39x, low): a race in auth.json
 *         writes could expose stored credentials; fixed in 0.78.1.
 *       - CVE-2026-54326 (GHSA-7v5m-pr3q-6453, low): XSS in HTML session
 *         exports; fixed in 0.78.1.
 *     The fleet ran 1.0.2 on 2026-10-30, so this floor installs nothing on a
 *     box on its own.
 *   * target latest: the newest pinned version (PI_PINNED_LATEST), not npm's
 *     latest tag; pi's other dist-tag, legacy-node20, is an old line.
 *   * restart none, as the other agent CLIs'.
 */
import { parseClaudeUpdatePolicy, type ClaudeUpdatePolicy } from './claudeUpdatePolicy';

export const PI_UPDATE_POLICY_FLAG = 'pi-update-policy';

export const PI_TARGET_TAGS: readonly string[] = ['latest'];

/**
 * What `latest` is for pi: the newest version deploy/termag-pi-update pins
 * (its PINS), which is what a box resolves latest to, not the version npm's
 * latest tag or the fleet's inventory names. The Software tab's "behind" and
 * the fleet's Update behind compare with it, so a box on it is current and
 * one past it is ahead, never behind, as Cursor's (CURSOR_PINNED_LATEST).
 * piUpdatePolicy.test.ts reads the recipe's PINS and fails until this moves
 * with them.
 */
export const PI_PINNED_LATEST = '1.5.0';

export const DEFAULT_PI_UPDATE_POLICY: ClaudeUpdatePolicy = {
  mode: 'off',
  floor: '0.79.0',
  target: 'latest',
  restart: 'none',
  drainSec: 600,
  forceAfterHours: 24,
};

/** The flag's value, key by key over pi's defaults; a bad key keeps its default. */
export function parsePiUpdatePolicy(value: unknown): ClaudeUpdatePolicy {
  return parseClaudeUpdatePolicy(value, DEFAULT_PI_UPDATE_POLICY, PI_TARGET_TAGS, undefined, PI_UPDATE_POLICY_FLAG);
}
