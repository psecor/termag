import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freshAccess } from './access.js';
import { Api, type WhoamiResponse } from './api.js';
import type { ParsedArgs } from './args.js';
import { resolveTarget } from './config.js';
import type { Ctx } from './context.js';
import type { ExecResult } from './system.js';
import { credentialsPath, loadLogin, type StoredLogin } from './credentials.js';
import {
  AWS_PROFILE, TERMAG_ACCOUNT, TERMAG_ROLE, awsProfileSection, findTermagSshHost, parseGhInclude,
  sshKeyFingerprint, ssoAuthorizeUrl,
} from './doctorProbes.js';
import { installAwsProfile, MIN_AWS_CLI, parseAwsCliVersion, supportsSsoSession } from './connect/awsConfig.js';
import { CliError, EXIT, type ExitCode } from './errors.js';
import { formatDate, json } from './output.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
  /** Not applicable here (on a box) or not checkable yet (not signed in). */
  skipped?: boolean;
  /** Was failing, and doctor fixed it in this run. */
  fixed?: boolean;
}

export interface DoctorReport {
  host: string;
  ok: boolean;
  summary: Record<CheckStatus, number>;
  checks: CheckResult[];
}

/** The orgs whose SSO a GitHub token must be authorized for. */
export const GITHUB_ORGS = ['example-org', 'example-labs'];

interface Repair {
  question: string;
  /** Returns a note for the result line, or throws a CliError with the reason it failed. */
  apply: () => Promise<string | void>;
}

interface Outcome {
  status: CheckStatus;
  detail: string;
  fix?: string;
  skipped?: boolean;
  repair?: Repair;
}

interface Check {
  id: string;
  title: string;
  run: (s: State) => Promise<Outcome>;
}

interface CredentialsView {
  github: { available: boolean; connected: { label: string; updatedAt: string } | null };
  claudeGateway: { available: boolean; enabled: boolean };
  sshKeys: Array<{ fingerprint: string; comment: string }>;
}

interface LocalGh {
  installed: boolean;
  /** Held in memory to store it with termag; never printed. */
  token: string | null;
  login: string | null;
}

interface State {
  ctx: Ctx;
  host: string;
  credsPath: string;
  /** A device login wins over the box's own token, as in authedApi. */
  login: StoredLogin | null;
  boxToken: string | null;
  api: Api | null;
  credentialKind: 'device' | 'box' | null;
  credentials?: CredentialsView | 'unsupported';
  gh?: LocalGh;
}

const notInstalled = async (): Promise<ExecResult> => ({ code: 127, stdout: '', stderr: '' });

function exec(s: State, cmd: string, args: string[]): Promise<ExecResult> {
  return (s.ctx.exec ?? notInstalled)(cmd, args);
}

function tilde(s: State, path: string): string {
  return path.startsWith(s.ctx.home + '/') ? '~' + path.slice(s.ctx.home.length) : path;
}

const firstLine = (text: string) => text.trim().split(/\r?\n/).find(Boolean)?.trim() ?? '';

const fail = (detail: string, fix?: string, repair?: Repair): Outcome => ({ status: 'fail', detail, fix, repair });
const warn = (detail: string, fix?: string, repair?: Repair): Outcome => ({ status: 'warn', detail, fix, repair });
const ok = (detail: string): Outcome => ({ status: 'ok', detail });

const ON_BOX: Outcome = { status: 'ok', detail: 'skipped: not needed on a box', skipped: true };
const NEEDS_LOGIN: Outcome = { status: 'warn', detail: 'skipped: needs a sign-in (see Login)', skipped: true };
const fixInTerminal = (what: string) => `run \`termag doctor\` in a terminal to ${what}`;

async function credentials(s: State): Promise<CredentialsView | 'unsupported'> {
  if (!s.credentials) {
    try {
      s.credentials = await s.api!.request<CredentialsView>('GET', '/credentials');
    } catch (err) {
      if (err instanceof CliError && err.code === 'not_found') s.credentials = 'unsupported';
      else throw err;
    }
  }
  return s.credentials;
}

const UNSUPPORTED: Outcome = { status: 'warn', detail: 'skipped: this orchestrator predates `termag doctor`', skipped: true };

