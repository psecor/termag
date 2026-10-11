import { randomBytes } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  KeyringNode,
  RawAesKeyringNode,
  RawAesWrappingSuiteIdentifier,
  type NodeDecryptionMaterial,
  type NodeEncryptionMaterial,
} from '@aws-crypto/client-node';

// An in-memory user_credentials table. Operations are lazy thenables, as
// Prisma's are, so $transaction can apply a batch all-or-nothing.
const db = vi.hoisted(() => {
  type Row = { userId: string; provider: string; label: string; ciphertext: Buffer };
  const rows = new Map<string, Row>();
  const key = (userId: string, provider: string) => `${userId}|${provider}`;
  const transactions: number[] = [];
  let failNextTransaction = false;
  function op(run: (table: Map<string, Row>) => unknown) {
    return {
      run,
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return Promise.resolve().then(() => run(rows)).then(resolve, reject);
      },
    };
  }
  const prisma = {
    userCredential: {
      findUnique: ({ where }: { where: { userId_provider: { userId: string; provider: string } } }) =>
        op(t => t.get(key(where.userId_provider.userId, where.userId_provider.provider)) ?? null),
      upsert: ({ where, create, update }: {
        where: { userId_provider: { userId: string; provider: string } };
        create: Row;
        update: Pick<Row, 'label' | 'ciphertext'>;
      }) => op(t => {
        const k = key(where.userId_provider.userId, where.userId_provider.provider);
        const existing = t.get(k);
        t.set(k, existing ? { ...existing, ...update } : { ...create });
      }),
      deleteMany: ({ where }: { where: { userId: string; provider: string | { in: string[] } } }) => op(t => {
        const providers = typeof where.provider === 'string' ? [where.provider] : where.provider.in;
        for (const p of providers) t.delete(key(where.userId, p));
      }),
      updateMany: ({ where, data }: {
        where: { userId: string; provider: string; ciphertext: Buffer };
        data: { label: string; ciphertext: Buffer };
      }) => op(t => {
        const existing = t.get(key(where.userId, where.provider));
        if (!existing || !existing.ciphertext.equals(where.ciphertext)) return { count: 0 };
        t.set(key(where.userId, where.provider), { ...existing, label: data.label, ciphertext: Buffer.from(data.ciphertext) });
        return { count: 1 };
      }),
    },
    $transaction: async (ops: { run: (t: Map<string, Row>) => unknown }[]) => {
      transactions.push(ops.length);
      const draft = new Map(rows);
      for (const o of ops) o.run(draft);
      if (failNextTransaction) {
        failNextTransaction = false;
        throw new Error('transaction aborted');
      }
      rows.clear();
      for (const [k, v] of draft) rows.set(k, v);
    },
  };
  return {
    prisma, rows, transactions, key,
    failTransaction: () => { failNextTransaction = true; },
  };
});
vi.mock('../db', () => ({ prisma: db.prisma }));

import { recheckGithub } from './githubCredential';
import {
  CREDENTIAL_PURPOSE,
  deleteCredentials,
  encryptionContextFor,
  getCredentialStoreConfig,
  githubStoreDeps,
  githubTokenSource,
  openCredential,
  readCredential,
  sealCredential,
  writeCredentials,
  type CredentialStoreConfig,
} from './credentialStore';

const ARN = 'arn:aws:kms:us-east-2:111122223333:key/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const ALICE = 'cmalice0000000001';
const BOB = 'cmbob00000000000002';
const TOKEN = 'gho_e2eAliceToken0123456789abcdefXYZ';

function rawKeyring(): RawAesKeyringNode {
  return new RawAesKeyringNode({
    keyName: 'test-key',
    keyNamespace: 'termag-test',
    unencryptedMasterKey: new Uint8Array(randomBytes(32)),
    wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
  });
}

class FailingKeyring extends KeyringNode {
  async _onEncrypt(_m: NodeEncryptionMaterial): Promise<NodeEncryptionMaterial> { throw new Error('KMS is unavailable'); }
  async _onDecrypt(_m: NodeDecryptionMaterial): Promise<NodeDecryptionMaterial> { throw new Error('KMS is unavailable'); }
}

