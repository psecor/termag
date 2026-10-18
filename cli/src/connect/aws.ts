import type { StdioOptions } from 'node:child_process';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import {
  awsConfigPath, installAwsProfile, MIN_AWS_CLI, parseAwsCliVersion, profileState, removeAwsProfile, supportsSsoSession,
} from './awsConfig.js';
import { capture, findTool, runAttached } from './process.js';
import { readIfExists } from './sshConfig.js';

/** Where boxes live and how a laptop reaches them (USAGE.md, "SSH from your laptop"). */
export interface AwsSettings {
  profile: string;
  document: string;
  defaultRegion: string;
  /** termag writes the profile itself; not for one named by TERMAG_AWS_PROFILE, which is the user's. */
  writesProfile: boolean;
}

export function awsSettings(env: NodeJS.ProcessEnv): AwsSettings {
  return {
    profile: env.TERMAG_AWS_PROFILE || 'termag-boxes',
    document: env.TERMAG_SSM_DOCUMENT || 'TermagSSH',
    defaultRegion: 'us-east-2',
    writesProfile: !env.TERMAG_AWS_PROFILE,
  };
}

const AWS_CLI_INSTALL = 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html';
const PLUGIN_INSTALL = 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html';

// What `aws sts get-caller-identity` prints when the profile's SSO session is the problem.
const SSO_PROBLEM = /sso|token|expired|credential|refresh/i;

export interface PreflightOptions {
  /** A person can answer: then an expired SSO session is renewed with `aws sso login`. */
  interactive: boolean;
  /** Where `aws sso login` may read and write. ssh-proxy keeps stdout for ssh's traffic. */
  loginStdio: StdioOptions;
}

function firstLine(text: string): string {
  return text.trim().split('\n').find(l => l.trim())?.trim() ?? '';
}

/**
 * Makes sure the profile exists: writes termag's `[sso-session]` profile when
 * the config has none by that name, and keeps an earlier termag-written one
 * current. Returns whether it changed the file, and the profile's form.
 */
async function ensureProfile(ctx: Ctx, settings: AwsSettings, awsPath: string): Promise<{ wrote: boolean; legacy: boolean }> {
  const configPath = awsConfigPath(ctx.env, ctx.home);
  let state = profileState(readIfExists(configPath) ?? '', settings.profile);
  if (state === 'shadowed') {
    // Theirs wins: it is the same account and role, and the AWS CLI can't read the file while both are there.
    const removed = removeAwsProfile(configPath);
    ctx.err(`termag: ${removed.path} has a ${settings.profile} profile (or [sso-session termag]) of its own as well as termag's,`
      + ` which the AWS CLI rejects; removed termag's${removed.backup ? ` (the previous file is ${removed.backup})` : ''}`);
    state = profileState(readIfExists(configPath) ?? '', settings.profile);
  }
  const profiles = await capture(awsPath, ['configure', 'list-profiles'], ctx.env);
  const listed = profiles.code === 0 ? profiles.stdout.split('\n').map(l => l.trim()).includes(settings.profile) : null;

  if (state !== 'managed' && listed !== false) return { wrote: false, legacy: state === 'own-legacy' };
  if (state !== 'managed' && !settings.writesProfile) {
    throw new CliError('failed',
      `No \`${settings.profile}\` profile in ~/.aws/config; add it as termag's USAGE.md shows ("SSH from your laptop")`);
  }
  if (state !== 'managed') {
    const versionOut = await capture(awsPath, ['--version'], ctx.env);
    const version = parseAwsCliVersion(`${versionOut.stdout} ${versionOut.stderr}`);
    if (version && !supportsSsoSession(version)) {
      throw new CliError('failed',
        `AWS CLI ${version.join('.')} predates the \`[sso-session]\` profile termag sets up; install ${MIN_AWS_CLI.join('.')} or later: ${AWS_CLI_INSTALL}`);
    }
  }
  const result = installAwsProfile(configPath, settings.profile);
  if (result.action === 'unchanged') return { wrote: false, legacy: false };
  ctx.err(`termag: ${result.action === 'added' ? 'added' : 'updated'} the ${settings.profile} AWS profile in ${result.path}`
    + `${result.backup ? ` (the previous file is ${result.backup})` : ''}; one AWS sign-in now lasts the access-portal session`);
  return { wrote: true, legacy: false };
}

/**
 * The connection checks `termag doctor` also runs: the AWS CLI, the Session
 * Manager plugin, the profile, and a live SSO session. Returns the AWS CLI's
 * path. The fixes it makes: writing termag's own profile when there is none,
 * and `aws sso login`, which only runs for a person at a terminal.
 */
export async function preflight(ctx: Ctx, settings: AwsSettings, opts: PreflightOptions): Promise<{ awsPath: string }> {
  const awsPath = findTool('aws', ctx.env);
  if (!awsPath) throw new CliError('failed', `The AWS CLI (v2) is needed to reach boxes over SSM; install it: ${AWS_CLI_INSTALL}`);
  if (!findTool('session-manager-plugin', ctx.env)) {
    throw new CliError('failed', `The AWS Session Manager plugin is needed to reach boxes; install session-manager-plugin: ${PLUGIN_INSTALL}`);
  }

  const { wrote, legacy } = await ensureProfile(ctx, settings, awsPath);

  const identityArgs = ['sts', 'get-caller-identity', '--profile', settings.profile, '--output', 'json'];
  const identity = await capture(awsPath, identityArgs, ctx.env);
  if (identity.code === 0) return { awsPath };
  const reason = firstLine(identity.stderr);
  if (!SSO_PROBLEM.test(reason)) {
    throw new CliError('failed', `AWS profile \`${settings.profile}\` does not work: ${reason || `aws exited ${identity.code}`}`);
  }
  const login = `aws sso login --profile ${settings.profile}`;
  const why = wrote ? 'has no AWS SSO session yet' : 'has an expired AWS SSO session';
  if (legacy) {
    ctx.err(`termag: your ${settings.profile} profile uses the legacy sso_start_url form, so each sign-in lasts one access token;`
      + ` delete it from ~/.aws/config and termag writes the [sso-session] form, which renews itself, on the next connect`);
  }
  if (!opts.interactive) {
    throw new CliError('auth_required', `\`${settings.profile}\` ${why}; run \`${login}\``);
  }
  ctx.err(`termag: ${settings.profile} ${why}; running \`${login}\``);
  const code = await runAttached(awsPath, ['sso', 'login', '--profile', settings.profile], ctx.env, opts.loginStdio);
  if (code !== 0) throw new CliError('auth_required', `\`${login}\` did not finish (exit ${code})`);
  const again = await capture(awsPath, identityArgs, ctx.env);
  if (again.code !== 0) {
    throw new CliError('auth_required', `AWS profile \`${settings.profile}\` still has no session after \`${login}\`: ${firstLine(again.stderr)}`);
  }
  return { awsPath };
}
