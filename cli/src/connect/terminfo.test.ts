import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findTool } from './process.js';
import { withTerminfo } from './terminfo.js';

// The box side of withTerminfo, run by a real sh with this machine's ncurses.
const ncurses = Boolean(findTool('tic', process.env) && findTool('infocmp', process.env));
const TERM = 'termag-test-term';
const SOURCE = `${TERM}|a terminal for termag's tests,\n\tam,\n\tcols#80,\n\tbel=^G,\n`;

let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'termag-terminfo-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function onBox(command: string, path = process.env.PATH) {
  const env = { PATH: path, HOME: home, TERM };
  const r = spawnSync('sh', ['-c', withTerminfo(TERM, SOURCE, command)], { env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!ncurses)('withTerminfo on the box', () => {
  it('installs a missing entry into ~/.terminfo, and the command runs under it', () => {
    const r = onBox('printf %s "$TERM"; infocmp -x >/dev/null && echo " found"');
    expect(r).toEqual({ status: 0, stdout: `${TERM} found\n`, stderr: '' });
    // Linux's ncurses files it under its first letter, macOS's under that letter's hex code (74 for t).
    const dirs = [TERM[0], TERM.charCodeAt(0).toString(16)];
    expect(dirs.some(d => existsSync(join(home, '.terminfo', d, TERM)))).toBe(true);
  });

  it('runs no tic once the box has it', () => {
    expect(onBox('true').status).toBe(0);
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tic'), '#!/bin/sh\necho tic ran >&2\nexit 1\n');
    chmodSync(join(bin, 'tic'), 0o755);
    expect(onBox('printf %s "$TERM"', `${bin}:${process.env.PATH}`)).toEqual({ status: 0, stdout: TERM, stderr: '' });
  });

  it('falls back to xterm-256color, saying so, when tic fails', () => {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tic'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'tic'), 0o755);
    expect(onBox('printf %s "$TERM"', `${bin}:${process.env.PATH}`)).toEqual({
      status: 0,
      stdout: 'xterm-256color',
      stderr: `termag: could not install the terminfo entry for ${TERM} on the box; using TERM=xterm-256color\n`,
    });
  });
});
