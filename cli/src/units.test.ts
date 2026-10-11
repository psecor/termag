import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCommandLine } from './args.js';
import { DEFAULT_HOST, baseUrlFromAgentUrl, findBoxCredential, normalizeHost, resolveTarget } from './config.js';
import { authorizeUrl, deviceNameFrom, listenForCallback, pkcePair } from './login.js';
import { formatDate, table } from './output.js';
import { VERSION } from './version.js';

describe('parseCommandLine', () => {
  it('resolves grouped commands, aliases and global flags anywhere', () => {
    expect(parseCommandLine(['box', 'ls', '--json'])).toMatchObject({ command: 'box list', json: true });
    expect(parseCommandLine(['--host', 'localhost:3040', 'project', 'list'])).toMatchObject({ command: 'project list', host: 'localhost:3040' });
    expect(parseCommandLine(['login', '--device', 'mbp'])).toMatchObject({ command: 'login', options: { device: 'mbp' } });
    expect(parseCommandLine(['help', 'project', 'ls'])).toMatchObject({ help: true, command: 'project list' });
  });

  it('refuses options that belong to another command', () => {
    expect(() => parseCommandLine(['whoami', '--device', 'x'])).toThrow(/not an option of `termag whoami`/);
    expect(() => parseCommandLine(['--nope'])).toThrow();
  });
});

describe('normalizeHost', () => {
  it.each([
    ['localhost:3040', 'http://localhost:3040/termag'],
    ['127.0.0.1:3040/termag/', 'http://127.0.0.1:3040/termag'],
    ['termag.example', 'https://termag.example/termag'],
    ['https://termag.example/custom', 'https://termag.example/custom'],
    [DEFAULT_HOST, DEFAULT_HOST],
  ])('%s → %s', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it('rejects other schemes and embedded credentials', () => {
    expect(() => normalizeHost('ftp://x')).toThrow();
    expect(() => normalizeHost('https://u:p@x')).toThrow();
  });
});

describe('box credentials', () => {
  const files = (map: Record<string, string>) => (p: string) => map[p] ?? null;
  const home = '/home/zane';
  const boxConfig = '/home/zane/src/termag/agent/agent.config.json';

  it('derives the orchestrator from the agent URL', () => {
    expect(baseUrlFromAgentUrl('ws://10.0.0.5:3040/termag/ws/agent')).toBe('http://10.0.0.5:3040/termag');
    expect(baseUrlFromAgentUrl('wss://termag.example/termag/ws/agent')).toBe('https://termag.example/termag');
  });

  it('finds a real agent token and skips the example placeholder', () => {
    expect(findBoxCredential({}, home, files({ [boxConfig]: JSON.stringify({ termag_url: 'ws://h:3040/termag/ws/agent', token: 'paste-your-agent-token-here' }) }))).toBeNull();
    expect(findBoxCredential({}, home, files({ [boxConfig]: JSON.stringify({ termag_url: 'ws://h:3040/termag/ws/agent', token: 'tmag_x' }) })))
      .toEqual({ host: 'http://h:3040/termag', token: 'tmag_x', path: boxConfig });
  });

  it('offers the box token only to its own orchestrator', () => {
    const read = files({ [boxConfig]: JSON.stringify({ server_url: 'ws://h:3040/termag/ws/agent', token: 'tmag_x' }) });
    expect(resolveTarget(undefined, {}, home, read)).toMatchObject({ host: 'http://h:3040/termag', source: 'box', box: { token: 'tmag_x' } });
    expect(resolveTarget('https://other.example', {}, home, read)).toMatchObject({ source: 'flag', box: null });
    expect(resolveTarget(undefined, {}, home, files({}))).toEqual({ host: DEFAULT_HOST, source: 'default', box: null });
    expect(resolveTarget(undefined, { TERMAG_URL: 'localhost:3040' }, home, files({}))).toMatchObject({ host: 'http://localhost:3040/termag', source: 'env' });
  });
});

describe('login helpers', () => {
  it('makes an S256 PKCE pair', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('sanitizes the hostname into a device name', () => {
    expect(deviceNameFrom('zane-mbp.local')).toBe('zane-mbp.local');
    expect(deviceNameFrom('--weird/host:name')).toBe('weird-host-name');
    expect(deviceNameFrom('!!!')).toBe('device');
    expect(deviceNameFrom('x'.repeat(100))).toHaveLength(64);
  });

  it('builds the authorize URL under the orchestrator base path', () => {
    const url = new URL(authorizeUrl('https://t.example/termag', { port: 50000, state: 's'.repeat(22), challenge: 'c', deviceName: 'mbp' }));
    expect(url.pathname).toBe('/termag/auth/cli/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ port: '50000', code_challenge_method: 'S256', device_name: 'mbp' });
  });

  it('ignores callbacks with the wrong state and resolves on the right one', async () => {
    const cb = await listenForCallback('right-state-value', 5000);
    try {
      const base = `http://127.0.0.1:${cb.port}/callback`;
      const wrong = await fetch(`${base}?code=evil&state=wrong`);
      expect(wrong.status).toBe(400);
      expect(await wrong.text()).toContain('Sign-in link mismatch');
      expect((await fetch(`${base}?error=access_denied&state=wrong`)).status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${cb.port}/favicon.ico`)).status).toBe(404);
      const ok = await fetch(`${base}?code=good&state=right-state-value`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");
      await expect(cb.result).resolves.toBe('good');
    } finally {
      cb.close();
    }
  });

  it('rejects when the browser cancels', async () => {
    const cb = await listenForCallback('right-state-value', 5000);
    try {
      await fetch(`http://127.0.0.1:${cb.port}/callback?error=access_denied&state=right-state-value`);
      await expect(cb.result).rejects.toMatchObject({ code: 'auth_required' });
    } finally {
      cb.close();
    }
  });
});

describe('output', () => {
  it('aligns columns without trailing padding', () => {
    expect(table(['A', 'BB'], [['xxx', 'y'], ['z', '']])).toBe('A    BB\nxxx  y\nz');
  });

  it('formats dates in UTC', () => {
    expect(formatDate('2026-10-02T14:05:59.000Z')).toBe('2026-10-02 14:05 UTC');
    expect(formatDate(null)).toBe('-');
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