let cfg: CredentialStoreConfig;

beforeEach(() => {
  db.rows.clear();
  db.transactions.length = 0;
  cfg = { kmsKeyArn: ARN, keyring: rawKeyring() };
});

describe('credential store config', () => {
  it('is off unless CREDENTIAL_STORE_KMS_KEY_ID is set', () => {
    expect(getCredentialStoreConfig({})).toBeNull();
    expect(getCredentialStoreConfig({ CREDENTIAL_STORE_KMS_KEY_ID: ` ${ARN} ` })).toEqual({ kmsKeyArn: ARN });
  });

  it('stays off for an alias or bare key id, which strict decryption cannot match', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getCredentialStoreConfig({ CREDENTIAL_STORE_KMS_KEY_ID: 'alias/termag-user-credentials' })).toBeNull();
    expect(getCredentialStoreConfig({ CREDENTIAL_STORE_KMS_KEY_ID: '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0' })).toBeNull();
    expect(getCredentialStoreConfig({ CREDENTIAL_STORE_KMS_KEY_ID: 'arn:aws:kms:us-east-2:111122223333:alias/termag-user-credentials' })).toBeNull();
    warn.mockRestore();
  });
});

describe('encryption context', () => {
  it('names the purpose, the user and the provider', () => {
    expect(encryptionContextFor(ALICE, 'github')).toEqual({ purpose: CREDENTIAL_PURPOSE, userId: ALICE, provider: 'github' });
  });

  it('refuses ids that are not a cuid or a provider name', () => {
    expect(() => encryptionContextFor('../other', 'github')).toThrow();
    expect(() => encryptionContextFor('', 'github')).toThrow();
    expect(() => encryptionContextFor(ALICE, 'GitHub')).toThrow();
    expect(() => encryptionContextFor(ALICE, '')).toThrow();
  });
});

describe('seal and open', () => {
  it('round-trips a value, and the ciphertext does not contain it', async () => {
    const sealed = await sealCredential(cfg, ALICE, 'github', { token: TOKEN });
    expect(sealed.includes(Buffer.from(TOKEN))).toBe(false);
    expect(await openCredential(cfg, ALICE, 'github', sealed)).toEqual({ token: TOKEN });
  });

  it("refuses a row copied onto another user's id", async () => {
    const sealed = await sealCredential(cfg, ALICE, 'github', { token: TOKEN });
    await expect(openCredential(cfg, BOB, 'github', sealed)).rejects.toThrow(/not encrypted for this user and provider/);
  });

  it('refuses a row copied onto another provider', async () => {
    const sealed = await sealCredential(cfg, ALICE, 'github', { token: TOKEN });
    await expect(openCredential(cfg, ALICE, 'example', sealed)).rejects.toThrow(/not encrypted for this user and provider/);
  });

  it('refuses a modified ciphertext', async () => {
    const sealed = await sealCredential(cfg, ALICE, 'github', { token: TOKEN });
    sealed[sealed.length - 20] ^= 0x01;
    await expect(openCredential(cfg, ALICE, 'github', sealed)).rejects.toThrow();
  });

  it('cannot be opened with another key', async () => {
    const sealed = await sealCredential(cfg, ALICE, 'github', { token: TOKEN });
    await expect(openCredential({ kmsKeyArn: ARN, keyring: rawKeyring() }, ALICE, 'github', sealed)).rejects.toThrow();
  });
});

