import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localSessionsEnabled, LocalSessionsDisabledError, sessionBelongsToUser, sessionName,
  ensureProjectDir, createSession, sendKeys, renameSession,
  hasSession, listSessions, killSession, capturePaneText, foregroundCommand, capturePaneForSlack,
  exactSessionTarget,
} from './tmux';

const original = process.env.LOCAL_SESSIONS_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.LOCAL_SESSIONS_ENABLED;
  else process.env.LOCAL_SESSIONS_ENABLED = original;
});

describe('localSessionsEnabled', () => {
  it('defaults to enabled when unset', () => {
    expect(localSessionsEnabled({})).toBe(true);
  });

  it('treats false/0/no/off (any case, padded) as disabled', () => {
    for (const v of ['false', 'FALSE', ' 0 ', 'no', 'Off']) {
      expect(localSessionsEnabled({ LOCAL_SESSIONS_ENABLED: v })).toBe(false);
    }
  });

  it('treats anything else as enabled', () => {
    for (const v of ['true', '1', 'yes', 'banana', '']) {
      expect(localSessionsEnabled({ LOCAL_SESSIONS_ENABLED: v })).toBe(true);
    }
  });
});

describe('with LOCAL_SESSIONS_ENABLED=false', () => {
  it('rejects operations that would create or drive a local session', async () => {
    process.env.LOCAL_SESSIONS_ENABLED = 'false';
    await expect(ensureProjectDir('alice', 'proj')).rejects.toBeInstanceOf(LocalSessionsDisabledError);
    await expect(createSession('alice-proj-agent', '/tmp')).rejects.toBeInstanceOf(LocalSessionsDisabledError);
    await expect(sendKeys('alice-proj-agent', 'ls')).rejects.toBeInstanceOf(LocalSessionsDisabledError);
    await expect(renameSession('a', 'b')).rejects.toBeInstanceOf(LocalSessionsDisabledError);
    await expect(ensureProjectDir('alice', 'proj')).rejects.toThrow(/LOCAL_SESSIONS_ENABLED=false/);
  });

  it('degrades probes to "nothing here" without touching tmux', async () => {
    process.env.LOCAL_SESSIONS_ENABLED = 'false';
    expect(await hasSession('alice-proj-agent')).toBe(false);
    expect(await listSessions()).toEqual([]);
    expect(await foregroundCommand('alice-proj-agent')).toBeNull();
    expect(await capturePaneText('alice-proj-agent')).toBe('(unable to capture pane)');
    expect(await capturePaneForSlack('alice-proj-agent')).toBe('(unable to capture pane)');
    await expect(killSession('alice-proj-agent')).resolves.toBeUndefined();
  });
});

function hasTmux(): boolean {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('sessionName', () => {
  it('builds <user>-<project>-<role>, adding the workstream only off main', () => {
    expect(sessionName('alice', 'proj', 'agent')).toBe('alice-proj-agent');
    expect(sessionName('alice', 'proj', 'ctrl', 'feat-x')).toBe('alice-proj-feat-x-ctrl');
  });

  it('writes `.` and `:` as `_`, the way tmux names the session', () => {
    expect(sessionName('first.last', 'webapp', 'agent')).toBe('first_last-webapp-agent');
    expect(sessionName('a.b', 'p.q', 'ctrl', 'w')).toBe('a_b-p_q-w-ctrl');
  });

  it.skipIf(!hasTmux())('is the name a real tmux server gives the session, so `=name:` targets it', () => {
    const name = sessionName('first.last', 'proj', 'agent');
    const tmux = (...argv: string[]) => execFileSync('tmux', ['-L', `termag-backend-test-${process.pid}`, ...argv], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      tmux('new-session', '-d', '-s', name, '-c', process.cwd());
      expect(tmux('list-sessions', '-F', '#{session_name}').trim()).toBe(name);
      tmux('set-option', '-t', `=${name}:`, 'history-limit', '10000');
    } finally {
      try { tmux('kill-server'); } catch { /* already gone */ }
    }
  });
});

describe('sessionBelongsToUser', () => {
  it('matches the full username as a prefix', () => {
    expect(sessionBelongsToUser('alice-proj-agent', 'alice')).toBe(true);
    expect(sessionBelongsToUser('alice', 'alice')).toBe(true);
    expect(sessionBelongsToUser('alice-smith-proj-agent', 'alice-smith')).toBe(true);
    expect(sessionBelongsToUser('alicex-proj-agent', 'alice')).toBe(false);
    expect(sessionBelongsToUser('bob-proj-agent', 'alice')).toBe(false);
  });

  it('matches a dotted username against its tmux-safe session names', () => {
    expect(sessionBelongsToUser('first_last-webapp-agent', 'first.last')).toBe(true);
    expect(sessionBelongsToUser('first_lastx-webapp-agent', 'first.last')).toBe(false);
  });
});

describe('exactSessionTarget', () => {
  it('pins a tmux target to one session name, so a dead name cannot prefix-match a sibling', () => {
    expect(exactSessionTarget('u-p-agent')).toBe('=u-p-agent');
  });
});