async function localGh(s: State): Promise<LocalGh> {
  if (!s.gh) {
    const r = await exec(s, 'gh', ['auth', 'token']);
    const token = r.code === 0 && /^[A-Za-z0-9_]{20,300}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
    let login: string | null = null;
    if (token) {
      const who = await exec(s, 'gh', ['api', 'user', '--jq', '.login']);
      login = who.code === 0 && who.stdout.trim() ? who.stdout.trim() : null;
    }
    s.gh = { installed: r.code !== 127, token, login };
  }
  return s.gh;
}

// ── Checks ──────────────────────────────────────────────────────────────────

const loginCheck: Check = {
  id: 'login',
  title: 'Login',
  async run(s) {
    if (!s.login && !s.boxToken) return fail(`not signed in to ${s.host}`, 'termag login');
    let api: Api;
    let who: WhoamiResponse;
    try {
      const token = s.login
        ? (await freshAccess({ host: s.host, credsPath: s.credsPath, fetch: s.ctx.fetch }, s.login)).accessToken
        : s.boxToken;
      api = new Api({ host: s.host, token, fetch: s.ctx.fetch });
      who = await api.request<WhoamiResponse>('GET', '/whoami');
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      if (err.code === 'auth_required') return fail(`${s.host} refused the sign-in: ${err.message}`, 'termag login');
      if (err.code === 'unreachable' || err.code === 'timeout') return fail(err.message, 'check --host / TERMAG_URL and your network');
      return fail(err.message);
    }
    s.api = api;
    s.credentialKind = who.credential.kind;
    const c = who.credential;
    return ok(c.kind === 'device'
      ? `${who.user.email} on ${s.host}, device "${c.deviceName}" (lapses ${formatDate(c.expiresAt)} if unused)`
      : `${who.user.email} on ${s.host}, through this box's own credentials`);
  },
};

interface LocalKey { path: string; line: string; fingerprint: string }

function localKeys(s: State): LocalKey[] {
  const out: LocalKey[] = [];
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const path = join(s.ctx.home, '.ssh', `${name}.pub`);
    const line = s.ctx.readFile(path)?.trim();
    const fingerprint = line ? sshKeyFingerprint(line) : null;
    if (line && fingerprint) out.push({ path, line, fingerprint });
  }
  return out;
}

// Adding a key is web-only: the CLI API has no route for it (routes/cliCredentials.ts).
function addKeyInWebUi(s: State, path: string): string {
  return `add ${tilde(s, path)} in the web UI: ${s.host}/settings (SSH keys)`;
}

const sshKeyCheck: Check = {
  id: 'ssh-key',
  title: 'SSH key',
  async run(s) {
    if (s.credentialKind === 'box') return ON_BOX;
    const keys = localKeys(s);
    const defaultPath = join(s.ctx.home, '.ssh', 'id_ed25519');
    const generate: Repair = {
      question: `Generate ${tilde(s, defaultPath)} with ssh-keygen?`,
      apply: async () => {
        mkdirSync(dirname(defaultPath), { recursive: true, mode: 0o700 });
        const code = await s.ctx.execInteractive!('ssh-keygen', ['-t', 'ed25519', '-f', defaultPath]);
        if (code !== 0) throw new CliError('failed', code === 127 ? 'ssh-keygen is not installed' : `ssh-keygen exited ${code}`);
      },
    };
    if (!s.api) {
      return keys.length ? NEEDS_LOGIN : fail('no SSH key in ~/.ssh', 'ssh-keygen -t ed25519, then `termag doctor`', generate);
    }
    const creds = await credentials(s);
    if (creds === 'unsupported') return UNSUPPORTED;
    const registered = new Set(creds.sshKeys.map(k => k.fingerprint));
    const match = keys.find(k => registered.has(k.fingerprint));
    if (match) return ok(`${tilde(s, match.path)} (${match.fingerprint}) is registered`);
    if (keys.length === 0) {
      return fail('no SSH key in ~/.ssh to register', `ssh-keygen -t ed25519, then ${addKeyInWebUi(s, `${defaultPath}.pub`)}`, generate);
    }
    const key = keys[0];
    return fail(`${tilde(s, key.path)} (${key.fingerprint}) is not registered, so boxes won't accept it`, addKeyInWebUi(s, key.path));
  },
};

