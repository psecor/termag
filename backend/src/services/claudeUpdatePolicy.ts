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

export type ClaudeUpdateRestart = 'none' | 'idle' | 'force';

/**
 * Whether updating a tool is on, and whether the sweep updates it on its own:
 * `off` turns off the Software tab's actions
 * (404), the sweep and session restarts, and keeps the floor, as the enabled
 * flag off did: a run gets the floor only, restart none, and Claude Code's
 * runner wrapper still enforces the floor; `manual`, the Software tab is on and
 * the sweep does nothing; `auto`, the sweep runs it too (toolUpdate/gate.ts).
 * A missing or malformed mode is `off`, and so is a policy the flag source cannot
 * serve (its fallback is null).
 */
export type ToolUpdateMode = 'off' | 'manual' | 'auto';
export const MODES: readonly ToolUpdateMode[] = ['off', 'manual', 'auto'];
export const isMode = (v: unknown): v is ToolUpdateMode => typeof v === 'string' && (MODES as readonly string[]).includes(v);

/** The flag and value pairs already logged as a missing or malformed mode: each is logged once per process, not on every read. */
const loggedModes = new Set<string>();

/**
 * A policy flag's `mode`, one of MODES. Missing (the key absent, null, or a
 * flag the flag source cannot serve) or malformed, it is `off`, the safe side,
 * and each is logged once per flag and value.
 */
export function parseUpdateMode(value: unknown, flag: string): ToolUpdateMode {
  if (isMode(value)) return value;
  const missing = value === undefined || value === null;
  const shown = missing ? 'missing' : (JSON.stringify(value) ?? String(value)).slice(0, 60);
  const key = `${flag}\u0000${shown}`;
  if (!loggedModes.has(key)) {
    loggedModes.add(key);
    console.warn(missing
      ? `[TOOL-UPDATE] ${flag}: no mode; off`
      : `[TOOL-UPDATE] ${flag}: mode ${shown} is not off, manual or auto; off`);
  }
  return 'off';
}

/** Tests: log every missing or malformed mode again. */
export function resetLoggedModesForTests(): void { loggedModes.clear(); }
export const RESTARTS: readonly ClaudeUpdateRestart[] = ['none', 'idle', 'force'];

export interface ClaudeUpdatePolicy {
  /** Off, manual or automatic (ToolUpdateMode); off when the flag has none, or a malformed one. */
  mode: ToolUpdateMode;
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
  mode: 'off',
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
 * defaults, the dist-tags its package publishes and its flag's key, which a
 * malformed mode's log line names (codexUpdatePolicy.ts).
 */
export function parseClaudeUpdatePolicy(
  value: unknown, defaults: ClaudeUpdatePolicy = DEFAULT_CLAUDE_UPDATE_POLICY, tags: readonly string[] = CLAUDE_TARGET_TAGS,
  isVersion: (v: unknown) => v is string = isClaudeVersion, flag: string = CLAUDE_UPDATE_POLICY_FLAG,
): ClaudeUpdatePolicy {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    // A mode has no default to fall back to: missing or malformed, it is off.
    mode: parseUpdateMode(v.mode, flag),
    floor: isVersion(v.floor) ? v.floor : defaults.floor,
    target: (typeof v.target === 'string' && tags.includes(v.target)) || isVersion(v.target) ? v.target as string : defaults.target,
    restart: isRestart(v.restart) ? v.restart : defaults.restart,
    drainSec: intIn(v.drainSec, 0, 3600) ?? defaults.drainSec,
    forceAfterHours: intIn(v.forceAfterHours, 1, 168) ?? defaults.forceAfterHours,
  };
}
