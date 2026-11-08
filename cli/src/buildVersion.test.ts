import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// buildVersion.mjs as install.sh runs it: `node buildVersion.mjs <package dir>`.
const SCRIPT = fileURLToPath(new URL('../buildVersion.mjs', import.meta.url));
const version = (dir: string, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env }).trim();

let root: string;
let repo: string;
let pkg: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
const commit = (path: string, text: string) => {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  appendFileSync(join(repo, path), text);
  git('add', '-A');
  git('commit', '-qm', `change ${path}`);
  return git('log', '-1', '--format=%h', '--abbrev=8');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'termag-build-version-'));
  repo = join(root, 'repo');
  pkg = join(repo, 'cli');
  mkdirSync(pkg, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  writeFileSync(join(pkg, 'package.json'), '{"version":"0.3.0"}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('buildVersion.mjs', () => {
  it('counts the commits that touched the package, and names the latest', () => {
    commit('cli/src/a.ts', 'a\n');
    commit('tui/src/b.ts', 'b\n');
    const latest = commit('cli/src/a.ts', 'more\n');
    commit('docs/c.md', 'c\n');
    expect(version(pkg)).toBe(`0.3.3+${latest}`);
  });

  it('says dirty for a tracked change or a new file in the package, and nothing else', () => {
    const sha = git('log', '-1', '--format=%h', '--abbrev=8');
    mkdirSync(join(pkg, 'dist'));
    writeFileSync(join(pkg, 'dist', 'main.js'), '');
    writeFileSync(join(repo, 'outside.txt'), 'elsewhere\n');
    expect(version(pkg)).toBe(`0.3.1+${sha}`);
    writeFileSync(join(pkg, 'new.ts'), '');
    expect(version(pkg)).toBe(`0.3.1+${sha}.dirty`);
    rmSync(join(pkg, 'new.ts'));
    appendFileSync(join(pkg, 'package.json'), '\n');
    expect(version(pkg)).toBe(`0.3.1+${sha}.dirty`);
  });

  it('falls back to package.json plus +unknown in a shallow clone or outside git', () => {
    commit('cli/src/a.ts', 'a\n');
    const shallow = join(root, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, shallow]);
    expect(version(join(shallow, 'cli'))).toBe('0.3.0+unknown');
    const plain = join(root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'package.json'), '{"version":"0.3.0"}\n');
    expect(version(plain)).toBe('0.3.0+unknown');
  });

  it('ignores a GIT_DIR from the caller', () => {
    const sha = git('log', '-1', '--format=%h', '--abbrev=8');
    const other = join(root, 'other');
    execFileSync('git', ['init', '-q', other]);
    expect(version(pkg, { ...process.env, GIT_DIR: join(other, '.git') })).toBe(`0.3.1+${sha}`);
  });
});
