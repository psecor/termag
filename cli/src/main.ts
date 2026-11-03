import { helpText, parseCommandLine, type ParsedArgs } from './args.js';
import { cmdBoxList, cmdLogin, cmdLogout, cmdProjectList, cmdWhoami } from './commands.js';
import { CONNECT_HANDLERS } from './connect/commands.js';
import { defaultCtx, type Ctx } from './context.js';
import { LIFECYCLE_HANDLERS } from './lifecycle.js';
import { CliError, EXIT, type ExitCode } from './errors.js';
import { VERSION } from './version.js';
import { cmdTui } from './tui.js';
import { cmdDoctor } from './doctor.js';
import { cmdUpdate } from './update.js';
import { ASK_HANDLERS } from './ask.js';
import { SPACE_HANDLERS } from './space.js';
import { cmdSpaceMemory } from './spaceMemory.js';
import { cmdSpaceSync } from './spaceSync.js';
import { HANDOFF_HANDLERS } from './handoff.js';
import { FORWARD_HANDLERS } from './forward/command.js';
import { AUTOMATION_HANDLERS } from './automation.js';
import { BUG_HANDLERS } from './bug.js';
import { EVENTS_HANDLERS } from './events/command.js';
import { AWAITED_AT_START, REPORTED_AT_START, countRequests, usageReport, usageReporter, type UsageReporter } from './usage.js';

const HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  tui: cmdTui,
  update: cmdUpdate,
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  doctor: cmdDoctor,
  'box list': cmdBoxList,
  'project list': cmdProjectList,
  ...LIFECYCLE_HANDLERS,
  ...CONNECT_HANDLERS,
  ...FORWARD_HANDLERS,
  ...ASK_HANDLERS,
  ...SPACE_HANDLERS,
  'space memory': cmdSpaceMemory,
  'space sync': cmdSpaceSync,
  ...HANDOFF_HANDLERS,
  ...AUTOMATION_HANDLERS,
  ...BUG_HANDLERS,
  ...EVENTS_HANDLERS,
};

function reportError(ctx: Ctx, err: CliError, asJson: boolean): void {
  if (asJson) ctx.err(JSON.stringify({ error: { code: err.code, message: err.message } }));
  else ctx.err(`termag: ${err.message}`);
}

/** `report` sends the run's usage report (usage.ts); unset, nothing is sent, as in tests. */
export async function run(argv: string[], ctx: Ctx, opts: { report?: UsageReporter } = {}): Promise<ExitCode> {
  const asJson = argv.includes('--json');
  let args: ParsedArgs;
  try {
    args = parseCommandLine(argv);
  } catch (err) {
    if (err instanceof CliError) { reportError(ctx, err, asJson); return err.exitCode; }
    throw err;
  }
  if (args.version) { ctx.out(args.json ? JSON.stringify({ version: VERSION }) : `termag ${VERSION}`); return EXIT.OK; }
  if (args.help || !args.command) {
    ctx.out(helpText(args.command));
    return args.help ? EXIT.OK : EXIT.USAGE;
  }
  const command = args.command;
  const startedAt = Date.now();
  const atStart = REPORTED_AT_START.has(command);
  // A long-running command's isn't awaited: it runs while the report goes, and an open request keeps
  // the process up only as long as its timeout. logout's is, before the sign-in it goes with is revoked.
  if (atStart) {
    const sent = opts.report?.(args, usageReport(ctx, command, null));
    if (AWAITED_AT_START.has(command)) await sent;
  }
  let code: ExitCode;
  try {
    code = await HANDLERS[command](ctx, args);
  } catch (err) {
    const e = err instanceof CliError ? err : new CliError('failed', (err as Error)?.message ?? String(err));
    reportError(ctx, e, args.json);
    code = e.exitCode;
  }
  if (!atStart) await opts.report?.(args, usageReport(ctx, command, { exitCode: code, durationMs: Date.now() - startedAt }));
  return code;
}

export async function main(argv: string[]): Promise<number> {
  const ctx = defaultCtx();
  const requests = countRequests(ctx);
  return run(argv, ctx, { report: usageReporter(ctx, { requests }) });
}
