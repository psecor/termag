/**
 * Python updates: the python-update-policy
 * flag as a parsed value, in the shape of Claude Code's (claudeUpdatePolicy.ts),
 * whose parser it uses with Python's defaults. Pure: python's entry in
 * services/toolUpdate/components.ts reads the flag for the owner and the box.
 *
 * Python on a box is pyenv's global, a python-build-standalone CPython uv
 * installed (packer/scripts/setup.sh); a box only moves within the minor it
 * runs (3.13.x): a new minor is the image's.
 *
 * The defaults are the safe side:
 *
 *   * floor 3.13.18 (2026-10-25), the newest 3.13 security release. Each PSF
 *     advisory (github.com/psf/advisory-database, PSF-2026-*) is mapped to the
 *     first v3.13.x tag that holds its fix commit; the changelog
 *     (docs.python.org/3.13/whatsnew/changelog.html, "Security") lists the same:
 *       - 3.13.18: CVE-2026-12345 (tempfile.TemporaryDirectory cleanup race,
 *         PSF-2026-42), CVE-2026-114583 (tarfile tar_filter bypass through link
 *         entries, PSF-2026-45), CVE-2026-115557 (ssl: a denylist of
 *         compromised eMudhra intermediate CA keys, PSF-2026-46).
 *       - 3.13.16 (2026-09-30): CVE-2026-82049 (tarfile filters, hard link to a
 *         symlink), CVE-2026-19445 (ssl sni_callback crash), CVE-2026-19553
 *         (ssl wrap_bio without server_hostname), CVE-2026-15806
 *         (HTTPPasswordMgr across schemes), CVE-2026-15310 (zip decompression
 *         bound), CVE-2026-17084 (stringprep), CVE-2026-87910 (tarfile link
 *         fallback).
 *       - 3.13.15 (2026-08-05): CVE-2026-11940, CVE-2026-11972, CVE-2026-4360
 *         (tarfile), CVE-2026-15308 (html.parser), CVE-2026-6879 (ElementTree),
 *         CVE-2026-18503 (csv), CVE-2026-0864 (configparser), CVE-2026-12003
 *         (in-tree landmark), CVE-2025-15366 (imaplib).
 *       - 3.13.14 (2026-06-10) and 3.13.13 (2026-04-07): CVE-2026-7774,
 *         CVE-2026-9669, CVE-2026-6100, CVE-2026-7210, CVE-2026-1502, and the
 *         rest of PSF-2026-9 to -27.
 *     3.13.17 (2026-10-21) only bumped the bundled pip. CVE-2026-103995 and
 *     CVE-2026-116566 (PSF-2026-47, -48, published after 3.13.18) have no 3.13
 *     release yet. Unlike most tools' floors this one is above part of the
 *     fleet (the image's 3.13 was whatever uv installed at its bake), as gh's
 *     is: those hosts are exposed.
 *   * target latest: the newest CPython of the box's own minor in the box's uv's
 *     list of downloads.
 *   * restart none: Python has no sessions to restart.
 */
import { parseClaudeUpdatePolicy, type ClaudeUpdatePolicy } from './claudeUpdatePolicy';

export const PYTHON_UPDATE_POLICY_FLAG = 'python-update-policy';

export const PYTHON_TARGET_TAGS: readonly string[] = ['latest'];

export const DEFAULT_PYTHON_UPDATE_POLICY: ClaudeUpdatePolicy = {
  mode: 'off',
  floor: '3.13.18',
  target: 'latest',
  restart: 'none',
  drainSec: 600,
  forceAfterHours: 24,
};

/** The flag's value, key by key over Python's defaults; a bad key keeps its default. */
export function parsePythonUpdatePolicy(value: unknown): ClaudeUpdatePolicy {
  return parseClaudeUpdatePolicy(value, DEFAULT_PYTHON_UPDATE_POLICY, PYTHON_TARGET_TAGS, undefined, PYTHON_UPDATE_POLICY_FLAG);
}
