import { randomBytes } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RawAesKeyringNode, RawAesWrappingSuiteIdentifier } from '@aws-crypto/client-node';
import type { FetchLike, FireworksKeySecret } from './fireworksKey';

// An in-memory user_credentials table, as credentialStore.test.ts keeps one.
const db = vi.hoisted(() => {
  type Row = { userId: string; provider: string; label: string; ciphertext: Buffer; updatedAt: Date };
  const rows = new Map<string, Row>();
  const key = (userId: string, provider: string) => `${userId}|${provider}`;
  // Runs once, after a findUnique has read its row and before it resolves: a write landing mid-read.
  const hooks: { afterFind: null | (() => Promise<void>) } = { afterFind: null };
  function op(run: (table: Map<string, Row>) => unknown) {
    return { run, then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(() => run(rows)).then(resolve, reject) };
  }
  const prisma = {
    userCredential: {
      findUnique: async ({ where }: { where: { userId_provider: { userId: string; provider: string } } }) => {
        const row = rows.get(key(where.userId_provider.userId, where.userId_provider.provider)) ?? null;
        const hook = hooks.afterFind;
        hooks.afterFind = null;
        if (hook) await hook();
        return row;
      },
      upsert: ({ where, create, update }: { where: { userId_provider: { userId: string; provider: string } }; create: Row; update: Pick<Row, 'label' | 'ciphertext'> }) => op(t => {
        const k = key(where.userId_provider.userId, where.userId_provider.provider);
        const existing = t.get(k);
        t.set(k, existing ? { ...existing, ...update, updatedAt: new Date() } : { ...create, updatedAt: new Date() });
      }),
      deleteMany: ({ where }: { where: { userId: string; provider: string | { in: string[] } } }) => op(t => {
        const providers = typeof where.provider === 'string' ? [where.provider] : where.provider.in;
        for (const p of providers) t.delete(key(where.userId, p));
      }),
      updateMany: ({ where, data }: { where: { userId: string; provider: string; ciphertext: Buffer }; data: { label: string; ciphertext: Buffer } }) => op(t => {
        const existing = t.get(key(where.userId, where.provider));
        if (!existing || !existing.ciphertext.equals(where.ciphertext)) return { count: 0 };
        t.set(key(where.userId, where.provider), { ...existing, label: data.label, ciphertext: Buffer.from(data.ciphertext) });
        return { count: 1 };
      }),
    },
    $transaction: async (ops: { run: (t: Map<string, Row>) => unknown }[]) => { for (const o of ops) o.run(rows); },
  };
  return { prisma, rows, key, hooks };
});
vi.mock('../db', () => ({ prisma: db.prisma }));

const store = vi.hoisted(() => ({ cfg: null as unknown }));
vi.mock('./credentialStore', async importOriginal => ({
  ...(await importOriginal<typeof import('./credentialStore')>()),
  getCredentialStoreConfig: () => store.cfg,
}));

const {
  connectFireworksKey, fireworksKeyStatus, fireworksStoreDeps, keyHint, looksLikeFireworksKey, ownerKeyState,
  probeFireworksKey, readFireworksKey, readFireworksKeyStatus, resetFireworksKeyCache, revalidateFireworksKey,
  EXPIRY_WARNING_MS, REVALIDATE_MS,
} = await import('./fireworksKey');
const { writeCredentials, deleteCredentials } = await import('./credentialStore');

const ALICE = 'cmalice0000000001';
const KEY = 'fw_3ZtestAliceKey0123456789abcdef'; // gitleaks:allow (test sentinel)
const OTHER = 'fw_9YtestOtherKey0123456789abcdef'; // gitleaks:allow (test sentinel)

type Answer = { status: number; body?: unknown } | Error;
function fakeFetch(routes: Record<string, Answer | ((url: string) => Answer)>) {
  const calls: Array<{ url: string; authorization: string }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization });
    const path = url.replace('https://api.fireworks.ai', '');
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p))?.[1];
    const a = typeof hit === 'function' ? hit(path) : hit ?? { status: 404 };
    if (a instanceof Error) throw a;
    return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body ?? null };
  };
  return { impl, calls };
}

const ACCOUNTS = { status: 200, body: { accounts: [{ name: 'accounts/acme', displayName: 'Acme' }] } };
const ADMIN_LIST = {
  status: 200,
  body: { apiKeys: [
    { keyId: 'k1', prefix: 'fw_3Zt', email: 'alice@example.com', expireTime: '2027-05-01T00:00:00Z' },
    { keyId: 'k2', prefix: 'fw_9Yt', email: 'bob@example.com', expireTime: '2027-01-01T00:00:00Z' },
  ] },
};

