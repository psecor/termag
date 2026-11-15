/**
 * A person's own Fireworks API key ("Your own Fireworks
 * key"): pasted in Settings, held only on the orchestrator, sealed like the
 * GitHub token (credentialStore.ts, provider `fireworks`). Boxes never get it.
 * The gateway's check (fireworksAuthz.ts) returns it to Envoy, which puts it
 * in place of the box token on the two inference routes, so Fireworks bills
 * and budgets the call to that person.
 *
 * A pasted key is checked with one read-only call, `GET /v1/accounts`, which
 * any role may make. Who owns the key and when it expires are not in that
 * answer, and Fireworks has no "whoami" call: they come from the account's
 * key list (`GET /v1/accounts/{a}/users/-/apiKeys`), matched by the
 * `prefix` Fireworks shows for each key. Listing every user's keys needs an
 * Admin key; for any other key the list fails or does not hold it, and the
 * key is stored without an owner or expiry.
 *
 * A key Fireworks later answers 401 for is marked invalid: the check refuses
 * the box's calls with the reason, and Settings asks for a new key. The
 * gateway passes Fireworks' answers to the box, so the orchestrator never
 * sees that 401 itself; it re-checks a key in use at most every
 * REVALIDATE_MS (revalidateFireworksKey), from the check, off its path.
 */

import { prisma } from '../db';
import {
  getCredentialStoreConfig, onCredentialChange, openCredential, sealCredential, writeCredentials,
  type CredentialStoreConfig,
} from './credentialStore';
import { CredentialInputError } from './githubCredential';

export const FIREWORKS_PROVIDER = 'fireworks';
export const FIREWORKS_API = 'https://api.fireworks.ai';

// One key, as Fireworks prints it: no spaces, nothing a header cannot carry.
const KEY_SHAPE = /^[\x21-\x7e]{16,512}$/;
const PROBE_TIMEOUT_MS = 8_000;
const KEY_TTL_MS = 60_000;
export const REVALIDATE_MS = 10 * 60_000;
export const EXPIRY_WARNING_MS = 14 * 24 * 60 * 60_000;
// The key list is read for identity only: a few pages of a few accounts.
const MAX_ACCOUNTS = 3;
const MAX_KEY_PAGES = 5;

export interface FireworksKeySecret {
  key: string;
  /** `accounts/<id>`'s id, when the key reaches exactly one account or its key list named it. */
  accountId: string | null;
  accountName: string | null;
  /** The owner's email, from the account's key list. */
  owner: string | null;
  /** Fireworks' key id, from the same list. */
  keyId: string | null;
  /** ISO time the key stops working, from the same list. */
  expireTime: string | null;
  /** When Fireworks answered 401 for it, and so termag stopped using it. */
  invalidAt: string | null;
}

export type FireworksProbe =
  | { kind: 'ok'; accountId: string | null; accountName: string | null; owner: string | null; keyId: string | null; expireTime: string | null }
  | { kind: 'rejected'; status: number }
  | { kind: 'unavailable'; detail: string }
  // Fireworks answered 200 but named no account the key reaches, so the key is not verified.
  | { kind: 'unverified'; detail: string };

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

export function looksLikeFireworksKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_SHAPE.test(value);
}

