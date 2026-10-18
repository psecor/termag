import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PROCESS_NAMES } from '../providers/registry';
import { classifyForeground } from './foregroundProbe';
import { buildCloneCommand } from './projectTemplates';

/**
 * Basename tmux's pane_current_command reports while `git fetch` in `command`
 * runs. Measured on tmux 3.5: a subshell that still has work after the fetch
 * stays the process-group leader, so the pane shows the shell. A direct git,
 * including one with a `VAR=value` prefix, is the leader itself. Bash execs
 * the last command of a subshell, so a fetch with nothing after it becomes git.
 */
function fetchForegroundName(command: string): string {
  const match = /(?:^|[\s;&|])git fetch\b/.exec(command);
  if (!match) return 'bash';
  const at = match.index + match[0].length - 'git fetch'.length;
  let depth = 0;
  for (let i = 0; i < at; i++) {
    if (command[i] === '(' && command[i - 1] !== '$') depth++;
    else if (command[i] === ')') depth = Math.max(0, depth - 1);
  }
  if (depth === 0) return 'git';
  let scan = depth;
  for (let i = at + 'git fetch'.length; i < command.length; i++) {
    if (command[i] === '(' && command[i - 1] !== '$') scan++;
    else if (command[i] === ')') {
      scan--;
      if (scan < depth) return 'git';
    } else if (scan === depth && (command.startsWith('&&', i) || command.startsWith('||', i) || command[i] === ';')) {
      return 'bash';
    }
  }
  return 'git';
}

function hasTmux(): boolean {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('classifyForeground', () => {
  it('treats git, any case, and a path to git as busy', () => {
    expect(classifyForeground('git')).toBe('busy');
    expect(classifyForeground('Git')).toBe('busy');
    expect(classifyForeground('/usr/bin/git')).toBe('busy');
    expect(classifyForeground('git-remote-https')).toBe('busy');
    expect(classifyForeground('/usr/lib/git-core/git-remote-http')).toBe('busy');
  });

  it('treats an empty command and a shell as not running', () => {
    expect(classifyForeground('')).toBe('not-running');
    expect(classifyForeground(null)).toBe('not-running');
    expect(classifyForeground('zsh')).toBe('not-running');
    expect(classifyForeground('bash')).toBe('not-running');
  });

  it('treats a registered agent process as running', () => {
    expect(ALL_PROCESS_NAMES).toContain('claude');
    expect(classifyForeground('claude')).toBe('running');
  });

  it('does not treat digit, github, or ssh as git', () => {
    expect(classifyForeground('digit')).toBe('not-running');
    expect(classifyForeground('github')).toBe('not-running');
    expect(classifyForeground('ssh')).toBe('not-running');
  });

  it('classifies a shell-wrapped fetch as idle and the checkout fetch as busy', () => {
    const wrapped = '( export GIT_CONFIG_GLOBAL=/dev/null && git fetch --progress origin && true )';
    expect(classifyForeground(fetchForegroundName(wrapped))).toBe('not-running');
    expect(classifyForeground('bash')).toBe('not-running');
    expect(classifyForeground('zsh')).toBe('not-running');
    expect(classifyForeground(fetchForegroundName(buildCloneCommand('https://github.com/o/r.git')))).toBe('busy');
    expect(classifyForeground(fetchForegroundName(buildCloneCommand('https://github.com/o/r.git', undefined, { blankGlobalGitconfig: true })))).toBe('busy');
  });

  it.skipIf(!hasTmux())('a shell-wrapped fetch is idle in tmux and the checkout fetch is busy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pane-fetch-'));
    const bin = join(dir, 'bin');
    const log = join(dir, 'git.log');
    const sock = `termag-fetch-${process.pid}`;
    const tmux = (...argv: string[]) => execFileSync('tmux', ['-L', sock, ...argv], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), `#!/bin/bash
printf '%s %s\\n' "$1" "\${GIT_CONFIG_GLOBAL-unset}" >> ${JSON.stringify(log)}
case "$1" in
  fetch) exec -a git sleep 30 ;;
  symbolic-ref) printf '%s\\n' main ;;
esac
exit 0
`);
      chmodSync(join(bin, 'git'), 0o755);
      tmux('new-session', '-d', '-s', 'probe', '-c', dir, '--', 'bash', '--noprofile', '--norc');
      tmux('send-keys', '-t', 'probe', '-l', `export PATH=${bin}${delimiter}$PATH`);
      tmux('send-keys', '-t', 'probe', 'Enter');

      const pane = () => tmux('display-message', '-p', '-t', 'probe', '#{pane_current_command}').trim();
      const logText = () => {
        try { return readFileSync(log, 'utf8'); } catch { return ''; }
      };
      const waitFor = (pred: () => boolean) => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (pred()) return;
          execFileSync('sleep', ['0.05']);
        }
        throw new Error(`timed out; pane=${pane()} log=${logText()}`);
      };

      execFileSync('sleep', ['0.2']);
      const wrapped = '( export GIT_CONFIG_GLOBAL=/dev/null && git fetch --progress origin && true )';
      tmux('send-keys', '-t', 'probe', '-l', wrapped);
      tmux('send-keys', '-t', 'probe', 'Enter');
      waitFor(() => logText().includes('fetch '));
      execFileSync('sleep', ['0.2']);
      expect(classifyForeground(pane())).toBe('not-running');

      tmux('send-keys', '-t', 'probe', 'C-c');
      waitFor(() => pane() === 'bash');
      writeFileSync(log, '');

      tmux('send-keys', '-t', 'probe', '-l', buildCloneCommand('https://github.com/o/r.git', undefined, { blankGlobalGitconfig: true }));
      tmux('send-keys', '-t', 'probe', 'Enter');
      // The helper logs "fetch" and then execs, so the pane is git only after that.
      waitFor(() => logText().includes('fetch ') && classifyForeground(pane()) === 'busy');
      expect(classifyForeground(pane())).toBe('busy');
      const fetchLine = logText().split('\n').find(line => line.startsWith('fetch '));
      expect(fetchLine).toBe('fetch /dev/null');
    } finally {
      try { tmux('kill-server'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