beforeEach(() => {
  db.rows.clear();
  resetFireworksKeyCache();
  store.cfg = {
    kmsKeyArn: 'arn:aws:kms:us-east-2:111122223333:key/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0',
    keyring: new RawAesKeyringNode({
      keyName: 'test-key', keyNamespace: 'termag-test', unencryptedMasterKey: new Uint8Array(randomBytes(32)),
      wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
    }),
  };
});

const secret = (over: Partial<FireworksKeySecret> = {}): FireworksKeySecret => ({
  key: KEY, accountId: 'acme', accountName: 'Acme', owner: 'alice@example.com', keyId: 'k1', expireTime: null, invalidAt: null, ...over,
});

describe('looksLikeFireworksKey and keyHint', () => {
  it('takes one printable token, and shows only its first characters', () => {
    expect(looksLikeFireworksKey(KEY)).toBe(true);
    for (const bad of ['', 'short', `${KEY} x`, `${KEY}\n`, 42, null]) expect(looksLikeFireworksKey(bad)).toBe(false);
    expect(keyHint(KEY)).toBe('fw_3Zt…');
  });
});

describe('probeFireworksKey', () => {
  it("checks the key with GET /v1/accounts and reads its owner and expiry from an Admin key's list", async () => {
    const f = fakeFetch({ '/v1/accounts?': ACCOUNTS, '/v1/accounts/acme/users/-/apiKeys': ADMIN_LIST });
    expect(await probeFireworksKey(KEY, { fetchImpl: f.impl })).toEqual({
      kind: 'ok', accountId: 'acme', accountName: 'Acme', owner: 'alice@example.com', keyId: 'k1', expireTime: '2027-05-01T00:00:00Z',
    });
    expect(f.calls.every(c => c.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it('keeps a key whose list it may not read, without an owner or expiry', async () => {
    const f = fakeFetch({ '/v1/accounts?': ACCOUNTS, '/v1/accounts/acme/users/-/apiKeys': { status: 403 } });
    expect(await probeFireworksKey(KEY, { fetchImpl: f.impl })).toEqual({
      kind: 'ok', accountId: 'acme', accountName: 'Acme', owner: null, keyId: null, expireTime: null,
    });
  });

  it('names no owner when two keys share the prefix, or none matches', async () => {
    const twins = { status: 200, body: { apiKeys: [{ prefix: 'fw_3Z', email: 'a@x' }, { prefix: 'fw_3Zt', email: 'b@x' }] } };
    expect(await probeFireworksKey(KEY, { fetchImpl: fakeFetch({ '/v1/accounts?': ACCOUNTS, '/v1/accounts/acme/users/-/apiKeys': twins }).impl }))
      .toMatchObject({ kind: 'ok', owner: null });
    const none = { status: 200, body: { apiKeys: [{ prefix: 'fw_zz', email: 'a@x' }, { prefix: 'fw', email: 'short@x' }] } };
    expect(await probeFireworksKey(KEY, { fetchImpl: fakeFetch({ '/v1/accounts?': ACCOUNTS, '/v1/accounts/acme/users/-/apiKeys': none }).impl }))
      .toMatchObject({ kind: 'ok', owner: null });
  });

  it('follows the list a few pages, and finds the account among several', async () => {
    const pages = (path: string) => (path.includes('pageToken=p2')
      ? { status: 200, body: { apiKeys: [{ keyId: 'k9', prefix: 'fw_3Zte', email: 'alice@example.com' }] } }
      : { status: 200, body: { apiKeys: [], nextPageToken: 'p2' } });
    const f = fakeFetch({
      '/v1/accounts?': { status: 200, body: { accounts: [{ name: 'accounts/one' }, { name: 'accounts/two', displayName: 'Two' }] } },
      '/v1/accounts/one/': { status: 200, body: { apiKeys: [] } },
      '/v1/accounts/two/': pages,
    });
    expect(await probeFireworksKey(KEY, { fetchImpl: f.impl })).toMatchObject({ kind: 'ok', accountId: 'two', accountName: 'Two', owner: 'alice@example.com', keyId: 'k9' });
  });

  it('does not accept a key on a 200 that names no account', async () => {
    for (const body of [null, {}, { accounts: [] }, { accounts: 'acme' }, { accounts: [{ name: 'not-an-account' }, { displayName: 'x' }] }]) {
      expect(await probeFireworksKey(KEY, { fetchImpl: fakeFetch({ '/v1/accounts?': { status: 200, body } }).impl }), JSON.stringify(body))
        .toEqual({ kind: 'unverified', detail: 'Fireworks answered without an account for this key' });
    }
  });

  it('calls a 401 or 403 a rejection, and anything else Fireworks could not say', async () => {
    expect(await probeFireworksKey(KEY, { fetchImpl: fakeFetch({ '/v1/accounts?': { status: 401 } }).impl })).toEqual({ kind: 'rejected', status: 401 });
    expect(await probeFireworksKey(KEY, { fetchImpl: fakeFetch({ '/v1/accounts?': { status: 403 } }).impl })).toEqual({ kind: 'rejected', status: 403 });
    expect(await probeFireworksKey(KEY, { fetchImpl: fakeFetch({ '/v1/accounts?': { status: 503 } }).impl })).toEqual({ kind: 'unavailable', detail: 'HTTP 503' });
    expect(await probeFireworksKey(KEY, { fetchImpl: fakeFetch({ '/v1/accounts?': new TypeError('fetch failed') }).impl })).toEqual({ kind: 'unavailable', detail: 'unreachable' });
  });

  it('reads no key list when asked only whether the key works', async () => {
    const f = fakeFetch({ '/v1/accounts?': ACCOUNTS, '/v1/accounts/acme/users/-/apiKeys': ADMIN_LIST });
    expect(await probeFireworksKey(KEY, { fetchImpl: f.impl, identity: false })).toMatchObject({ kind: 'ok', owner: null });
    expect(f.calls).toHaveLength(1);
  });
});

describe('connectFireworksKey', () => {
  const deps = (fetchImpl: FetchLike) => fireworksStoreDeps(store.cfg as never, ALICE, fetchImpl);

  it("stores a key Fireworks accepts, sealed, with its owner as the row's label", async () => {
    const f = fakeFetch({ '/v1/accounts?': ACCOUNTS, '/v1/accounts/acme/users/-/apiKeys': ADMIN_LIST });
    await connectFireworksKey(`  Bearer ${KEY}\n`, deps(f.impl));
    const row = db.rows.get(db.key(ALICE, 'fireworks'))!;
    expect(row.label).toBe('alice@example.com');
    expect(row.ciphertext.includes(Buffer.from(KEY))).toBe(false);
    expect(await readFireworksKey(ALICE)).toEqual(secret({ expireTime: '2027-05-01T00:00:00Z' }));
  });

  it('refuses what is not a key, a key Fireworks rejects, and says so when Fireworks cannot answer', async () => {
    await expect(connectFireworksKey('not a key', deps(fakeFetch({}).impl))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not a Fireworks API key/) });
    await expect(connectFireworksKey(KEY, deps(fakeFetch({ '/v1/accounts?': { status: 401 } }).impl))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/rejected that key \(HTTP 401\)/) });
    await expect(connectFireworksKey(KEY, deps(fakeFetch({ '/v1/accounts?': { status: 500 } }).impl))).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/Try again/) });
    await expect(connectFireworksKey(KEY, deps(fakeFetch({ '/v1/accounts?': { status: 200, body: { accounts: [] } } }).impl)))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/could not verify that key: Fireworks answered without an account/) });
    expect(db.rows.size).toBe(0);
  });
});

