/**
 * On-warm run reports
 *
 * Owns the translation from `~/.termag/on-warm.status.json`, as the agent
 * forwards it, into what an Instance row should hold. The file's contract is
 * documented in the header of `deploy/termag-hook-run`, which is its only
 * writer.
 *
 * Nothing here touches Prisma or the clock. `agentRegistry.ts` owns both, the
 * same split `instanceLifecycle.ts` uses.
 */

/** The `onWarmStatus` column's vocabulary. `pending` is the reconciler's value at launch, before any run has reported. */
export const ON_WARM_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type OnWarmStatus = typeof ON_WARM_STATUSES[number];

/** The states a run can report. A subset of the column's vocabulary, which is why the mapping below is an assignment. */
const RUN_STATES = ['running', 'succeeded', 'failed'] as const;
export type OnWarmRunState = typeof RUN_STATES[number];

/** One finished script, appended in run order, including the one that failed. */
export interface OnWarmScriptRun {
  script: string;
  seconds: number;
  exitCode: number;
}

interface OnWarmRunEvidence {
  durations: OnWarmScriptRun[];
  logTail: string;
}

/**
 * One report of a warm run's progress.
 *
 * Split by state rather than carried as one bag of nullable fields because the
 * failure detail only means anything on a failure. The runner nulls `script`,
 * `exitCode` and `reason` on success precisely so no stale script name can be
 * mistaken for a live one, and this shape makes that field unreadable rather
 * than merely null.
 */
export type OnWarmReport =
  | (OnWarmRunEvidence & { state: 'running'; script: string | null })
  | (OnWarmRunEvidence & { state: 'succeeded' })
  | (OnWarmRunEvidence & { state: 'failed'; script: string | null; exitCode: number | null; reason: string | null });

const MAX_LOG_TAIL_CHARS = 4096;
const MAX_FIELD_LENGTH = 256;

/**
 * Null when the payload carries no state this orchestrator understands, which
 * is the one field it cannot proceed without.
 *
 * `schema` is read past rather than checked. A box runs the copy of
 * `termag-hook-run` its own checkout holds and the orchestrator ships
 * separately, so the two versions are routinely out of step in both
 * directions; refusing a newer file would turn an upgraded box into a silent
 * warm-run timeout, when every field this function needs is present and means
 * the same thing. `state` is the version-independent part of the contract.
 */
export function parseOnWarmReport(raw: unknown): OnWarmReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;

  const state = RUN_STATES.find(s => s === fields.state);
  if (!state) return null;

  const evidence: OnWarmRunEvidence = {
    durations: parseDurations(fields.durations),
    logTail: typeof fields.logTail === 'string' ? fields.logTail : '',
  };

  switch (state) {
    case 'running':
      return { ...evidence, state, script: shortString(fields.script) };
    case 'succeeded':
      return { ...evidence, state };
    case 'failed':
      return {
        ...evidence,
        state,
        script: shortString(fields.script),
        exitCode: typeof fields.exitCode === 'number' && Number.isInteger(fields.exitCode) ? fields.exitCode : null,
        // Not a closed union. The runner's four reasons are documented in its
        // header, but a newer box may report one this build has never heard of
        // and an operator still needs to read it.
        reason: shortString(fields.reason),
      };
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

/**
 * The guarded `updateMany` a report implies, in the shape `warmCompletionUpdate`
 * uses.
 *
 * A failed run fails the box here rather than only recording `onWarmStatus`.
 * The lifecycle says a warming box whose on-warm run failed is `failed`, and
 * leaving it `warming` costs three things: it holds an in-flight slot so its
 * replacement is not launched, the breaker cannot see it, and nothing moves it
 * until the 45-minute stuck sweep eventually calls it incomplete, which is a
 * worse description of what happened than the reason this report carries.
 *
 * Guarded on `warming` because every state here describes a run that is only
 * meaningful while the box is still in the pool's boot phase. A late frame
 * arriving after the sweep has failed the box, or after a claim, must not
 * rewrite either outcome.
 */
export function onWarmRunUpdate(
  instanceId: string,
  report: OnWarmReport,
): {
  where: { id: string; status: 'warming' };
  data: { onWarmStatus: OnWarmStatus; onWarmLog: string; status?: 'failed'; provisioningError?: string };
} {
  const data = {
    onWarmStatus: report.state,
    onWarmLog: report.logTail.slice(-MAX_LOG_TAIL_CHARS),
  };
  return {
    where: { id: instanceId, status: 'warming' },
    data: report.state === 'failed'
      ? { ...data, status: 'failed' as const, provisioningError: failureLine(report) }
      : data,
  };
}

/** One line for `provisioningError`, which the breaker's log quotes back. */
function failureLine(report: Extract<OnWarmReport, { state: 'failed' }>): string {
  const at = report.script ? ` at ${report.script}` : '';
  const exit = report.exitCode === null ? '' : ` exit ${report.exitCode}`;
  return `on-warm ${report.reason ?? 'failed'}${at}${exit}`.slice(0, MAX_FIELD_LENGTH);
}

/**
 * Whether this report is the half of the warm promotion that on-warm owns.
 *
 * Only a short-circuit. `warmCompletionUpdate`'s where clause is what actually
 * authorises the promotion, so a caller that ignored this and always attempted
 * it would still be correct, just one query per progress report noisier.
 */
export function promotesToWarm(report: OnWarmReport): boolean {
  return report.state === 'succeeded';
}

/** One log line of a report, for the `[POOL]` operator trail. */
export function describeOnWarmRun(report: OnWarmReport): string {
  const scripts = report.durations.map(d => `${d.script} ${d.seconds}s`).join(', ');
  const suffix = scripts ? ` [${scripts}]` : '';

  switch (report.state) {
    case 'running':
      return `running${report.script ? ` ${report.script}` : ''}${suffix}`;
    case 'succeeded':
      return `succeeded${suffix}`;
    case 'failed': {
      const at = report.script ? ` at ${report.script}` : '';
      const exit = report.exitCode === null ? '' : ` exit ${report.exitCode}`;
      return `failed ${report.reason ?? 'unknown'}${at}${exit}${suffix}`;
    }
    default: {
      const unreachable: never = report;
      return unreachable;
    }
  }
}

function parseDurations(raw: unknown): OnWarmScriptRun[] {
  if (!Array.isArray(raw)) return [];
  const out: OnWarmScriptRun[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { script, seconds, exitCode } = entry as Record<string, unknown>;
    const name = shortString(script);
    if (!name) continue;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) continue;
    if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) continue;
    out.push({ script: name, seconds, exitCode });
  }
  return out;
}

// Every string here reaches a log line and a DB column, so newlines (which
// would forge a second log line) and unbounded length are cut at the boundary.
function shortString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\0\r\n]/g, ' ').trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_FIELD_LENGTH);
}
