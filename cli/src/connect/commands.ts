import type { WhoamiResponse } from '../api.js';
import type { ParsedArgs } from '../args.js';
import { authedApi, session, type Session } from '../commands.js';
import type { Ctx } from '../context.js';
import { loadLogin } from '../credentials.js';
import { CliError, EXIT, usage, type ExitCode } from '../errors.js';
import { json } from '../output.js';
import { awsSettings, preflight } from './aws.js';
import { findTool, runAttached } from './process.js';
import {
  assertNoStrayWords, buildSshArgv, inDirectory, LOGIN_SHELL, remoteCommandLine, scanSshOptions,
  shQuote, splitAtDoubleDash,
} from './sshArgs.js';
import { installBlock, proxyCommandFor, renderBlock, sshConfigPath } from './sshConfig.js';
import {
  aliasFor, boxFromAlias, parseRef, pickBox, pickProject, ssmTarget, type ConnectBox, type ConnectProject, type Ref,
} from './target.js';

interface Resolved {
  box: ConnectBox;
  project: ConnectProject | null;
  instanceId: string;
  region: string;
  /** The box's unix user, falling back to the account's for an agent that never reported one. */
  user: string;
  ownerUnixUser: () => Promise<string>;
}

async function resolve(ctx: Ctx, s: Session, ref: Ref): Promise<Resolved> {
  const api = await authedApi(ctx, s);
  const { boxes } = await api.request<{ boxes: ConnectBox[] }>('GET', '/boxes');
  const box = pickBox(boxes, ref.box);
  const { instanceId, region } = ssmTarget(box, awsSettings(ctx.env).defaultRegion);
  let project: ConnectProject | null = null;
  if (ref.project) {
    const { projects } = await api.request<{ projects: ConnectProject[] }>('GET', '/projects');
    project = pickProject(projects, box, ref.project);
  }
  let who: Promise<WhoamiResponse> | null = null;
  const ownerUnixUser = async () => (await (who ??= api.request<WhoamiResponse>('GET', '/whoami'))).user.unixUsername;
  const user = box.hostUnixUser || await ownerUnixUser();
  return { box, project, instanceId, region, user, ownerUnixUser };
}

// Relative to the home directory ssh lands in, for an orchestrator that predates `directory`.
const directoryOf = (p: ConnectProject) => p.directory ?? `termag/projects/${p.name}`;

async function connect(ctx: Ctx, r: Resolved, opts: { userOptions: string[]; remote: string | null; tty: boolean }): Promise<ExitCode> {
  const settings = awsSettings(ctx.env);
  const { awsPath } = await preflight(ctx, settings, { interactive: ctx.interactive, loginStdio: 'inherit' });
  const sshPath = findTool('ssh', ctx.env);
  if (!sshPath) throw new CliError('failed', 'ssh (OpenSSH) is not installed');
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
  return await runAttached(sshPath, argv, ctx.env) as ExitCode;
}

export async function cmdSsh(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = parseRef(args.args[0]);
  const { options, command } = splitAtDoubleDash(args.passthrough ?? []);
  const scanned = scanSshOptions(options);
  assertNoStrayWords(scanned);
  const r = await resolve(ctx, session(ctx, args), ref);

  const noCommand = scanned.flags.has('N');
  let remote = noCommand ? null : remoteCommandLine(command);
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
  return connect(ctx, r, { userOptions: options, remote, tty });
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
  return connect(ctx, r, { userOptions: [], remote: `tmux attach-session -t ${shQuote(name)}`, tty: true });
}

/**
 * How ssh should start this CLI: the `termag` on PATH by absolute path (it
 * survives upgrades), else this very node and script.
 */
function termagCommand(ctx: Ctx): string[] {
  const onPath = findTool('termag', ctx.env, { fallback: false });
  return onPath ? [onPath] : [process.execPath, process.argv[1]];
}

// A box reports its own unix user, so only names that can't break out of their ssh_config line go in.
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const SAFE_USER = /^[a-z_][a-z0-9_.-]*$/;

export async function cmdSshConfig(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const s = session(ctx, args);
  const api = await authedApi(ctx, s);
  const user = loadLogin(s.credsPath, s.target.host)?.unixUsername
    ?? (await api.request<WhoamiResponse>('GET', '/whoami')).user.unixUsername;
  const { boxes } = await api.request<{ boxes: ConnectBox[] }>('GET', '/boxes');
  const block = renderBlock({
    user,
    hostUsers: boxes
      .filter(b => b.hostUnixUser && b.hostUnixUser !== user && SAFE_NAME.test(b.name) && SAFE_USER.test(b.hostUnixUser))
      .map(b => ({ alias: aliasFor(b), user: b.hostUnixUser! }))
      .sort((a, b) => a.alias.localeCompare(b.alias)),
    proxyCommand: proxyCommandFor(termagCommand(ctx), s.target.source === 'default' ? null : s.target.host),
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
  if (result.action !== 'unchanged') ctx.out('`ssh termag-<box>` now reaches each of your boxes. Re-run this after adding a box.');
  return EXIT.OK;
}

/**
 * ssh runs this with the connection on stdin and stdout, so nothing but the
 * SSM session may ever write to stdout. A person is present when stderr is a
 * terminal; an editor's Remote-SSH gets a one-line reason instead of a prompt.
 */
export async function cmdSshProxy(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [alias, port] = args.args;
  if (!alias || !port) throw usage('Usage: termag ssh-proxy termag-<box> <port>');
  if (port !== '22') throw new CliError('failed', `termag reaches boxes on port 22 only, not ${port}`);
  const r = await resolve(ctx, session(ctx, args), { box: boxFromAlias(alias), project: null });
  const settings = awsSettings(ctx.env);
  const { awsPath } = await preflight(ctx, settings, { interactive: ctx.stderrIsTTY ?? false, loginStdio: ['ignore', 2, 2] });
  const code = await runAttached(awsPath, [
    'ssm', 'start-session', '--target', r.instanceId, '--document-name', settings.document,
    '--parameters', `portNumber=${port}`, '--region', r.region, '--profile', settings.profile,
  ], ctx.env);
  return code as ExitCode;
}

export const CONNECT_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  ssh: cmdSsh,
  attach: cmdAttach,
  'ssh-config': cmdSshConfig,
  'ssh-proxy': cmdSshProxy,
};
