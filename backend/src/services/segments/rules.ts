/**
 * The engagement-ladder rules.
 *
 * Pure functions only: no prisma, no dates beyond the ISO strings handed in.
 * windows are sliding calendar windows computed in UTC.
 */
import { dateAddDays, isoToday } from './dateutil';

export const SEGMENTS = ['New', 'Power', 'Active', 'Passive', 'Dormant', 'Service'] as const;
export type Segment = (typeof SEGMENTS)[number];

/** Sliding windows + thresholds. */
export const RULES = {
  NEW_DAYS: 3,
  ACTIVE_WINDOW: 7, ACTIVE_MIN: 3,
  PASSIVE_WINDOW: 7, PASSIVE_MIN: 1,
  POWER_WINDOW: 7, POWER_MIN: 5,
  POWER_CREAT_WINDOW: 30, POWER_BOXES: 2, POWER_CREATIONS: 5,
  DORMANT_WINDOW: 30,
} as const;

/** The agent-time floor for a day to count as active (5 min). */
export const AGENT_FLOOR_MS = 5 * 60 * 1000;

export interface UserDay {
  /** Signals for the day: 0 when there was none. `visited` is diagnostic only. */
  agentMs: number;
  humanMs: number;
  tokenRows: number;
  visited: boolean;
}
export interface CreationsDay { boxes: number; projects: number; workstreams: number }

/** Activity: any signal fires the day. */
export function isActiveDay(d: UserDay): boolean {
  return d.agentMs >= AGENT_FLOOR_MS || d.humanMs > 0 || d.tokenRows > 0;
}

function covered(active: Set<string>, day: string, window: number, minimum: number): boolean {
  const lo = dateAddDays(day, -(window - 1));
  let hits = 0;
  for (let d = lo; d <= day; d = dateAddDays(d, 1)) {
    if (active.has(d)) hits++;
  }
  return hits >= minimum;
}

/**
 * Segment for one user on one evaluation day, first match wins:
 * New > Power > Active > Passive > Dormant.
 *
 * @param tenureStart users.createdAt (YYYY-MM-DD): the New gate.
 * @param active days that passed isActiveDay, including days before tenureStart
 *   (backfilled signal) — only days >= tenureStart influence Newness etc.
 * @param creations boxes/projects/workstreams by creation day.
 * @param day the day being evaluated.
 */
export function segmentFor(
  tenureStart: string,
  active: Set<string>,
  creations: Map<string, CreationsDay>,
  day: string,
): Segment {
  const tenureDays = Math.floor((Date.parse(day) - Date.parse(tenureStart)) / 86_400_000) + 1;
  if (tenureDays <= RULES.NEW_DAYS) return 'New';

  let boxes = 0, creationsCount = 0;
  const lo = tenureStart > dateAddDays(day, -(RULES.POWER_CREAT_WINDOW - 1))
    ? tenureStart : dateAddDays(day, -(RULES.POWER_CREAT_WINDOW - 1));
  for (let d = lo; d <= day; d = dateAddDays(d, 1)) {
    const c = creations.get(d);
    if (c) { boxes += c.boxes; creationsCount += c.projects + c.workstreams; }
  }
  const powerCreation = boxes >= RULES.POWER_BOXES || creationsCount >= RULES.POWER_CREATIONS;

  if (covered(active, day, RULES.POWER_WINDOW, RULES.POWER_MIN) && powerCreation) return 'Power';
  if (covered(active, day, RULES.ACTIVE_WINDOW, RULES.ACTIVE_MIN)) return 'Active';
  if (covered(active, day, RULES.PASSIVE_WINDOW, RULES.PASSIVE_MIN)) return 'Passive';
  return 'Dormant';
}

/** Smallest helper: the day after an ISO date string. */
export { dateAddDays, isoToday };
