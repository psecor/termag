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
import { HANDOFF_HANDLERS } from './handoff.js';

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
  ...ASK_HANDLERS,
  ...SPACE_HANDLERS,
  ...HANDOFF_HANDLERS,
};

function reportError(ctx: Ctx, err: CliError, asJson: boolean): void {
  if (asJson) ctx.err(JSON.stringify({ error: { code: err.code, message: err.message } }));
  else ctx.err(`termag: ${err.message}`);
}

export async function run(argv: string[], ctx: Ctx): Promise<ExitCode> {
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
  try {
    return await HANDLERS[args.command](ctx, args);
  } catch (err) {
    const e = err instanceof CliError ? err : new CliError('failed', (err as Error)?.message ?? String(err));
    reportError(ctx, e, args.json);
    return e.exitCode;
  }
}

export async function main(argv: string[]): Promise<number> {
  return run(argv, defaultCtx());
}
