/**
 * The CLI's usage report: what `termag <command>`
 * POSTs to /api/cli/v1/usage once per run, checked here and recorded as the
 * `cli.command` product event. The command is the CLI's own name for it (its
 * COMMANDS key, `box list`), never its arguments or options; everything else
 * is an enum, a count or a version. Pure.
 */
import type { ProductEventDetail } from './productEvents';

/** A command name: one or two lowercase words, as the CLI's COMMANDS keys are. */
const COMMAND = /^[a-z][a-z0-9-]{0,30}( [a-z][a-z0-9-]{0,30})?$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const PHASES = ['started', 'finished'] as const;
/** A day: longer is a clock jump, not a run. */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export type CliUsageResult = { detail: ProductEventDetail } | { error: string };

export function parseCliUsage(body: unknown): CliUsageResult {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.command !== 'string' || !COMMAND.test(b.command)) return { error: 'command must be a termag command name' };
  if (!PHASES.includes(b.phase as typeof PHASES[number])) return { error: 'phase must be started or finished' };
  if (b.version !== undefined && (typeof b.version !== 'string' || !VERSION.test(b.version))) return { error: 'version is not a version' };
  if (b.exitCode !== undefined && !(Number.isInteger(b.exitCode) && (b.exitCode as number) >= 0 && (b.exitCode as number) <= 255)) {
    return { error: 'exitCode must be an integer from 0 to 255' };
  }
  if (b.durationMs !== undefined && !(typeof b.durationMs === 'number' && b.durationMs >= 0 && b.durationMs <= MAX_DURATION_MS)) {
    return { error: 'durationMs must be a number of milliseconds' };
  }
  for (const key of ['interactive', 'claudeCode'] as const) {
    if (b[key] !== undefined && typeof b[key] !== 'boolean') return { error: `${key} must be a boolean` };
  }
  return {
    detail: {
      command: b.command,
      phase: b.phase as string,
      version: b.version as string | undefined,
      exitCode: b.exitCode as number | undefined,
      durationMs: typeof b.durationMs === 'number' ? Math.round(b.durationMs) : undefined,
      interactive: b.interactive as boolean | undefined,
      claudeCode: b.claudeCode as boolean | undefined,
    },
  };
}
