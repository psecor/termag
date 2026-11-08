/**
 * GitHub CLI updates:
 * the gh-update-policy flag as a parsed value, in the shape of Claude Code's
 * (claudeUpdatePolicy.ts), whose parser it uses with gh's defaults. Pure: gh's
 * entry in services/toolUpdate/components.ts reads the flag for the owner and
 * the box.
 *
 * The defaults are the safe side:
 *
 *   * floor 2.102.0, the release that fixes every advisory GitHub has
 *     published for cli/cli (github.com/cli/cli/security/advisories):
 *       - GHSA-39wj-f2f4-978v (medium): filesystem operations could write
 *         outside their destination through symlinks; fixed in 2.102.0.
 *       - GHSA-qcwj-mr2r-2cx7 (low): argument injection in `gh skill search`
 *         could redirect a skill installation; fixed in 2.102.0.
 *       - GHSA-4mq3-hpgx-9cx8, GHSA-wjmr-j3rp-mh2g (low): `gh attestation
 *         verify` compared --source-ref case-insensitively and took
 *         --signer-workflow as a prefix; fixed in 2.102.0.
 *       - CVE-2026-72924 (GHSA-vfhh-p7hm-pxfh, low): `gh codespace ports
 *         forward` listened on every interface; fixed in 2.98.0.
 *       - CVE-2026-64654 (GHSA-3m3g-3wcr-px46, medium): terminal escape
 *         sequence injection in several commands; fixed in 2.97.0.
 *       - CVE-2026-64653 (GHSA-4fjg-2h4q-fwg3, low): unescaped request URL
 *         components allowed path traversal; fixed in 2.97.0.
 *       - CVE-2026-64652 (GHSA-cg6r-mpgc-h9mm, low): `gh auth status` showed
 *         part of the token; fixed in 2.97.0.
 *       - CVE-2026-64655 (GHSA-mm27-mwq9-fr5g, low): attestation SAN matching
 *         did not escape regex metacharacters; fixed in 2.97.0.
 *       - CVE-2026-59831 (GHSA-8cg3-r6g9-fpg2, medium): a malicious Codespace
 *         could run commands through `gh codespace jupyter`; fixed in 2.96.0.
 *       - CVE-2026-48501 (GHSA-8xvp-7hj6-mcj9, high): the token went in the
 *         Authorization header to TUF repository mirrors, non-GitHub hosts;
 *         fixed in 2.93.0.
 *       - CVE-2026-45803 (GHSA-crc3-h8v6-qh57, low): `gh run view` log output
 *         allowed terminal escape injection; fixed in 2.92.0.
 *       - and the older ones, all fixed by 2.67.0 (CVE-2025-25204,
 *         CVE-2024-54132, CVE-2024-52308, CVE-2024-53858, GHSA-fqfh-778m-2v32).
 *     The fleet's reference was 2.103.3 on 2026-10-30, with 79 hosts on older
 *     minors: those below the floor are exposed to at least the medium ones.
 *   * target latest: what cli.github.com's apt repository lists now, the
 *     only version the box installs (the repository lists one at a time).
 *   * restart none: gh has no sessions to restart.
 */
import { parseClaudeUpdatePolicy, type ClaudeUpdatePolicy } from './claudeUpdatePolicy';

export const GH_UPDATE_POLICY_FLAG = 'gh-update-policy';

export const GH_TARGET_TAGS: readonly string[] = ['latest'];

export const DEFAULT_GH_UPDATE_POLICY: ClaudeUpdatePolicy = {
  mode: 'off',
  floor: '2.102.0',
  target: 'latest',
  restart: 'none',
  drainSec: 600,
  forceAfterHours: 24,
};

/** The flag's value, key by key over gh's defaults; a bad key keeps its default. */
export function parseGhUpdatePolicy(value: unknown): ClaudeUpdatePolicy {
  return parseClaudeUpdatePolicy(value, DEFAULT_GH_UPDATE_POLICY, GH_TARGET_TAGS, undefined, GH_UPDATE_POLICY_FLAG);
}
