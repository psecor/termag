import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { FLAG_REGISTRY, FlagKey, isFlagKey } from './flags';

// The registry against the code that reads it. Server reads are typed (FlagKey),
// so these checks cover what the compiler cannot: the browser's keys, which
// live in the frontend package, and entries nothing reads any more.

const repo = resolve(__dirname, '../..');
const keys = Object.keys(FLAG_REGISTRY) as FlagKey[];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

const frontendFlags = readFileSync(join(repo, 'frontend/src/flags.ts'), 'utf8');
const flagsBlock = frontendFlags.match(/export const FLAGS = \{([\s\S]*?)\} as const;/)?.[1] ?? '';
// FLAGS name -> flag key, e.g. warmPool -> warm-pool-enabled.
const browserKeys = new Map([...flagsBlock.matchAll(/^\s*(\w+): '([^']+)',/gm)].map((m) => [m[1], m[2]]));

const backendText = sources(join(repo, 'backend/src'))
  .filter((f) => !f.endsWith(join('src', 'flags.ts')))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
const frontendFiles = sources(join(repo, 'frontend/src')).map((f) => ({ f, text: readFileSync(f, 'utf8') }));

describe('flag registry', () => {
  it('found the browser flags', () => {
    expect(browserKeys.size).toBeGreaterThan(0);
  });

  it('lists every browser flag, marked client', () => {
    for (const key of browserKeys.values()) {
      expect(isFlagKey(key), `${key} is read in frontend/src/flags.ts but missing from backend/src/flags.ts`).toBe(true);
      if (isFlagKey(key)) expect(FLAG_REGISTRY[key].client, `${key} is read by the browser`).toBe(true);
    }
  });

  it('has no client entry the browser does not read', () => {
    const read = new Set(browserKeys.values());
    for (const key of keys.filter((k) => FLAG_REGISTRY[k].client)) {
      expect(read.has(key), `${key} is marked client but frontend/src/flags.ts does not name it`).toBe(true);
    }
  });

  it('has a server entry exactly for the flags the backend reads', () => {
    for (const key of keys) {
      // A read is a variation call on the key or on a constant holding it;
      // the constant's declaration alone is not one.
      const names = [...backendText.matchAll(new RegExp(`const (\\w+)\\s*=\\s*['"\`]${key}['"\`]`, 'g'))].map((m) => m[1]);
      const arg = [`['"\`]${key}['"\`]`, ...names.map((n) => `${n}\\b`)].join('|');
      const read = new RegExp(`(?:boolVariation|boolVariationForContext|stringVariation|numberVariationForContext|jsonVariation)\\(\\s*(?:${arg})`).test(backendText);
      const listed = FLAG_REGISTRY[key].server.length > 0;
      expect(read, `${key}: server is ${JSON.stringify(FLAG_REGISTRY[key].server)}, but backend/src ${read ? 'reads' : 'never reads'} it`).toBe(listed);
    }
  });

  it('is read by the browser only through useFlag(FLAGS.x)', () => {
    for (const { f, text } of frontendFiles) {
      if (f.endsWith(join('frontend', 'src', 'flags.ts'))) continue;
      // useFlags() would skip both the registry and the e2e overrides.
      expect(/\buseFlags\b/.test(text), `${f} calls useFlags(); read flags with useFlag`).toBe(false);
      for (const m of text.matchAll(/\buseFlag\(\s*([^,)]*)/g)) {
        expect(m[1].trim(), `${f}: useFlag(${m[1].trim()}, …) does not name a FLAGS key`).toMatch(/^FLAGS\.\w+$/);
      }
    }
  });

  it('is read by the browser with the listed fallback', () => {
    for (const { f, text } of frontendFiles) {
      for (const m of text.matchAll(/\buseFlag\(\s*FLAGS\.(\w+)\s*,\s*([^),]+?)\s*,?\s*\)/g)) {
        const key = browserKeys.get(m[1]);
        expect(key, `${f}: FLAGS.${m[1]} is not in frontend/src/flags.ts`).toBeDefined();
        if (key && isFlagKey(key)) {
          expect(m[2].trim(), `${f}: ${key} read with fallback ${m[2]}`).toBe(JSON.stringify(FLAG_REGISTRY[key].fallback).replace(/"/g, "'"));
        }
      }
    }
  });

  it('gives each entry a fallback of its kind and docs that exist', () => {
    for (const key of keys) {
      const spec = FLAG_REGISTRY[key];
      if (spec.kind === 'json') expect(spec.fallback, `${key}: a json flag falls back to its reader's code defaults`).toBeNull();
      else expect(typeof spec.fallback, key).toBe(spec.kind);
      expect(spec.addedIn, key).toMatch(/^#\d+$/);
      if ('docs' in spec) expect(existsSync(join(repo, spec.docs)), `${key}: ${spec.docs}`).toBe(true);
    }
  });
});
