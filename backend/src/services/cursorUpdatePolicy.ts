/**
 * Cursor agent updates: the cursor-update-policy flag as
 * a parsed value, in the shape of Claude Code's (claudeUpdatePolicy.ts), whose
 * parser it uses with Cursor's defaults and Cursor's version shape. Pure:
 * Cursor's entry in services/toolUpdate/components.ts reads the flag for the
 * owner and the box.
 *
 * The Cursor agent CLI (`cursor-agent`, also linked as `agent`) is versioned by
 * date and build, `2026.10.22-27dcf5f`, the name of its directory under
 * ~/.local/share/cursor-agent/versions and of its download at
 * downloads.cursor.com/lab/<version>/. An exact version names the build.
 *
 * The defaults are the safe side:
 *
 *   * floor 2025.09.17-25b418f, from Cursor's published advisories for the CLI
 *     (github.com/cursor/cursor/security/advisories; the IDE's, versioned 1.x
 *     to 3.x, are another product):
 *       - CVE-2025-61591 (GHSA-wj33-264c-j9cq, high): remote code execution
 *         through the agent's MCP OAuth2 flow; before 2025.09.17-25b418f.
 *       - CVE-2025-61592 (GHSA-v64q-396f-7m79, high): code execution through
 *         a permissive CLI config in a repository; up to 2025.08.09-d8191f3,
 *         fixed in 2025.09.17-25b418f.
 *       - CVE-2025-61593 (GHSA-x2vq-h6v6-jhc6, high): sensitive file
 *         overwrite bypass; before 2025.09.12-4852336, fixed in
 *         2025.09.17-25b418f.
 *       - CVE-2025-64109 (GHSA-4hwr-97q3-37w2, high): command injection
 *         through a repository's .cursor/mcp.json; before 2025.09.17-25b418f.
 *     The fleet ran 2026.10.x on 2026-10-30, so this floor installs nothing on
 *     a box on its own.
 *   * target latest: the newest pinned build (CURSOR_PINNED_LATEST); there are
 *     no other channels to choose.
 *   * restart none, as Codex's: the sweep must not restart sessions until the
 *     flag says so.
 */
import { parseClaudeUpdatePolicy, type ClaudeUpdatePolicy } from './claudeUpdatePolicy';

export const CURSOR_UPDATE_POLICY_FLAG = 'cursor-update-policy';
/** The release flag: off, the admin routes answer 404 claude_update_off for Cursor and a box's policy says restart nothing. */
export const CURSOR_UPDATE_ENABLED_FLAG = 'cursor-update-enabled';

export const CURSOR_TARGET_TAGS: readonly string[] = ['latest'];

/**
 * What `latest` is for the Cursor agent: the newest build that
 * deploy/termag-cursor-update pins for every arch (its PINS), which is what a
 * box resolves latest to, not the newest build Cursor or the fleet's
 * inventory names. The Software tab's "behind" and the fleet's Update behind
 * compare with it, so a box on it is current and one Cursor's own updater
 * moved past it is ahead, never behind (Bugbot on #1080).
 * cursorUpdatePolicy.test.ts reads the recipe's PINS and fails until this
 * moves with them.
 */
export const CURSOR_PINNED_LATEST = '2026.10.22-27dcf5f';

const VERSION = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{6,40}$/;
/** An exact Cursor agent build, `YYYY.MM.DD-<hex>`, nothing before or after it. */
export const isCursorVersion = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v);

export const DEFAULT_CURSOR_UPDATE_POLICY: ClaudeUpdatePolicy = {
  floor: '2025.09.17-25b418f',
  target: 'latest',
  restart: 'none',
  drainSec: 600,
  forceAfterHours: 24,
};

/** The flag's value, key by key over Cursor's defaults; a bad key keeps its default. */
export function parseCursorUpdatePolicy(value: unknown): ClaudeUpdatePolicy {
  return parseClaudeUpdatePolicy(value, DEFAULT_CURSOR_UPDATE_POLICY, CURSOR_TARGET_TAGS, isCursorVersion);
}
