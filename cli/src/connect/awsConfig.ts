import { join } from 'node:path';
import { CliError } from '../errors.js';
import { installBlock, readIfExists, removeBlock, type InstallResult, type ManagedBlock } from './sshConfig.js';

export const AWS_BEGIN_MARKER = '# >>> termag aws-config >>>';
export const AWS_END_MARKER = '# <<< termag aws-config <<<';

const AWS_BLOCK: ManagedBlock = {
  begin: AWS_BEGIN_MARKER, end: AWS_END_MARKER, file: '~/.aws/config', command: 'termag ssh <box>', at: 'bottom',
};

/**
 * The SSO sign-in for the AWS account the boxes run in. Set TERMAG_SSO_START_URL
 * and TERMAG_AWS_ACCOUNT to your organization's; the defaults are placeholders.
 */
export const TERMAG_SSO = {
  session: 'termag',
  startUrl: process.env.TERMAG_SSO_START_URL || 'https://your-org.awsapps.com/start/',
  ssoRegion: 'us-east-1',
  accountId: process.env.TERMAG_AWS_ACCOUNT || '123456789012',
  roleName: 'TermagUser',
  region: 'us-east-2',
} as const;

/** `[sso-session]` needs AWS CLI 2.9 or later; older ones reject the profile outright. */
export const MIN_AWS_CLI: readonly [number, number] = [2, 9];

export function awsConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.AWS_CONFIG_FILE || join(home, '.aws', 'config');
}

/**
 * The profile in the `[sso-session]` form. That form registers the AWS CLI
 * for a refresh token, so one `aws sso login` keeps renewing the profile's
 * access token for as long as the access-portal session lasts; the legacy
 * `sso_start_url`-in-the-profile form can't refresh, so its sign-in ends with
 * its one access token.
 */
export function renderAwsBlock(profile: string): string {
  return [
    AWS_BEGIN_MARKER,
    '# Written by the termag CLI the first time it connects to a box; it replaces everything between these markers.',
    `[sso-session ${TERMAG_SSO.session}]`,
    `sso_start_url = ${TERMAG_SSO.startUrl}`,
    `sso_region = ${TERMAG_SSO.ssoRegion}`,
    'sso_registration_scopes = sso:account:access',
    '',
    `[profile ${profile}]`,
    `sso_session = ${TERMAG_SSO.session}`,
    `sso_account_id = ${TERMAG_SSO.accountId}`,
    `sso_role_name = ${TERMAG_SSO.roleName}`,
    `region = ${TERMAG_SSO.region}`,
    AWS_END_MARKER,
  ].join('\n');
}

/** `aws-cli/2.15.30 Python/3.11.8 Darwin/23.4.0 …` → [2, 15]; null when it doesn't look like that. */
export function parseAwsCliVersion(text: string): [number, number] | null {
  const m = /aws-cli\/(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function supportsSsoSession(version: [number, number]): boolean {
  return version[0] > MIN_AWS_CLI[0] || (version[0] === MIN_AWS_CLI[0] && version[1] >= MIN_AWS_CLI[1]);
}

interface Section { kind: string; name: string; keys: Map<string, string>; managed: boolean }

function sections(content: string): Section[] {
  const out: Section[] = [];
  let managed = false;
  let current: Section | null = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === AWS_BEGIN_MARKER) { managed = true; continue; }
    if (line === AWS_END_MARKER) { managed = false; current = null; continue; }
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*(?:(profile|sso-session)\s+)?([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      current = { kind: header[1] ?? 'profile', name: header[2], keys: new Map(), managed };
      out.push(current);
      continue;
    }
    const kv = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (kv && current) current.keys.set(kv[1].toLowerCase(), kv[2]);
  }
  return out;
}

export type ProfileState =
  /** No such profile in the file. */
  | 'missing'
  /** Between termag's markers. */
  | 'managed'
  /** The user's own, in the `[sso-session]` form or not SSO at all. */
  | 'own'
  /** The user's own, in the legacy `sso_start_url` form: one login per token. */
  | 'own-legacy'
  /**
   * termag's block and a section of the user's by the same name, as when a
   * tool appends its own profile after the CLI wrote one. The AWS CLI rejects
   * a config with a repeated section, so every `aws` command fails until one goes.
   */
  | 'shadowed';

export function profileState(content: string, profile: string): ProfileState {
  const all = sections(content);
  const found = all.filter(s => s.kind === 'profile' && s.name === profile);
  if (found.length === 0) return 'missing';
  const ours = found.some(s => s.managed);
  const theirs = all.filter(s => !s.managed && (
    (s.kind === 'profile' && s.name === profile) || (s.kind === 'sso-session' && s.name === TERMAG_SSO.session)));
  if (ours && theirs.length > 0) return 'shadowed';
  if (ours) return 'managed';
  const own = found[0];
  return own.keys.has('sso_start_url') && !own.keys.has('sso_session') ? 'own-legacy' : 'own';
}

/** Takes termag's block out again, leaving the user's sections as they are. */
export function removeAwsProfile(path: string): { path: string; removed: boolean; backup: string | null } {
  const result = removeBlock(path, AWS_BLOCK);
  return { path: result.path, removed: result.action === 'removed', backup: result.backup };
}

/**
 * Adds termag's `[sso-session]` profile to the AWS config, or brings an
 * earlier termag-written one up to date. Refuses when the user's own config
 * already defines the session name or the profile, rather than shadowing it.
 */
export function installAwsProfile(path: string, profile: string): InstallResult {
  const existing = readIfExists(path) ?? '';
  const theirs = sections(existing).filter(s => !s.managed);
  if (theirs.some(s => s.kind === 'sso-session' && s.name === TERMAG_SSO.session)) {
    throw new CliError('failed',
      `${path} already has an \`[sso-session ${TERMAG_SSO.session}]\` of its own; add a \`${profile}\` profile that uses it, or rename it`);
  }
  if (theirs.some(s => s.kind === 'profile' && s.name === profile)) {
    throw new CliError('failed', `${path} already has its own \`${profile}\` profile; termag leaves it alone`);
  }
  return installBlock(path, renderAwsBlock(profile), AWS_BLOCK);
}
