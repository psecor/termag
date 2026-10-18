import { usage } from '../errors.js';

/** POSIX shell quoting; plain words stay readable. */
export function shQuote(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The remote command line for `termag ssh … -- <cmd>`. One argument is a shell
 * command line, as with plain ssh (`-- 'make test | tail'`); several are words
 * that each reach the remote program intact (`-- claude -p "fix the test"`).
 */
export function remoteCommandLine(words: string[]): string | null {
  if (words.length === 0) return null;
  if (words.length === 1) return words[0];
  return words.map(shQuote).join(' ');
}

// ssh(1) single-letter options that take a value.
const FLAGS_WITH_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw');

export interface ScannedOptions {
  /** Every single-letter flag given, e.g. N for `-N` or `-NL 3000:…`. */
  flags: Set<string>;
  /** Words that are neither an option nor an option's value. */
  stray: string[];
}

/** Reads the ssh options a user passed through, without interpreting them. */
export function scanSshOptions(tokens: string[]): ScannedOptions {
  const flags = new Set<string>();
  const stray: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!/^-[A-Za-z0-9]/.test(t)) { stray.push(t); continue; }
    for (let j = 1; j < t.length; j++) {
      flags.add(t[j]);
      if (FLAGS_WITH_VALUE.has(t[j])) {
        if (j === t.length - 1) i++;
        break;
      }
    }
  }
  return { flags, stray };
}

/** `[ssh options…] [-- cmd…]` → the two halves. */
export function splitAtDoubleDash(tokens: string[]): { options: string[]; command: string[] } {
  const i = tokens.indexOf('--');
  return i < 0 ? { options: tokens, command: [] } : { options: tokens.slice(0, i), command: tokens.slice(i + 1) };
}

export interface SsmRoute {
  awsPath: string;
  instanceId: string;
  region: string;
  profile: string;
  document: string;
}

/**
 * The ProxyCommand USAGE.md documents for laptops, with the box filled in.
 * ssh expands `%` tokens before the shell sees the line, so literal ones are doubled.
 */
export function ssmProxyCommand(r: SsmRoute): string {
  const literal = (w: string) => shQuote(w).replace(/%/g, '%%');
  return [
    literal(r.awsPath), 'ssm', 'start-session',
    '--target', literal(r.instanceId),
    '--document-name', literal(r.document),
    '--parameters', 'portNumber=%p',
    '--region', literal(r.region),
    '--profile', literal(r.profile),
  ].join(' ');
}

export interface SshPlan {
  route: SsmRoute;
  /** `termag-<box>`: what ssh calls the host. */
  alias: string;
  user: string;
  userOptions: string[];
  remote: string | null;
  tty: boolean;
  batch: boolean;
}

/**
 * ssh's arguments. The user's options come first because ssh keeps the first
 * value it sees for each setting, so they can override any default here. The
 * host key is filed under the instance id, so a box re-created under the same
 * name is a new host rather than a changed key; SSM has already authenticated
 * the instance, which is why a first connection may accept its key.
 */
export function buildSshArgv(p: SshPlan): string[] {
  const argv = [...p.userOptions];
  argv.push(
    '-o', `ProxyCommand=${ssmProxyCommand(p.route)}`,
    '-o', `HostKeyAlias=${p.route.instanceId}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', `User=${p.user}`,
  );
  if (p.batch) argv.push('-o', 'BatchMode=yes');
  if (p.tty) argv.push('-t');
  argv.push(p.alias);
  if (p.remote !== null) argv.push(p.remote);
  return argv;
}

export function inDirectory(directory: string, command: string): string {
  return `cd ${shQuote(directory)} && ${command}`;
}

export const LOGIN_SHELL = 'exec "${SHELL:-/bin/sh}" -l';

export function assertNoStrayWords(scanned: ScannedOptions): void {
  if (scanned.stray.length) {
    throw usage(`\`${scanned.stray[0]}\` is not an ssh option; put the remote command after \`--\``);
  }
}
