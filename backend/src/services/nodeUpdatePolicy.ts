/**
 * Node updates: the node-update-policy flag as a
 * parsed value, in the shape of Claude Code's (claudeUpdatePolicy.ts), whose
 * parser it uses with Node's defaults. Pure: node's entry in
 * services/toolUpdate/components.ts reads the flag for the owner and the box.
 *
 * A box only moves within the major it runs (24.x): a new major is the image's.
 *
 * The defaults are the safe side:
 *
 *   * floor 24.22.1, the newest security release on the 24.x line (nodejs.org
 *     marks each release's `security`; doc/changelogs/CHANGELOG_V24.md lists
 *     the CVEs), fixing every 2026 Node security release's CVEs before it:
 *       - 24.22.1 (2026-10-20): CVE-2026-105481 (http agent data guard),
 *         CVE-2026-105482 (dns: null bytes in resolve inputs), CVE-2026-105483
 *         and CVE-2026-106069 (tls: IP normalization, non-canonical IPs),
 *         CVE-2026-106073 (permission model: realpathSync), CVE-2026-106074
 *         (crypto: random caches across snapshots), CVE-2026-111497 (brotli).
 *       - 24.18.1 (2026-07-28): CVE-2026-56846, CVE-2026-56848 (http2, high),
 *         CVE-2026-58043 (permission model, high), CVE-2026-56850,
 *         CVE-2026-58040, CVE-2026-58041, CVE-2026-58042, CVE-2026-58045
 *         (medium), CVE-2026-56847, CVE-2026-58039, CVE-2026-58044 (low).
 *       - 24.17.0 (2026-06-17): CVE-2026-48618 (tls server identity, high),
 *         CVE-2026-48933 (WebCrypto, high), CVE-2026-48615, CVE-2026-48619,
 *         CVE-2026-48928, CVE-2026-48930, CVE-2026-48934, CVE-2026-48937
 *         (medium), CVE-2026-48617, CVE-2026-48931, CVE-2026-48935 (low).
 *       - 24.14.1 (2026-03-24): CVE-2026-21710, CVE-2026-21637 (high),
 *         CVE-2026-21717, CVE-2026-21713, CVE-2026-21714, CVE-2026-21712
 *         (medium), CVE-2026-21716, CVE-2026-21715 (low).
 *       - 24.13.0 (2026-01-12): CVE-2025-59465, CVE-2025-55132,
 *         CVE-2025-55130, CVE-2025-59466, CVE-2025-55131, CVE-2026-21637.
 *     The fleet ran 24.22.1 on 2026-10-30 (24.22.2, the newest, is not a
 *     security release), so this floor installs nothing on a box on its own.
 *   * target latest: the newest release of the box's own major.
 *   * restart none: the agent is restarted on the new Node, and no session.
 *     A run's restart is the admin's choice for it (run.ts): idle or force
 *     stops and resumes the sessions of the tools that run on Node.
 */
import { parseClaudeUpdatePolicy, type ClaudeUpdatePolicy } from './claudeUpdatePolicy';

export const NODE_UPDATE_POLICY_FLAG = 'node-update-policy';

export const NODE_TARGET_TAGS: readonly string[] = ['latest'];

export const DEFAULT_NODE_UPDATE_POLICY: ClaudeUpdatePolicy = {
  mode: 'off',
  floor: '24.22.1',
  target: 'latest',
  restart: 'none',
  drainSec: 600,
  forceAfterHours: 24,
};

/** The flag's value, key by key over Node's defaults; a bad key keeps its default. */
export function parseNodeUpdatePolicy(value: unknown): ClaudeUpdatePolicy {
  return parseClaudeUpdatePolicy(value, DEFAULT_NODE_UPDATE_POLICY, NODE_TARGET_TAGS, undefined, NODE_UPDATE_POLICY_FLAG);
}
