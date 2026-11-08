import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { RawAesKeyringNode, RawAesWrappingSuiteIdentifier } from '@aws-crypto/client-node';
import { sealCredential, openCredential, type CredentialStoreConfig } from './credentialStore';
import {
  createPoolTokenSource, deletePoolCredential, openPoolCredential, poolCredentialSummary, PoolCredentialUnavailable,
  onPoolCredentialChange, readPoolGithubToken, sealPoolCredential, setPoolGithubCredential, type PoolCredentialRows,
} from './poolCredential';

const ARN = 'arn:aws:kms:us-east-2:111122223333:key/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const POOL_PAT = 'github_pat_e2ePoolReadonly0123456789abcdef'; // gitleaks:allow (test sentinel)
const ADMIN = 'cmadmin000000001';

function rawKeyring(): RawAesKeyringNode {
  return new RawAesKeyringNode({
    keyName: 'test-key', keyNamespace: 'termag-test',
    unencryptedMasterKey: new Uint8Array(randomBytes(32)),
    wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
  });
}

function memoryRows(): PoolCredentialRows & { rows: Map<string, { label: string; ciphertext: Buffer; updatedByUserId: string; updatedAt: Date }> } {
  const rows = new Map<string, { label: string; ciphertext: Buffer; updatedByUserId: string; updatedAt: Date }>();
  return {
    rows,
    find: async p => rows.get(p) ?? null,
    upsert: async (p, row) => { rows.set(p, { ...row, updatedAt: new Date('2026-11-06T12:00:00Z') }); },
    remove: async p => rows.delete(p),
  };
}

const github = (status: number, login = 'pool-bot') => vi.fn(async () =>
  new Response(status === 200 ? JSON.stringify({ login, id: 7 }) : '{}', { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

let cfg: CredentialStoreConfig;
beforeEach(() => { cfg = { kmsKeyArn: ARN, keyring: rawKeyring() }; });

describe('pool credential sealing', () => {
  it("opens as the pool's, and never as a user's or a user's as the pool's", async () => {
    const sealed = await sealPoolCredential(cfg, 'github', { token: POOL_PAT, login: 'pool-bot' });
    expect(sealed.includes(Buffer.from(POOL_PAT))).toBe(false);
    expect(await openPoolCredential(cfg, 'github', sealed)).toEqual({ token: POOL_PAT, login: 'pool-bot' });
    await expect(openCredential(cfg, 'cmalice0000000001', 'github', sealed)).rejects.toThrow(/not encrypted for this user/);
    const users = await sealCredential(cfg, 'cmalice0000000001', 'github', { token: 'gho_x' });
    await expect(openPoolCredential(cfg, 'github', users)).rejects.toThrow(/not encrypted as the pool's/);
  });
});

describe('setPoolGithubCredential', () => {
  it('stores a token GitHub accepts, labelled with its login, and reads it back', async () => {
    const rows = memoryRows();
    const summary = await setPoolGithubCredential(` ${POOL_PAT} `, ADMIN, { rows, cfg, fetchImpl: github(200) });
    expect(summary).toEqual({ provider: 'github', set: true, label: '@pool-bot', updatedAt: '2026-11-06T12:00:00.000Z', updatedByUserId: ADMIN });
    expect(JSON.stringify(summary)).not.toContain(POOL_PAT);
    expect(await readPoolGithubToken({ rows, cfg })).toBe(POOL_PAT);
  });

  it('refuses what is not a GitHub token, and one GitHub rejects, storing nothing', async () => {
    const rows = memoryRows();
    await expect(setPoolGithubCredential('hunter2', ADMIN, { rows, cfg, fetchImpl: github(200) })).rejects.toThrow(/not a GitHub token/);
    await expect(setPoolGithubCredential(POOL_PAT, ADMIN, { rows, cfg, fetchImpl: github(401) })).rejects.toThrow(/GitHub rejected/);
    expect(rows.rows.size).toBe(0);
  });

  it('refuses with the credential store off', async () => {
    await expect(setPoolGithubCredential(POOL_PAT, ADMIN, { rows: memoryRows(), cfg: null, fetchImpl: github(200) })).rejects.toBeInstanceOf(PoolCredentialUnavailable);
  });

  it('deletes, after which nothing is read', async () => {
    const rows = memoryRows();
    await setPoolGithubCredential(POOL_PAT, ADMIN, { rows, cfg, fetchImpl: github(200) });
    expect(await deletePoolCredential('github', { rows })).toBe(true);
    expect(await readPoolGithubToken({ rows, cfg })).toBeNull();
    expect(await poolCredentialSummary('github', { rows })).toMatchObject({ set: false, label: null });
  });
});

describe('pool credential change listeners', () => {
  it('hears a set and a delete', async () => {
    const rows = memoryRows();
    const heard = vi.fn();
    const off = onPoolCredentialChange(heard);
    await setPoolGithubCredential(POOL_PAT, ADMIN, { rows, cfg, fetchImpl: github(200) });
    await deletePoolCredential('github', { rows });
    off();
    await deletePoolCredential('github', { rows });
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('createPoolTokenSource: the broker reads the row every time, and opens it only when it changed', () => {
  it("sees another process's delete and replace at once, with no KMS call while the row is unchanged", async () => {
    const rows = memoryRows();
    await setPoolGithubCredential(POOL_PAT, ADMIN, { rows, cfg, fetchImpl: github(200) });
    // Two processes: each its own source over the same table.
    const open = vi.fn(openPoolCredential);
    const a = createPoolTokenSource({ rows, cfg, open });
    expect(await a()).toBe(POOL_PAT);
    expect(await a()).toBe(POOL_PAT);
    expect(open).toHaveBeenCalledTimes(1);
    // Process b deletes it; a's next read sees no row.
    await deletePoolCredential('github', { rows });
    expect(await a()).toBeNull();
    // Process b sets another; a opens the new row.
    const OTHER = 'github_pat_e2ePoolReadonlyOTHER456789abcdef'; // gitleaks:allow (test sentinel)
    await setPoolGithubCredential(OTHER, ADMIN, { rows, cfg, fetchImpl: github(200) });
    expect(await a()).toBe(OTHER);
  });
});

