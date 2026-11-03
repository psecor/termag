/**
 * Claude Code updates: the
 * claude-code-update-policy flag as a parsed value. Pure: the flag's raw value
 * comes from the caller (Claude Code's entry in services/toolUpdate/components.ts
 * reads it for the owner and the box), and every answer here is a plain value.
 *
 * The flag is a config flag whose fallback is null, so a deployment without
 * the flag source, or one the flag source cannot answer, runs these defaults. Each
 * key is validated on its own and a bad one keeps its default, so a typo in
 * the flag source cannot lower the floor or turn a restart into a force.
 */

export const CLAUDE_UPDATE_POLICY_FLAG = 'claude-code-update-policy';
/** The release flag: off, the admin routes answer 404 claude_update_off and a box's policy says restart nothing. */
export const CLAUDE_UPDATE_ENABLED_FLAG = 'claude-code-update-enabled';

export type ClaudeUpdateRestart = 'none' | 'idle' | 'force';
export const RESTARTS: readonly ClaudeUpdateRestart[] = ['none', 'idle', 'force'];

export interface ClaudeUpdatePolicy {
  /** The lowest version a runner or a box may run: `x.y.z`. */
  floor: string;
  /** What an update installs: an npm dist-tag (`latest`, `stable`) or an exact `x.y.z`. */
  target: string;
  /** How a run restarts the sessions on an old binary. */
  restart: ClaudeUpdateRestart;
  /** How long a run waits for a session to go idle before it stops it, in seconds. */
  drainSec: number;
  /** How long a box may stay below the floor before the sweep forces (phase 3). */
  forceAfterHours: number;
}

export const DEFAULT_CLAUDE_UPDATE_POLICY: ClaudeUpdatePolicy = {
  floor: '2.1.308',
  target: 'latest',
  restart: 'idle',
  drainSec: 600,
  forceAfterHours: 24,
};

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
/** An exact Claude Code version, `x.y.z`, nothing before or after it. */
export const isClaudeVersion = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v);

export const isRestart = (v: unknown): v is ClaudeUpdateRestart => typeof v === 'string' && (RESTARTS as readonly string[]).includes(v);

const intIn = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

/** The npm dist-tags Claude Code's target may name. */
export const CLAUDE_TARGET_TAGS: readonly string[] = ['latest', 'stable'];

/**
 * The flag's value, key by key over the defaults. Another tool's policy has
 * the same shape (services/toolUpdate/components.ts) and passes its own
 * defaults and the dist-tags its package publishes (codexUpdatePolicy.ts).
 */
export function parseClaudeUpdatePolicy(
  value: unknown, defaults: ClaudeUpdatePolicy = DEFAULT_CLAUDE_UPDATE_POLICY, tags: readonly string[] = CLAUDE_TARGET_TAGS,
  isVersion: (v: unknown) => v is string = isClaudeVersion,
): ClaudeUpdatePolicy {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    floor: isVersion(v.floor) ? v.floor : defaults.floor,
    target: (typeof v.target === 'string' && tags.includes(v.target)) || isVersion(v.target) ? v.target as string : defaults.target,
    restart: isRestart(v.restart) ? v.restart : defaults.restart,
    drainSec: intIn(v.drainSec, 0, 3600) ?? defaults.drainSec,
    forceAfterHours: intIn(v.forceAfterHours, 1, 168) ?? defaults.forceAfterHours,
  };
}
