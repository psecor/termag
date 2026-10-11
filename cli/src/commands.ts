import { freshAccess, expiresAtFrom } from './access.js';
import { Api, type Box, type Project, type WhoamiResponse } from './api.js';
import type { ParsedArgs } from './args.js';
import { resolveTarget, type Target } from './config.js';
import type { Ctx } from './context.js';
import { credentialsPath, loadLogin, removeLogin, saveLogin, type StoredLogin } from './credentials.js';
import { runDoctor } from './doctor.js';
import { CliError, EXIT, type ExitCode } from './errors.js';
import { browserLogin, deviceNameFrom } from './login.js';
import { formatDate, json, table } from './output.js';

export interface Session {
  target: Target;
  credsPath: string;
}

export function session(ctx: Ctx, args: ParsedArgs): Session {
  return {
    target: resolveTarget(args.host, ctx.env, ctx.home, ctx.readFile),
    credsPath: credentialsPath(ctx.env, ctx.home),
  };
}

/** The login's access token, refreshed with its device token when missing or about to lapse. */
async function accessToken(ctx: Ctx, s: Session, login: StoredLogin): Promise<string> {
  return (await freshAccess({ host: s.target.host, credsPath: s.credsPath, fetch: ctx.fetch }, login)).accessToken;
}

/** A device login for this orchestrator wins over the box's own credential. */
export async function authedApi(ctx: Ctx, s: Session, opts: { timeoutMs?: number } = {}): Promise<Api> {
  const notSignedIn = () => new CliError('auth_required', `Not signed in to ${s.target.host}; run \`termag login\``);
  const login = loadLogin(s.credsPath, s.target.host);
  if (!login) {
    if (!s.target.box?.token) throw notSignedIn();
    return new Api({ host: s.target.host, token: s.target.box.token, fetch: ctx.fetch, timeoutMs: opts.timeoutMs });
  }
  // Re-read per request: a refresh saves the new access token, and a logout elsewhere removes the login.
  const token = async () => {
    const current = loadLogin(s.credsPath, s.target.host);
    if (!current) throw notSignedIn();
    return accessToken(ctx, s, current);
  };
  return new Api({ host: s.target.host, token, fetch: ctx.fetch, timeoutMs: opts.timeoutMs });
}

function describeCredential(who: WhoamiResponse): string {
  const c = who.credential;
  return c.kind === 'device'
    ? `device sign-in "${c.deviceName}", lapses ${formatDate(c.expiresAt)} if unused (at the latest ${formatDate(c.maxExpiresAt)})`
    : "this box's own credentials";
}

export async function cmdLogin(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const s = session(ctx, args);
  const deviceOption = args.options.device;
  if (s.target.box && deviceOption === undefined) {
    const who = await new Api({ host: s.target.host, token: s.target.box.token, fetch: ctx.fetch }).request<WhoamiResponse>('GET', '/whoami');
    if (!args.json) {
      ctx.out(`On this box termag uses the box's own credentials: signed in to ${s.target.host} as ${who.user.email}.`);
      ctx.out('');
    }
    const doctor = await runDoctor(ctx, args, { print: !args.json, fix: !args.json, yes: args.yes });
    if (args.json) ctx.out(json({ host: s.target.host, ...who, doctor }));
    return EXIT.OK;
  }
  if (!ctx.interactive) {
    throw new CliError('auth_required', `Not signed in to ${s.target.host}; \`termag login\` needs a person at a terminal`);
  }
  const deviceName = deviceNameFrom(typeof deviceOption === 'string' ? deviceOption : ctx.hostname);
  const token = await browserLogin({
    host: s.target.host,
    deviceName,
    fetch: ctx.fetch,
    openBrowser: ctx.openBrowser,
    notify: ctx.err,
    timeoutMs: ctx.loginTimeoutMs,
  });
  saveLogin(s.credsPath, s.target.host, {
    token: token.token,
    accessToken: token.accessToken,
    accessTokenExpiresAt: expiresAtFrom(token.accessTokenExpiresIn),
    deviceName: token.deviceName,
    email: token.user.email,
    unixUsername: token.user.unixUsername,
    expiresAt: token.expiresAt,
    maxExpiresAt: token.maxExpiresAt,
  });
  if (!args.json) {
    ctx.out(`Signed in to ${s.target.host} as ${token.user.email} on "${token.deviceName}".`);
    ctx.out(`Stays signed in while used at least weekly, until ${formatDate(token.maxExpiresAt)} at the latest.`);
    ctx.out('');
  }
  const doctor = await runDoctor(ctx, args, { print: !args.json, fix: !args.json, yes: args.yes });
  if (args.json) {
    ctx.out(json({ host: s.target.host, user: token.user, deviceName: token.deviceName, expiresAt: token.expiresAt, maxExpiresAt: token.maxExpiresAt, doctor }));
  }
  return EXIT.OK;
}

