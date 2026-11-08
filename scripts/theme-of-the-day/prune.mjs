// Deletes the theme-of-the-day directories dated more than 14 days before a
// date (.claude/skills/theme-of-the-day/, step 6), with `git rm`, and nothing
// else: only dated directories under frontend/src/theme/daily/ are touched.
//
//   node scripts/theme-of-the-day/prune.mjs <YYYY-MM-DD>

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { daysToPrune, parseDate } from './lib.mjs';

const date = process.argv[2];
try { parseDate(date); } catch (e) { console.error(`usage: prune.mjs <YYYY-MM-DD>\n${e.message}`); process.exit(2); }
const dir = 'frontend/src/theme/daily';
const names = readdirSync(dir).filter(n => statSync(join(dir, n)).isDirectory());
const old = daysToPrune(names, date);
for (const n of old) execFileSync('git', ['rm', '-rq', '--', join(dir, n)], { stdio: 'inherit' });
console.log(`prune: removed ${old.length} day(s)${old.length ? `: ${old.join(', ')}` : ''}`);
