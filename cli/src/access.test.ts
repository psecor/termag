import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshAccess, REFRESH_MARGIN_MS } from './access.js';
import type { StoredLogin } from './credentials.js';

let dir: string;
let refreshes: number;
const fakeFetch = (async () => {
  refreshes++;
  const body = { accessToken: `eyJfresh.${refreshes}.sig`, accessTokenExpiresIn: 3600, expiresAt: '2099-01-01T00:00:00Z', maxExpiresAt: '2099-01-01T00:00:00Z' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const login = (leftMs: number): StoredLogin => ({
  token: 'tmcli_' + 'f'.repeat(64),
  accessToken: 'eyJcached.x.sig',
  accessTokenExpiresAt: new Date(Date.now() + leftMs).toISOString(),
  deviceName: 'laptop', email: 'someone@example.com', unixUsername: 'someone',
  expiresAt: '2099-01-01T00:00:00Z', maxExpiresAt: '2099-01-01T00:00:00Z',
});

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'termag-access-')); refreshes = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('freshAccess', () => {
  const deps = () => ({ host: 'https://orch.example.com/termag', credsPath: join(dir, 'credentials.json'), fetch: fakeFetch });

  it('keeps a cached token past REFRESH_MARGIN_MS, and refreshes one inside it', async () => {
    expect((await freshAccess(deps(), login(REFRESH_MARGIN_MS + 30_000))).accessToken).toBe('eyJcached.x.sig');
    expect((await freshAccess(deps(), login(REFRESH_MARGIN_MS - 1000))).accessToken).toBe('eyJfresh.1.sig');
  });

  it('refreshes one that won\'t last `validForMs`, and keeps one that will', async () => {
    const validForMs = 15 * 60_000;
    expect((await freshAccess(deps(), login(10 * 60_000), { validForMs })).accessToken).toBe('eyJfresh.1.sig');
    expect((await freshAccess(deps(), login(20 * 60_000), { validForMs })).accessToken).toBe('eyJcached.x.sig');
    // Shorter than the margin: the margin still wins.
    expect((await freshAccess(deps(), login(30_000), { validForMs: 1000 })).accessToken).toBe('eyJfresh.2.sig');
    expect(refreshes).toBe(2);
  });
});
