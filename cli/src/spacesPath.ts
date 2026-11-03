import { lstatSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CliError } from './errors.js';

/**
 * Where the CLI may write or delete for spaces: only inside
 * ~/.termag/spaces, and never through a symlink. Everything it keeps there
 * goes through checkInSpaces first: the memory copies, `.panes`, `.versions`,
 * `.sessions`, `default.json`, the locks and the staging folders. A link
 * planted anywhere on the path (~/.termag, ~/.termag/spaces, `.panes`, …)
 * would otherwise take a write, a chmod or a `rm -r` somewhere else, such as
 * ~/.termag or $HOME.
 */

export function spacesDir(home: string): string { return join(home, '.termag', 'spaces'); }

/** Refuses `p` if it, or any folder between `from` and it, is a symlink (paths that don't exist yet pass). */
function refuseLinks(from: string, p: string): void {
  const parts = relative(from, p).split(sep).filter(Boolean);
  let at = from;
  for (const part of ['', ...parts]) {
    at = part ? join(at, part) : at;
    let st;
    try { st = lstatSync(at); } catch { return; }
    if (st.isSymbolicLink()) throw new CliError('failed', `Refusing to touch ${p}: ${at} is a symlink; remove it and run again`);
  }
}

/** `dir`, resolved, if it is inside ~/.termag/spaces with no symlink on the way from ~/.termag; else a refusal. */
export function checkInSpaces(home: string, dir: string): string {
  const root = resolve(spacesDir(home));
  const target = resolve(dir);
  if (target !== root && !target.startsWith(root + sep)) throw new CliError('failed', `Refusing to touch ${target}: it is outside ${root}`);
  refuseLinks(resolve(home, '.termag'), target);
  return target;
}

/** For a file the caller names outside the spaces folder (the chat runner's `--session`): neither it nor its folder may be a link. */
export function checkNotLinked(file: string): string {
  const target = resolve(file);
  for (const p of [dirname(target), target]) {
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) throw new CliError('failed', `Refusing to write ${target}: ${p} is a symlink`);
  }
  return target;
}
