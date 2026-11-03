import { capture, findTool } from './process.js';
import { shQuote } from './sshArgs.js';

/**
 * A terminal's TERM has to name a terminfo entry the box has, or tmux refuses
 * to attach ("missing or unsuitable terminal: xterm-ghostty") and full-screen
 * programs misdraw. Ubuntu 24.04's ncurses has no entry for Ghostty, and none
 * for kitty without kitty-terminfo. So, as Ghostty's own ssh integration does,
 * termag copies the local entry to the box (`infocmp -x` here, `tic -x` there,
 * into the box user's ~/.terminfo), and falls back to xterm-256color when it
 * has nothing to copy.
 *
 * The check and the install ride on the session's own command line, so they
 * cost no second SSM session, and tic runs only on a box that lacks the entry,
 * so the first session installs it and every later one finds it.
 */

export const FALLBACK_TERM = 'xterm-256color';

// Only a name this plain goes into the remote command line.
const SAFE_TERM = /^[A-Za-z0-9._+-]+$/;

// In ncurses-base, an Essential package, so on every Ubuntu box: no check, and the session's command stays as
// it was. Anything else (wezterm, foot, alacritty, … from ncurses-term) gets the check, which costs only bytes.
const BOX_TERMS = new Set([
  'xterm', 'xterm-256color', 'xterm-color', 'screen', 'screen-256color', 'tmux', 'tmux-256color',
  'vt100', 'vt102', 'vt220', 'linux', 'dumb', 'ansi', 'rxvt', 'rxvt-unicode', 'rxvt-unicode-256color',
]);

export type TermPlan =
  /** Leave TERM and the command alone. */
  | { kind: 'keep' }
  /** Install `source` (an `infocmp -x` entry) on the box unless it has `term`. */
  | { kind: 'install'; term: string; source: string }
  /** Nothing to copy: run the session under FALLBACK_TERM. */
  | { kind: 'fallback'; term: string; reason: string };

export async function planTerm(env: NodeJS.ProcessEnv): Promise<TermPlan> {
  const term = env.TERM ?? '';
  if (term === '' || BOX_TERMS.has(term)) return { kind: 'keep' };
  if (!SAFE_TERM.test(term)) return { kind: 'fallback', term, reason: 'its name has characters termag does not pass to a box' };
  const infocmp = findTool('infocmp', env);
  if (!infocmp) return { kind: 'fallback', term, reason: 'there is no infocmp here to copy its terminfo entry to the box' };
  const r = await capture(infocmp, ['-x', term], env, 10_000);
  if (r.code !== 0 || !r.stdout.trim()) return { kind: 'fallback', term, reason: 'this machine has no terminfo entry for it to copy to the box' };
  return { kind: 'install', term, source: r.stdout };
}

/**
 * What ssh's own configuration (the user's -o options and ~/.ssh/config) says
 * about a session with no command: `ssh -G` prints it without connecting.
 */
export async function sshSessionConfig(
  sshPath: string, args: string[], env: NodeJS.ProcessEnv,
): Promise<{ remoteCommand: boolean; noTty: boolean }> {
  const r = await capture(sshPath, ['-G', ...args], env, 10_000);
  const lines = r.stdout.split('\n').map(l => l.trim().toLowerCase());
  const value = (key: string) => lines.find(l => l.startsWith(`${key} `))?.slice(key.length + 1).trim();
  const remote = value('remotecommand');
  const tty = value('requesttty');
  return { remoteCommand: remote !== undefined && remote !== 'none', noTty: tty === 'no' || tty === 'false' };
}

/** The notice for a fallback, one line. */
export function fallbackNotice(p: Extract<TermPlan, { kind: 'fallback' }>): string {
  return `termag: TERM=${p.term} may be unknown on the box and ${p.reason}; using TERM=${FALLBACK_TERM} for this session`;
}

/**
 * `command`, preceded by the check and install. A box whose tic fails still
 * gets a working session, under FALLBACK_TERM, with the same one-line notice.
 */
export function withTerminfo(term: string, source: string, command: string): string {
  const has = `infocmp ${term} >/dev/null 2>&1`;
  const entry = Buffer.from(source, 'utf8').toString('base64');
  const notice = shQuote(`termag: could not install the terminfo entry for ${term} on the box; using TERM=${FALLBACK_TERM}`);
  return `if ! ${has}; then printf %s ${entry} | base64 -d | tic -x -o "$HOME/.terminfo" - >/dev/null 2>&1; `
    + `${has} || { echo ${notice} >&2; TERM=${FALLBACK_TERM}; export TERM; }; fi; ${command}`;
}
