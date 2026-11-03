/**
 * Usage reports: one `POST /api/cli/v1/usage` per
 * command run, which the orchestrator records as its `cli.command` product
 * event. The report names the command as COMMANDS does (`box list`), never
 * its arguments or options.
 *
 * Best effort: a short timeout and every failure swallowed, so a report never
 * changes what a command prints or returns. Skipped with no usable credential
 * for the orchestrator (it never asks for a login, and refreshes one only for
 * a report at start; see usageBearer), and with TERMAG_TELEMETRY=0 or
 * DO_NOT_TRACK=1. A run that made no request of its own hands its report to a
 * detached process rather than wait for it (usageReporter).
 */
import { REFRESH_MARGIN_MS } from './access.js';
import { Api, cliRequest } from './api.js';
import type { ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { loadLogin, type StoredLogin } from './credentials.js';
import { VERSION } from './version.js';

const REPORT_TIMEOUT_MS = 1500;

/**
 * Commands that report as they start. Most run until someone ends them, often
 * with Ctrl-C or by closing the terminal, so a report at the end may never be
 * sent; theirs goes in the background while they run. `logout` revokes the
 * sign-in its report would go with, so it waits for its report first
 * (AWAITED_AT_START). Every other command reports when it finishes, with its
 * exit code.
 */
export const REPORTED_AT_START: ReadonlySet<string> = new Set(['tui', 'ssh', 'attach', 'ssh-proxy', 'forward', 'events', 'logout']);
export const AWAITED_AT_START: ReadonlySet<string> = new Set(['logout']);

export interface UsageReport {
  command: string;
  phase: 'started' | 'finished';
  version: string;
  exitCode?: number;
  durationMs?: number;
  /** A person at a terminal (Ctx.interactive). */
  interactive: boolean;
  /** Run from Claude Code's Bash tool, which sets CLAUDECODE=1. */
  claudeCode: boolean;
}

export type UsageReporter = (args: ParsedArgs, report: UsageReport) => Promise<void>;

export function usageOptedOut(env: NodeJS.ProcessEnv): boolean {
  const telemetry = env.TERMAG_TELEMETRY?.trim().toLowerCase();
  const dnt = env.DO_NOT_TRACK?.trim();
  return telemetry === '0' || telemetry === 'false' || telemetry === 'off' || (!!dnt && dnt !== '0');
}

export function usageReport(
  ctx: Pick<Ctx, 'env' | 'interactive'>,
  command: string,
  outcome: { exitCode: number; durationMs: number } | null,
): UsageReport {
  return {
    command,
    phase: outcome ? 'finished' : 'started',
    version: VERSION,
    ...(outcome && { exitCode: outcome.exitCode, durationMs: Math.round(outcome.durationMs) }),
    interactive: ctx.interactive,
    claudeCode: ctx.env.CLAUDECODE === '1',
  };
}

/**
 * The bearer a finished run's report goes with, never refreshed: a device
 * sign-in's access token while it is good, else (with no sign-in) the box's
 * own token, else none. A refresh has the CLI's usual timeout, and an open
 * request keeps the process up after the command is done; a command that
 * called the API has refreshed the token already. A report sent in the
 * background as a long-running command starts may refresh: the command keeps
 * the process up anyway. One the command waits for does not.
 */
export function usageBearer(login: Pick<StoredLogin, 'accessToken' | 'accessTokenExpiresAt'> | null, boxToken: string | undefined, now = Date.now()): string | null {
  if (!login) return boxToken ?? null;
  const expiresAt = Date.parse(login.accessTokenExpiresAt ?? '');
  return login.accessToken && expiresAt - REFRESH_MARGIN_MS > now ? login.accessToken : null;
}

/**
 * Counts the requests made through `ctx.fetch` from now on, by wrapping it.
 * `main` hands the count to usageReporter, so a run's report knows whether it
 * would be the run's first request.
 */
export function countRequests(ctx: Ctx): () => number {
  const inner = ctx.fetch;
  let n = 0;
  ctx.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => { n++; return inner(input, init); }) as typeof fetch;
  return () => n;
}

/**
 * The reporter `main` hands to `run`: posts with this machine's credential for the orchestrator.
 *
 * A finished run whose command made no request (`requests` says 0), such as
 * the `space memory context` hooks Claude Code runs at every session start and
 * prompt, would wait for a whole new connection to the orchestrator, about
 * 40 ms, just to report. Its report goes to `ctx.postInBackground` instead, a
 * detached process, and the run ends at once. A run that made a request sends
 * its own: the connection is open, and it costs about nothing.
 */
export function usageReporter(ctx: Ctx, opts: { requests?: () => number } = {}): UsageReporter {
  return async (args, report) => {
    if (usageOptedOut(ctx.env)) return;
    try {
      const s = session(ctx, args);
      let api: Api;
      if (report.phase === 'started' && !AWAITED_AT_START.has(report.command)) {
        api = await authedApi(ctx, s, { timeoutMs: REPORT_TIMEOUT_MS });
      } else {
        const token = usageBearer(loadLogin(s.credsPath, s.target.host), s.target.box?.token);
        if (!token) return;
        if (report.phase === 'finished' && ctx.postInBackground && opts.requests?.() === 0) {
          ctx.postInBackground({ ...cliRequest(s.target.host, 'POST', '/usage', report, token), timeoutMs: REPORT_TIMEOUT_MS });
          return;
        }
        api = new Api({ host: s.target.host, token, fetch: ctx.fetch, timeoutMs: REPORT_TIMEOUT_MS });
      }
      await api.request('POST', '/usage', report);
    } catch {
      // Telemetry only: not signed in, unreachable, a refused token, an older orchestrator's 404.
    }
  };
}
