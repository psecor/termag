/**
 * How far before a run row's current launch a box's report may be stamped
 * and still be that launch's. Box clocks
 * drift by seconds; a report from well before the launch belongs to an
 * earlier launch of the same relaunched order (recordRunnerStart reopens the
 * row with a new startedAt). Shared by the `started` rule
 * (services/claudeSessions.ts) and the usage rule
 * (services/claudeRunnerSessions.ts); its own module so neither imports the
 * other for a number.
 */
export const LAUNCH_SKEW_MS = 60 * 1000;