describe('writeCredentials', () => {
  it('writes several providers in one transaction, label and ciphertext in the same row', async () => {
    await writeCredentials(cfg, ALICE, {
      github: { value: { token: TOKEN }, label: '@alice' },
      example: { value: { secret: 'x' }, label: 'example' },
    });
    expect(db.transactions).toEqual([2]);
    expect(db.rows.get(db.key(ALICE, 'github'))?.label).toBe('@alice');
    expect(await readCredential(cfg, ALICE, 'github')).toEqual({ token: TOKEN });
    expect(await readCredential(cfg, ALICE, 'example')).toEqual({ secret: 'x' });
  });

  it('applies a replace and a delete together', async () => {
    await writeCredentials(cfg, ALICE, {
      github: { value: { token: TOKEN }, label: '@alice' },
      example: { value: { secret: 'x' }, label: 'example' },
    });
    await writeCredentials(cfg, ALICE, { github: { value: { token: 'second' }, label: '@alice' }, example: null });
    expect(db.transactions).toEqual([2, 2]);
    expect(await readCredential(cfg, ALICE, 'github')).toEqual({ token: 'second' });
    expect(db.rows.has(db.key(ALICE, 'example'))).toBe(false);
  });

  it('writes nothing when encryption fails', async () => {
    await writeCredentials(cfg, ALICE, { github: { value: { token: TOKEN }, label: '@alice' } });
    const before = db.rows.get(db.key(ALICE, 'github'));
    await expect(writeCredentials({ kmsKeyArn: ARN, keyring: new FailingKeyring() }, ALICE, {
      github: { value: { token: 'new' }, label: '@alice' },
      example: null,
    })).rejects.toThrow(/KMS is unavailable/);
    expect(db.transactions).toEqual([1]);
    expect(db.rows.get(db.key(ALICE, 'github'))).toBe(before);
  });

  it('keeps every row when the transaction fails', async () => {
    await writeCredentials(cfg, ALICE, { github: { value: { token: TOKEN }, label: '@alice' } });
    db.failTransaction();
    await expect(writeCredentials(cfg, ALICE, {
      github: null,
      example: { value: { secret: 'x' }, label: 'example' },
    })).rejects.toThrow(/aborted/);
    expect(await readCredential(cfg, ALICE, 'github')).toEqual({ token: TOKEN });
    expect(db.rows.has(db.key(ALICE, 'example'))).toBe(false);
  });

  it('reads null for a provider with no row', async () => {
    expect(await readCredential(cfg, ALICE, 'github')).toBeNull();
  });
});

describe('deleteCredentials', () => {
  it('deletes the row without a KMS call', async () => {
    await writeCredentials(cfg, ALICE, { github: { value: { token: TOKEN }, label: '@alice' } });
    await writeCredentials(cfg, BOB, { github: { value: { token: 'bob' }, label: '@bob' } });
    await deleteCredentials(ALICE, ['github']);
    expect(db.rows.has(db.key(ALICE, 'github'))).toBe(false);
    expect(await readCredential(cfg, BOB, 'github')).toEqual({ token: 'bob' });
  });

  it("drops the broker's cached token", async () => {
    const forget = vi.spyOn(githubTokenSource, 'forget');
    await deleteCredentials(ALICE, ['github']);
    expect(forget).toHaveBeenCalledWith(ALICE);
    forget.mockRestore();
  });
});

describe('githubStoreDeps', () => {
  it('does not restore a token deleted during recheck', async () => {
    const deps = githubStoreDeps(cfg, ALICE);
    await deps.write({ login: 'octocat', githubUserId: 1, token: TOKEN });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        await deleteCredentials(ALICE, ['github']);
        return new Response(JSON.stringify({ login: 'octocat', id: 1 }), {
          headers: { 'x-oauth-scopes': 'repo, read:org' },
        });
      }
      return new Response('[]');
    });
    await recheckGithub({
      readSnapshot: deps.readSnapshot,
      replaceIfUnchanged: deps.replaceIfUnchanged,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await deps.read()).toBeNull();
  });

  it('stores the label with the value and reads it back', async () => {
    const deps = githubStoreDeps(cfg, ALICE);
    await deps.write({ login: 'alice', githubUserId: 7, token: TOKEN });
    expect(db.rows.get(db.key(ALICE, 'github'))?.label).toBe('@alice');
    expect(await deps.read()).toEqual({ login: 'alice', githubUserId: 7, token: TOKEN });
    await deleteCredentials(ALICE, ['github']);
    expect(await deps.read()).toBeNull();
  });
});