describe('readFireworksKey', () => {
  it('caches per user, and drops the copy when the row is written or deleted', async () => {
    await writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret(), label: 'a' } });
    expect((await readFireworksKey(ALICE))?.key).toBe(KEY);
    await writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret({ key: OTHER }), label: 'a' } });
    expect((await readFireworksKey(ALICE))?.key).toBe(OTHER);
    await deleteCredentials(ALICE, ['fireworks']);
    expect(await readFireworksKey(ALICE)).toBeNull();
  });

  it('never caches a key deleted while it was being read', async () => {
    await writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret(), label: 'a' } });
    db.hooks.afterFind = () => deleteCredentials(ALICE, ['fireworks']);
    await readFireworksKey(ALICE);
    expect(db.rows.size).toBe(0);
    expect(await readFireworksKey(ALICE)).toBeNull();
  });

  it('never caches a key replaced while it was being read', async () => {
    await writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret(), label: 'a' } });
    db.hooks.afterFind = () => writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret({ key: OTHER }), label: 'a' } });
    await readFireworksKey(ALICE);
    expect((await readFireworksKey(ALICE))?.key).toBe(OTHER);
  });

  it('answers with no key, and caches none, when every read overlaps a write', async () => {
    await writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret(), label: 'a' } });
    let writes = 0;
    const rewrite = async () => {
      writes++;
      await writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret({ key: writes % 2 ? OTHER : KEY }), label: 'a' } });
      if (writes < 3) db.hooks.afterFind = rewrite;
    };
    db.hooks.afterFind = rewrite;
    expect(await readFireworksKey(ALICE)).toBeNull();
    expect(writes).toBe(3);
    expect((await readFireworksKey(ALICE))?.key).toBe(OTHER);
  });

  it('is null with no credential store', async () => {
    store.cfg = null;
    expect(await readFireworksKey(ALICE)).toBeNull();
  });
});