const githubCheck: Check = {
  id: 'github',
  title: 'GitHub',
  async run(s) {
    if (s.credentialKind === 'box') return ON_BOX;
    if (!s.api) return NEEDS_LOGIN;
    const creds = await credentials(s);
    if (creds === 'unsupported') return UNSUPPORTED;
    const gh = await localGh(s);
    const store: Repair | undefined = gh.token ? {
      question: 'Store your `gh` login\'s token with termag? Boxes use it through termag; it never lands on a box.',
      apply: async () => {
        await s.api!.request<{ label: string }>('PUT', '/github', { token: gh.token });
      },
    } : undefined;
    const noLocal = gh.installed
      ? 'gh auth login, then `termag doctor`'
      : 'install gh (https://cli.github.com), run gh auth login, then `termag doctor`';

    if (!creds.github.available) {
      return warn('this orchestrator has no credential store, so boxes cannot use your GitHub login');
    }
    const connected = creds.github.connected;
    if (connected) {
      if (gh.login && connected.label !== `@${gh.login}`) {
        return warn(
          `termag holds ${connected.label}'s token, but gh is signed in as @${gh.login}`,
          fixInTerminal(`replace it with @${gh.login}'s`),
          store,
        );
      }
      return ok(`connected as ${connected.label} (stored ${formatDate(connected.updatedAt)})`);
    }
    if (!gh.token) {
      return fail(`not connected, and ${gh.installed ? 'gh is not signed in' : 'gh is not installed'}`, noLocal);
    }
    return fail(
      'not connected: boxes cannot clone private repositories',
      `${fixInTerminal('store your gh token')}, or paste \`gh auth token\` in the web UI (Settings, Credentials)`,
      store,
    );
  },
};

const githubSsoCheck: Check = {
  id: 'github-sso',
  title: 'GitHub SSO',
  async run(s) {
    if (s.credentialKind === 'box') return ON_BOX;
    const gh = await localGh(s);
    if (!gh.token) return { status: 'warn', detail: 'skipped: needs a gh login (see GitHub)', skipped: true };
    const authorized: string[] = [];
    const needsSso: Array<{ org: string; url: string | null }> = [];
    const other: string[] = [];
    for (const org of GITHUB_ORGS) {
      const r = await exec(s, 'gh', ['api', '--include', `user/memberships/orgs/${org}`]);
      const res = parseGhInclude(r.stdout);
      if (res.status === 200) authorized.push(org);
      else if (res.status === 403 && res.sso) needsSso.push({ org, url: ssoAuthorizeUrl(res.sso) });
      else if (res.status === 404) other.push(`not a member of ${org}`);
      else other.push(`could not check ${org}${res.status ? ` (HTTP ${res.status})` : `: ${firstLine(r.stderr) || 'gh api failed'}`}`);
    }
    if (needsSso.length) {
      const orgs = needsSso.map(n => n.org).join(' and ');
      const urls = needsSso.map(n => n.url).filter(Boolean);
      return warn(
        `the gh token is not SSO-authorized for ${orgs}: clones from ${orgs} will fail`,
        urls.length ? `authorize it at ${urls.join(' and ')}` : `gh auth refresh -h github.com, and authorize ${orgs} when asked`,
      );
    }
    if (other.length) return warn(other.join('; '));
    return ok(`the gh token is authorized for ${authorized.join(' and ')}`);
  },
};

function awsConfigPath(s: State): string {
  return s.ctx.env.AWS_CONFIG_FILE || join(s.ctx.home, '.aws', 'config');
}

const awsProfileCheck: Check = {
  id: 'aws-profile',
  title: 'AWS profile',
  async run(s) {
    if (s.credentialKind === 'box') return ON_BOX;
    const path = awsConfigPath(s);
    const existing = s.ctx.readFile(path);
    const section = awsProfileSection(existing, AWS_PROFILE);
    if (!section) {
      return fail(`no [profile ${AWS_PROFILE}] in ${tilde(s, path)}`, fixInTerminal('add it'), {
        question: `Add the ${AWS_PROFILE} profile (Termag account, ${TERMAG_ROLE} role) to ${tilde(s, path)}?`,
        // The same managed [sso-session] block `termag ssh` writes, so one AWS sign-in lasts the portal session.
        apply: async () => {
          const r = await exec(s, 'aws', ['--version']);
          const version = parseAwsCliVersion(`${r.stdout} ${r.stderr}`);
          if (version && !supportsSsoSession(version)) {
            throw new Error(`AWS CLI ${version.join('.')} predates the [sso-session] profile; install ${MIN_AWS_CLI.join('.')} or later`);
          }
          installAwsProfile(path, AWS_PROFILE);
        },
      });
    }
    if (section.sso_account_id !== TERMAG_ACCOUNT || section.sso_role_name !== TERMAG_ROLE) {
      return warn(
        `[profile ${AWS_PROFILE}] signs in to account ${section.sso_account_id ?? '?'} as ${section.sso_role_name ?? '?'}, not ${TERMAG_ACCOUNT} as ${TERMAG_ROLE}`,
        `set sso_account_id = ${TERMAG_ACCOUNT} and sso_role_name = ${TERMAG_ROLE} in ${tilde(s, path)}`,
      );
    }
    return ok(`[profile ${AWS_PROFILE}] in ${tilde(s, path)}`);
  },
};

