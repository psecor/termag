import { freshAccess, expiresAtFrom } from './access.js';
import { Api, type BearerSource, type Box, type Project, type WhoamiResponse } from './api.js';
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

/** The login's access token, refreshed with its device token when missing, about to lapse, or `rejected`. */
async function accessToken(ctx: Ctx, s: Session, login: StoredLogin, opts: { rejected?: string; validForMs?: number } = {}): Promise<string> {
  return (await freshAccess({ host: s.target.host, credsPath: s.credsPath, fetch: ctx.fetch }, login, opts)).accessToken;
}

/**
 * The bearer for this orchestrator, asked for before every request: a device
 * login's access token (refreshed when about to lapse) wins over the box's own
 * credential. Given the token the orchestrator just refused (`rejected`), it
 * refreshes, unless another request already has; a box's credential is what
 * it is.
 */
export function bearerFor(ctx: Ctx, s: Session): BearerSource {
  const notSignedIn = () => new CliError('auth_required', `Not signed in to ${s.target.host}; run \`termag login\``);
  const login = loadLogin(s.credsPath, s.target.host);
  if (!login) {
    const boxToken = s.target.box?.token;
    if (!boxToken) throw notSignedIn();
    return async () => boxToken;
  }
  // Re-read per request: a refresh saves the new access token, and a logout elsewhere removes the login.
  return async (opts = {}) => {
    const current = loadLogin(s.credsPath, s.target.host);
    if (!current) throw notSignedIn();
    return accessToken(ctx, s, current, { rejected: opts.rejected, validForMs: opts.validForMs });
  };
}

/** A device login for this orchestrator wins over the box's own credential. */
export async function authedApi(ctx: Ctx, s: Session, opts: { timeoutMs?: number } = {}): Promise<Api> {
  const login = loadLogin(s.credsPath, s.target.host);
  const token = !login && s.target.box?.token ? s.target.box.token : bearerFor(ctx, s);
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

const REQUIREMENTS_RE = /^(\d+)vcpu-(\d+)gib$/;

/** `4vcpu-32gib` as "4 vCPU, 32 GB": a requirements box before EC2 has said which type it got. */
function requirementsText(size: string): string {
  const m = REQUIREMENTS_RE.exec(size);
  return m ? `${m[1]} vCPU, ${m[2]} GB` : size;
}

/**
 * A box's size in a sentence: the preset's name; for a box sized by its
 * repo's requirements, the type it launched as, else the requirements; null
 * for no size.
 */
export function boxSizeText(b: Pick<Box, 'size' | 'instanceType'>): string | null {
  if (!b.size) return null;
  return REQUIREMENTS_RE.test(b.size) ? b.instanceType ?? requirementsText(b.size) : b.size;
}

/** The box's size and disk, as a create says what it got: `large, 200 GB disk`; null when neither is known. */
export function boxSpecText(b: Pick<Box, 'size' | 'instanceType' | 'diskGiB'>): string | null {
  const parts = [boxSizeText(b), b.diskGiB ? `${b.diskGiB} GB disk` : null].filter((p): p is string => !!p);
  return parts.length ? parts.join(', ') : null;
}

/**
 * The SIZE column: the size and the type it got; the type alone for a box
 * sized by its repo's .termag/environment.json requirements (recorded as
 * `4vcpu-32gib`) and for a box with no size; `-` when neither is known.
 */
export function boxSizeCell(b: Pick<Box, 'size' | 'instanceType'>): string {
  if (b.size && REQUIREMENTS_RE.test(b.size)) return b.instanceType ?? requirementsText(b.size);
  if (b.size) return b.instanceType ? `${b.size} (${b.instanceType})` : b.size;
  return b.instanceType ?? '-';
}

export async function cmdBoxList(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const s = session(ctx, args);
  const api = await authedApi(ctx, s);
  const { boxes } = await api.request<{ boxes: Box[] }>('GET', '/boxes');
  if (args.json) { ctx.out(json({ boxes })); return EXIT.OK; }
  if (boxes.length === 0) { ctx.out('No boxes. Create one with `termag box create <name>`.'); return EXIT.OK; }
  ctx.out(table(
    ['BOX', 'STATE', 'SIZE', 'DISK', 'AGENT', 'PROJECTS'],
    boxes.map(b => [
      b.name,
      b.state === 'failed' && b.error ? `failed: ${b.error}` : b.state,
      b.resize?.running ? `${boxSizeCell(b)} -> ${b.resize.to} (${b.resize.phase})` : boxSizeCell(b),
      b.diskGiB ? `${b.diskGiB} GB` : '-',
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