/** The first characters of the key, for telling two keys apart in Settings; never more of it. */
export function keyHint(key: string): string {
  return `${key.slice(0, 6)}…`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function getJson(fetchImpl: FetchLike, key: string, url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  let body: unknown = null;
  if (res.ok) body = await res.json().catch(() => null);
  return { status: res.status, body };
}

interface KeyMatch { accountId: string; owner: string | null; keyId: string | null; expireTime: string | null }

/** The key's row in its account's key list, matched by Fireworks' prefix; null when not exactly one row matches. */
async function findKeyInList(fetchImpl: FetchLike, key: string, apiBase: string, accountIds: string[]): Promise<KeyMatch | null> {
  const matches: KeyMatch[] = [];
  for (const accountId of accountIds.slice(0, MAX_ACCOUNTS)) {
    let pageToken = '';
    for (let page = 0; page < MAX_KEY_PAGES; page++) {
      const q = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
      const { status, body } = await getJson(fetchImpl, key, `${apiBase}/v1/accounts/${encodeURIComponent(accountId)}/users/-/apiKeys?${q}`);
      if (status !== 200 || !body || typeof body !== 'object') break;
      const list = (body as { apiKeys?: unknown }).apiKeys;
      for (const k of Array.isArray(list) ? list : []) {
        if (!k || typeof k !== 'object') continue;
        const row = k as Record<string, unknown>;
        const prefix = str(row.prefix);
        if (!prefix || prefix.length < 4 || !key.startsWith(prefix)) continue;
        matches.push({ accountId, owner: str(row.email), keyId: str(row.keyId), expireTime: str(row.expireTime) });
      }
      pageToken = str((body as { nextPageToken?: unknown }).nextPageToken) ?? '';
      if (!pageToken) break;
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Asks Fireworks about a key with read-only calls. `identity` also reads the
 * key list for the owner and expiry (best effort: any failure there leaves
 * them null). A 401 or 403 on the accounts call is a rejection; anything
 * else that is not a 200 means Fireworks could not say. A 200 that names no
 * account (`accounts/<id>`) does not verify the key.
 */
export async function probeFireworksKey(
  key: string,
  { fetchImpl = fetch as unknown as FetchLike, apiBase = FIREWORKS_API, identity = true }: { fetchImpl?: FetchLike; apiBase?: string; identity?: boolean } = {},
): Promise<FireworksProbe> {
  let accounts: { status: number; body: unknown };
  try {
    accounts = await getJson(fetchImpl, key, `${apiBase}/v1/accounts?pageSize=50`);
  } catch (err) {
    return { kind: 'unavailable', detail: (err as Error).name === 'TimeoutError' ? 'timed out' : 'unreachable' };
  }
  if (accounts.status === 401 || accounts.status === 403) return { kind: 'rejected', status: accounts.status };
  if (accounts.status !== 200) return { kind: 'unavailable', detail: `HTTP ${accounts.status}` };
  const rows = (accounts.body as { accounts?: unknown } | null)?.accounts;
  const list = (Array.isArray(rows) ? rows : []).flatMap(a => {
    const name = str((a as { name?: unknown } | null)?.name);
    const id = name?.match(/^accounts\/([^/]+)$/)?.[1];
    return id ? [{ id, displayName: str((a as { displayName?: unknown }).displayName) }] : [];
  });
  if (!list.length) return { kind: 'unverified', detail: 'Fireworks answered without an account for this key' };
  const only = list.length === 1 ? list[0] : null;
  let match: KeyMatch | null = null;
  if (identity) {
    try {
      match = await findKeyInList(fetchImpl, key, apiBase, list.map(a => a.id));
    } catch {
      match = null;
    }
  }
  const accountId = match?.accountId ?? only?.id ?? null;
  return {
    kind: 'ok',
    accountId,
    accountName: list.find(a => a.id === accountId)?.displayName ?? null,
    owner: match?.owner ?? null,
    keyId: match?.keyId ?? null,
    expireTime: match?.expireTime && !Number.isNaN(Date.parse(match.expireTime)) ? match.expireTime : null,
  };
}

/** What Settings shows for a stored key: never the key. */
export function fireworksLabel(secret: Pick<FireworksKeySecret, 'owner' | 'accountName' | 'accountId'>): string {
  return secret.owner ?? secret.accountName ?? secret.accountId ?? 'Fireworks API key';
}

function isSecret(v: unknown): v is FireworksKeySecret {
  return !!v && typeof v === 'object' && looksLikeFireworksKey((v as { key?: unknown }).key);
}

interface Snapshot { secret: FireworksKeySecret; ciphertext: Buffer }

async function readSnapshot(cfg: CredentialStoreConfig, userId: string): Promise<Snapshot | null> {
  const row = await prisma.userCredential.findUnique({
    where: { userId_provider: { userId, provider: FIREWORKS_PROVIDER } },
    select: { ciphertext: true },
  });
  if (!row) return null;
  const secret = await openCredential(cfg, userId, FIREWORKS_PROVIDER, row.ciphertext);
  return isSecret(secret) ? { secret, ciphertext: Buffer.from(row.ciphertext) } : null;
}

const byUser = new Map<string, { at: number; secret: FireworksKeySecret | null }>();
const lastProbe = new Map<string, number>();
// Bumped on every write, delete or invalid mark of a user's key. A read that
// started before a bump never caches what it read: it may be the old key.
const generation = new Map<string, number>();
const READ_ATTEMPTS = 3;

function forgetKey(userId: string): void {
  generation.set(userId, (generation.get(userId) ?? 0) + 1);
  byUser.delete(userId);
}

onCredentialChange((userId, provider) => {
  if (provider !== FIREWORKS_PROVIDER) return;
  forgetKey(userId);
  lastProbe.delete(userId);
});

/**
 * The user's stored key, cached per user for KEY_TTL_MS so the gateway's
 * calls cost one KMS decrypt a minute at most. null with no row or no
 * credential store. Throws on a KMS or decrypt failure (not cached), so the
 * check answers 503 rather than spending another key.
 *
 * A write or delete during the read makes the read start again, so neither
 * the cache nor the caller gets a key that was removed or replaced meanwhile.
 * After READ_ATTEMPTS reads that each overlap a change it answers with no key
 * (the shared key or the flag's refusal) and caches nothing.
 */
export async function readFireworksKey(userId: string, now = Date.now()): Promise<FireworksKeySecret | null> {
  const hit = byUser.get(userId);
  if (hit && now - hit.at < KEY_TTL_MS) return hit.secret;
  const cfg = getCredentialStoreConfig();
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const before = generation.get(userId) ?? 0;
    const secret = cfg ? (await readSnapshot(cfg, userId))?.secret ?? null : null;
    if ((generation.get(userId) ?? 0) !== before) continue;
    byUser.set(userId, { at: now, secret });
    return secret;
  }
  console.warn(`[FIREWORKS-KEY] user=${userId} key changed during ${READ_ATTEMPTS} reads; answering with none`);
  return null;
}

export type OwnerKeyState =
  | { state: 'none' }
  | { state: 'valid'; key: string }
  | { state: 'invalid'; reason: 'rejected' | 'expired'; at: string };

/** Whether the gateway may spend a stored key now. */
export function ownerKeyState(secret: FireworksKeySecret | null, now = Date.now()): OwnerKeyState {
  if (!secret) return { state: 'none' };
  if (secret.invalidAt) return { state: 'invalid', reason: 'rejected', at: secret.invalidAt };
  if (secret.expireTime && Date.parse(secret.expireTime) <= now) return { state: 'invalid', reason: 'expired', at: secret.expireTime };
  return { state: 'valid', key: secret.key };
}

export interface FireworksStoreDeps {
  write(secret: FireworksKeySecret): Promise<void>;
  probe(key: string): Promise<FireworksProbe>;
}

export function fireworksStoreDeps(cfg: CredentialStoreConfig, userId: string, fetchImpl?: FetchLike): FireworksStoreDeps {
  return {
    write: secret => writeCredentials(cfg, userId, { [FIREWORKS_PROVIDER]: { value: secret, label: fireworksLabel(secret) } }),
    probe: key => probeFireworksKey(key, { fetchImpl }),
  };
}

/** Checks a pasted key with Fireworks and stores it; throws CredentialInputError with what to tell the person. */
export async function connectFireworksKey(raw: unknown, deps: FireworksStoreDeps): Promise<FireworksKeySecret> {
  const key = typeof raw === 'string' ? raw.trim().replace(/^Bearer\s+/i, '') : raw;
  if (!looksLikeFireworksKey(key)) throw new CredentialInputError('That is not a Fireworks API key (paste the key from Fireworks\' API Keys page, without spaces).');
  const probe = await deps.probe(key);
  if (probe.kind === 'rejected') throw new CredentialInputError(`Fireworks rejected that key (HTTP ${probe.status}). Check it in Fireworks' API Keys page and paste it again.`);
  if (probe.kind === 'unavailable') {
    throw new CredentialInputError(`Could not check the key with Fireworks (${probe.detail}). Try again in a minute.`, 502);
  }
  if (probe.kind === 'unverified') throw new CredentialInputError(`termag could not verify that key: ${probe.detail}. Check it in Fireworks' API Keys page and paste it again.`);
  const secret: FireworksKeySecret = {
    key,
    accountId: probe.accountId,
    accountName: probe.accountName,
    owner: probe.owner,
    keyId: probe.keyId,
    expireTime: probe.expireTime,
    invalidAt: null,
  };
  await deps.write(secret);
  return secret;
}

/**
 * Re-checks a user's key with Fireworks at most once per REVALIDATE_MS, and
 * marks it invalid when Fireworks answers 401. The write only happens while
 * the row still holds the key that was checked, so a key pasted meanwhile is
 * never marked. Never throws: it runs off the gateway check's path.
 */
export async function revalidateFireworksKey(
  userId: string,
  { now = Date.now(), fetchImpl }: { now?: number; fetchImpl?: FetchLike } = {},
): Promise<'skipped' | 'valid' | 'invalid' | 'unknown'> {
  const last = lastProbe.get(userId);
  if (last !== undefined && now - last < REVALIDATE_MS) return 'skipped';
  lastProbe.set(userId, now);
  try {
    const cfg = getCredentialStoreConfig();
    if (!cfg) return 'skipped';
    const snap = await readSnapshot(cfg, userId);
    if (!snap || snap.secret.invalidAt) return 'skipped';
    const probe = await probeFireworksKey(snap.secret.key, { fetchImpl, identity: false });
    if (probe.kind === 'ok') return 'valid';
    if (probe.kind !== 'rejected' || probe.status !== 401) return 'unknown';
    const marked: FireworksKeySecret = { ...snap.secret, invalidAt: new Date(now).toISOString() };
    const ciphertext = await sealCredential(cfg, userId, FIREWORKS_PROVIDER, marked);
    const updated = await prisma.userCredential.updateMany({
      where: { userId, provider: FIREWORKS_PROVIDER, ciphertext: snap.ciphertext },
      data: { label: fireworksLabel(marked), ciphertext },
    });
    forgetKey(userId);
    if (updated.count) console.warn(`[FIREWORKS-KEY] user=${userId} key rejected by Fireworks (401); marked invalid`);
    return updated.count ? 'invalid' : 'skipped';
  } catch (err) {
    console.warn(`[FIREWORKS-KEY] user=${userId} re-check failed: ${(err as Error).message}`);
    return 'unknown';
  }
}

/** Settings' view of a stored key: never the key itself. */
export interface FireworksKeyStatus {
  label: string;
  hint: string;
  owner: string | null;
  account: string | null;
  expireTime: string | null;
  /** The key expires within EXPIRY_WARNING_MS. */
  expiresSoon: boolean;
  invalid: { reason: 'rejected' | 'expired'; at: string } | null;
  updatedAt: Date;
}

export function fireworksKeyStatus(secret: FireworksKeySecret, updatedAt: Date, now = Date.now()): FireworksKeyStatus {
  const state = ownerKeyState(secret, now);
  const expires = secret.expireTime ? Date.parse(secret.expireTime) : NaN;
  return {
    label: fireworksLabel(secret),
    hint: keyHint(secret.key),
    owner: secret.owner,
    account: secret.accountName ?? secret.accountId,
    expireTime: secret.expireTime,
    expiresSoon: state.state === 'valid' && Number.isFinite(expires) && expires - now <= EXPIRY_WARNING_MS,
    invalid: state.state === 'invalid' ? { reason: state.reason, at: state.at } : null,
    updatedAt,
  };
}

/** The stored key's Settings view, or null with none. Throws on a decrypt failure. */
export async function readFireworksKeyStatus(cfg: CredentialStoreConfig, userId: string, now = Date.now()): Promise<FireworksKeyStatus | null> {
  const row = await prisma.userCredential.findUnique({
    where: { userId_provider: { userId, provider: FIREWORKS_PROVIDER } },
    select: { ciphertext: true, updatedAt: true },
  });
  if (!row) return null;
  const secret = await openCredential(cfg, userId, FIREWORKS_PROVIDER, row.ciphertext);
  return isSecret(secret) ? fireworksKeyStatus(secret, row.updatedAt, now) : null;
}

/** Test hook: forget every cached key and re-check time. */
export function resetFireworksKeyCache(): void {
  byUser.clear();
  lastProbe.clear();
  generation.clear();
}
