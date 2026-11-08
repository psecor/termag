import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { randomBytes } from 'node:crypto';
import { RawAesKeyringNode, RawAesWrappingSuiteIdentifier } from '@aws-crypto/client-node';
import { poolCredentialRouter } from './poolCredential';
import { readPoolGithubToken, type PoolCredentialRows } from '../../services/poolCredential';

const POOL_PAT = 'github_pat_e2ePoolReadonly0123456789abcdef'; // gitleaks:allow (test sentinel)
const rows = new Map<string, { label: string; ciphertext: Buffer; updatedByUserId: string; updatedAt: Date }>();
const memory: PoolCredentialRows = {
  find: async p => rows.get(p) ?? null,
  upsert: async (p, row) => { rows.set(p, { ...row, updatedAt: new Date('2026-11-06T12:00:00Z') }); },
  remove: async p => rows.delete(p),
};
const cfg = {
  kmsKeyArn: 'arn:aws:kms:us-east-2:111122223333:key/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0',
  keyring: new RawAesKeyringNode({
    keyName: 'k', keyNamespace: 'termag-test', unencryptedMasterKey: new Uint8Array(randomBytes(32)),
    wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
  }),
};
const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
  const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
  return auth.includes(POOL_PAT)
    ? new Response(JSON.stringify({ login: 'pool-bot', id: 7 }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('{}', { status: 401 });
}) as unknown as typeof fetch;

let server: Server;
let base: string;
let viaToken = false;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // What requireAdmin leaves behind: the admin, and adminTokenId for a bearer token.
  app.use((req, _res, next) => { req.user = { id: 'cmadmin000000001' } as Express.User; if (viaToken) req.adminTokenId = 'tok1'; next(); });
  app.use(poolCredentialRouter({ rows: memory, cfg, fetchImpl }));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pool-credential/github`;
});
afterAll(() => { server.close(); });
beforeEach(() => { rows.clear(); viaToken = false; });

const put = (body: unknown) => fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('/api/admin/pool-credential/github', () => {
  it('stores a token GitHub accepts and shows only its login', async () => {
    const res = await put({ token: POOL_PAT });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(POOL_PAT);
    expect(JSON.parse(text)).toMatchObject({ set: true, label: '@pool-bot', updatedByUserId: 'cmadmin000000001' });
    expect(await (await fetch(base)).json()).toMatchObject({ set: true, label: '@pool-bot' });
    expect(await readPoolGithubToken({ rows: memory, cfg })).toBe(POOL_PAT);
  });

  it('answers 400 for a token GitHub rejects', async () => {
    const res = await put({ token: 'github_pat_somethingElse0123456789' }); // gitleaks:allow (test sentinel)
    expect(res.status).toBe(400);
    expect(rows.size).toBe(0);
  });

  it('takes a set or a delete only from a signed-in admin session, not an admin token', async () => {
    viaToken = true;
    expect((await put({ token: POOL_PAT })).status).toBe(403);
    expect((await fetch(base, { method: 'DELETE' })).status).toBe(403);
    expect((await fetch(base)).status).toBe(200);
  });

  it('deletes', async () => {
    await put({ token: POOL_PAT });
    expect(await (await fetch(base, { method: 'DELETE' })).json()).toEqual({ removed: true });
    expect(await (await fetch(base)).json()).toMatchObject({ set: false });
  });
});
