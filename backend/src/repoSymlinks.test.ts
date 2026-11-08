import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';

// The orchestrator bake ships the CI checkout as it is (packer/orchestrator.pkr.hcl,
// the file provisioner with source "../"), and packer follows every symlink it
// meets. One whose target isn't there fails the whole bake ("lstat ../frontend/x:
// no such file or directory"), so nothing deploys. A stray `frontend/y -> x`
// did that on 2026-11-06. Every tracked symlink has to point at something.

const repo = resolve(__dirname, '../..');

// Tracked paths whose index mode is 120000 (a symlink).
function trackedSymlinks(): string[] {
  const out = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: repo, encoding: 'utf8' });
  return out
    .split('\0')
    .filter((line) => line.startsWith('120000 '))
    .map((line) => line.slice(line.indexOf('\t') + 1));
}

describe('tracked symlinks', () => {
  it('each points at a path in the checkout', () => {
    const dangling = trackedSymlinks().filter((path) => {
      const at = join(repo, path);
      return !existsSync(resolve(dirname(at), readlinkSync(at)));
    });
    expect(dangling, 'these symlinks point at nothing, and the orchestrator bake fails on them').toEqual([]);
  });
});
