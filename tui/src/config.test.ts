import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePrefix, resolveConfig, saveLastTarget } from './config.js';

describe('resolveConfig', () => {
  const home = '/home/u';
  const tuiJson = '/home/u/.config/termag/tui.json';

  it('takes the orchestrator and credential from `termag tui`', () => {
    const read = (p: string) => p === tuiJson ? JSON.stringify({ returnKey: 'Y', lastTarget: { projectId: 'p1', workstream: 'main' } }) : null;
    expect(resolveConfig({ TERMAG_URL: 'http://env/termag/', TERMAG_TOKEN: 'tmcli_x', TERMAG_CREDENTIAL: 'termag login' }, read, home))
      .toEqual({ url: 'http://env/termag', token: 'tmcli_x', source: 'termag login', returnKey: 'Y', prefix: '\x1c', notify: true, lastTarget: { projectId: 'p1', workstream: 'main' } });
  });

  it('takes a device sign-in\'s refresh token and access-token expiry', () => {
    const env = {
      TERMAG_URL: 'http://env/termag', TERMAG_TOKEN: 'eyJa', TERMAG_REFRESH_TOKEN: 'tmcli_r',
      TERMAG_TOKEN_EXPIRES_AT: '2026-10-06T22:00:00.000Z',
    };
    expect(resolveConfig(env, () => null, home).refresh)
      .toEqual({ refreshToken: 'tmcli_r', expiresAt: Date.parse('2026-10-06T22:00:00.000Z') });
    expect(resolveConfig({ ...env, TERMAG_TOKEN_EXPIRES_AT: 'soon' }, () => null, home).refresh?.expiresAt).toBe(0);
    expect(resolveConfig({ TERMAG_URL: 'u', TERMAG_TOKEN: 'tmag_box' }, () => null, home).refresh).toBeUndefined();
  });

  it('defaults the settings and labels a bare TERMAG_TOKEN', () => {
    expect(resolveConfig({ TERMAG_URL: 'http://env/termag', TERMAG_TOKEN: 't' }, () => null, home))
      .toMatchObject({ source: 'TERMAG_TOKEN', returnKey: 'T', prefix: '\x1c', notify: true, lastTarget: null });
    const off = (p: string) => p === tuiJson ? '{"returnKey": null, "prefix": "C-]", "notify": false}' : null;
    const c = resolveConfig({ TERMAG_URL: 'u', TERMAG_TOKEN: 't' }, off, home);
    expect(c.returnKey).toBeNull();
    expect(c.prefix).toBe('\x1d');
    expect(c.notify).toBe(false);
  });

  it('parses the remote-attach prefix', () => {
    expect(parsePrefix(undefined)).toBe('\x1c');
    expect(parsePrefix('C-\\')).toBe('\x1c');
    expect(parsePrefix('C-]')).toBe('\x1d');
    expect(parsePrefix('C-a')).toBe('\x01');
    expect(parsePrefix('C-Z')).toBe('\x1a');
    expect(parsePrefix('`')).toBe('`');
    expect(parsePrefix('nonsense')).toBe('\x1c');
  });

  it('ignores credentials in tui.json and agent configs, and points at `termag tui`', () => {
    const files: Record<string, string> = {
      [tuiJson]: JSON.stringify({ url: 'http://tui/termag', token: 'tui-tok' }),
      '/home/u/src/termag/agent/agent.config.json': JSON.stringify({ termag_url: 'ws://box:3040/termag/ws/agent', token: 'tmag_x' }),
    };
    expect(() => resolveConfig({}, (p) => files[p] ?? null, home)).toThrow(/termag tui/);
    expect(() => resolveConfig({ TERMAG_URL: 'http://env/termag' }, (p) => files[p] ?? null, home)).toThrow(/termag tui/);
  });
});

describe('saveLastTarget', () => {
  it('keeps settings and drops a stored url and token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termag-tui-config-'));
    try {
      const path = join(dir, 'tui.json');
      writeFileSync(path, JSON.stringify({ url: 'http://old/termag', token: 'tmag_old', returnKey: 'Y' }));
      saveLastTarget({ projectId: 'p1', workstream: 'feat' }, path);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ returnKey: 'Y', lastTarget: { projectId: 'p1', workstream: 'feat' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