describe('ownerKeyState and fireworksKeyStatus', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');

  it('spends a valid key, and refuses a rejected or expired one', () => {
    expect(ownerKeyState(null)).toEqual({ state: 'none' });
    expect(ownerKeyState(secret(), now)).toEqual({ state: 'valid', key: KEY });
    expect(ownerKeyState(secret({ invalidAt: '2026-11-08T00:00:00Z' }), now)).toEqual({ state: 'invalid', reason: 'rejected', at: '2026-11-08T00:00:00Z' });
    expect(ownerKeyState(secret({ expireTime: '2026-11-01T00:00:00Z' }), now)).toEqual({ state: 'invalid', reason: 'expired', at: '2026-11-01T00:00:00Z' });
  });

  it('warns within two weeks of the expiry, and never shows the key', () => {
    const soon = new Date(now + EXPIRY_WARNING_MS - 1000).toISOString();
    const later = new Date(now + EXPIRY_WARNING_MS + 1000).toISOString();
    const at = new Date(now);
    expect(fireworksKeyStatus(secret({ expireTime: soon }), at, now)).toMatchObject({ expiresSoon: true, invalid: null, hint: 'fw_3Zt…', label: 'alice@example.com', account: 'Acme' });
    expect(fireworksKeyStatus(secret({ expireTime: later }), at, now)).toMatchObject({ expiresSoon: false });
    expect(fireworksKeyStatus(secret(), at, now)).toMatchObject({ expiresSoon: false, expireTime: null });
    expect(JSON.stringify(fireworksKeyStatus(secret({ expireTime: soon }), at, now))).not.toContain(KEY);
  });
});

describe('revalidateFireworksKey', () => {
  const t0 = Date.parse('2026-11-09T12:00:00Z');

  it('marks a key Fireworks answers 401 for invalid, at most once per interval', async () => {
    await writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret(), label: 'alice@example.com' } });
    expect((await readFireworksKey(ALICE))?.invalidAt).toBeNull();
    const ok = fakeFetch({ '/v1/accounts?': ACCOUNTS });
    expect(await revalidateFireworksKey(ALICE, { now: t0, fetchImpl: ok.impl })).toBe('valid');
    const rejected = fakeFetch({ '/v1/accounts?': { status: 401 } });
    expect(await revalidateFireworksKey(ALICE, { now: t0 + REVALIDATE_MS - 1, fetchImpl: rejected.impl })).toBe('skipped');
    expect(rejected.calls).toHaveLength(0);
    expect(await revalidateFireworksKey(ALICE, { now: t0 + REVALIDATE_MS, fetchImpl: rejected.impl })).toBe('invalid');
    expect(ownerKeyState(await readFireworksKey(ALICE))).toMatchObject({ state: 'invalid', reason: 'rejected' });
    const status = await readFireworksKeyStatus(store.cfg as never, ALICE);
    expect(status?.invalid).toMatchObject({ reason: 'rejected' });
  });

  it('leaves the key alone on a 403, an outage, or a key pasted meanwhile', async () => {
    await writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret(), label: 'a' } });
    expect(await revalidateFireworksKey(ALICE, { now: t0, fetchImpl: fakeFetch({ '/v1/accounts?': { status: 403 } }).impl })).toBe('unknown');
    expect(await revalidateFireworksKey(ALICE, { now: t0 + REVALIDATE_MS, fetchImpl: fakeFetch({ '/v1/accounts?': new TypeError('fetch failed') }).impl })).toBe('unknown');
    expect((await readFireworksKey(ALICE))?.invalidAt).toBeNull();

    // The 401 answers for the old key while a new one is pasted.
    const swap = fakeFetch({ '/v1/accounts?': () => {
      void writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret({ key: OTHER }), label: 'a' } });
      return { status: 401 };
    } });
    await revalidateFireworksKey(ALICE, { now: t0 + 2 * REVALIDATE_MS, fetchImpl: swap.impl });
    await new Promise(r => setTimeout(r, 10));
    expect(ownerKeyState(await readFireworksKey(ALICE))).toEqual({ state: 'valid', key: OTHER });
  });

  it('leaves the key alone when Fireworks answers 200 without an account', async () => {
    await writeCredentials(store.cfg as never, ALICE, { fireworks: { value: secret(), label: 'a' } });
    expect(await revalidateFireworksKey(ALICE, { now: t0, fetchImpl: fakeFetch({ '/v1/accounts?': { status: 200, body: {} } }).impl })).toBe('unknown');
    expect((await readFireworksKey(ALICE))?.invalidAt).toBeNull();
  });

  it('does nothing without a stored key', async () => {
    expect(await revalidateFireworksKey(ALICE, { now: t0, fetchImpl: fakeFetch({}).impl })).toBe('skipped');
  });
});
