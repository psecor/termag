/**
 * The MCP sign-in state row against a real Postgres: consumeOAuthState's raw
 * DELETE … RETURNING answers the row once, with where the callback returns
 * the browser (`returnTo`).
 *
 * Needs TERMAG_TEST_PG_URL, a superuser URL (as db.integration.test.ts).
 * Skipped without it. Each run creates and drops its own database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';

const adminUrl = process.env.TERMAG_TEST_PG_URL;
const dbName = `termag_mcpstate_${process.pid}`;
const dbUrl = adminUrl ? adminUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) : '';
vi.hoisted(() => { if (process.env.TERMAG_TEST_PG_URL) process.env.DATABASE_URL = process.env.TERMAG_TEST_PG_URL.replace(/\/[^/?]*(\?|$)/, `/termag_mcpstate_${process.pid}$1`); });

describe.skipIf(!adminUrl)('MCP sign-in state against Postgres', () => {
  let store: typeof import('./mcpConnectorStore');
  let prisma: typeof import('../db').prisma;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const push = spawnSync(join(__dirname, '../../node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: join(__dirname, '../..'), env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    if (push.status !== 0) throw new Error(`db push failed: ${push.stderr}`);
    ({ prisma } = await import('../db'));
    store = await import('./mcpConnectorStore');
    await prisma.user.create({ data: { id: 'u1', googleId: 'g-u1', googleEmail: 'u1@example.com', unixUsername: 'u1', displayName: 'u1' } });
    await prisma.mcpConnector.create({ data: { id: 'c1', userId: 'u1', name: 'acme', upstream: 'https://mcp.acme.example/mcp', authType: 'oauth' } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('answers a wizard sign-in\'s returnTo once', async () => {
    await store.createOAuthState('n-welcome', 'u1', 'c1', 'verifier', ['read'], 'welcome');
    expect(await store.consumeOAuthState('n-welcome')).toMatchObject({ userId: 'u1', connectorId: 'c1', codeVerifier: 'verifier', scopes: ['read'], returnTo: 'welcome' });
    expect(await store.consumeOAuthState('n-welcome')).toBeNull();
  });

  it('answers null for a sign-in started in Settings', async () => {
    await store.createOAuthState('n-settings', 'u1', 'c1', 'verifier', []);
    expect((await store.consumeOAuthState('n-settings'))?.returnTo).toBeNull();
  });
});
