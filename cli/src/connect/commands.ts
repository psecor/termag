import type { Api, WhoamiResponse } from '../api.js';
import type { ParsedArgs } from '../args.js';
import { authedApi, session, type Session } from '../commands.js';
import type { Ctx } from '../context.js';
import { loadLogin } from '../credentials.js';
import { CliError, EXIT, usage, type ExitCode } from '../errors.js';
import { START_WAIT_S, startAndWait, timeoutSeconds } from '../lifecycle.js';
import { json } from '../output.js';
import { awsSettings, preflight } from './aws.js';
import { findTool, runAttached } from './process.js';
import {
  assertNoStrayWords, buildSshArgv, inDirectory, LOGIN_SHELL, remoteCommandLine, scanSshOptions,
  shQuote, splitAtDoubleDash,
} from './sshArgs.js';
import { installBlock, proxyCommandFor, renderBlock, sshConfigPath, sshHosts } from './sshConfig.js';
import { FALLBACK_TERM, fallbackNotice, planTerm, sshSessionConfig, withTerminfo } from './terminfo.js';
import {
  aliasFor, boxFromAlias, parseRef, pickBox, pickProject, ssmTarget, wakeAction, type ConnectBox, type ConnectProject,
  type Ref,
} from './target.js';

export interface Resolved {
  api: Api;
  box: ConnectBox;
  project: ConnectProject | null;
  instanceId: string;
  region: string;
  /** The box's unix user, falling back to the account's for an agent that never reported one. */
  user: string;
  ownerUnixUser: () => Promise<string>;
}

/** A box by name (or id) from the caller's /boxes, with the client that listed it; null is the only box. */
export async function resolveBox(ctx: Ctx, s: Session, name: string | null): Promise<{ api: Api; box: ConnectBox }> {
  const api = await authedApi(ctx, s);
  const { boxes } = await api.request<{ boxes: ConnectBox[] }>('GET', '/boxes');
  return { api, box: pickBox(boxes, name) };
}

/** A box (and project) to reach over SSM: the box must be an EC2 box that is running. */
export async function resolve(ctx: Ctx, s: Session, ref: Ref): Promise<Resolved> {
  const { api, box } = await resolveBox(ctx, s, ref.box);
  const { instanceId, region } = ssmTarget(box, awsSettings(ctx.env).defaultRegion);
  let project: ConnectProject | null = null;
  if (ref.project) {
    const { projects } = await api.request<{ projects: ConnectProject[] }>('GET', '/projects');
    project = pickProject(projects, box, ref.project);
  }
  let who: Promise<WhoamiResponse> | null = null;
  const ownerUnixUser = async () => (await (who ??= api.request<WhoamiResponse>('GET', '/whoami'))).user.unixUsername;
  const user = box.hostUnixUser || await ownerUnixUser();
  return { api, box, project, instanceId, region, user, ownerUnixUser };
}

// Relative to the home directory ssh lands in, for an orchestrator that predates `directory`.
export const directoryOf = (p: ConnectProject) => p.directory ?? `termag/projects/${p.name}`;

interface ConnectOptions {
  userOptions: string[];
  remote: string | null;
  tty: boolean;
  /**
   * The session is a terminal on the box: a shell or tmux. Its TERM then has
   * to be one the box knows (terminfo.ts). With no remote command, ssh's own
   * login shell becomes LOGIN_SHELL so the check has a command to precede.
   */
  terminal?: boolean;
}

