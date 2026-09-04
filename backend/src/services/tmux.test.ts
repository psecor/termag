import { afterEach, describe, expect, it } from 'vitest';
import {
  localSessionsEnabled, LocalSessionsDisabledError,
  ensureProjectDir, createSession, sendKeys, renameSession,
  hasSession, listSessions, killSession, capturePaneText, foregroundCommand, capturePaneForSlack,
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
