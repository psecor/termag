// The theme-of-the-day path check (.claude/skills/theme-of-the-day/,
// docs/daily-theme.md): a day's work may touch only
// frontend/src/theme/daily/<YYYY-MM-DD>/{meta.json,theme.css,sprite.js}.
// The skill runs it before it commits, and the automation before it pushes, so
// the rule is code and not only a sentence in the skill.
//
//   node scripts/theme-of-the-day/check-diff.mjs [<base>]
//
// Checks everything that differs from <base> (default origin/main): commits
// since the merge base, staged and unstaged changes, and untracked files.
// Exits 0 when all of it is allowed, 1 (listing the rest) when not, 2 when git fails.

import { execFileSync } from 'node:child_process';
import { disallowedPaths } from './lib.mjs';

const base = process.argv[2] ?? 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
let paths;
try {
  paths = [...new Set([
    ...git('diff', '--name-only', `${base}...HEAD`),
    ...git('diff', '--name-only', 'HEAD'),
    ...git('ls-files', '--others', '--exclude-standard'),
  ])].sort();
} catch (e) {
  console.error(`check-diff: git failed: ${e.message}`);
  process.exit(2);
}
const bad = disallowedPaths(paths);
if (bad.length) {
  console.error(`check-diff: ${bad.length} path(s) outside frontend/src/theme/daily/<date>/{meta.json,theme.css,sprite.js}:`);
  for (const p of bad) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-diff: ok (${paths.length} path(s), all a day's files)`);
