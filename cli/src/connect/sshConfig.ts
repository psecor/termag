import { copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from '../errors.js';
import { shQuote } from './sshArgs.js';

export const BEGIN_MARKER = '# >>> termag ssh-config >>>';
export const END_MARKER = '# <<< termag ssh-config <<<';

export function sshConfigPath(home: string): string {
  return join(home, '.ssh', 'config');
}

/** The command ssh runs for a `termag-*` host: `<termag> [--host <url>] ssh-proxy %h %p`. */
export function proxyCommandFor(termag: string[], host: string | null): string {
  const words = [...termag.map(w => shQuote(w).replace(/%/g, '%%'))];
  if (host) words.push('--host', shQuote(host).replace(/%/g, '%%'));
  words.push('ssh-proxy', '%h', '%p');
  return words.join(' ');
}

/**
 * One `Host termag-*` entry. It goes at the top of the file because ssh keeps
 * the first value it finds for each setting, so a later `Host *` can't
 * override it. The trailing `Host *` hands whatever follows back to every
 * host, so settings the file had before its first `Host` line stay global.
 * `hostUsers` comes first for the same reason: a box whose agent runs as
 * someone other than `user` (a claimed warm box stays `termag`).
 */
export function renderBlock(opts: { proxyCommand: string; user: string; hostUsers?: Array<{ alias: string; user: string }> }): string {
  return [
    BEGIN_MARKER,
    '# Managed by `termag ssh-config --install`, which replaces everything between these markers.',
    '# `ssh termag-<box>` reaches that box over SSM (TermagSSH), with the same checks as `termag ssh`.',
    ...(opts.hostUsers ?? []).flatMap(h => [`Host ${h.alias}`, `  User ${h.user}`]),
    'Host termag-*',
    `  User ${opts.user}`,
    `  ProxyCommand ${opts.proxyCommand}`,
    '  StrictHostKeyChecking accept-new',
    '  ServerAliveInterval 30',
    'Host *',
    END_MARKER,
  ].join('\n');
}

export type UpsertAction = 'added' | 'updated' | 'unchanged';

/** A file region termag owns: everything between two marker lines. */
export interface ManagedBlock {
  begin: string;
  end: string;
  /** How the file is named in an error, and the command that rewrites it. */
  file: string;
  command: string;
  /** Where a first install goes. */
  at: 'top' | 'bottom';
}

const SSH_BLOCK: ManagedBlock = {
  begin: BEGIN_MARKER, end: END_MARKER, file: '~/.ssh/config', command: 'termag ssh-config --install', at: 'top',
};

/** Puts `block` in `existing` between the markers, touching nothing outside them. */
export function upsertBlock(existing: string, block: string, managed: ManagedBlock = SSH_BLOCK): { content: string; action: UpsertAction } {
  const lines = existing.split('\n');
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === managed.begin) begins.push(i);
    else if (t === managed.end) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) {
    if (existing === '') return { content: `${block}\n`, action: 'added' };
    const content = managed.at === 'top'
      ? `${block}\n\n${existing}`
      : `${existing.replace(/\n*$/, '')}\n\n${block}\n`;
    return { content, action: 'added' };
  }
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    throw new CliError('failed',
      `The termag markers in ${managed.file} are unmatched or repeated; remove the termag lines by hand and re-run \`${managed.command}\``);
  }
  const content = [...lines.slice(0, begins[0]), block, ...lines.slice(ends[0] + 1)].join('\n');
  return { content, action: content === existing ? 'unchanged' : 'updated' };
}

export function readIfExists(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface InstallResult {
  path: string;
  action: UpsertAction;
  backup: string | null;
}

/**
 * Rewrites the config at `path` with `edit`. A symlinked config (a dotfiles
 * checkout) is edited where it really lives; the previous content is kept in
 * `<config>.termag-backup`; the new file replaces the old one in a single
 * rename with the old file's mode, or 0600 for a new one.
 */
function rewriteConfig<A extends string>(
  path: string,
  edit: (existing: string) => { content: string; action: A },
  unchanged: A,
): { path: string; action: A; backup: string | null } {
  let target = path;
  try { target = realpathSync(path); } catch { /* not there yet */ }
  const existing = readIfExists(target);
  const { content, action } = edit(existing ?? '');
  if (action === unchanged) return { path: target, action, backup: null };

  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = 0o600;
  let backup: string | null = null;
  if (existing !== null) {
    mode = statSync(target).mode & 0o777;
    backup = `${target}.termag-backup`;
    copyFileSync(target, backup);
    chmodSync(backup, mode);
  }
  const tmp = join(dir, `.config.termag-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { path: target, action, backup };
}

/** Writes the block into the config at `path`, touching nothing outside the markers. */
export function installBlock(path: string, block: string, managed: ManagedBlock = SSH_BLOCK): InstallResult {
  return rewriteConfig(path, existing => upsertBlock(existing, block, managed), 'unchanged');
}

/** Drops the markers and everything between them, plus the blank line that set the block off. */
export function dropBlock(existing: string, managed: ManagedBlock): { content: string; action: 'removed' | 'absent' } {
  const lines = existing.split('\n');
  const begin = lines.findIndex(l => l.trim() === managed.begin);
  const end = lines.findIndex((l, i) => i > begin && l.trim() === managed.end);
  if (begin < 0 || end < 0) return { content: existing, action: 'absent' };
  const from = begin > 0 && lines[begin - 1].trim() === '' ? begin - 1 : begin;
  const to = from === 0 && lines[end + 1]?.trim() === '' ? end + 2 : end + 1;
  return { content: [...lines.slice(0, from), ...lines.slice(to)].join('\n'), action: 'removed' };
}

export function removeBlock(path: string, managed: ManagedBlock): { path: string; action: 'removed' | 'absent'; backup: string | null } {
  return rewriteConfig(path, existing => dropBlock(existing, managed), 'absent');
}