async function connect(ctx: Ctx, r: Resolved, opts: ConnectOptions): Promise<ExitCode> {
  const settings = awsSettings(ctx.env);
  const { awsPath } = await preflight(ctx, settings, { interactive: ctx.interactive, loginStdio: 'inherit' });
  const sshPath = findTool('ssh', ctx.env);
  if (!sshPath) throw new CliError('failed', 'ssh (OpenSSH) is not installed');
  let env = ctx.env;
  if (opts.terminal) {
    let plan = await planTerm(ctx.env);
    if (plan.kind === 'install' && opts.remote === null) {
      // ssh's own shell gains a command and -t only where ssh's configuration has room for them.
      const config = await sshSessionConfig(sshPath, [...opts.userOptions, aliasFor(r.box)], ctx.env);
      if (config.noTty) plan = { kind: 'keep' };
      else if (config.remoteCommand) plan = { kind: 'fallback', term: plan.term, reason: "ssh's RemoteCommand leaves no command to install its terminfo entry before" };
    }
    if (plan.kind === 'install') {
      opts = { ...opts, remote: withTerminfo(plan.term, plan.source, opts.remote ?? LOGIN_SHELL), tty: true };
    } else if (plan.kind === 'fallback') {
      ctx.err(fallbackNotice(plan));
      env = { ...ctx.env, TERM: FALLBACK_TERM };
    }
  }
  const argv = buildSshArgv({
    route: { awsPath, instanceId: r.instanceId, region: r.region, profile: settings.profile, document: settings.document },
    alias: aliasFor(r.box),
    user: r.user,
    userOptions: opts.userOptions,
    remote: opts.remote,
    tty: opts.tty,
    batch: !ctx.interactive,
  });
  // ssh's own exit status is the result, as with running ssh directly.
  return await runAttached(sshPath, argv, env) as ExitCode;
}

export async function cmdSsh(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = parseRef(args.args[0]);
  const { options, command } = splitAtDoubleDash(args.passthrough ?? []);
  const scanned = scanSshOptions(options);
  assertNoStrayWords(scanned);
  const r = await resolve(ctx, session(ctx, args), ref);

  const noCommand = scanned.flags.has('N');
  let remote = noCommand ? null : remoteCommandLine(command);
  // A shell on the box: ssh's own (no command, a pty unless -T) or the project's login shell.
  const terminal = remote === null && !noCommand && ctx.interactive && !scanned.flags.has('T');
  let tty = false;
  if (r.project && !noCommand) {
    const dir = directoryOf(r.project);
    if (remote === null) {
      remote = inDirectory(dir, LOGIN_SHELL);
      tty = ctx.interactive && !scanned.flags.has('T') && !scanned.flags.has('t');
    } else {
      remote = inDirectory(dir, remote);
    }
  }
  return connect(ctx, r, { userOptions: options, remote, tty, terminal });
}

export async function cmdAttach(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = parseRef(args.args[0]);
  if (!ref.project) throw usage('`termag attach` needs a project: termag attach <box>/<project>');
  if (!ctx.interactive) {
    throw new CliError('failed', '`termag attach` needs a terminal; from a script, use `termag ssh <box>/<project> -- <cmd>`');
  }
  const r = await resolve(ctx, session(ctx, args), ref);
  const role = args.options.ctrl ? 'ctrl' : 'agent';
  const name = r.project!.sessions?.[role] ?? `${await r.ownerUnixUser()}-${r.project!.name}-${role}`;
  return connect(ctx, r, { userOptions: [], remote: `tmux attach-session -t ${shQuote(name)}`, tty: true, terminal: true });
}

/**
 * How ssh should start this CLI: the `termag` on PATH by absolute path (it
 * survives upgrades), else this very node and script.
 */
function termagCommand(ctx: Ctx): string[] {
  const onPath = findTool('termag', ctx.env, { fallback: false });
  return onPath ? [onPath] : [process.execPath, process.argv[1]];
}

