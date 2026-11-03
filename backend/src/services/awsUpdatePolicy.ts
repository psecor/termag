/**
 * AWS CLI v2 updates: the aws-update-policy flag as a parsed value, in the shape of
 * Claude Code's (claudeUpdatePolicy.ts), whose parser it uses with the AWS
 * CLI's defaults. Pure: aws's entry in services/toolUpdate/components.ts reads
 * the flag for the owner and the box.
 *
 * The defaults are the safe side:
 *
 *   * floor 2.35.3, the release that fixes every advisory AWS has published
 *     for the AWS CLI v2 (github.com/aws/aws-cli/security/advisories):
 *       - CVE-2026-18654 (GHSA-hqvf-45jj-mccq, medium): the EMR helper
 *         commands disabled SSH host key verification; fixed in 2.35.3.
 *       - CVE-2026-13769 (GHSA-wfp6-f47h-hxc3, medium): overly permissive file
 *         permissions; fixed in 2.34.29.
 *       - GHSA-747p-wmpv-9c78 (medium): the cli_history database did not
 *         restrict its file permissions on Unix; fixed in 2.33.20.
 *     The fleet's reference was 2.39.2 on 2026-10-30, with its oldest hosts on
 *     2.38.5, so this floor installs nothing on a box on its own.
 *   * target latest: the version AWS's unversioned installer zip holds, read
 *     from that zip once its signature verifies.
 *   * restart none: the AWS CLI has no sessions to restart.
 */
import { parseClaudeUpdatePolicy, type ClaudeUpdatePolicy } from './claudeUpdatePolicy';

export const AWS_UPDATE_POLICY_FLAG = 'aws-update-policy';
/** The release flag: off, the admin routes answer 404 claude_update_off for aws and a box's policy says restart nothing. */
export const AWS_UPDATE_ENABLED_FLAG = 'aws-update-enabled';

export const AWS_TARGET_TAGS: readonly string[] = ['latest'];

export const DEFAULT_AWS_UPDATE_POLICY: ClaudeUpdatePolicy = {
  floor: '2.35.3',
  target: 'latest',
  restart: 'none',
  drainSec: 600,
  forceAfterHours: 24,
};

/** The flag's value, key by key over the AWS CLI's defaults; a bad key keeps its default. */
export function parseAwsUpdatePolicy(value: unknown): ClaudeUpdatePolicy {
  return parseClaudeUpdatePolicy(value, DEFAULT_AWS_UPDATE_POLICY, AWS_TARGET_TAGS);
}
