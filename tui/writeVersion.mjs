// The TUI build's version, for src/version.ts to read from dist/version.txt:
// cli/buildVersion.mjs's (`0.1.<commits touching tui/>+<sha>`, from git), or,
// with no cli/ beside this checkout, package.json's version plus `+unknown`.
// A cli/buildVersion.mjs that is there but fails is an error, not a fallback.
// One helper for both build paths: `npm run build` and install.sh.
//
// Usage: node writeVersion.mjs [<file>]   write it (default dist/version.txt)
//        node writeVersion.mjs --print    print it (install.sh's stamp)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tuiDir = dirname(fileURLToPath(import.meta.url));
const script = resolve(tuiDir, '..', 'cli', 'buildVersion.mjs');

const version = existsSync(script)
  ? (await import(pathToFileURL(script).href)).buildVersion(tuiDir)
  : `${JSON.parse(readFileSync(resolve(tuiDir, 'package.json'), 'utf8')).version}+unknown`;

if (process.argv[2] === '--print') process.stdout.write(`${version}\n`);
else writeFileSync(resolve(tuiDir, process.argv[2] ?? 'dist/version.txt'), `${version}\n`);
