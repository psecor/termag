/**
 * Caps for space channels and the Slack router as tuning parameters:
 * the `space-slack-limits` JSON flag over
 * these defaults, malformed keys falling back one by one, as agent-spawn-limits
 * does (services/spawnLimits.ts). A space's own `SpaceSlack.limits` is parsed
 * the same way over the flag's value, so it can tighten or loosen one key
 * without restating the rest.
 */
import { jsonVariation } from '../featureFlags';
import type { FlagUser } from '../featureFlags';

export const SPACE_SLACK_LIMITS_FLAG = 'space-slack-limits';

export interface SpaceSlackLimits {
  /** Slack channels linked to one space. */
  channelsPerSpace: number;
  /** Orchestrator turns running at once for one space. */
  concurrentTurnsPerSpace: number;
  /** Space and router turns running at once across termag. */
  concurrentTurnsAll: number;
  /** Router turns one person may start per UTC day. */
  routerTurnsPerDay: number;
  /** Space turns one requester may start per UTC day, across spaces. */
  turnsPerRequesterPerDay: number;
  /** Spaces a read-only cross-space question fans out to. */
  fanOut: number;
  /** Asks a space orchestrator may have open at once. */
  asksPerSpace: number;
  /** Ask approval cards one requester may raise per UTC day. */
  asksPerRequesterPerDay: number;
  /** When an unapproved approval card expires. */
  cardTtlHours: number;
  /** New boxes a space may propose per UTC day. */
  newBoxesPerDay: number;
  /** Orchestrator run-minutes one space may spend per UTC day. */
  runMinutesPerDay: number;
  /** Streamed answers started per minute (Slack's Tier-2 budget, shared by every stream). */
  streamStartsPerMinute: number;
  /** Private channels may be linked. */
  allowPrivate: boolean;
}

export const DEFAULT_SPACE_SLACK_LIMITS: SpaceSlackLimits = {
  channelsPerSpace: 5,
  concurrentTurnsPerSpace: 2,
  concurrentTurnsAll: 10,
  routerTurnsPerDay: 200,
  turnsPerRequesterPerDay: 60,
  fanOut: 3,
  asksPerSpace: 5,
  asksPerRequesterPerDay: 20,
  cardTtlHours: 24,
  newBoxesPerDay: 1,
  runMinutesPerDay: 480,
  streamStartsPerMinute: 18,
  allowPrivate: true,
};

const posInt = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : undefined;
const nonNegInt = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** The limits a flag value (or a space's overrides) gives, every malformed key keeping its default. */
export function parseSpaceSlackLimits(value: unknown, defaults: SpaceSlackLimits = DEFAULT_SPACE_SLACK_LIMITS): SpaceSlackLimits {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    channelsPerSpace: posInt(v.channelsPerSpace, 100) ?? defaults.channelsPerSpace,
    concurrentTurnsPerSpace: posInt(v.concurrentTurnsPerSpace, 50) ?? defaults.concurrentTurnsPerSpace,
    concurrentTurnsAll: posInt(v.concurrentTurnsAll, 1000) ?? defaults.concurrentTurnsAll,
    routerTurnsPerDay: posInt(v.routerTurnsPerDay, 100_000) ?? defaults.routerTurnsPerDay,
    turnsPerRequesterPerDay: posInt(v.turnsPerRequesterPerDay, 100_000) ?? defaults.turnsPerRequesterPerDay,
    fanOut: posInt(v.fanOut, 20) ?? defaults.fanOut,
    // 0 turns a capability off for a space without turning the flag off for everyone.
    asksPerSpace: nonNegInt(v.asksPerSpace, 100) ?? defaults.asksPerSpace,
    asksPerRequesterPerDay: nonNegInt(v.asksPerRequesterPerDay, 1000) ?? defaults.asksPerRequesterPerDay,
    cardTtlHours: posInt(v.cardTtlHours, 7 * 24) ?? defaults.cardTtlHours,
    newBoxesPerDay: nonNegInt(v.newBoxesPerDay, 20) ?? defaults.newBoxesPerDay,
    runMinutesPerDay: posInt(v.runMinutesPerDay, 24 * 60 * 10) ?? defaults.runMinutesPerDay,
    streamStartsPerMinute: posInt(v.streamStartsPerMinute, 1000) ?? defaults.streamStartsPerMinute,
    allowPrivate: bool(v.allowPrivate) ?? defaults.allowPrivate,
  };
}

/**
 * The limits for a space, read for its runner: the flag over the defaults,
 * then the space's own `SpaceSlack.limits` over that.
 */
export async function spaceSlackLimitsFor(runner: FlagUser, spaceOverrides: unknown = null): Promise<SpaceSlackLimits> {
  const fromFlag = parseSpaceSlackLimits(await jsonVariation(SPACE_SLACK_LIMITS_FLAG, runner, null));
  return parseSpaceSlackLimits(spaceOverrides, fromFlag);
}
