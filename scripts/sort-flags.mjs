#!/usr/bin/env node
// sort-flags.mjs — put every entry of the two flag registries at its place in
// alphabetical order by flag key, each with the comment above it:
// FLAG_REGISTRY in backend/src/flags.ts and FLAGS in frontend/src/flags.ts
// (by the value, so both files share one order). backend/src/flags.test.ts
// fails when either is out of order.
//
// For after a merge of main: git can merge a flag PR's entry cleanly and still
// leave it where the file was before it was sorted. Resolve any conflict
// markers first (keep both sides' entries); this refuses a file that still has
// them, or that lists a key twice.
//
//   node scripts/sort-flags.mjs          sort both files in place
//   node scripts/sort-flags.mjs --check  exit 1, changing nothing, if either is out of order

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

function sortBlock(path, start, end, keyOf, isLast) {
  const file = join(repo, path);
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.some((l) => /^(<<<<<<<|=======$|>>>>>>>)/.test(l))) throw new Error(`${path}: resolve the conflict markers first`);
  const s = lines.findIndex((l) => start.test(l)) + 1;
  const e = lines.findIndex((l, i) => i >= s && end.test(l));
  if (s === 0 || e < 0) throw new Error(`${path}: registry not found`);
  const entries = [];
  let cur = [];
  for (const l of lines.slice(s, e)) {
    cur.push(l);
    if (isLast(l)) {
      entries.push({ key: cur.map(keyOf).find(Boolean), lines: cur });
      cur = [];
    }
  }
  if (cur.length) throw new Error(`${path}: lines after the last entry: ${cur.join(' / ')}`);
  const keys = entries.map((x) => x.key);
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (twice.length) throw new Error(`${path}: listed twice: ${twice.join(', ')}`);
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const moved = sorted.some((x, i) => x !== entries[i]);
  if (moved && !check) writeFileSync(file, [...lines.slice(0, s), ...sorted.flatMap((x) => x.lines), ...lines.slice(e)].join('\n'));
  console.log(`${path}: ${moved ? (check ? 'out of order' : 'sorted') : 'in order'} (${entries.length} flags)`);
  return moved;
}

const moved = [
  sortBlock('backend/src/flags.ts', /^export const FLAG_REGISTRY = \{$/, /^\} as const satisfies/,
    (l) => l.match(/^ {2}'([^']+)': \{$/)?.[1], (l) => l === '  },'),
  sortBlock('frontend/src/flags.ts', /^export const FLAGS = \{$/, /^\} as const;$/,
    (l) => l.match(/^ {2}\w+: '([^']+)',$/)?.[1], (l) => /^ {2}\w+: '[^']+',$/.test(l)),
];
if (check && moved.some(Boolean)) process.exit(1);