export async function cmdLogout(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const s = session(ctx, args);
  const login = loadLogin(s.credsPath, s.target.host);
  if (!login) {
    const message = s.target.box
      ? `Not signed in to ${s.target.host} with \`termag login\`; this box's own credentials stay in place.`
      : `Not signed in to ${s.target.host}.`;
    if (args.json) ctx.out(json({ host: s.target.host, signedOut: false }));
    else ctx.out(message);
    return EXIT.OK;
  }
  let revoked = true;
  try {
    await new Api({ host: s.target.host, token: await accessToken(ctx, s, login), fetch: ctx.fetch }).request('DELETE', '/token');
  } catch (err) {
    // A token the server already refuses is as good as revoked.
    if (!(err instanceof CliError && err.code === 'auth_required')) revoked = false;
  }
  removeLogin(s.credsPath, s.target.host);
  if (args.json) ctx.out(json({ host: s.target.host, signedOut: true, revoked }));
  else ctx.out(`Signed out of ${s.target.host}.`);
  if (!revoked) {
    ctx.err(`termag: could not reach ${s.target.host} to revoke the token; sign "${login.deviceName}" out in the web UI (Settings, CLI sign-ins).`);
  }
  return EXIT.OK;
}

export async function cmdWhoami(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const s = session(ctx, args);
  const api = await authedApi(ctx, s);
  const who = await api.request<WhoamiResponse>('GET', '/whoami');
  if (args.json) {
    ctx.out(json({ host: s.target.host, ...who }));
  } else {
    ctx.out(`${who.user.email} (${who.user.unixUsername}) on ${s.target.host}`);
    ctx.out(`via ${describeCredential(who)}`);
  }
  return EXIT.OK;
}

export async function cmdBoxList(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const s = session(ctx, args);
  const api = await authedApi(ctx, s);
  const { boxes } = await api.request<{ boxes: Box[] }>('GET', '/boxes');
  if (args.json) { ctx.out(json({ boxes })); return EXIT.OK; }
  if (boxes.length === 0) { ctx.out('No boxes. Create one with `termag box create <name>`.'); return EXIT.OK; }
  ctx.out(table(
    ['BOX', 'STATE', 'AGENT', 'PROJECTS'],
    boxes.map(b => [
      b.name,
      b.state === 'failed' && b.error ? `failed: ${b.error}` : b.state,
      b.agentConnected ? 'connected' : '-',
      b.projects.map(p => p.name).join(', ') || '-',
    ]),
  ));
  const unaddressable = boxes.filter(b => !b.addressable).map(b => `"${b.name}"`);
  if (unaddressable.length) {
    ctx.err(`termag: ${unaddressable.join(', ')} can't be used as a box name on the command line (letters, digits, - and _ only); rename in the web UI.`);
  }
  return EXIT.OK;
}

export async function cmdProjectList(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const s = session(ctx, args);
  const api = await authedApi(ctx, s);
  const { projects } = await api.request<{ projects: Project[] }>('GET', '/projects');
  if (args.json) { ctx.out(json({ projects })); return EXIT.OK; }
  if (projects.length === 0) { ctx.out('No projects.'); return EXIT.OK; }
  ctx.out(table(
    ['PROJECT', 'AGENT', 'STATUS'],
    projects.map(p => [
      p.ref,
      p.provider ?? '-',
      p.status === 'waiting' && p.waitingReason ? `waiting (${p.waitingReason})` : p.status.replace('_', ' '),
    ]),
  ));
  return EXIT.OK;
}