export async function cmdSshConfig(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const wake = args.options.wake === true;
  const s = session(ctx, args);
  const api = await authedApi(ctx, s);
  const user = loadLogin(s.credsPath, s.target.host)?.unixUsername
    ?? (await api.request<WhoamiResponse>('GET', '/whoami')).user.unixUsername;
  const [{ boxes }, { projects }] = await Promise.all([
    api.request<{ boxes: ConnectBox[] }>('GET', '/boxes'),
    api.request<{ projects: ConnectProject[] }>('GET', '/projects'),
  ]);
  const { hostUsers, sessionHosts, skipped } = sshHosts(user, boxes, projects);
  for (const ref of skipped) {
    ctx.err(`${ref} has no termag-<box>.<project> host: a name in it has characters ssh_config can't carry. \`termag attach ${ref}\` reaches it.`);
  }
  const block = renderBlock({
    user,
    hostUsers,
    sessionHosts,
    proxyCommand: proxyCommandFor(termagCommand(ctx), s.target.source === 'default' ? null : s.target.host, { wake }),
  });
  const path = sshConfigPath(ctx.home);
  if (!args.options.install) {
    if (args.json) ctx.out(json({ path, entry: block }));
    else ctx.out(block);
    return EXIT.OK;
  }
  const result = installBlock(path, block);
  if (args.json) { ctx.out(json(result)); return EXIT.OK; }
  const verb = { added: 'Added the termag entry to', updated: 'Updated the termag entry in', unchanged: 'The termag entry is already in' }[result.action];
  ctx.out(`${verb} ${result.path}.${result.backup ? ` The previous file is ${result.backup}.` : ''}`);
  if (result.action !== 'unchanged') {
    ctx.out(wake
      ? '`ssh termag-<box>` now reaches each of your boxes and starts a parked one, and `ssh termag-<box>.<project>` (or `.ctrl`) attaches to a project. Re-run `termag ssh-config --install --wake` after adding a box or a project.'
      : '`ssh termag-<box>` now reaches each of your boxes, and `ssh termag-<box>.<project>` (or `.ctrl`) attaches to a project. Re-run this after adding a box or a project.');
  }
  return EXIT.OK;
}

/**
 * ssh runs this with the connection on stdin and stdout, so nothing but the
 * SSM session may ever write to stdout. A person is present when stderr is a
 * terminal; an editor's Remote-SSH gets a one-line reason instead of a prompt.
 */
export async function cmdSshProxy(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [alias, port] = args.args;
  if (!alias || !port) throw usage('Usage: termag ssh-proxy [--wake [--timeout <seconds>]] termag-<box> <port>');
  if (port !== '22') throw new CliError('failed', `termag reaches boxes on port 22 only, not ${port}`);
  const wake = args.options.wake === true;
  if (!wake && args.options.timeout !== undefined) throw usage('--timeout goes with --wake, which waits for the box');
  const timeoutS = timeoutSeconds(args, START_WAIT_S);
  const { api, box } = await resolveBox(ctx, session(ctx, args), boxFromAlias(alias));
  const settings = awsSettings(ctx.env);
  const action = wake && box.kind === 'ec2' ? wakeAction(box.state) : 'connect';
  const wakes = action !== 'connect' && action !== 'refuse';
  // A box that won't be woken is refused before AWS is touched.
  if (!wakes) ssmTarget(box, settings.defaultRegion);
  const { awsPath } = await preflight(ctx, settings, { interactive: ctx.stderrIsTTY ?? false, loginStdio: ['ignore', 2, 2] });
  let target = box;
  if (wakes) {
    ctx.err(`termag: ${box.name} is ${box.state}; bringing it up before connecting (--wake)`);
    target = (await startAndWait(ctx, api, box, timeoutS, false)).box as ConnectBox;
  }
  const { instanceId, region } = ssmTarget(target, settings.defaultRegion);
  const code = await runAttached(awsPath, [
    'ssm', 'start-session', '--target', instanceId, '--document-name', settings.document,
    '--parameters', `portNumber=${port}`, '--region', region, '--profile', settings.profile,
  ], ctx.env);
  return code as ExitCode;
}

export const CONNECT_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  ssh: cmdSsh,
  attach: cmdAttach,
  'ssh-config': cmdSshConfig,
  'ssh-proxy': cmdSshProxy,
};
