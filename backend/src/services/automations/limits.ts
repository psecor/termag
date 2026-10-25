/**
 * Automation limits as tuning parameters: the `automation-limits` JSON flag over these defaults, read for
 * the owner and the box a run would land on, malformed keys falling back one
 * by one, as agent-spawn-limits does (services/spawnLimits.ts).
 */
import { jsonVariation } from '../featureFlags';
import type { FlagBox, FlagUser } from '../featureFlags';

export const AUTOMATION_LIMITS_FLAG = 'automation-limits';

export interface AutomationLimits {
  /** The smallest gap a schedule may have between occurrences. */
  minIntervalMinutes: number;
  /** Enabled automations one user may have. */
  maxEnabledPerUser: number;
  /** The most a single run may be allowed to take; the per-automation setting is capped here. */
  maxRunMinutes: number;
  /** Run-minutes one user may spend per UTC day across all automations. */
  dailyRunMinutes: number;
  /** Runs live at once on one box. */
  perBoxConcurrent: number;
  /** The most finished runs an automation may keep worktrees for. */
  keepRunsMax: number;
  /** Consecutive failed or timed-out runs that pause an automation. */
  pauseAfterFailures: number;
  /** A pending run waits this long for its box before it is skipped. */
  pendingMinutes: number;
}

export const DEFAULT_AUTOMATION_LIMITS: AutomationLimits = {
  minIntervalMinutes: 15,
  maxEnabledPerUser: 10,
  maxRunMinutes: 240,
  dailyRunMinutes: 480,
  perBoxConcurrent: 2,
  keepRunsMax: 50,
  pauseAfterFailures: 3,
  pendingMinutes: 15,
};

const posInt = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : undefined;

/** The limits a flag value gives, every malformed key falling back to its default. */
export function parseAutomationLimits(value: unknown, defaults: AutomationLimits = DEFAULT_AUTOMATION_LIMITS): AutomationLimits {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    minIntervalMinutes: posInt(v.minIntervalMinutes, 7 * 24 * 60) ?? defaults.minIntervalMinutes,
    maxEnabledPerUser: posInt(v.maxEnabledPerUser, 1000) ?? defaults.maxEnabledPerUser,
    maxRunMinutes: posInt(v.maxRunMinutes, 24 * 60) ?? defaults.maxRunMinutes,
    dailyRunMinutes: posInt(v.dailyRunMinutes, 24 * 60 * 100) ?? defaults.dailyRunMinutes,
    perBoxConcurrent: posInt(v.perBoxConcurrent, 100) ?? defaults.perBoxConcurrent,
    keepRunsMax: posInt(v.keepRunsMax, 1000) ?? defaults.keepRunsMax,
    pauseAfterFailures: posInt(v.pauseAfterFailures, 100) ?? defaults.pauseAfterFailures,
    pendingMinutes: posInt(v.pendingMinutes, 24 * 60) ?? defaults.pendingMinutes,
  };
}

/** The limits for this owner on this box, from the flag. */
export async function automationLimitsFor(user: FlagUser, box: FlagBox | null): Promise<AutomationLimits> {
  return parseAutomationLimits(await jsonVariation(AUTOMATION_LIMITS_FLAG, user, null, box));
}
