// The version a build of a termag package (cli/, and tui/) reports, worked out
// from git so that every build says which code it is, with nothing to bump:
//
//   <major>.<minor>.<commits touching the package>+<the latest one's sha>
//   e.g. 0.1.157+c4b6b803, and 0.1.157+c4b6b803.dirty with uncommitted changes
//
// major.minor come from the package's package.json and change only by hand.
// The patch number grows with each commit that touches the package, so on
// main a later build has a higher one, which the orchestrator's version
// comparison (backend services/software/versions.ts) reads as newer. Boxes
// and laptops build from full clones, so the same commit gives the same
// version everywhere. Without that history (a shallow clone, as in CI, or a
// copy outside git, as in install.test.sh) it is package.json's version plus
// `+unknown`.
//
// Usage: node buildVersion.mjs [<package dir>]   (default: this file's
// directory). Prints the version. It needs no dependencies, so install.sh
// runs it before `npm ci`; build.mjs imports buildVersion().
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildVersion(dir) {
  const base = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).version;
  // A git variable from the caller (a hook, a worktree script) would point git elsewhere.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (git('rev-parse', '--is-shallow-repository') !== 'false') return `${base}+unknown`;
    const sha = git('log', '-1', '--format=%h', '--abbrev=8', '--', '.');
    if (!sha) return `${base}+unknown`;
    const count = git('rev-list', '--count', 'HEAD', '--', '.');
    // Tracked changes and new files, not ignored ones (node_modules, dist).
    const dirty = git('status', '--porcelain', '--', '.') ? '.dirty' : '';
    const [major, minor] = base.split('.');
    return `${major}.${minor}.${count}+${sha}${dirty}`;
  } catch {
    return `${base}+unknown`;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
  process.stdout.write(`${buildVersion(dir)}\n`);
}