const ssmPluginCheck: Check = {
  id: 'session-manager-plugin',
  title: 'SSM plugin',
  async run(s) {
    if (s.credentialKind === 'box') return ON_BOX;
    const r = await exec(s, 'session-manager-plugin', ['--version']);
    if (r.code === 0) return ok(`session-manager-plugin ${firstLine(r.stdout) || 'installed'}`);
    if (s.ctx.platform === 'darwin') {
      return fail('session-manager-plugin is not installed', 'brew install --cask session-manager-plugin', {
        question: 'Install it with `brew install --cask session-manager-plugin`?',
        apply: async () => {
          const code = await s.ctx.execInteractive!('brew', ['install', '--cask', 'session-manager-plugin']);
          if (code !== 0) throw new CliError('failed', code === 127 ? 'Homebrew is not installed' : `brew exited ${code}`);
        },
      });
    }
    return fail('session-manager-plugin is not installed',
      'install it: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html');
  },
};

const awsSsoCheck: Check = {
  id: 'aws-sso',
  title: 'AWS SSO',
  async run(s) {
    if (s.credentialKind === 'box') return ON_BOX;
    const version = await exec(s, 'aws', ['--version']);
    if (version.code === 127) {
      return fail('the AWS CLI is not installed', s.ctx.platform === 'darwin'
        ? 'brew install awscli'
        : 'install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html');
    }
    if (!awsProfileSection(s.ctx.readFile(awsConfigPath(s)), AWS_PROFILE)) {
      return fail(`needs the ${AWS_PROFILE} profile (see AWS profile)`);
    }
    const r = await exec(s, 'aws', ['sts', 'get-caller-identity', '--profile', AWS_PROFILE, '--output', 'json']);
    if (r.code === 0) {
      let arn = '';
      try { arn = String((JSON.parse(r.stdout) as { Arn?: unknown }).Arn ?? ''); } catch { /* fall through */ }
      return ok(arn ? `signed in as ${arn}` : `signed in with ${AWS_PROFILE}`);
    }
    const why = firstLine(r.stderr);
    return fail(`no valid AWS SSO session for ${AWS_PROFILE}${why ? ` (${why})` : ''}`, `aws sso login --profile ${AWS_PROFILE}`, {
      question: `Run \`aws sso login --profile ${AWS_PROFILE}\` now?`,
      apply: async () => {
        const code = await s.ctx.execInteractive!('aws', ['sso', 'login', '--profile', AWS_PROFILE]);
        if (code !== 0) throw new CliError('failed', `aws sso login exited ${code}`);
      },
    });
  },
};

function listDir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

const sshConfigCheck: Check = {
  id: 'ssh-config',
  title: 'SSH config',
  async run(s) {
    if (s.credentialKind === 'box') return ON_BOX;
    const found = findTermagSshHost(s.ctx.home, s.ctx.readFile, listDir);
    if (found?.managed) return ok(`termag ssh-config entry in ${tilde(s, found.path)}`);
    if (found) return ok(`Host termag-* entry in ${tilde(s, found.path)} (written by hand, not by \`termag ssh-config --install\`)`);
    return warn(
      'no Host termag-* entry in ~/.ssh/config: plain ssh, scp, rsync and Remote-SSH cannot reach boxes by name',
      'termag ssh-config --install',
    );
  },
};

