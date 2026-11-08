import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readVersion, TUI_VERSION } from './version.js';

// A package laid out like tui/: package.json, and dist/ where the build writes version.txt.
let pkg: string;
let dist: URL;
beforeEach(() => {
  pkg = mkdtempSync(join(tmpdir(), 'termag-tui-version-'));
  mkdirSync(join(pkg, 'dist'));
  writeFileSync(join(pkg, 'package.json'), '{"version":"0.3.0"}\n');
  dist = pathToFileURL(join(pkg, 'dist') + '/');
});
afterEach(() => rmSync(pkg, { recursive: true, force: true }));

describe('readVersion', () => {
  it('reads the version the build wrote', () => {
    writeFileSync(join(pkg, 'dist', 'version.txt'), '0.3.18+d57cf6f2\n');
    expect(readVersion(dist)).toBe('0.3.18+d57cf6f2');
  });

  it("falls back to package.json's when there is no build", () => {
    expect(readVersion(dist)).toBe('0.3.0');
  });

  it('ignores a file that is not a version, since it goes into a header', () => {
    writeFileSync(join(pkg, 'dist', 'version.txt'), '0.3.18\r\nX-Injected: yes\n');
    expect(readVersion(dist)).toBe('0.3.0');
  });

  it("is package.json's version when run from the sources", () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(TUI_VERSION).toBe(version);
  });
});
