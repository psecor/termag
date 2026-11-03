import type { CommandSpec, ParsedArgs } from '../args.js';
import { bearerFor, session } from '../commands.js';
import { resolveBox } from '../connect/commands.js';
import type { Ctx } from '../context.js';
import { CliError, EXIT, usage, type ExitCode } from '../errors.js';
import { isMissingWs } from '../lazyWs.js';
import { formatBytes } from '../space.js';
import { parsePortSpecs } from './ports.js';
import { probeForward } from './probe.js';
import type { Totals } from './forwarder.js';

export const FORWARD_COMMANDS: Record<string, CommandSpec> = {
  forward: {
    summary: 'Forward local ports to ports on a box through the orchestrator, until Ctrl-C',
    usage: 'termag forward <box> <port>[:<local>]…\n\n'
      + 'Each <port> on the box is reached at localhost:<local> (default: the same port) on\n'
      + '127.0.0.1 and ::1 only. Local ports start at 1024.\n'
      + '  termag forward devbox 3000 5173\n'
      + '  termag forward devbox 80:8080',
    maxArgs: 101,
  },
};

export const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Resolves on Ctrl-C (or a SIGTERM or SIGHUP), which then no longer end the process. */
export function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const on = () => { for (const s of STOP_SIGNALS) process.off(s, on); resolve(); };
    for (const s of STOP_SIGNALS) process.on(s, on);
  });
}

export function describeTotals(t: Totals, box: string): string {
  const conns = `${t.connections} connection${t.connections === 1 ? '' : 's'}`;
  const failed = t.failed ? ` (${t.failed} failed)` : '';
  return `Forwarded ${conns}${failed}: ${formatBytes(t.bytesUp)} to ${box}, ${formatBytes(t.bytesDown)} from it.`;
}

/**
 * The relay, and with it `ws`, loads only for a forward. install.sh's `npm ci` empties
 * node_modules first, so after a failed or killed reinstall every other command, `termag
 * update` above all, must still start: nothing on the startup path may import `ws` statically.
 */
export async function loadForwarder(): Promise<typeof import('./forwarder.js')> {
  try {
    return await import('./forwarder.js');
  } catch (err) {
    if (!isMissingWs(err)) throw err;
    throw new CliError('failed', 'termag forward needs the `ws` package, which this install is missing (an interrupted reinstall?); run `termag update` or `cli/install.sh` in the termag checkout');
  }
}

export async function cmdForward(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [boxName, ...specs] = args.args;
  if (!boxName || specs.length === 0) throw usage(`Name a box and at least one port. Usage: ${FORWARD_COMMANDS.forward.usage.split('\n')[0]}`);
  const ports = parsePortSpecs(specs);
  const { startForward } = await loadForwarder();
  const s = session(ctx, args);
  const { api, box } = await resolveBox(ctx, s, boxName);

  const probe = await probeForward(api, box, ports);
  if (!probe.ok) {
    const meanwhile = probe.fallback ? `. Meanwhile, \`${probe.fallback}\` forwards the same ports over SSM` : '';
    throw new CliError(probe.code === 'forbidden' ? 'forbidden' : 'failed', `${probe.message}${meanwhile}`, probe.status, { code: probe.code });
  }

  const forward = await startForward({
    host: s.target.host,
    box,
    ports,
    token: bearerFor(ctx, s),
    exec: ctx.exec,
    notify: line => ctx.err(`termag forward: ${line}`),
  });
  if (args.json) {
    ctx.out(JSON.stringify({ box: { id: box.id, name: box.name }, listening: forward.listening }));
  } else {
    for (const l of forward.listening) ctx.out(`Forwarding localhost:${l.local} to ${box.name}:${l.port} (${l.addresses.join(', ')})`);
    ctx.out('Ctrl-C to stop.');
  }

  await (ctx.untilInterrupted ?? untilSignal)();
  const totals = await forward.stop();
  if (args.json) ctx.out(JSON.stringify({ totals }));
  else ctx.out(describeTotals(totals, box.name));
  return EXIT.OK;
}

export const FORWARD_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  forward: cmdForward,
};