const claudeCheck: Check = {
  id: 'claude',
  title: 'Claude',
  async run(s) {
    if (!s.api) return NEEDS_LOGIN;
    const creds = await credentials(s);
    if (creds === 'unsupported') return UNSUPPORTED;
    const gw = creds.claudeGateway;
    if (!gw.available) return ok('off: this orchestrator has no Claude gateway, so boxes use their own Claude login');
    if (!gw.enabled) return warn('off: your boxes do not get Claude through termag', 'turn it on in the web UI (Settings, Credentials)');
    return ok('on: your boxes get Claude through termag, nothing to set up');
  },
};

export const CHECKS: Check[] = [
  loginCheck, sshKeyCheck, githubCheck, githubSsoCheck, awsProfileCheck, ssmPluginCheck, awsSsoCheck, sshConfigCheck, claudeCheck,
];

// ── Runner ──────────────────────────────────────────────────────────────────

async function runOne(check: Check, s: State): Promise<Outcome> {
  try {
    return await check.run(s);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const TITLE_WIDTH = Math.max(...CHECKS.map(c => c.title.length));

function line(r: CheckResult): string {
  const head = `${r.status.padEnd(4)}  ${r.title.padEnd(TITLE_WIDTH)}  `;
  const fixLine = r.fix && r.status !== 'ok' ? `\n${' '.repeat(head.length)}fix: ${r.fix}` : '';
  return `${head}${r.detail}${r.fixed ? ' (fixed)' : ''}${fixLine}`;
}

async function askYes(ctx: Ctx, question: string): Promise<boolean> {
  const answer = await ctx.prompt!(`${question} [Y/n] `);
  if (answer === null) return false;
  const a = answer.trim().toLowerCase();
  return a === '' || a === 'y' || a === 'yes';
}

export interface DoctorOptions {
  /** Print each check as it runs (the human output); the report is returned either way. */
  print: boolean;
  /** Offer fixes. Only honored at a terminal. */
  fix: boolean;
  /** Apply fixes without asking. */
  yes: boolean;
}

export async function runDoctor(ctx: Ctx, args: ParsedArgs, opts: DoctorOptions): Promise<DoctorReport> {
  const target = resolveTarget(args.host, ctx.env, ctx.home, ctx.readFile);
  const credsPath = credentialsPath(ctx.env, ctx.home);
  const s: State = {
    ctx, host: target.host, credsPath, login: loadLogin(credsPath, target.host), boxToken: target.box?.token ?? null,
    api: null, credentialKind: null,
  };
  const canFix = opts.fix && ctx.interactive && !!ctx.prompt && !!ctx.execInteractive;
  if (opts.print) { ctx.out(`Checking termag setup for ${s.host}`); ctx.out(''); }
  const checks: CheckResult[] = [];
  for (const check of CHECKS) {
    let o = await runOne(check, s);
    let fixed = false;
    if (o.status !== 'ok' && o.repair && canFix) {
      if (opts.print) ctx.out(line({ id: check.id, title: check.title, status: o.status, detail: o.detail }));
      if (opts.yes || await askYes(ctx, `  ${o.repair.question}`)) {
        let note: string | void = undefined;
        let error: string | null = null;
        try { note = await o.repair.apply(); } catch (err) { error = err instanceof Error ? err.message : String(err); }
        s.credentials = undefined;
        const after = await runOne(check, s);
        fixed = !error && after.status === 'ok';
        o = { ...after, detail: [after.detail, note, error && `fix failed: ${error}`].filter(Boolean).join('; ') };
      }
    }
    const result: CheckResult = {
      id: check.id, title: check.title, status: o.status, detail: o.detail,
      ...(o.fix && o.status !== 'ok' ? { fix: o.fix } : {}),
      ...(o.skipped ? { skipped: true } : {}),
      ...(fixed ? { fixed: true } : {}),
    };
    checks.push(result);
    if (opts.print) ctx.out(line(result));
  }
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  if (opts.print) {
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    ctx.out(summary.fail || summary.warn
      ? `\n${plural(summary.fail, 'problem')}, ${plural(summary.warn, 'warning')}.`
      : '\nAll checks passed.');
  }
  return { host: s.host, ok: summary.fail === 0, summary, checks };
}

export async function cmdDoctor(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const report = await runDoctor(ctx, args, { print: !args.json, fix: !args.json, yes: args.yes });
  if (args.json) ctx.out(json(report));
  return report.ok ? EXIT.OK : EXIT.FAILED;
}
